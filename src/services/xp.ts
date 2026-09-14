import { all, get, run } from '../database/db';

/** XP nécessaire pour passer du niveau `level` au suivant (formule façon MEE6). */
export function xpToNext(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** XP totale nécessaire pour atteindre un niveau. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

export function levelFromXp(xp: number): { level: number; current: number; needed: number } {
  let level = 0;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level) && level < 1000) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, current: rest, needed: xpToNext(level) };
}

export interface XpRow {
  user_id: string;
  xp: number;
  level: number;
  last_message_at: number;
}

export function getXp(guildId: string, userId: string): XpRow {
  return get<XpRow>('SELECT user_id, xp, level, last_message_at FROM xp WHERE guild_id = ? AND user_id = ?', guildId, userId) ?? { user_id: userId, xp: 0, level: 0, last_message_at: 0 };
}

export function levelOf(guildId: string, userId: string): number {
  return getXp(guildId, userId).level;
}

/** Ajoute (ou retire) de l'XP. Retourne l'ancien et le nouveau niveau. */
export function addXp(guildId: string, userId: string, amount: number, touchMessage = false): { oldLevel: number; newLevel: number; xp: number } {
  const before = getXp(guildId, userId);
  const xp = Math.max(0, before.xp + Math.round(amount));
  const newLevel = levelFromXp(xp).level;
  run(
    `INSERT INTO xp (guild_id, user_id, xp, level, last_message_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, last_message_at = CASE WHEN ? THEN excluded.last_message_at ELSE xp.last_message_at END`,
    guildId,
    userId,
    xp,
    newLevel,
    touchMessage ? Date.now() : before.last_message_at,
    touchMessage ? 1 : 0,
  );
  return { oldLevel: before.level, newLevel, xp };
}

export function setXp(guildId: string, userId: string, xp: number): number {
  const level = levelFromXp(xp).level;
  run(
    `INSERT INTO xp (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level`,
    guildId,
    userId,
    Math.max(0, Math.floor(xp)),
    level,
  );
  return level;
}

export function leaderboard(guildId: string, limit = 100, offset = 0): XpRow[] {
  return all<XpRow>('SELECT user_id, xp, level, last_message_at FROM xp WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC LIMIT ? OFFSET ?', guildId, limit, offset);
}

export function rankOf(guildId: string, userId: string): number {
  const me = getXp(guildId, userId);
  if (!me.xp) return 0;
  return (get<{ n: number }>('SELECT COUNT(*) AS n FROM xp WHERE guild_id = ? AND xp > ?', guildId, me.xp)?.n ?? 0) + 1;
}

export function levelRoles(guildId: string): { level: number; role_id: string }[] {
  return all('SELECT level, role_id FROM levels WHERE guild_id = ? ORDER BY level ASC', guildId);
}

export function setLevelRole(guildId: string, level: number, roleId: string): void {
  run('INSERT OR IGNORE INTO levels (guild_id, level, role_id) VALUES (?, ?, ?)', guildId, level, roleId);
}

export function removeLevelRole(guildId: string, roleId: string): number {
  return run('DELETE FROM levels WHERE guild_id = ? AND role_id = ?', guildId, roleId).changes;
}
