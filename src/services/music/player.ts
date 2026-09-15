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
import { lireConfig } from '../../core/guildConfig';
import { creerRegistre } from '../../core/logger';
import { ouvrirPiste, type Piste } from './sources';

const registre = creerRegistre('musique');

export type ModeBoucle = 'off' | 'track' | 'queue';
export const LIBELLES_BOUCLE: Record<ModeBoucle, string> = { off: 'désactivée', track: 'le morceau', queue: 'la file' };

/** File active limitée ; le surplus attend en réserve et remonte tout seul (comme sur Airline). */
export const FILE_ACTIVE_MAX = 1000;
const HISTORIQUE_MAX = 20;

export interface EvenementsLecteur {
  surDebut(session: LecteurServeur, piste: Piste): void;
  surErreur(session: LecteurServeur, piste: Piste | null, erreur: Error): void;
  surFin(session: LecteurServeur): void;
}

export class LecteurServeur {
  connexion: VoiceConnection | null = null;
  readonly lecteur: AudioPlayer;
  ressource: AudioResource | null = null;
  file: Piste[] = [];
  reserve: Piste[] = [];
  historique: Piste[] = [];
  actuel: Piste | null = null;
  boucle: ModeBoucle = 'off';
  volume: number;
  salonTexteId: string | null = null;
  votesPasser = new Set<string>();
  joues = 0;
  messagePanneauId: string | null = null;
  private minuteurInactivite: NodeJS.Timeout | null = null;
  private minuteurVide: NodeJS.Timeout | null = null;
  private detruit = false;
  private demarrage = false;

  constructor(
    readonly serveur: Guild,
    private readonly evenements: EvenementsLecteur,
    private readonly surDestruction: (serveurId: string) => void,
  ) {
    this.volume = Math.min(Math.max(lireConfig(serveur.id).musique.volumeParDefaut, 1), 200) / 100;
    this.lecteur = createAudioPlayer();
    this.lecteur.on(AudioPlayerStatus.Idle, () => void this.suivant());
    this.lecteur.on('error', (echec) => {
      registre.avertir(`Erreur de lecture sur ${this.serveur.id} : ${echec.message}`);
      this.evenements.surErreur(this, this.actuel, echec);
    });
  }

  get channelId(): string | null {
    return this.connexion?.joinConfig.channelId ?? null;
  }

  get paused(): boolean {
    return this.lecteur.state.status === AudioPlayerStatus.Paused || this.lecteur.state.status === AudioPlayerStatus.AutoPaused;
  }

  get waiting(): number {
    return this.file.length + this.reserve.length;
  }

  get elapsed(): number {
    return Math.floor((this.ressource?.playbackDuration ?? 0) / 1000);
  }

