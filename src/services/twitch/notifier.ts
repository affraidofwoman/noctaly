import { EmbedBuilder, type Client, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { all, get, run } from '../../database/db';
import { brandFor, parseColor } from '../../core/brand';
import { getConfig } from '../../core/guildConfig';
import { journal, recordLog, resolveTextChannel } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import { formatNumber, truncate } from '../../core/text';
import { formatDuration, ts } from '../../core/time';
import { isHttpUrl, linkButton, row } from '../../core/ui';
import { renderTemplate } from '../../core/variables';
import { getClips, getLatestVod, getStreams, getUsers, streamThumbnail, type TwitchStream } from './api';

const log = createLogger('twitch');

export interface TwitchChannelRow {
  id: number;
  guild_id: string;
  login: string;
  broadcaster_id: string | null;
  display_name: string | null;
  profile_image: string | null;
  channel_id: string;
  role_id: string | null;
  message: string | null;
  color: string | null;
  show_image: number;
  notify_end: number;
  notify_changes: number;
  notify_clips: number;
  notify_events: number;
  live_stream_id: string | null;
  live_message_id: string | null;
  live_started_at: number | null;
  live_last_seen: number | null;
  last_title: string | null;
  last_game: string | null;
  last_viewers: number | null;
  peak_viewers: number | null;
  last_clip_at: number | null;
  created_at: number;
}

/** Un live absent moins longtemps que cela est considéré comme une micro-coupure (pas de fin, pas de doublon). */
export const OFFLINE_GRACE_MS = 5 * 60_000;

export function listChannels(guildId?: string): TwitchChannelRow[] {
  return guildId
    ? all<TwitchChannelRow>('SELECT * FROM twitch_channels WHERE guild_id = ? ORDER BY login', guildId)
    : all<TwitchChannelRow>('SELECT * FROM twitch_channels');
}

export function getChannel(guildId: string, login: string): TwitchChannelRow | undefined {
  return get<TwitchChannelRow>('SELECT * FROM twitch_channels WHERE guild_id = ? AND login = ?', guildId, login.toLowerCase());
}

export function getChannelById(id: number): TwitchChannelRow | undefined {
  return get<TwitchChannelRow>('SELECT * FROM twitch_channels WHERE id = ?', id);
}

export async function addChannel(guildId: string, login: string, channelId: string, roleId: string | null): Promise<TwitchChannelRow> {
  const [user] = await getUsers([login]);
  if (!user) throw new Error('introuvable');
  run(
    `INSERT INTO twitch_channels (guild_id, login, broadcaster_id, display_name, profile_image, channel_id, role_id, created_at, last_clip_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, login) DO UPDATE SET channel_id = excluded.channel_id, role_id = excluded.role_id, broadcaster_id = excluded.broadcaster_id,
       display_name = excluded.display_name, profile_image = excluded.profile_image`,
    guildId,
    user.login,
    user.id,
    user.display_name,
    user.profile_image_url,
    channelId,
    roleId,
    Date.now(),
    Date.now(),
  );
  return getChannel(guildId, user.login)!;
}

export function removeChannel(guildId: string, login: string): boolean {
  return run('DELETE FROM twitch_channels WHERE guild_id = ? AND login = ?', guildId, login.toLowerCase()).changes > 0;
}

export function updateChannel(id: number, patch: Partial<Pick<TwitchChannelRow, 'channel_id' | 'role_id' | 'message' | 'color' | 'show_image' | 'notify_end' | 'notify_changes' | 'notify_clips' | 'notify_events'>>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  run(`UPDATE twitch_channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k] ?? null), id);
}

function colorOf(guild: Guild, ch: TwitchChannelRow): number {
  return parseColor(ch.color) ?? parseColor(getConfig(guild.id).twitch.color) ?? brandFor(guild.id).color;
}

function streamVars(guild: Guild, ch: TwitchChannelRow, stream: Pick<TwitchStream, 'user_name' | 'game_name' | 'title' | 'viewer_count'> | null) {
  return {
    guild,
    role: ch.role_id ? guild.roles.cache.get(ch.role_id) ?? null : null,
    extra: {
      streamer: stream?.user_name ?? ch.display_name ?? ch.login,
      game: stream?.game_name || 'Sans catégorie',
      title: stream?.title ?? ch.last_title ?? '',
      viewers: stream ? formatNumber(stream.viewer_count) : '0',
      url: `https://twitch.tv/${ch.login}`,
      brand: brandFor(guild.id).key ? brandFor(guild.id).name : guild.name,
    },
  };
}

