import { get, run } from '../database/db';
import { getConfig } from '../core/guildConfig';
import { dayKey } from '../core/time';

type DailyColumn = 'messages' | 'joins' | 'leaves' | 'voice_seconds' | 'commands';

/** Incrémente un compteur journalier du serveur (dans son fuseau horaire). */
export function bumpDaily(guildId: string, column: DailyColumn, amount = 1): void {
  const day = dayKey(Date.now(), getConfig(guildId).general.timezone);
  run(
    `INSERT INTO stats_daily (guild_id, day, ${column}) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    guildId,
    day,
    amount,
  );
}

/** Profil d'activité d'un membre (créé à la première rencontre). */
export function touchUser(guildId: string, userId: string): void {
  run('INSERT OR IGNORE INTO users (guild_id, user_id, first_seen) VALUES (?, ?, ?)', guildId, userId, Date.now());
}

export function bumpUser(guildId: string, userId: string, column: 'messages' | 'voice_seconds', amount = 1): void {
  run(
    `INSERT INTO users (guild_id, user_id, first_seen, ${column}) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    guildId,
    userId,
    Date.now(),
    amount,
  );
}

export function userActivity(guildId: string, userId: string): { messages: number; voice_seconds: number; first_seen: number } | undefined {
  return get('SELECT messages, voice_seconds, first_seen FROM users WHERE guild_id = ? AND user_id = ?', guildId, userId);
}
