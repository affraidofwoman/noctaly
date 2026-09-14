import type { Client } from 'discord.js';
import type { Dispatcher } from './dispatcher';

interface BotState {
  client: Client<true> | null;
  dispatcher: Dispatcher | null;
  startedAt: number;
}

export const botState: BotState = {
  client: null,
  dispatcher: null,
  startedAt: Date.now(),
};

export function getClient(): Client<true> {
  if (!botState.client) throw new Error('Client Discord non prêt');
  return botState.client;
}

export function getDispatcher(): Dispatcher {
  if (!botState.dispatcher) throw new Error('Dispatcher non initialisé');
  return botState.dispatcher;
}
