import { EmbedBuilder, type Guild, type GuildMember, type User } from 'discord.js';
import { all, get, run } from '../database/db';
import { brandName, colorFor } from '../core/embeds';
import { UserError } from '../core/errors';
import { getConfig } from '../core/guildConfig';
import { journal, recordLog } from '../core/logService';
import { createLogger } from '../core/logger';
import { checkModeratable } from '../core/permissions';
import { truncate } from '../core/text';
import { formatDuration, ts } from '../core/time';

const log = createLogger('sanctions');

export type SanctionType = 'warn' | 'unwarn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'blacklist' | 'unblacklist';

export const MAX_TIMEOUT_MS = 28 * 86_400_000;

const LABELS: Record<SanctionType, { title: string; verb: string; pose: boolean; emoji: string }> = {
  warn: { title: 'Avertissement', verb: 'averti', pose: true, emoji: '⚠️' },
  unwarn: { title: 'Avertissement retiré', verb: 'retiré un avertissement à', pose: false, emoji: '🧽' },
  timeout: { title: 'Timeout', verb: 'mis en timeout', pose: true, emoji: '⏳' },
  untimeout: { title: 'Timeout levé', verb: 'sorti du timeout', pose: false, emoji: '🔊' },
  kick: { title: 'Expulsion', verb: 'expulsé', pose: true, emoji: '👢' },
  ban: { title: 'Bannissement', verb: 'banni', pose: true, emoji: '🔨' },
  unban: { title: 'Débannissement', verb: 'débanni', pose: false, emoji: '🕊️' },
  blacklist: { title: 'Blacklist', verb: 'blacklisté', pose: true, emoji: '⛔' },
  unblacklist: { title: 'Blacklist levée', verb: 'retiré de la blacklist', pose: false, emoji: '✅' },
};

const DM_TEXT: Partial<Record<SanctionType, (where: string) => string>> = {
  warn: (w) => `Tu as reçu un **avertissement** sur ${w}`,
  timeout: (w) => `Tu as été **mis en timeout** sur ${w}`,
  kick: (w) => `Tu as été **expulsé** de ${w}`,
  ban: (w) => `Tu as été **banni** de ${w}`,
  unban: (w) => `Ton bannissement de ${w} a été **levé**. Tu peux revenir.`,
  blacklist: (w) => `Tu as été **blacklist** de ${w} définitivement`,
  unblacklist: (w) => `Tu as été **retiré de la blacklist** de ${w}. Tu peux revenir.`,
};

export interface SanctionInput {
  guild: Guild;
  actor: GuildMember;
  target: User;
  type: SanctionType;
  reason?: string | null;
  durationMs?: number;
  /** Pour unwarn : numéro de l'avertissement (sinon le plus récent). */
  warningId?: number;
  /** Ne pas déclencher les actions automatiques (utilisé par elles-mêmes). */
  auto?: boolean;
}

export interface SanctionResult {
  type: SanctionType;
  target: User;
  reason: string;
  dmSent: boolean;
  warnings?: number;
  warningId?: number;
  followUp?: SanctionResult | null;
  until?: number;
}

/** Message privé façon Airline : « Sanction appliquée » / « Sanction levée ». */
async function notify(guild: Guild, user: User, type: SanctionType, reason: string, durationMs?: number): Promise<boolean> {
  const cfg = getConfig(guild.id).moderation;
  const text = DM_TEXT[type];
  if (!cfg.dmOnAction || !text || user.bot) return false;
  const pose = LABELS[type].pose;
  const lines = [text(`**${guild.name}**`)];
  if (pose) {
    lines[0] += reason ? ` pour la raison suivante : \`${truncate(reason, 400)}\`` : '.';
    if (durationMs) lines.push(`Durée : **${formatDuration(durationMs)}**`);
    if (cfg.contactText) lines.push('', cfg.contactText);
  }
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, pose ? 'error' : 'success'))
    .setAuthor({ name: pose ? 'Sanction appliquée' : 'Sanction levée' })
    .setDescription(lines.join('\n'))
    .setFooter({ text: brandName(guild) })
    .setTimestamp();
  try {
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

export function activeWarnings(guildId: string, userId: string): { id: number; moderator_id: string; reason: string; created_at: number }[] {
  return all('SELECT id, moderator_id, reason, created_at FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY created_at ASC', guildId, userId);
}

export function countWarnings(guildId: string, userId: string): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1', guildId, userId)?.n ?? 0;
}

