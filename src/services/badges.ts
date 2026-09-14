import { all, get, run } from '../database/db';

export interface BadgeDefinition {
  badge_id: string;
  name: string;
  emoji: string;
  description: string;
}

/** Badges proposés par défaut sur chaque serveur (modifiables). */
export const DEFAULT_BADGES: BadgeDefinition[] = [
  { badge_id: 'og', name: 'OG', emoji: '🏆', description: 'Membre de très longue date' },
  { badge_id: 'actif', name: 'Actif', emoji: '⭐', description: 'Niveau 10 atteint' },
  { badge_id: 'giveaway', name: 'Giveaway Winner', emoji: '🎉', description: 'A gagné un giveaway' },
  { badge_id: 'birthday', name: 'Birthday', emoji: '🎂', description: 'A fêté son anniversaire ici' },
  { badge_id: 'vip', name: 'VIP', emoji: '💎', description: 'Booste le serveur' },
  { badge_id: 'early', name: 'Early Supporter', emoji: '🔥', description: 'Parmi les premiers membres' },
  { badge_id: 'gamer', name: 'Gamer', emoji: '🎮', description: 'Participe aux événements gaming' },
  { badge_id: 'staff', name: 'Staff', emoji: '🛡️', description: 'Membre de l’équipe' },
];

function ensureDefaults(guildId: string): void {
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM badges WHERE guild_id = ?', guildId)?.n ?? 0;
  if (count > 0) return;
  for (const b of DEFAULT_BADGES) {
    run('INSERT OR IGNORE INTO badges (guild_id, badge_id, name, emoji, description) VALUES (?, ?, ?, ?, ?)', guildId, b.badge_id, b.name, b.emoji, b.description);
  }
}

export function listBadges(guildId: string): BadgeDefinition[] {
  ensureDefaults(guildId);
  return all<BadgeDefinition>('SELECT badge_id, name, emoji, description FROM badges WHERE guild_id = ? ORDER BY name COLLATE NOCASE', guildId);
}

export function getBadge(guildId: string, badgeId: string): BadgeDefinition | undefined {
  ensureDefaults(guildId);
  return get<BadgeDefinition>('SELECT badge_id, name, emoji, description FROM badges WHERE guild_id = ? AND badge_id = ?', guildId, badgeId);
}

export function upsertBadge(guildId: string, badge: BadgeDefinition): void {
  ensureDefaults(guildId);
  run(
    `INSERT INTO badges (guild_id, badge_id, name, emoji, description) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, badge_id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, description = excluded.description`,
    guildId,
    badge.badge_id,
    badge.name,
    badge.emoji,
    badge.description,
  );
}

export function deleteBadge(guildId: string, badgeId: string): boolean {
  run('DELETE FROM user_badges WHERE guild_id = ? AND badge_id = ?', guildId, badgeId);
  return run('DELETE FROM badges WHERE guild_id = ? AND badge_id = ?', guildId, badgeId).changes > 0;
}

/** Donne un badge (sans doublon). Retourne true s'il est nouveau. */
export function grantBadge(guildId: string, userId: string, badgeId: string, grantedBy: string | null = null): boolean {
  if (!getBadge(guildId, badgeId)) return false;
  return run('INSERT OR IGNORE INTO user_badges (guild_id, user_id, badge_id, granted_at, granted_by) VALUES (?, ?, ?, ?, ?)', guildId, userId, badgeId, Date.now(), grantedBy).changes > 0;
}

export function revokeBadge(guildId: string, userId: string, badgeId: string): boolean {
  return run('DELETE FROM user_badges WHERE guild_id = ? AND user_id = ? AND badge_id = ?', guildId, userId, badgeId).changes > 0;
}

export function userBadges(guildId: string, userId: string): (BadgeDefinition & { granted_at: number })[] {
  ensureDefaults(guildId);
  return all(
    `SELECT b.badge_id, b.name, b.emoji, b.description, u.granted_at FROM user_badges u
     JOIN badges b ON b.guild_id = u.guild_id AND b.badge_id = u.badge_id
     WHERE u.guild_id = ? AND u.user_id = ? ORDER BY u.granted_at`,
    guildId,
    userId,
  );
}
