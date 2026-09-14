import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import { randomInt } from 'node:crypto';
import type { Client, Guild, GuildMember, VoiceBasedChannel } from 'discord.js';
import { getConfig } from '../../core/guildConfig';
import { createLogger } from '../../core/logger';
import { openTrack, type Track } from './sources';

const log = createLogger('musique');

export type LoopMode = 'off' | 'track' | 'queue';
export const LOOP_LABELS: Record<LoopMode, string> = { off: 'désactivée', track: 'le morceau', queue: 'la file' };

/** File active limitée ; le surplus attend en réserve et remonte tout seul (comme sur Airline). */
export const QUEUE_ACTIVE_MAX = 1000;
const HISTORY_MAX = 20;

export interface MusicEvents {
  onStart(session: GuildMusic, track: Track): void;
  onError(session: GuildMusic, track: Track | null, error: Error): void;
  onFinish(session: GuildMusic): void;
}

export class GuildMusic {
  connection: VoiceConnection | null = null;
  readonly player: AudioPlayer;
  resource: AudioResource | null = null;
  queue: Track[] = [];
  reserve: Track[] = [];
  history: Track[] = [];
  current: Track | null = null;
  loop: LoopMode = 'off';
  volume: number;
  textChannelId: string | null = null;
  skipVotes = new Set<string>();
  played = 0;
  panelMessageId: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private starting = false;

  constructor(
    readonly guild: Guild,
    private readonly events: MusicEvents,
    private readonly onDestroy: (guildId: string) => void,
  ) {
    this.volume = Math.min(Math.max(getConfig(guild.id).music.defaultVolume, 1), 200) / 100;
    this.player = createAudioPlayer();
    this.player.on(AudioPlayerStatus.Idle, () => void this.next());
    this.player.on('error', (err) => {
      log.warn(`Erreur de lecture sur ${this.guild.id} : ${err.message}`);
      this.events.onError(this, this.current, err);
    });
  }

  get channelId(): string | null {
    return this.connection?.joinConfig.channelId ?? null;
  }

  get paused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  get waiting(): number {
    return this.queue.length + this.reserve.length;
  }

  get elapsed(): number {
    return Math.floor((this.resource?.playbackDuration ?? 0) / 1000);
  }

