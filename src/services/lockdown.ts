import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type GuildChannel,
  type User,
} from 'discord.js';
import { all, get, parseJson, run } from '../database/db';
import { UserError } from '../core/errors';
import { journal, recordLog } from '../core/logService';

export type LockScope = 'channel' | 'category' | 'server';

/** État de l'overwrite @everyone avant verrouillage, pour le restaurer exactement. */
interface OverwriteSnapshot {
  allow: string;
  deny: string;
  existed: boolean;
}

const LOCK_PERMS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Speak,
];

const LOCKABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildStageVoice]);

function snapshot(channel: GuildChannel): OverwriteSnapshot {
  const ow = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  return { allow: String(ow?.allow.bitfield ?? 0n), deny: String(ow?.deny.bitfield ?? 0n), existed: !!ow };
}

async function lockOne(channel: GuildChannel, reason: string): Promise<OverwriteSnapshot | null> {
  if (!LOCKABLE.has(channel.type)) return null;
  const everyone = channel.guild.roles.everyone;
  // Déjà fermé à @everyone : on ne touche à rien.
  if (!channel.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages) && channel.type !== ChannelType.GuildVoice) return null;
  const snap = snapshot(channel);
  await channel.permissionOverwrites.edit(everyone, Object.fromEntries(LOCK_PERMS.map((p) => [new PermissionsBitField(p).toArray()[0]!, false])), { reason });
  return snap;
}

async function restoreOne(channel: GuildChannel, snap: OverwriteSnapshot, reason: string): Promise<void> {
  const everyone = channel.guild.roles.everyone.id;
  // Remet exactement l'état d'avant pour les permissions touchées par le verrouillage.
  const options = snap.existed ? toOptions(BigInt(snap.allow), BigInt(snap.deny)) : toOptions(0n, 0n);
  await channel.permissionOverwrites.edit(everyone, options, { reason });
  if (!snap.existed) {
    const current = channel.permissionOverwrites.cache.get(everyone);
    if (current && current.allow.bitfield === 0n && current.deny.bitfield === 0n) await current.delete(reason);
  }
}

function toOptions(allow: bigint, deny: bigint): Record<string, boolean | null> {
  const opts: Record<string, boolean | null> = {};
  for (const flag of LOCK_PERMS) {
    const name = new PermissionsBitField(flag).toArray()[0]!;
    opts[name] = (allow & flag) === flag ? true : (deny & flag) === flag ? false : null;
  }
  return opts;
}

export interface LockResult {
  id: number;
  locked: number;
  skipped: number;
}

function activeLock(guildId: string, scope: LockScope, targetId: string) {
  return get<{ id: number; snapshot: string }>('SELECT id, snapshot FROM lockdowns WHERE guild_id = ? AND scope = ? AND target_id = ? AND active = 1', guildId, scope, targetId);
}

/** Verrouille un salon, une catégorie ou tout le serveur, en gardant de quoi tout restaurer. */
export async function lock(guild: Guild, scope: LockScope, targetId: string, actor: User, reason: string): Promise<LockResult> {
  if (activeLock(guild.id, scope, targetId)) throw new UserError(scope === 'channel' ? 'Ce salon est déjà verrouillé.' : 'Un verrouillage est déjà en cours sur cette cible.');
  let channels: GuildChannel[];
  if (scope === 'channel') {
    const ch = guild.channels.cache.get(targetId);
    if (!ch || !('permissionOverwrites' in ch)) throw new UserError('Salon introuvable.');
    channels = [ch as GuildChannel];
  } else if (scope === 'category') {
    const cat = guild.channels.cache.get(targetId) as CategoryChannel | undefined;
    if (!cat || cat.type !== ChannelType.GuildCategory) throw new UserError('Catégorie introuvable.');
    channels = [...cat.children.cache.values()];
  } else {
    channels = [...guild.channels.cache.values()].filter((c) => 'permissionOverwrites' in c && c.type !== ChannelType.GuildCategory) as unknown as GuildChannel[];
  }

  const audit = `Verrouillage par ${actor.tag} : ${reason}`.slice(0, 500);
  const snaps: Record<string, OverwriteSnapshot> = {};
  let skipped = 0;
  for (const ch of channels) {
    try {
      const snap = await lockOne(ch, audit);
      if (snap) snaps[ch.id] = snap;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (!Object.keys(snaps).length) throw new UserError('Aucun salon à verrouiller (déjà fermés ou permissions insuffisantes).');
  const r = run(
    'INSERT INTO lockdowns (guild_id, scope, target_id, snapshot, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    guild.id,
    scope,
    targetId,
    JSON.stringify(snaps),
    reason,
    actor.id,
    Date.now(),
  );
  recordLog(guild.id, 'security', 'lock', null, actor.id, { scope, targetId, reason, channels: Object.keys(snaps).length });
  void journal(guild, 'security', {
    title: scope === 'server' ? 'Lockdown du serveur' : scope === 'category' ? 'Catégorie verrouillée' : 'Salon verrouillé',
    tone: 'alerte',
    lines: [scope === 'server' ? '**Cible** : tout le serveur' : `**Cible** : <#${targetId}>`, `**Salons fermés** : ${Object.keys(snaps).length}`, `**Raison** : ${reason}`],
    by: actor,
  });
  return { id: r.lastInsertRowid, locked: Object.keys(snaps).length, skipped };
}

/** Lève un verrouillage et restaure les permissions d'origine. */
export async function unlock(guild: Guild, scope: LockScope, targetId: string, actor: User): Promise<number> {
  const row = activeLock(guild.id, scope, targetId);
  if (!row) throw new UserError(scope === 'channel' ? 'Ce salon n’est pas verrouillé par le bot.' : 'Aucun verrouillage en cours sur cette cible.');
  const snaps = parseJson<Record<string, OverwriteSnapshot>>(row.snapshot, {});
  const audit = `Déverrouillage par ${actor.tag}`;
  let restored = 0;
  for (const [channelId, snap] of Object.entries(snaps)) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch || !('permissionOverwrites' in ch)) continue;
    try {
      await restoreOne(ch as GuildChannel, snap, audit);
      restored++;
    } catch {
      /* salon devenu inaccessible : on continue */
    }
  }
  run('UPDATE lockdowns SET active = 0 WHERE id = ?', row.id);
  recordLog(guild.id, 'security', 'unlock', null, actor.id, { scope, targetId, restored });
  void journal(guild, 'security', {
    title: scope === 'server' ? 'Fin du lockdown' : 'Déverrouillage',
    tone: 'ok',
    lines: [scope === 'server' ? '**Cible** : tout le serveur' : `**Cible** : <#${targetId}>`, `**Salons rouverts** : ${restored}`],
    by: actor,
  });
  return restored;
}

export function activeLocks(guildId: string): { scope: LockScope; target_id: string; created_at: number; reason: string | null }[] {
  return all('SELECT scope, target_id, created_at, reason FROM lockdowns WHERE guild_id = ? AND active = 1 ORDER BY created_at DESC', guildId);
}

export function isServerLocked(guildId: string): boolean {
  return !!activeLock(guildId, 'server', guildId);
}