  rejoindre(salon: VoiceBasedChannel): VoiceConnection {
    if (this.connexion && this.connexion.joinConfig.channelId === salon.id && this.connexion.state.status !== VoiceConnectionStatus.Destroyed) return this.connexion;
    this.connexion?.destroy();
    const connexion = joinVoiceChannel({
      channelId: salon.id,
      guildId: salon.guild.id,
      adapterCreator: salon.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connexion.subscribe(this.lecteur);
    this.connexion = connexion;
    connexion.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connexion, VoiceConnectionStatus.Signalling, 5_000), entersState(connexion, VoiceConnectionStatus.Connecting, 5_000)]);
      } catch {
        // Déconnexion réelle (kick du vocal, salon supprimé) : on nettoie.
        if (this.connexion === connexion) this.detruire();
      }
    });
    return connexion;
  }

  /** Ajoute des pistes ; lance la lecture si rien ne joue. Retourne la position du premier ajout. */
  ajouter(pistes: Piste[]): { position: number; immediat: boolean; reserves: number } {
    const enLecture = !!this.actuel || this.demarrage;
    const position = this.file.length + this.reserve.length + 1;
    const place = Math.max(0, FILE_ACTIVE_MAX - this.file.length);
    this.file.push(...pistes.slice(0, place));
    if (pistes.length > place) this.reserve.push(...pistes.slice(place));
    const fileMax = lireConfig(this.serveur.id).musique.maxQueue;
    if (fileMax > 0 && this.waiting > fileMax * 25) this.reserve.length = Math.max(0, fileMax * 25 - this.file.length);
    this.annulerInactivite();
    if (!enLecture) void this.suivant();
    return { position, immediat: !enLecture, reserves: this.reserve.length };
  }

  private recharger(): void {
    if (!this.reserve.length) return;
    const place = FILE_ACTIVE_MAX - this.file.length;
    if (place > 0) this.file.push(...this.reserve.splice(0, place));
  }

  private async jouer(piste: Piste): Promise<void> {
    this.actuel = piste;
    this.votesPasser.clear();
    this.demarrage = true;
    try {
      const flux = await ouvrirPiste(piste);
      const ressource = createAudioResource(flux, { inputType: StreamType.Raw, inlineVolume: true });
      ressource.volume?.setVolumeLogarithmic(this.volume);
      this.ressource = ressource;
      if (this.connexion && this.connexion.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connexion, VoiceConnectionStatus.Ready, 20_000).catch(() => {
          throw new Error('la connexion vocale n’est jamais devenue prête (vérifie mes permissions Parler)');
        });
      }
      this.lecteur.play(ressource);
      this.joues++;
      this.evenements.surDebut(this, piste);
    } finally {
      this.demarrage = false;
    }
  }

  /** Passe au morceau suivant en respectant la boucle. */
  async suivant(): Promise<void> {
    if (this.detruit || this.demarrage) return;
    const termine = this.actuel;
    if (termine) {
      if (this.boucle === 'track') {
        await this.jouer(termine).catch((echec: Error) => this.echouer(termine, echec));
        return;
      }
      this.historique.push(termine);
      if (this.historique.length > HISTORIQUE_MAX) this.historique.shift();
      if (this.boucle === 'queue') this.file.push(termine);
    }
    this.recharger();
    const aVenir = this.file.shift();
    if (!aVenir) {
      this.actuel = null;
      this.ressource = null;
      this.evenements.surFin(this);
      this.armerInactivite();
      return;
    }
    await this.jouer(aVenir).catch((echec: Error) => this.echouer(aVenir, echec));
  }

  private async echouer(piste: Piste, echec: Error): Promise<void> {
    registre.avertir(`Lecture impossible (${piste.titre}) : ${echec.message}`);
    this.evenements.surErreur(this, piste, echec);
    if (this.boucle === 'track') this.boucle = 'off';
    this.actuel = null;
    await this.suivant();
  }

  passer(): Piste | null {
    const ignores = this.actuel;
    const boucle = this.boucle;
    if (boucle === 'track') this.boucle = 'off';
    this.lecteur.stop(true);
    if (boucle === 'track') setTimeout(() => (this.boucle = boucle), 1_000).unref();
    return ignores;
  }

  /** Rejoue le morceau précédent (le morceau en cours revient en tête de file). */
  precedent(): Piste | null {
    const anterieur = this.historique.pop();
    if (!anterieur) return null;
    if (this.actuel) this.file.unshift(this.actuel);
    this.file.unshift(anterieur);
    this.actuel = null;
    this.lecteur.stop(true);
    if (this.lecteur.state.status === AudioPlayerStatus.Idle && !this.demarrage) void this.suivant();
    return anterieur;
  }

  basculerPause(): boolean {
    if (this.paused) this.lecteur.unpause();
    else this.lecteur.pause();
    return this.paused;
  }

  reglerVolume(pourcentage: number): void {
    this.volume = Math.min(Math.max(pourcentage, 1), 200) / 100;
    this.ressource?.volume?.setVolumeLogarithmic(this.volume);
  }

  melanger(): number {
    const lireTout = [...this.file, ...this.reserve];
    for (let i = lireTout.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [lireTout[i], lireTout[j]] = [lireTout[j]!, lireTout[i]!];
    }
    this.file = lireTout.slice(0, FILE_ACTIVE_MAX);
    this.reserve = lireTout.slice(FILE_ACTIVE_MAX);
    return lireTout.length;
  }

  retirer(position: number): Piste | null {
    const indice = position - 1;
    if (indice < 0) return null;
    if (indice < this.file.length) {
      const [retiree] = this.file.splice(indice, 1);
      this.recharger();
      return retiree ?? null;
    }
    const enReserve = indice - this.file.length;
    return this.reserve.splice(enReserve, 1)[0] ?? null;
  }

  retirerPistesPlaylist(): number {
    const avant = this.waiting;
    this.file = this.file.filter((t) => !t.depuisPlaylist);
    this.reserve = this.reserve.filter((t) => !t.depuisPlaylist);
    this.recharger();
    return avant - this.waiting;
  }

  /** Temps estimé avant qu'une position de la file ne soit jouée (secondes). */
  tempsAvant(indice: number): number {
    let total = this.actuel ? Math.max(0, (this.actuel.duree || 0) - this.elapsed) : 0;
    const lireTout = this.reserve.length ? [...this.file, ...this.reserve] : this.file;
    for (let i = 0; i < indice; i++) total += lireTout[i]?.duree || 0;
    return total;
  }

  estDansLeSalon(membre: GuildMember): boolean {
    return !!this.channelId && membre.voice.channelId === this.channelId;
  }

  auditeursHumains(): number {
    const salon = this.channelId ? this.serveur.channels.cache.get(this.channelId) : null;
    return salon && salon.isVoiceBased() ? salon.members.filter((m) => !m.user.bot).size : 0;
  }

  votesRequis(): number {
    return Math.max(1, Math.ceil(this.auditeursHumains() / 2));
  }

  private armerInactivite(): void {
    this.annulerInactivite();
    this.minuteurInactivite = setTimeout(() => this.detruire(), 5 * 60_000);
    this.minuteurInactivite.unref();
  }

  private annulerInactivite(): void {
    if (this.minuteurInactivite) clearTimeout(this.minuteurInactivite);
    this.minuteurInactivite = null;
  }

  /** Quitte après X minutes seul dans le salon. */
  verifierVide(): void {
    const minutes = lireConfig(this.serveur.id).musique.quitterSiVideMinutes;
    if (!this.channelId || minutes <= 0) return;
    if (this.auditeursHumains() > 0) {
      if (this.minuteurVide) clearTimeout(this.minuteurVide);
      this.minuteurVide = null;
      return;
    }
    if (this.minuteurVide) return;
    this.minuteurVide = setTimeout(() => {
      if (this.auditeursHumains() === 0) this.detruire();
    }, minutes * 60_000);
    this.minuteurVide.unref();
  }

  detruire(): void {
    if (this.detruit) return;
    this.detruit = true;
    this.annulerInactivite();
    if (this.minuteurVide) clearTimeout(this.minuteurVide);
    this.file = [];
    this.reserve = [];
    this.lecteur.stop(true);
    try {
      this.connexion?.destroy();
    } catch {
      /* déjà détruite */
    }
    this.connexion = null;
    this.surDestruction(this.serveur.id);
  }
}

const sessions = new Map<string, LecteurServeur>();

export function lireSession(serveurId: string): LecteurServeur | undefined {
  return sessions.get(serveurId);
}

export function obtenirSession(serveur: Guild, evenements: EvenementsLecteur): LecteurServeur {
  let session = sessions.get(serveur.id);
  if (!session) {
    session = new LecteurServeur(serveur, evenements, (id) => sessions.delete(id));
    sessions.set(serveur.id, session);
  }
  return session;
}

export function toutesSessions(): LecteurServeur[] {
  return [...sessions.values()];
}

export function detruireTout(): void {
  for (const s of sessions.values()) s.detruire();
}

export type { Client };
