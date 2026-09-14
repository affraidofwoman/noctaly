import { all, get, run } from '../database/db';
import { env } from './env';
import { PermLevel } from './types';

export type WhitelistId = 'owner' | 'streamer' | 'admin' | 'sys' | 'staff' | 'support' | 'logs' | 'bypass' | 'giveaway' | 'dj';

export interface WhitelistDefinition {
  id: WhitelistId;
  label: string;
  emoji: string;
  group: string;
  description: string;
  /** Portée : globale (tous les serveurs) ou par serveur. */
  scope: 'global' | 'guild';
  /** Niveau donné par la whitelist (null = accès ciblé, sans niveau). */
  grants: PermLevel | null;
  /** Niveau minimum pour donner ou retirer cette whitelist. */
  managedBy: PermLevel;
  /** Préfixe de commande rapide (domaine général "=" sauf owner "."). */
  shortcut: string;
}

/** Catalogue des whitelists, dans l'ordre d'affichage. */
export const WHITELISTS: WhitelistDefinition[] = [
  {
    id: 'owner',
    label: 'Owner bot',
    emoji: '👑',
    group: 'Bot',
    description: 'Tout le bot, sur tous les serveurs, et les enseignes /custom',
    scope: 'global',
    grants: PermLevel.BOT_OWNER,
    managedBy: PermLevel.BOT_OWNER,
    shortcut: 'owner',
  },
  {
    id: 'streamer',
    label: 'Streamer',
    emoji: '🎥',
    group: 'Serveur',
    description: 'Le streamer du serveur : tous les réglages et toutes les whitelists',
    scope: 'guild',
    grants: PermLevel.STREAMER,
    managedBy: PermLevel.STREAMER,
    shortcut: 'streamer',
  },
  {
    id: 'admin',
    label: 'Admin',
    emoji: '🛠️',
    group: 'Serveur',
    description: 'Configurer le bot et distribuer les whitelists du staff',
    scope: 'guild',
    grants: PermLevel.ADMIN,
    managedBy: PermLevel.STREAMER,
    shortcut: 'admin',
  },
  {
    id: 'sys',
    label: 'Système',
    emoji: '🛡️',
    group: 'Modération',
    description: 'Sanctions, blacklist et commandes de modération sensibles',
    scope: 'guild',
    grants: PermLevel.MODERATOR,
    managedBy: PermLevel.ADMIN,
    shortcut: 'sys',
  },
  {
    id: 'staff',
    label: 'Staff',
    emoji: '⭐',
    group: 'Modération',
    description: 'Tickets, suggestions, événements et annonces',
    scope: 'guild',
    grants: PermLevel.STAFF,
    managedBy: PermLevel.ADMIN,
    shortcut: 'staff',
  },
  {
    id: 'support',
    label: 'Support',
    emoji: '🎫',
    group: 'Modération',
    description: 'Voir et répondre aux tickets',
    scope: 'guild',
    grants: PermLevel.SUPPORT,
    managedBy: PermLevel.MODERATOR,
    shortcut: 'support',
  },
  {
    id: 'logs',
    label: 'Logs',
    emoji: '🔎',
    group: 'Accès ciblés',
    description: 'Voir les salons de logs et l’historique /logs',
    scope: 'guild',
    grants: null,
    managedBy: PermLevel.ADMIN,
    shortcut: 'wlogs',
  },
  {
    id: 'bypass',
    label: 'Bypass',
    emoji: '🚧',
    group: 'Accès ciblés',
    description: 'Ignoré par l’automod, l’anti-raid et les salons de commandes',
    scope: 'guild',
    grants: null,
    managedBy: PermLevel.ADMIN,
    shortcut: 'bypass',
  },
  {
    id: 'giveaway',
    label: 'Giveaway',
    emoji: '🎉',
    group: 'Accès ciblés',
    description: 'Lancer, terminer et relancer les giveaways',
    scope: 'guild',
    grants: null,
    managedBy: PermLevel.ADMIN,
    shortcut: 'wlgiveaway',
  },
  {
    id: 'dj',
    label: 'DJ',
    emoji: '🎧',
    group: 'Accès ciblés',
    description: 'Piloter la musique pour tout le monde',
    scope: 'guild',
    grants: null,
    managedBy: PermLevel.STAFF,
    shortcut: 'dj',
  },
];