export function isBlacklisted(guildId: string, userId: string): { scope: string; reason: string; added_by: string; added_at: number } | undefined {
  return get('SELECT scope, reason, added_by, added_at FROM blacklist WHERE user_id = ? AND scope IN (?, ?) ORDER BY scope = ? DESC LIMIT 1', userId, guildId, 'global', 'global');
}

export function blacklistEntries(scope: string): { user_id: string; reason: string; added_by: string; added_at: number }[] {
  return all('SELECT user_id, reason, added_by, added_at FROM blacklist WHERE scope = ? ORDER BY added_at DESC', scope);
}

async function fetchMember(guild: Guild, id: string): Promise<GuildMember | null> {
  return guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
}

/**
 * Applique une sanction complète : vérifications, action Discord, base de données,
 * message privé, journal sanction-log et actions automatiques des warns.
 */
export async function applySanction(input: SanctionInput): Promise<SanctionResult> {
  const { guild, actor, target, type } = input;
  const reason = (input.reason ?? '').trim() || 'Aucune raison';
  const auditReason = truncate(`${reason} — par ${actor.user.tag}`, 500);
  const member = await fetchMember(guild, target.id);
  const needsMember = ['warn', 'timeout', 'untimeout', 'kick'].includes(type);
  if (needsMember && !member) throw new UserError('Ce membre n’est pas sur le serveur.');
  if (member && ['warn', 'timeout', 'kick', 'ban', 'blacklist'].includes(type) && !input.auto) {
    const check = checkModeratable(actor, member);
    if (!check.ok) throw new UserError(check.reason);
  }

  const result: SanctionResult = { type, target, reason, dmSent: false };

  // Le message privé part avant l'expulsion : après, le bot ne partage plus de serveur avec la personne.
  if (type === 'kick' || type === 'ban' || type === 'blacklist') {
    result.dmSent = await notify(guild, target, type, reason, input.durationMs);
  }

  switch (type) {
    case 'warn': {
      const r = run('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', guild.id, target.id, actor.id, reason, Date.now());
      result.warningId = r.lastInsertRowid;
      result.warnings = countWarnings(guild.id, target.id);
      break;
    }
    case 'unwarn': {
      const warning = input.warningId
        ? get<{ id: number }>('SELECT id FROM warnings WHERE id = ? AND guild_id = ? AND user_id = ? AND active = 1', input.warningId, guild.id, target.id)
        : get<{ id: number }>('SELECT id FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', guild.id, target.id);
      if (!warning) throw new UserError('Aucun avertissement actif correspondant.');
      run('UPDATE warnings SET active = 0 WHERE id = ?', warning.id);
      result.warningId = warning.id;
      result.warnings = countWarnings(guild.id, target.id);
      break;
    }
    case 'timeout': {
      const duration = Math.min(Math.max(input.durationMs ?? getConfig(guild.id).moderation.defaultTimeoutMinutes * 60_000, 5_000), MAX_TIMEOUT_MS);
      if (!member!.moderatable) throw new UserError('Je ne peux pas mettre ce membre en timeout (rôle trop haut ou administrateur).');
      await member!.timeout(duration, auditReason);
      result.until = Date.now() + duration;
      input.durationMs = duration;
      break;
    }
    case 'untimeout':
      if (!member!.isCommunicationDisabled()) throw new UserError('Ce membre n’est pas en timeout.');
      await member!.timeout(null, auditReason);
      break;
    case 'kick':
      if (!member!.kickable) throw new UserError('Je ne peux pas expulser ce membre.');
      await member!.kick(auditReason);
      break;
    case 'ban':
    case 'blacklist': {
      if (member && !member.bannable) throw new UserError('Je ne peux pas bannir ce membre.');
      if (type === 'blacklist') {
        run(
          `INSERT INTO blacklist (scope, user_id, reason, added_by, added_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope, user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_at = excluded.added_at`,
          guild.id,
          target.id,
          reason,
          actor.id,
          Date.now(),
        );
      }
      const hours = getConfig(guild.id).moderation.banDeleteHours;
      await guild.members.ban(target.id, { reason: auditReason, deleteMessageSeconds: Math.min(hours, 168) * 3600 }).catch((err: { code?: number }) => {
        // Déjà banni : la blacklist reste valable.
        if (err.code !== 10026 || type !== 'blacklist') throw err;
      });
      break;
    }
    case 'unban':
      await guild.bans.remove(target.id, auditReason).catch((err: { code?: number }) => {
        if (err.code === 10026) throw new UserError('Ce compte n’est pas banni.');
        throw err;
      });
      break;
    case 'unblacklist': {
      const r = run('DELETE FROM blacklist WHERE scope = ? AND user_id = ?', guild.id, target.id);
      if (!r.changes) throw new UserError('Ce compte n’est pas dans la blacklist du serveur.');
      await guild.bans.remove(target.id, auditReason).catch(() => undefined);
      break;
    }
  }

  if (type !== 'kick' && type !== 'ban' && type !== 'blacklist') {
    result.dmSent = await notify(guild, target, type, reason, input.durationMs);
  }

  const label = LABELS[type];
  recordLog(guild.id, type === 'blacklist' || type === 'unblacklist' ? 'blacklist' : 'sanction', type, target.id, actor.id, {
    reason,
    durationMs: input.durationMs ?? null,
    warningId: result.warningId ?? null,
  });
  void journal(guild, type === 'blacklist' || type === 'unblacklist' ? 'blacklist' : 'sanction', {
    title: label.pose ? `${label.title}${input.auto ? ' (automatique)' : ''}` : label.title,
    tone: label.pose ? 'alerte' : 'ok',
    thumbnail: target.displayAvatarURL({ size: 128 }),
    lines: [
      `**Cible** : <@${target.id}> \`${target.tag}\` \`${target.id}\``,
      `**Raison** : ${truncate(reason, 800)}`,
      input.durationMs && type === 'timeout' ? `**Durée** : ${formatDuration(input.durationMs)} (fin ${ts(result.until ?? Date.now(), 'R')})` : null,
      result.warnings !== undefined ? `**Avertissements actifs** : ${result.warnings}` : null,
      `**Message privé** : ${result.dmSent ? 'remis' : 'non remis'}`,
    ],
    by: actor.user,
  });

  if (type === 'warn' && !input.auto && result.warnings) {
    result.followUp = await runAutoAction(guild, actor, target, result.warnings).catch((err: unknown) => {
      log.warn(`Action automatique impossible : ${(err as Error).message}`);
      return null;
    });
  }
  return result;
}

