import type { Client, VoiceState } from 'discord.js';
import { all, run } from '../database/db';
import { createLogger } from '../core/logger';

const log = createLogger('vocal');

export interface VoiceCredit {
  guildId: string;
  userId: string;
  channelId: string;
  seconds: number;
  /** Seul(e) dans le salon, sourd ou dans le salon AFK : les modules peuvent ignorer ce temps. */
  idle: boolean;
}

type Listener = (credit: VoiceCredit, client: Client) => void;

const listeners: Listener[] = [];
const MAX_CREDIT_S = 10 * 60;

/** Un module s'abonne au temps passé en vocal (XP, statistiques, quêtes…). */
export function onVoiceTime(listener: Listener): void {
  listeners.push(listener);
}

function emit(client: Client, credit: VoiceCredit): void {
  if (credit.seconds <= 0) return;
  for (const l of listeners) {
    try {
      l(credit, client);
    } catch (err) {
      log.warn(`Écouteur vocal en échec : ${(err as Error).message}`);
    }
  }
}

function isIdle(state: VoiceState): boolean {
  const channel = state.channel;
  if (!channel) return true;
  if (state.selfDeaf || state.serverDeaf) return true;
  if (state.guild.afkChannelId === channel.id) return true;
  return channel.members.filter((m) => !m.user.bot).size < 2;
}

function credit(client: Client, guildId: string, userId: string, until: number, state: VoiceState | null): void {
  const row = all<{ channel_id: string; started_at: number }>('SELECT channel_id, started_at FROM voice_sessions WHERE guild_id = ? AND user_id = ?', guildId, userId)[0];
  if (!row) return;
  const seconds = Math.min(Math.floor((until - row.started_at) / 1000), MAX_CREDIT_S);
  emit(client, { guildId, userId, channelId: row.channel_id, seconds, idle: state ? isIdle(state) : false });
}

/** À brancher sur voiceStateUpdate (module cœur). */
export function handleVoiceState(before: VoiceState, after: VoiceState): void {
  const member = after.member ?? before.member;
  if (!member || member.user.bot) return;
  const now = Date.now();
  const guildId = after.guild.id;
  if (before.channelId && before.channelId !== after.channelId) {
    credit(after.client, guildId, member.id, now, before);
    run('DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?', guildId, member.id);
  }
  if (after.channelId && before.channelId !== after.channelId) {
    run('INSERT OR REPLACE INTO voice_sessions (guild_id, user_id, channel_id, started_at) VALUES (?, ?, ?, ?)', guildId, member.id, after.channelId, now);
  }
}

/** Crédite régulièrement les sessions en cours (le temps n'est pas perdu en cas de redémarrage). */
export function flushVoice(client: Client): void {
  const now = Date.now();
  for (const row of all<{ guild_id: string; user_id: string; channel_id: string; started_at: number }>('SELECT * FROM voice_sessions')) {
    const guild = client.guilds.cache.get(row.guild_id);
    const state = guild?.voiceStates.cache.get(row.user_id);
    if (!guild || !state?.channelId) {
      run('DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?', row.guild_id, row.user_id);
      continue;
    }
    const seconds = Math.min(Math.floor((now - row.started_at) / 1000), MAX_CREDIT_S);
    emit(client, { guildId: row.guild_id, userId: row.user_id, channelId: state.channelId, seconds, idle: isIdle(state) });
    run('UPDATE voice_sessions SET started_at = ?, channel_id = ? WHERE guild_id = ? AND user_id = ?', now, state.channelId, row.guild_id, row.user_id);
  }
}

/** Au démarrage : repart de zéro pour les personnes déjà en vocal. */
export function resyncVoice(client: Client): void {
  run('DELETE FROM voice_sessions');
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user.bot) continue;
      run('INSERT OR REPLACE INTO voice_sessions (guild_id, user_id, channel_id, started_at) VALUES (?, ?, ?, ?)', guild.id, state.id, state.channelId, now);
    }
  }
}