/** Message de live : « 🔴 {streamer} est en LIVE ! » + jeu, titre, viewers et bouton « REGARDER LE LIVE ». */
export function buildLiveMessage(guild: Guild, ch: TwitchChannelRow, stream: TwitchStream) {
  const cfg = getConfig(guild.id).twitch;
  const vars = streamVars(guild, ch, stream);
  const content = renderTemplate(ch.message || cfg.liveMessage, vars);
  const url = `https://twitch.tv/${ch.login}`;
  const embed = new EmbedBuilder()
    .setColor(colorOf(guild, ch))
    .setAuthor({ name: `${stream.user_name} est en LIVE !`, iconURL: ch.profile_image ?? undefined, url })
    .setTitle(truncate(stream.title || 'Live en cours', 256))
    .setURL(url)
    .addFields(
      { name: '🎮 Jeu', value: stream.game_name || 'Sans catégorie', inline: true },
      { name: '👥 Viewers', value: formatNumber(stream.viewer_count), inline: true },
      { name: '⏱️ Depuis', value: ts(Date.parse(stream.started_at), 'R'), inline: true },
    )
    .setFooter({ text: 'Twitch', iconURL: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png' })
    .setTimestamp(Date.parse(stream.started_at));
  if (ch.profile_image && isHttpUrl(ch.profile_image)) embed.setThumbnail(ch.profile_image);
  if (ch.show_image && isHttpUrl(stream.thumbnail_url)) embed.setImage(streamThumbnail(stream));
  return {
    content: truncate(content, 2000),
    embeds: [embed],
    components: [row(linkButton(url, 'REGARDER LE LIVE', '🔴'))],
    allowedMentions: { roles: ch.role_id ? [ch.role_id] : [], parse: [] as ('everyone' | 'roles' | 'users')[] },
  };
}

function buildEndedEmbed(guild: Guild, ch: TwitchChannelRow, vodUrl: string | null) {
  const duration = ch.live_started_at ? Date.now() - ch.live_started_at : 0;
  const embed = new EmbedBuilder()
    .setColor(0x4e5058)
    .setAuthor({ name: `${ch.display_name ?? ch.login} était en live`, iconURL: ch.profile_image ?? undefined, url: `https://twitch.tv/${ch.login}` })
    .setTitle(truncate(ch.last_title || 'Live terminé', 256))
    .setURL(`https://twitch.tv/${ch.login}`)
    .setDescription('⚫ Le live est terminé.')
    .addFields(
      { name: '🎮 Dernier jeu', value: ch.last_game || '—', inline: true },
      { name: '⏱️ Durée', value: duration ? formatDuration(duration) : '—', inline: true },
      { name: '📈 Pic de viewers', value: formatNumber(ch.peak_viewers ?? 0), inline: true },
    )
    .setTimestamp();
  if (ch.profile_image) embed.setThumbnail(ch.profile_image);
  const buttons = vodUrl ? [row(linkButton(vodUrl, 'Revoir le live', '📼'))] : [row(linkButton(`https://twitch.tv/${ch.login}`, 'La chaîne', '💜'))];
  return { embeds: [embed], components: buttons };
}

function targetChannel(guild: Guild, ch: TwitchChannelRow): GuildTextBasedChannel | null {
  return resolveTextChannel(guild, ch.channel_id);
}

async function onLive(client: Client, ch: TwitchChannelRow, stream: TwitchStream): Promise<void> {
  const guild = client.guilds.cache.get(ch.guild_id);
  if (!guild) return;
  const channel = targetChannel(guild, ch);
  const startedAt = Date.parse(stream.started_at);
  let messageId: string | null = null;
  if (channel) {
    // Une annonce impossible à construire ou à envoyer ne doit jamais bloquer l'enregistrement du live (sinon doublons).
    const sent = await (async () => channel.send(buildLiveMessage(guild, ch, stream)))().catch((err: Error) => {
      log.warn(`Notification de live non envoyée (${ch.login} → ${guild.id}) : ${err.message}`);
      return null;
    });
    messageId = sent?.id ?? null;
    // Publication automatique dans les salons d'annonces pour les serveurs abonnés.
    if (sent && sent.crosspostable) await sent.crosspost().catch(() => undefined);
  }
  run(
    `UPDATE twitch_channels SET live_stream_id = ?, live_message_id = ?, live_started_at = ?, live_last_seen = ?, last_title = ?, last_game = ?, last_viewers = ?, peak_viewers = ? WHERE id = ?`,
    stream.id,
    messageId,
    startedAt,
    Date.now(),
    stream.title,
    stream.game_name,
    stream.viewer_count,
    stream.viewer_count,
    ch.id,
  );
  recordLog(guild.id, 'twitch', 'live', null, null, { login: ch.login, title: stream.title, game: stream.game_name });
  void journal(guild, 'twitch', {
    title: 'Live lancé',
    tone: 'ok',
    lines: [`**Chaîne** : [${stream.user_name}](https://twitch.tv/${ch.login})`, `**Jeu** : ${stream.game_name || '—'}`, `**Titre** : ${truncate(stream.title, 300)}`, channel ? `**Annonce** : <#${channel.id}>` : '⚠️ Salon d’annonce inutilisable'],
  });
}

async function onUpdate(client: Client, ch: TwitchChannelRow, stream: TwitchStream): Promise<void> {
  const guild = client.guilds.cache.get(ch.guild_id);
  if (!guild) return;
  const changes: string[] = [];
  if (ch.last_game !== null && stream.game_name !== ch.last_game) changes.push(`🎮 **Jeu** : ${ch.last_game || '—'} → **${stream.game_name || '—'}**`);
  if (ch.last_title !== null && stream.title !== ch.last_title) changes.push(`📺 **Titre** : ${truncate(stream.title, 250)}`);
  run(
    'UPDATE twitch_channels SET live_last_seen = ?, last_title = ?, last_game = ?, last_viewers = ?, peak_viewers = MAX(COALESCE(peak_viewers, 0), ?) WHERE id = ?',
    Date.now(),
    stream.title,
    stream.game_name,
    stream.viewer_count,
    stream.viewer_count,
    ch.id,
  );
  const channel = targetChannel(guild, ch);
  if (channel && ch.live_message_id) {
    const message = await channel.messages.fetch(ch.live_message_id).catch(() => null);
    if (message) await message.edit(buildLiveMessage(guild, { ...ch, last_title: stream.title }, stream)).catch(() => undefined);
  }
  if (!changes.length) return;
  void journal(guild, 'twitch', { title: 'Live modifié', tone: 'info', lines: [`**Chaîne** : ${stream.user_name}`, ...changes] });
  if (ch.notify_changes && channel) {
    const embed = new EmbedBuilder()
      .setColor(colorOf(guild, ch))
      .setAuthor({ name: stream.user_name, iconURL: ch.profile_image ?? undefined, url: `https://twitch.tv/${ch.login}` })
      .setDescription(changes.join('\n'));
    await channel.send({ embeds: [embed], components: [row(linkButton(`https://twitch.tv/${ch.login}`, 'Rejoindre le live', '🔴'))] }).catch(() => undefined);
  }
}

async function onOffline(client: Client, ch: TwitchChannelRow): Promise<void> {
  const guild = client.guilds.cache.get(ch.guild_id);
  run('UPDATE twitch_channels SET live_stream_id = NULL, live_message_id = NULL, live_last_seen = NULL WHERE id = ?', ch.id);
  if (!guild) return;
  const vod = ch.broadcaster_id ? await getLatestVod(ch.broadcaster_id).catch(() => null) : null;
  const channel = targetChannel(guild, ch);
  if (channel && ch.live_message_id) {
    const message = await channel.messages.fetch(ch.live_message_id).catch(() => null);
    if (message) await message.edit({ content: message.content, ...buildEndedEmbed(guild, ch, vod?.url ?? null), allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  if (ch.notify_end && channel) {
    const text = renderTemplate(getConfig(guild.id).twitch.endMessage, streamVars(guild, ch, null));
    if (text.trim()) await channel.send({ content: truncate(text, 2000), allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  recordLog(guild.id, 'twitch', 'offline', null, null, { login: ch.login, peak: ch.peak_viewers });
  void journal(guild, 'twitch', {
    title: 'Live terminé',
    tone: 'neutre',
    lines: [`**Chaîne** : ${ch.display_name ?? ch.login}`, ch.live_started_at ? `**Durée** : ${formatDuration(Date.now() - ch.live_started_at)}` : null, `**Pic de viewers** : ${ch.peak_viewers ?? 0}`],
  });
}

/** Un tour de sondage : une seule requête par lot de 100 chaînes, pour tous les serveurs. */
export async function pollStreams(client: Client): Promise<void> {
  const channels = listChannels().filter((c) => client.guilds.cache.has(c.guild_id) && isModuleEnabled(c.guild_id, 'twitch'));
  if (!channels.length) return;
  const streams = await getStreams(channels.map((c) => c.login));
  const byLogin = new Map(streams.map((s) => [s.user_login.toLowerCase(), s]));
  const now = Date.now();
  for (const ch of channels) {
    try {
      const stream = byLogin.get(ch.login);
      if (stream) {
        if (ch.live_stream_id === stream.id) await onUpdate(client, ch, stream);
        // Reprise après une coupure courte : même live, on ne renotifie pas.
        else if (ch.live_stream_id && ch.live_last_seen && now - ch.live_last_seen < OFFLINE_GRACE_MS && Date.parse(stream.started_at) - (ch.live_started_at ?? 0) < OFFLINE_GRACE_MS * 2) {
          run('UPDATE twitch_channels SET live_stream_id = ? WHERE id = ?', stream.id, ch.id);
          await onUpdate(client, { ...ch, live_stream_id: stream.id }, stream);
        } else await onLive(client, ch, stream);
      } else if (ch.live_stream_id && (!ch.live_last_seen || now - ch.live_last_seen >= OFFLINE_GRACE_MS)) {
        await onOffline(client, ch);
      }
    } catch (err) {
      log.warn(`Traitement Twitch ${ch.login} (${ch.guild_id}) en échec : ${(err as Error).message}`);
    }
  }
}

/** Nouveaux clips depuis le dernier passage. */
export async function pollClips(client: Client): Promise<void> {
  const channels = listChannels().filter((c) => c.notify_clips && c.broadcaster_id && client.guilds.cache.has(c.guild_id) && isModuleEnabled(c.guild_id, 'twitch'));
  for (const ch of channels) {
    const since = ch.last_clip_at ?? Date.now() - 3_600_000;
    const clips = (await getClips(ch.broadcaster_id!, since).catch(() => [])).filter((c) => Date.parse(c.created_at) > since).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!clips.length) continue;
    const guild = client.guilds.cache.get(ch.guild_id)!;
    const channel = targetChannel(guild, ch);
    for (const clip of clips.slice(-5)) {
      if (!channel) break;
      const embed = new EmbedBuilder()
        .setColor(colorOf(guild, ch))
        .setAuthor({ name: `Nouveau clip — ${ch.display_name ?? ch.login}`, iconURL: ch.profile_image ?? undefined })
        .setTitle(truncate(clip.title, 256))
        .setURL(clip.url)
        .setImage(clip.thumbnail_url)
        .setFooter({ text: `Clippé par ${clip.creator_name} · ${Math.round(clip.duration)} s` });
      await channel.send({ embeds: [embed], components: [row(linkButton(clip.url, 'Voir le clip', '🎬'))] }).catch(() => undefined);
    }
    run('UPDATE twitch_channels SET last_clip_at = ? WHERE id = ?', Math.max(...clips.map((c) => Date.parse(c.created_at))), ch.id);
  }
}

/** Événements EventSub (raid, follow, abonnement) envoyés aux serveurs qui suivent la chaîne. */
export async function dispatchTwitchEvent(client: Client, broadcasterId: string, title: string, description: string, url: string): Promise<void> {
  const channels = listChannels().filter((c) => c.broadcaster_id === broadcasterId && c.notify_events && isModuleEnabled(c.guild_id, 'twitch'));
  for (const ch of channels) {
    const guild = client.guilds.cache.get(ch.guild_id);
    if (!guild) continue;
    const channel = targetChannel(guild, ch);
    const embed = new EmbedBuilder().setColor(colorOf(guild, ch)).setAuthor({ name: title, iconURL: ch.profile_image ?? undefined, url }).setDescription(description).setTimestamp();
    if (channel) await channel.send({ embeds: [embed], components: [row(linkButton(url, 'La chaîne', '💜'))] }).catch(() => undefined);
    void journal(guild, 'twitch', { title, tone: 'info', lines: [description] });
  }
}


