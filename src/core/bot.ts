import type { Client } from 'discord.js';
import type { Aiguilleur } from './dispatcher';

interface EtatBot {
  client: Client<true> | null;
  aiguilleur: Aiguilleur | null;
  debutLe: number;
}

export const etatBot: EtatBot = {
  client: null,
  aiguilleur: null,
  debutLe: Date.now(),
};

export function lireClient(): Client<true> {
  if (!etatBot.client) throw new Error('Client Discord non prêt');
  return etatBot.client;
}

export function lireAiguilleur(): Aiguilleur {
  if (!etatBot.aiguilleur) throw new Error('Dispatcher non initialisé');
  return etatBot.aiguilleur;
}