  join(channel: VoiceBasedChannel): VoiceConnection {
    if (this.connection && this.connection.joinConfig.channelId === channel.id && this.connection.state.status !== VoiceConnectionStatus.Destroyed) return this.connection;
    this.connection?.destroy();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connection.subscribe(this.player);
    this.connection = connection;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
      } catch {
        // Déconnexion réelle (kick du vocal, salon supprimé) : on nettoie.
        if (this.connection === connection) this.destroy();
      }
    });
    return connection;
  }

  /** Ajoute des pistes ; lance la lecture si rien ne joue. Retourne la position du premier ajout. */
  add(tracks: Track[]): { position: number; immediate: boolean; reserved: number } {
    const playing = !!this.current || this.starting;
    const position = this.queue.length + this.reserve.length + 1;
    const room = Math.max(0, QUEUE_ACTIVE_MAX - this.queue.length);
    this.queue.push(...tracks.slice(0, room));
    if (tracks.length > room) this.reserve.push(...tracks.slice(room));
    const maxQueue = getConfig(this.guild.id).music.maxQueue;
    if (maxQueue > 0 && this.waiting > maxQueue * 25) this.reserve.length = Math.max(0, maxQueue * 25 - this.queue.length);
    this.clearIdle();
    if (!playing) void this.next();
    return { position, immediate: !playing, reserved: this.reserve.length };
  }

  private refill(): void {
    if (!this.reserve.length) return;
    const room = QUEUE_ACTIVE_MAX - this.queue.length;
    if (room > 0) this.queue.push(...this.reserve.splice(0, room));
  }

  private async play(track: Track): Promise<void> {
    this.current = track;
    this.skipVotes.clear();
    this.starting = true;
    try {
      const stream = await openTrack(track);
      const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume?.setVolumeLogarithmic(this.volume);
      this.resource = resource;
      if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000).catch(() => {
          throw new Error('la connexion vocale n’est jamais devenue prête (vérifie mes permissions Parler)');
        });
      }
      this.player.play(resource);
      this.played++;
      this.events.onStart(this, track);
    } finally {
      this.starting = false;
    }
  }

  /** Passe au morceau suivant en respectant la boucle. */
  async next(): Promise<void> {
    if (this.destroyed || this.starting) return;
    const finished = this.current;
    if (finished) {
      if (this.loop === 'track') {
        await this.play(finished).catch((err: Error) => this.fail(finished, err));
        return;
      }
      this.history.push(finished);
      if (this.history.length > HISTORY_MAX) this.history.shift();
      if (this.loop === 'queue') this.queue.push(finished);
    }
    this.refill();
    const upcoming = this.queue.shift();
    if (!upcoming) {
      this.current = null;
      this.resource = null;
      this.events.onFinish(this);
      this.armIdle();
      return;
    }
    await this.play(upcoming).catch((err: Error) => this.fail(upcoming, err));
  }

  private async fail(track: Track, err: Error): Promise<void> {
    log.warn(`Lecture impossible (${track.title}) : ${err.message}`);
    this.events.onError(this, track, err);
    if (this.loop === 'track') this.loop = 'off';
    this.current = null;
    await this.next();
  }

  skip(): Track | null {
    const skipped = this.current;
    const loop = this.loop;
    if (loop === 'track') this.loop = 'off';
    this.player.stop(true);
    if (loop === 'track') setTimeout(() => (this.loop = loop), 1_000).unref();
    return skipped;
  }

  /** Rejoue le morceau précédent (le morceau en cours revient en tête de file). */
  previous(): Track | null {
    const prev = this.history.pop();
    if (!prev) return null;
    if (this.current) this.queue.unshift(this.current);
    this.queue.unshift(prev);
    this.current = null;
    this.player.stop(true);
    if (this.player.state.status === AudioPlayerStatus.Idle && !this.starting) void this.next();
    return prev;
  }

  togglePause(): boolean {
    if (this.paused) this.player.unpause();
    else this.player.pause();
    return this.paused;
  }

  setVolume(percent: number): void {
    this.volume = Math.min(Math.max(percent, 1), 200) / 100;
    this.resource?.volume?.setVolumeLogarithmic(this.volume);
  }

  shuffle(): number {
    const all = [...this.queue, ...this.reserve];
    for (let i = all.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [all[i], all[j]] = [all[j]!, all[i]!];
    }
    this.queue = all.slice(0, QUEUE_ACTIVE_MAX);
    this.reserve = all.slice(QUEUE_ACTIVE_MAX);
    return all.length;
  }

  remove(position: number): Track | null {
    const index = position - 1;
    if (index < 0) return null;
    if (index < this.queue.length) {
      const [removed] = this.queue.splice(index, 1);
      this.refill();
      return removed ?? null;
    }
    const inReserve = index - this.queue.length;
    return this.reserve.splice(inReserve, 1)[0] ?? null;
  }

  clearPlaylistTracks(): number {
    const before = this.waiting;
    this.queue = this.queue.filter((t) => !t.fromPlaylist);
    this.reserve = this.reserve.filter((t) => !t.fromPlaylist);
    this.refill();
    return before - this.waiting;
  }

  /** Temps estimé avant qu'une position de la file ne soit jouée (secondes). */
  timeUntil(index: number): number {
    let total = this.current ? Math.max(0, (this.current.duration || 0) - this.elapsed) : 0;
    const all = this.reserve.length ? [...this.queue, ...this.reserve] : this.queue;
    for (let i = 0; i < index; i++) total += all[i]?.duration || 0;
    return total;
  }

  isInSameChannel(member: GuildMember): boolean {
    return !!this.channelId && member.voice.channelId === this.channelId;
  }

  humanListeners(): number {
    const channel = this.channelId ? this.guild.channels.cache.get(this.channelId) : null;
    return channel && channel.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
  }

  votesNeeded(): number {
    return Math.max(1, Math.ceil(this.humanListeners() / 2));
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.destroy(), 5 * 60_000);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Quitte après X minutes seul dans le salon. */
  checkEmpty(): void {
    const minutes = getConfig(this.guild.id).music.leaveOnEmptyMinutes;
    if (!this.channelId || minutes <= 0) return;
    if (this.humanListeners() > 0) {
      if (this.emptyTimer) clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
      return;
    }
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      if (this.humanListeners() === 0) this.destroy();
    }, minutes * 60_000);
    this.emptyTimer.unref();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.queue = [];
    this.reserve = [];
    this.player.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      /* déjà détruite */
    }
    this.connection = null;
    this.onDestroy(this.guild.id);
  }
}

const sessions = new Map<string, GuildMusic>();

export function getSession(guildId: string): GuildMusic | undefined {
  return sessions.get(guildId);
}

export function ensureSession(guild: Guild, events: MusicEvents): GuildMusic {
  let session = sessions.get(guild.id);
  if (!session) {
    session = new GuildMusic(guild, events, (id) => sessions.delete(id));
    sessions.set(guild.id, session);
  }
  return session;
}

export function allSessions(): GuildMusic[] {
  return [...sessions.values()];
}

export function destroyAll(): void {
  for (const s of sessions.values()) s.destroy();
}

export type { Client };