/** Actions automatiques configurées : ex. 3 warns → timeout, 5 → kick, 7 → ban. */
async function runAutoAction(guild: Guild, actor: GuildMember, target: User, warnings: number): Promise<SanctionResult | null> {
  const rule = getConfig(guild.id).moderation.autoActions.find((a) => a.warns === warnings);
  if (!rule) return null;
  const me = guild.members.me;
  if (!me) return null;
  return applySanction({
    guild,
    actor: me,
    target,
    type: rule.action,
    reason: `${warnings} avertissements (action automatique, dernier par ${actor.user.tag})`,
    durationMs: rule.action === 'timeout' ? rule.durationMinutes * 60_000 : undefined,
    auto: true,
  });
}

export function describeResult(result: SanctionResult): string {
  const label = LABELS[result.type];
  const lines = [`${label.emoji} <@${result.target.id}> ${label.verb}.`, `-# Raison : ${truncate(result.reason, 300)}`];
  if (result.until) lines.push(`-# Fin ${ts(result.until, 'R')}`);
  if (result.warnings !== undefined) lines.push(`-# Avertissements actifs : **${result.warnings}**${result.warningId ? ` · n°${result.warningId}` : ''}`);
  if (!result.dmSent && label.pose) lines.push('-# Message privé non remis (MP fermés).');
  if (result.followUp) lines.push('', `🤖 Action automatique : ${LABELS[result.followUp.type].title.toLowerCase()}.`);
  return lines.join('\n');
}

/** Parse « 3:timeout:60, 5:kick, 7:ban » pour les actions automatiques. */
export function parseAutoActions(input: string): { warns: number; action: 'timeout' | 'kick' | 'ban'; durationMinutes: number }[] | null {
  if (!input.trim()) return [];
  const out: { warns: number; action: 'timeout' | 'kick' | 'ban'; durationMinutes: number }[] = [];
  for (const part of input.split(',')) {
    const m = /^\s*(\d{1,2})\s*:\s*(timeout|kick|ban)\s*(?::\s*(\d{1,5}))?\s*$/i.exec(part);
    if (!m) return null;
    const action = m[2]!.toLowerCase() as 'timeout' | 'kick' | 'ban';
    out.push({ warns: Number(m[1]), action, durationMinutes: action === 'timeout' ? Math.min(Number(m[3] ?? 60), 40_320) : 0 });
  }
  return out.sort((a, b) => a.warns - b.warns);
}

export function formatAutoActions(list: { warns: number; action: string; durationMinutes: number }[]): string {
  return list.map((a) => `${a.warns}:${a.action}${a.action === 'timeout' ? `:${a.durationMinutes}` : ''}`).join(', ');
}
