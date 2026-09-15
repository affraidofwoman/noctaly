import { lireTout, lire, executer } from '../database/db';
import { environnement } from './env';
import { Niveau } from './types';

export type WhitelistId = 'owner' | 'streamer' | 'admin' | 'sys' | 'staff' | 'support' | 'logs' | 'bypass' | 'giveaway' | 'dj';

export interface DefinitionWhitelist {
  id: WhitelistId;
  libelle: string;
  emoji: string;
  groupe: string;
  description: string;
  /** Portée : globale (tous les serveurs) ou par serveur. */
  portee: 'global' | 'guild';
  /** Niveau donné par la whitelist (null = accès ciblé, sans niveau). */
  accorde: Niveau | null;
  /** Niveau minimum pour donner ou retirer cette whitelist. */
  gerePar: Niveau;
  /** Préfixe de commande rapide (domaine général "=" sauf owner "."). */
  raccourci: string;
}

/** Catalogue des whitelists, dans l'ordre d'affichage. */
export const WHITELISTS: DefinitionWhitelist[] = [
  {
    id: 'owner',
    libelle: 'Owner bot',
    emoji: '👑',
    groupe: 'Bot',
    description: 'Tout le bot, sur tous les serveurs, et les enseignes /custom',
    portee: 'global',
    accorde: Niveau.PROPRIETAIRE_BOT,
    gerePar: Niveau.PROPRIETAIRE_BOT,
    raccourci: 'owner',
  },
  {
    id: 'streamer',
    libelle: 'Streamer',
    emoji: '🎥',
    groupe: 'Serveur',
    description: 'Le streamer du serveur : tous les réglages et toutes les whitelists',
    portee: 'guild',
    accorde: Niveau.STREAMER,
    gerePar: Niveau.STREAMER,
    raccourci: 'streamer',
  },
  {
    id: 'admin',
    libelle: 'Admin',
    emoji: '🛠️',
    groupe: 'Serveur',
    description: 'Configurer le bot et distribuer les whitelists du staff',
    portee: 'guild',
    accorde: Niveau.ADMIN,
    gerePar: Niveau.STREAMER,
    raccourci: 'admin',
  },
  {
    id: 'sys',
    libelle: 'Système',
    emoji: '🛡️',
    groupe: 'Modération',
    description: 'Sanctions, blacklist et commandes de modération sensibles',
    portee: 'guild',
    accorde: Niveau.MODERATEUR,
    gerePar: Niveau.ADMIN,
    raccourci: 'sys',
  },
  {
    id: 'staff',
    libelle: 'Staff',
    emoji: '⭐',
    groupe: 'Modération',
    description: 'Tickets, suggestions, événements et annonces',
    portee: 'guild',
    accorde: Niveau.STAFF,
    gerePar: Niveau.ADMIN,
    raccourci: 'staff',
  },
  {
    id: 'support',
    libelle: 'Support',
    emoji: '🎫',
    groupe: 'Modération',
    description: 'Voir et répondre aux tickets',
    portee: 'guild',
    accorde: Niveau.SUPPORT,
    gerePar: Niveau.MODERATEUR,
    raccourci: 'support',
  },
  {
    id: 'logs',
    libelle: 'Logs',
    emoji: '🔎',
    groupe: 'Accès ciblés',
    description: 'Voir les salons de logs et l’historique /logs',
    portee: 'guild',
    accorde: null,
    gerePar: Niveau.ADMIN,
    raccourci: 'wlogs',
  },
  {
    id: 'bypass',
    libelle: 'Bypass',
    emoji: '🚧',
    groupe: 'Accès ciblés',
    description: 'Ignoré par l’automod, l’anti-raid et les salons de commandes',
    portee: 'guild',
    accorde: null,
    gerePar: Niveau.ADMIN,
    raccourci: 'bypass',
  },
  {
    id: 'giveaway',
    libelle: 'Giveaway',
    emoji: '🎉',
    groupe: 'Accès ciblés',
    description: 'Lancer, terminer et relancer les giveaways',
    portee: 'guild',
    accorde: null,
    gerePar: Niveau.ADMIN,
    raccourci: 'wlgiveaway',
  },
  {
    id: 'dj',
    libelle: 'DJ',
    emoji: '🎧',
    groupe: 'Accès ciblés',
    description: 'Piloter la musique pour tout le monde',
    portee: 'guild',
    accorde: null,
    gerePar: Niveau.STAFF,
    raccourci: 'dj',
  },
];

export function lireWhitelist(id: string): DefinitionWhitelist | undefined {
  return WHITELISTS.find((w) => w.id === id);
}

function porteeDe(definition: DefinitionWhitelist, serveurId: string | null): string {
  return definition.portee === 'global' ? 'global' : (serveurId ?? 'global');
}

