import type { Client } from 'discord.js';
import { createLogger } from '../core/logger';

const log = createLogger('activite');

export type ActivityType = 'messages' | 'voice_minutes' | 'giveaways' | 'daily';

export interface ActivityEvent {
  guildId: string;
  userId: string;
  type: ActivityType;
  amount: number;
}

type Listener = (event: ActivityEvent, client: Client | null) => void;
const listeners: Listener[] = [];
let clientRef: Client | null = null;

export function bindActivityClient(client: Client): void {
  clientRef = client;
}

/** Les modules (quêtes, succès…) s'abonnent à l'activité sans dépendre des modules qui la produisent. */
export function onActivity(listener: Listener): void {
  listeners.push(listener);
}

export function emitActivity(event: ActivityEvent): void {
  for (const l of listeners) {
    try {
      l(event, clientRef);
    } catch (err) {
      log.warn(`Écouteur d’activité en échec : ${(err as Error).message}`);
    }
  }
}
