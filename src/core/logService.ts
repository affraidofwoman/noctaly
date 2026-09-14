import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type AttachmentBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type OverwriteResolvable,
  type PermissionResolvable,
  type User,
} from 'discord.js';
import { run } from '../database/db';
import { getConfig, updateConfig } from './guildConfig';
import { createLogger } from './logger';
import { isModuleEnabled } from './moduleManager';
import { truncate } from './text';
import { listMembers, type WhitelistId } from './whitelists';

const log = createLogger('journal');

export type LogType =
  | 'sanction'
  | 'blacklist'
  | 'clear'
  | 'automod'
  | 'role'
  | 'whitelist'
  | 'autorole'
  | 'member'
  | 'message'
  | 'channel'
  | 'voice'
  | 'command'
  | 'security'
  | 'backup'
  | 'health'
  | 'ticket'
  | 'giveaway'
  | 'twitch'
  | 'invite'
  | 'boost'
  | 'community';

export interface LogChannelDefinition {
  type: LogType;
  name: string;
  description: string;
}

export interface LogCategoryDefinition {
  category: string;
  /** Permission Discord qui donne la vue sur la catégorie. */
  viewPermission: PermissionResolvable;
  /** Whitelists qui donnent la vue sur la catégorie. */
  viewWhitelists: WhitelistId[];
  channels: LogChannelDefinition[];
}

/** Structure des salons de logs, à la manière du bot Airline : un salon nommé par type. */
export const LOG_STRUCTURE: LogCategoryDefinition[] = [
  {
    category: 'Logs · Sanctions',
    viewPermission: PermissionFlagsBits.BanMembers,
    viewWhitelists: ['sys', 'logs'],
    channels: [
      { type: 'sanction', name: 'sanction-log', description: 'Warns, timeouts, kicks, bans et unbans' },
      { type: 'blacklist', name: 'bl-log', description: 'Blacklist : &bl et &unbl' },
      { type: 'clear', name: 'clear-log', description: 'Suppressions de messages (&clear)' },
      { type: 'automod', name: 'automod-log', description: 'Filtres : spam, liens, invitations, mots interdits' },
    ],
  },
  {
    category: 'Logs · Rôles & Accès',
    viewPermission: PermissionFlagsBits.ManageRoles,
    viewWhitelists: ['admin', 'logs'],
    channels: [
      { type: 'role', name: 'role-log', description: 'Rôles créés, modifiés, supprimés, donnés ou retirés' },
      { type: 'whitelist', name: 'wl-log', description: 'Whitelists accordées ou retirées (/wl)' },
      { type: 'autorole', name: 'autorole-log', description: 'Rôles automatiques, rôles à réaction et niveaux' },
    ],
  },
  {
    category: 'Logs · Serveur',
    viewPermission: PermissionFlagsBits.ManageGuild,
    viewWhitelists: ['admin', 'logs'],
    channels: [
      { type: 'member', name: 'membre-log', description: 'Arrivées et départs de membres' },
      { type: 'message', name: 'message-log', description: 'Messages modifiés ou supprimés' },
      { type: 'channel', name: 'salon-log', description: 'Salons créés, supprimés ou modifiés' },
      { type: 'voice', name: 'vocal-log', description: 'Connexions, déconnexions et déplacements' },
      { type: 'command', name: 'commande-log', description: 'Commandes utilisées' },
      { type: 'security', name: 'securite-log', description: 'Anti-raid, anti-nuke et lockdown' },
      { type: 'backup', name: 'backup-log', description: 'Sauvegardes de la configuration' },
      { type: 'health', name: 'sante-log', description: 'État du bot et alertes techniques' },
    ],
  },
  {
    category: 'Logs · Communauté',
    viewPermission: PermissionFlagsBits.ManageMessages,
    viewWhitelists: ['staff', 'logs'],
    channels: [
      { type: 'ticket', name: 'ticket-logs', description: 'Ouverture, fermeture et transcripts des tickets' },
      { type: 'giveaway', name: 'giveaway-log', description: 'Giveaways lancés, terminés et relancés' },
      { type: 'twitch', name: 'twitch-log', description: 'Lives, changements de jeu et de titre' },
      { type: 'invite', name: 'invite-log', description: 'Invitations utilisées' },
      { type: 'boost', name: 'boost-log', description: 'Boosts du serveur' },
      { type: 'community', name: 'communaute-log', description: 'Suggestions, signalements, formulaires, événements' },
    ],
  },
];

export const LOG_TYPES: LogChannelDefinition[] = LOG_STRUCTURE.flatMap((c) => c.channels);

export function logDefinition(type: LogType): LogChannelDefinition {
  return LOG_TYPES.find((t) => t.type === type)!;
}

export function categoryOf(type: LogType): LogCategoryDefinition {
  return LOG_STRUCTURE.find((c) => c.channels.some((ch) => ch.type === type))!;
}

export const TONES = {
  neutre: 0x7b5cff,
  ok: 0x3fe08f,
  alerte: 0xe0455a,
  info: 0x46c8ff,
  or: 0xf0b232,
} as const;

export type Tone = keyof typeof TONES;

function usableTextChannel(guild: Guild, channelId: string | null | undefined): GuildTextBasedChannel | null {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) return null;
  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  }
  return channel as GuildTextBasedChannel;
}

export function resolveTextChannel(guild: Guild, channelId: string | null | undefined): GuildTextBasedChannel | null {
  return usableTextChannel(guild, channelId);
}