export function getWhitelist(id: string): WhitelistDefinition | undefined {
  return WHITELISTS.find((w) => w.id === id);
}

function scopeFor(def: WhitelistDefinition, guildId: string | null): string {
  return def.scope === 'global' ? 'global' : (guildId ?? 'global');
}

// Cache par portée : les whitelists sont lues à chaque interaction.
const cache = new Map<string, Map<string, Set<string>>>();

function loadScope(scope: string): Map<string, Set<string>> {
  let lists = cache.get(scope);
  if (!lists) {
    lists = new Map();
    for (const row of all<{ list: string; user_id: string }>('SELECT list, user_id FROM whitelists WHERE scope = ?', scope)) {
      let set = lists.get(row.list);
      if (!set) lists.set(row.list, (set = new Set()));
      set.add(row.user_id);
    }
    cache.set(scope, lists);
  }
  return lists;
}

/** Owners codés dans l'environnement : ils ne peuvent jamais être retirés. */
export function isEnvOwner(userId: string): boolean {
  return env.ownerIds.includes(userId);
}

export function isBotOwner(userId: string): boolean {
  return isEnvOwner(userId) || isWhitelisted('owner', userId, null);
}

export function isWhitelisted(listId: WhitelistId, userId: string, guildId: string | null): boolean {
  const def = getWhitelist(listId);
  if (!def) return false;
  if (listId === 'owner' && isEnvOwner(userId)) return true;
  return loadScope(scopeFor(def, guildId)).get(listId)?.has(userId) ?? false;
}

export function listMembers(listId: WhitelistId, guildId: string | null): string[] {
  const def = getWhitelist(listId);
  if (!def) return [];
  const ids = [...(loadScope(scopeFor(def, guildId)).get(listId) ?? [])];
  if (listId === 'owner') for (const id of env.ownerIds) if (!ids.includes(id)) ids.unshift(id);
  return ids;
}

export function userWhitelists(userId: string, guildId: string | null): WhitelistDefinition[] {
  return WHITELISTS.filter((w) => isWhitelisted(w.id, userId, guildId));
}

/** Niveau le plus élevé accordé par les whitelists d'un utilisateur. */
export function whitelistLevel(userId: string, guildId: string | null): PermLevel {
  let level = PermLevel.MEMBER;
  for (const w of userWhitelists(userId, guildId)) if (w.grants !== null && w.grants > level) level = w.grants;
  return level;
}

export function addToWhitelist(listId: WhitelistId, userId: string, guildId: string | null, addedBy: string): boolean {
  const def = getWhitelist(listId);
  if (!def) throw new Error(`Whitelist inconnue : ${listId}`);
  const scope = scopeFor(def, guildId);
  const r = run(
    'INSERT OR IGNORE INTO whitelists (scope, list, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)',
    scope,
    listId,
    userId,
    addedBy,
    Date.now(),
  );
  cache.delete(scope);
  return r.changes > 0;
}

export function removeFromWhitelist(listId: WhitelistId, userId: string, guildId: string | null): boolean {
  const def = getWhitelist(listId);
  if (!def) throw new Error(`Whitelist inconnue : ${listId}`);
  const scope = scopeFor(def, guildId);
  const r = run('DELETE FROM whitelists WHERE scope = ? AND list = ? AND user_id = ?', scope, listId, userId);
  cache.delete(scope);
  return r.changes > 0;
}

export function whitelistEntry(listId: WhitelistId, userId: string, guildId: string | null): { added_by: string | null; added_at: number } | undefined {
  const def = getWhitelist(listId);
  if (!def) return undefined;
  return get('SELECT added_by, added_at FROM whitelists WHERE scope = ? AND list = ? AND user_id = ?', scopeFor(def, guildId), listId, userId);
}

export function clearWhitelistCache(): void {
  cache.clear();
}

/** Peut-on donner/retirer cette whitelist ? (règle : strictement au-dessus, sauf owner/streamer) */
export function canManageWhitelist(actorLevel: PermLevel, def: WhitelistDefinition, actorIsEnvOwner: boolean, actorIsGuildOwner: boolean): boolean {
  if (def.id === 'owner') return actorIsEnvOwner;
  if (def.id === 'streamer') return actorLevel >= PermLevel.BOT_OWNER || actorIsGuildOwner;
  return actorLevel >= def.managedBy;
}