// Cache par portée : les whitelists sont lues à chaque interaction.
const cache = new Map<string, Map<string, Set<string>>>();

function chargerPortee(portee: string): Map<string, Set<string>> {
  let listes = cache.get(portee);
  if (!listes) {
    listes = new Map();
    for (const rangee of lireTout<{ liste: string; utilisateur_id: string }>('SELECT liste, utilisateur_id FROM whitelists WHERE portee = ?', portee)) {
      let ecrire = listes.get(rangee.liste);
      if (!ecrire) listes.set(rangee.liste, (ecrire = new Set()));
      ecrire.add(rangee.utilisateur_id);
    }
    cache.set(portee, listes);
  }
  return listes;
}

/** Owners codés dans l'environnement : ils ne peuvent jamais être retirés. */
export function estProprietaireFixe(utilisateurId: string): boolean {
  return environnement.proprietairesIds.includes(utilisateurId);
}

export function estProprietaireBot(utilisateurId: string): boolean {
  return estProprietaireFixe(utilisateurId) || estWhitelist('owner', utilisateurId, null);
}

export function estWhitelist(listeId: WhitelistId, utilisateurId: string, serveurId: string | null): boolean {
  const definition = lireWhitelist(listeId);
  if (!definition) return false;
  if (listeId === 'owner' && estProprietaireFixe(utilisateurId)) return true;
  return chargerPortee(porteeDe(definition, serveurId)).get(listeId)?.has(utilisateurId) ?? false;
}

export function membresListe(listeId: WhitelistId, serveurId: string | null): string[] {
  const definition = lireWhitelist(listeId);
  if (!definition) return [];
  const ids = [...(chargerPortee(porteeDe(definition, serveurId)).get(listeId) ?? [])];
  if (listeId === 'owner') for (const id of environnement.proprietairesIds) if (!ids.includes(id)) ids.unshift(id);
  return ids;
}

export function whitelistsMembre(utilisateurId: string, serveurId: string | null): DefinitionWhitelist[] {
  return WHITELISTS.filter((w) => estWhitelist(w.id, utilisateurId, serveurId));
}

/** Niveau le plus élevé accordé par les whitelists d'un utilisateur. */
export function niveauWhitelist(utilisateurId: string, serveurId: string | null): Niveau {
  let niveau = Niveau.MEMBRE;
  for (const w of whitelistsMembre(utilisateurId, serveurId)) if (w.accorde !== null && w.accorde > niveau) niveau = w.accorde;
  return niveau;
}

export function ajouterWhitelist(listeId: WhitelistId, utilisateurId: string, serveurId: string | null, ajoutePar: string): boolean {
  const definition = lireWhitelist(listeId);
  if (!definition) throw new Error(`Whitelist inconnue : ${listeId}`);
  const portee = porteeDe(definition, serveurId);
  const r = executer(
    'INSERT OR IGNORE INTO whitelists (portee, liste, utilisateur_id, ajoute_par, ajoute_le) VALUES (?, ?, ?, ?, ?)',
    portee,
    listeId,
    utilisateurId,
    ajoutePar,
    Date.now(),
  );
  cache.delete(portee);
  return r.changes > 0;
}

export function retirerWhitelist(listeId: WhitelistId, utilisateurId: string, serveurId: string | null): boolean {
  const definition = lireWhitelist(listeId);
  if (!definition) throw new Error(`Whitelist inconnue : ${listeId}`);
  const portee = porteeDe(definition, serveurId);
  const r = executer('DELETE FROM whitelists WHERE portee = ? AND liste = ? AND utilisateur_id = ?', portee, listeId, utilisateurId);
  cache.delete(portee);
  return r.changes > 0;
}

export function entreeWhitelist(listeId: WhitelistId, utilisateurId: string, serveurId: string | null): { ajoute_par: string | null; ajoute_le: number } | undefined {
  const definition = lireWhitelist(listeId);
  if (!definition) return undefined;
  return lire('SELECT ajoute_par, ajoute_le FROM whitelists WHERE portee = ? AND liste = ? AND utilisateur_id = ?', porteeDe(definition, serveurId), listeId, utilisateurId);
}

export function viderCacheWhitelists(): void {
  cache.clear();
}

/** Peut-on donner/retirer cette whitelist ? (règle : strictement au-dessus, sauf owner/streamer) */
export function peutGererWhitelist(niveauAuteur: Niveau, definition: DefinitionWhitelist, auteurProprietaireFixe: boolean, auteurProprietaireServeur: boolean): boolean {
  if (definition.id === 'owner') return auteurProprietaireFixe;
  if (definition.id === 'streamer') return niveauAuteur >= Niveau.PROPRIETAIRE_BOT || auteurProprietaireServeur;
  return niveauAuteur >= definition.gerePar;
}