/** Salon d'un type de log : celui choisi dans la configuration, sinon celui qui porte le nom attendu. */
export function logChannelFor(guild: Guild, type: LogType): GuildTextBasedChannel | null {
  const cfg = getConfig(guild.id).logs;
  if (cfg.disabled.includes(type)) return null;
  const configured = usableTextChannel(guild, cfg.channels[type] ?? cfg.fallbackChannelId);
  if (configured) return configured;
  const name = logDefinition(type).name;
  const byName = guild.channels.cache.find((c) => c.name === name && c.type === ChannelType.GuildText);
  return byName ? usableTextChannel(guild, byName.id) : null;
}

export interface JournalOptions {
  title: string;
  lines?: (string | null | undefined | false)[];
  tone?: Tone;
  by?: User | null;
  fields?: { name: string; value: string; inline?: boolean }[];
  files?: AttachmentBuilder[];
  thumbnail?: string | null;
}

export function buildJournalEmbed(options: JournalOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(TONES[options.tone ?? 'neutre'])
    .setAuthor({ name: truncate(options.title, 256) })
    .setTimestamp();
  const description = (options.lines ?? []).filter(Boolean).join('\n');
  if (description) embed.setDescription(truncate(description, 4096));
  for (const f of (options.fields ?? []).slice(0, 25)) {
    embed.addFields({ name: truncate(f.name, 256), value: truncate(f.value || '—', 1024), inline: f.inline ?? true });
  }
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.by) embed.setFooter({ text: truncate(`par ${options.by.tag}`, 2048), iconURL: options.by.displayAvatarURL({ size: 64 }) });
  return embed;
}

/** Écrit dans le salon de logs du type (si le module Logs est actif). */
export async function journal(guild: Guild, type: LogType, options: JournalOptions): Promise<boolean> {
  if (!isModuleEnabled(guild.id, 'logs')) return false;
  const channel = logChannelFor(guild, type);
  if (!channel) return false;
  try {
    await channel.send({ embeds: [buildJournalEmbed(options)], files: options.files ?? [], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    log.warn(`Envoi du log ${type} impossible sur ${guild.id} : ${(err as Error).message}`);
    return false;
  }
}

/** Historise un événement en base (utilisé par /logs et le dashboard). */
export function recordLog(
  guildId: string,
  type: LogType,
  action: string,
  userId: string | null,
  actorId: string | null,
  data: Record<string, unknown> = {},
): void {
  try {
    run(
      'INSERT INTO logs (guild_id, category, type, user_id, actor_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      guildId,
      type,
      action,
      userId,
      actorId,
      JSON.stringify(data),
      Date.now(),
    );
  } catch (err) {
    log.warn('Historisation impossible', err);
  }
}

/** Permissions d'une catégorie de logs : cachée, visible par la permission et les whitelists. */
export function logOverwrites(guild: Guild, def: LogCategoryDefinition): OverwriteResolvable[] {
  const overwrites: OverwriteResolvable[] = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
  const me = guild.members.me;
  if (me) {
    overwrites.push({
      id: me.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles],
    });
  }
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed) continue;
    if (role.permissions.has(def.viewPermission)) overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] });
  }
  const users = new Set<string>();
  for (const list of def.viewWhitelists) for (const id of listMembers(list, guild.id)) users.add(id);
  for (const id of listMembers('streamer', guild.id)) users.add(id);
  for (const id of users) {
    if (guild.members.cache.has(id)) overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
  }
  return overwrites.slice(0, 100);
}

/** Réapplique les accès des salons de logs existants (après un changement de whitelist). */
export async function syncLogPermissions(guild: Guild): Promise<number> {
  let updated = 0;
  for (const def of LOG_STRUCTURE) {
    const overwrites = logOverwrites(guild, def);
    const category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === def.category);
    const targets = [
      category,
      ...def.channels.map((ch) => logChannelFor(guild, ch.type)).filter((c) => c && 'parentId' in c && c.parentId === category?.id),
    ];
    for (const target of targets) {
      if (!target || !('permissionOverwrites' in target)) continue;
      try {
        await target.permissionOverwrites.set(overwrites, 'Mise à jour des accès aux logs');
        updated++;
      } catch (err) {
        log.warn(`Accès du salon ${target.id} non mis à jour : ${(err as Error).message}`);
      }
    }
  }
  return updated;
}

/**
 * Crée (sans jamais écraser) les catégories et salons de logs manquants, puis les enregistre dans la configuration.
 * Retourne le nombre de salons créés.
 */
export async function ensureLogChannels(guild: Guild): Promise<{ created: number; linked: number }> {
  let created = 0;
  let linked = 0;
  const channels: Partial<Record<LogType, string>> = {};
  for (const def of LOG_STRUCTURE) {
    let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === def.category);
    if (!category) {
      category = await guild.channels.create({
        name: def.category,
        type: ChannelType.GuildCategory,
        permissionOverwrites: logOverwrites(guild, def),
        reason: 'Création des salons de logs',
      });
      created++;
    }
    for (const ch of def.channels) {
      const existing = guild.channels.cache.find((c) => c.name === ch.name && c.type === ChannelType.GuildText);
      if (existing) {
        channels[ch.type] = existing.id;
        linked++;
        continue;
      }
      const channel = await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: ch.description,
        permissionOverwrites: logOverwrites(guild, def),
        reason: 'Création des salons de logs',
      });
      channels[ch.type] = channel.id;
      created++;
    }
  }
  updateConfig(guild.id, (c) => {
    c.logs.channels = { ...c.logs.channels, ...channels };
  });
  return { created, linked };
}
