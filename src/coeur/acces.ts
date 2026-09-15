import { type Guild, type GuildMember, PermissionFlagsBits, type PermissionResolvable, type Role } from 'discord.js';
import { executer, lire, lireJson, lireTout, transaction } from './base';

import { environnement, LIBELLES_NIVEAUX, Niveau } from './outils';
import { type ConfigServeur, lireConfig } from './reglages';

export type WhitelistId = 'owner' | 'streamer' | 'admin' | 'sys' | 'staff' | 'support' | 'logs' | 'bypass' | 'giveaway' | 'dj';

export interface DefinitionWhitelist {
  id: WhitelistId;
  libelle: string;
  emoji: string;
  groupe: string;
  description: string;
  portee: 'global' | 'guild';
  accorde: Niveau | null;
  gerePar: Niveau;
  raccourci: string;
}

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

const cache = new Map<string, Map<string, Set<string>>>();

function chargerPortee(portee: string): Map<string, Set<string>> {
  let listes = cache.get(portee);
  if (!listes) {
    listes = new Map();
    for (const rangee of lireTout<{ liste: string; utilisateur_id: string }>('SELECT liste, utilisateur_id FROM whitelists WHERE portee = ?', portee)) {
      let membres = listes.get(rangee.liste);
      if (!membres) listes.set(rangee.liste, (membres = new Set()));
      membres.add(rangee.utilisateur_id);
    }
    cache.set(portee, listes);
  }
  return listes;
}

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

export function peutGererWhitelist(niveauAuteur: Niveau, definition: DefinitionWhitelist, auteurProprietaireFixe: boolean, auteurProprietaireServeur: boolean): boolean {
  if (definition.id === 'owner') return auteurProprietaireFixe;
  if (definition.id === 'streamer') return niveauAuteur >= Niveau.PROPRIETAIRE_BOT || auteurProprietaireServeur;
  return niveauAuteur >= definition.gerePar;
}

export interface ProfilMembre {
  id: string;
  guildOwnerId: string;
  roleIds: string[];
  isAdministrator: boolean;
  canManageGuild: boolean;
  whitelistLevel: Niveau;
  isBotOwner: boolean;
}

export function calculerNiveau(membre: ProfilMembre, permissions: ConfigServeur['permissions']): Niveau {
  if (membre.isBotOwner) return Niveau.PROPRIETAIRE_BOT;
  let niveau = membre.whitelistLevel;
  const monter = (l: Niveau) => {
    if (l > niveau) niveau = l;
  };
  const possede = (ids: string[]) => ids.some((id) => membre.roleIds.includes(id));
  if (membre.id === membre.guildOwnerId) monter(Niveau.STREAMER);
  if (possede(permissions.streamer)) monter(Niveau.STREAMER);
  if (membre.isAdministrator || membre.canManageGuild || possede(permissions.admin)) monter(Niveau.ADMIN);
  if (possede(permissions.moderateur)) monter(Niveau.MODERATEUR);
  if (possede(permissions.staff)) monter(Niveau.STAFF);
  if (possede(permissions.support)) monter(Niveau.SUPPORT);
  return niveau;
}

export function lireNiveau(membre: GuildMember): Niveau {
  const permissions = lireConfig(membre.guild.id).permissions;
  return calculerNiveau(
    {
      id: membre.id,
      guildOwnerId: membre.guild.ownerId,
      roleIds: [...membre.roles.cache.keys()],
      isAdministrator: membre.permissions.has(PermissionFlagsBits.Administrator),
      canManageGuild: membre.permissions.has(PermissionFlagsBits.ManageGuild),
      whitelistLevel: niveauWhitelist(membre.id, membre.guild.id),
      isBotOwner: estProprietaireBot(membre.id),
    },
    permissions,
  );
}

export function aNiveau(membre: GuildMember, niveau: Niveau): boolean {
  return lireNiveau(membre) >= niveau;
}

export function aAcces(membre: GuildMember, niveau: Niveau, whitelist?: string): boolean {
  if (lireNiveau(membre) >= niveau) return true;
  return !!whitelist && estWhitelist(whitelist as WhitelistId, membre.id, membre.guild.id);
}

export function estExempte(membre: GuildMember | null | undefined): boolean {
  if (!membre) return false;
  return estWhitelist('bypass', membre.id, membre.guild.id) || lireNiveau(membre) >= Niveau.MODERATEUR;
}

export function libelleNiveau(niveau: Niveau): string {
  return LIBELLES_NIVEAUX[niveau];
}

export function botPeutGererRole(serveur: Guild, role: Role): boolean {
  const moi = serveur.members.me;
  if (!moi || !moi.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (role.managed || role.id === serveur.id) return false;
  return moi.roles.highest.comparePositionTo(role) > 0;
}

export function rolesAttribuables(serveur: Guild, rolesIds: string[]): Role[] {
  return rolesIds
    .map((id) => serveur.roles.cache.get(id))
    .filter((r): r is Role => !!r && botPeutGererRole(serveur, r));
}

export type VerificationModeration = { ok: true } | { ok: false; reason: string };

export function verifierModerable(auteur: GuildMember, cible: GuildMember): VerificationModeration {
  const serveur = auteur.guild;
  if (cible.id === auteur.id) return { ok: false, reason: 'Tu ne peux pas faire ça sur toi-même.' };
  if (cible.id === serveur.ownerId) return { ok: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  if (cible.id === serveur.members.me?.id) return { ok: false, reason: 'Je ne peux pas me sanctionner moi-même.' };
  const moi = serveur.members.me;
  // - Sanctions automatiques -
  // Venues du bot : seule la hiérarchie des rôles compte.
  if (auteur.id === moi?.id) {
    return moi.roles.highest.comparePositionTo(cible.roles.highest) > 0 ? { ok: true } : { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  const niveauAuteur = lireNiveau(auteur);
  if (niveauAuteur < Niveau.PROPRIETAIRE_BOT && lireNiveau(cible) >= niveauAuteur) {
    return { ok: false, reason: 'Ce membre a un accès égal ou supérieur au tien.' };
  }
  if (auteur.id !== serveur.ownerId && niveauAuteur < Niveau.STREAMER && auteur.roles.highest.comparePositionTo(cible.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au tien.' };
  }
  if (moi && moi.roles.highest.comparePositionTo(cible.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  return { ok: true };
}

export function botAPermissions(serveur: Guild, permissions: PermissionResolvable): boolean {
  return serveur.members.me?.permissions.has(permissions) ?? false;
}


export const COULEUR_DEFAUT = 0x9146ff;

export const CLES_EMOJIS = {
  valide: '✅',
  probleme: '❌',
  refus: '⛔',
  info: 'ℹ️',
  attention: '⚠️',
  attente: '⏳',
  ticket: '🎫',
  giveaway: '🎉',
  cadeau: '🎁',
  live: '🔴',
  twitch: '💜',
  musique: '🎵',
  bienvenue: '👋',
  depart: '🚪',
  sanction: '🛡️',
  whitelist: '🔐',
  couronne: '👑',
  etoile: '⭐',
  stats: '📊',
  message: '💬',
  vocal: '🎙️',
  role: '🎭',
  cle: '🔑',
  corbeille: '🗑️',
  lien: '🔗',
  anniversaire: '🎂',
  rappel: '⏰',
  annonce: '📢',
  argent: '💰',
  niveau: '🏆',
  boost: '🚀',
  suggestion: '💡',
} as const;

export type CleEmoji = keyof typeof CLES_EMOJIS;

export interface LiensEnseigne {
  twitch?: string;
  youtube?: string;
  x?: string;
  tiktok?: string;
  instagram?: string;
  discord?: string;
}

export interface Enseigne {
  cle: string | null;
  nom: string;
  couleur: number;
  couleurPerso: boolean;
  pied: string | null;
  logo: string | null;
  fond: string | null;
  pseudoTwitch: string | null;
  liens: LiensEnseigne;
  emojis: Partial<Record<CleEmoji, string>>;
}

export interface LigneEnseigne {
  cle: string;
  nom: string;
  couleur: number | null;
  pied: string | null;
  logo: string | null;
  fond: string | null;
  pseudo_twitch: string | null;
  liens: string;
  emojis: string;
  cree_le: number;
  modifie_le: number;
}

export const MOTIF_CLE = /^[a-z0-9_-]{2,32}$/;
const MOTIF_IMAGE = /^https:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const MOTIF_EMOJI_PERSO = /^<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>$/;

export function estLienImage(valeur: string): boolean {
  return MOTIF_IMAGE.test(valeur.trim());
}

export function estEmoji(valeur: string): boolean {
  const v = valeur.trim();
  if (MOTIF_EMOJI_PERSO.test(v)) return true;
  return v.length > 0 && v.length <= 8 && /\p{Extended_Pictographic}/u.test(v);
}

export function lireCouleur(valeur: string | number | null | undefined): number | null {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  if (typeof valeur === 'number') return Number.isInteger(valeur) && valeur >= 0 && valeur <= 0xffffff ? valeur : null;
  const m = /^#?([0-9a-f]{6})$/i.exec(valeur.trim());
  return m ? Number.parseInt(m[1]!, 16) : null;
}

export function enHexa(couleur: number): string {
  return `#${couleur.toString(16).padStart(6, '0').toUpperCase()}`;
}

export const PALETTES = [
  {
    name: 'Twitch',
    description: 'Violets et tons néon',
    tons: [
      { name: 'Twitch', color: 0x9146ff },
      { name: 'Lavande', color: 0xbf94ff },
      { name: 'Aubergine', color: 0x5c16c5 },
      { name: 'Néon', color: 0x7b5cff },
      { name: 'Magenta', color: 0xe91e8c },
      { name: 'Glace', color: 0x46c8ff },
    ],
  },
  {
    name: 'Pastel',
    description: 'Douces et chaleureuses',
    tons: [
      { name: 'Dragée', color: 0xf2b8cd },
      { name: 'Brume', color: 0xb8d4f2 },
      { name: 'Menthe', color: 0xb8f2d8 },
      { name: 'Sable', color: 0xf2e2b8 },
      { name: 'Lilas', color: 0xd8b8f2 },
      { name: 'Abricot', color: 0xf2cdb8 },
    ],
  },
  {
    name: 'Vif',
    description: 'Lumineuses, elles sautent aux yeux',
    tons: [
      { name: 'Cyan', color: 0x46c8ff },
      { name: 'Citron', color: 0xe8e83a },
      { name: 'Corail', color: 0xff6f5f },
      { name: 'Turquoise', color: 0x2fd8c8 },
      { name: 'Fuchsia', color: 0xff5fbf },
      { name: 'Lime', color: 0x8fe83a },
    ],
  },
  {
    name: 'Profond',
    description: 'Saturées et franches',
    tons: [
      { name: 'Encre', color: 0x2f4f8f },
      { name: 'Sapin', color: 0x1f6f4f },
      { name: 'Grenat', color: 0x8f2f4f },
      { name: 'Ambre', color: 0xcf8f1f },
      { name: 'Prune', color: 0x5f2f8f },
      { name: 'Ardoise', color: 0x3f4f5f },
    ],
  },
];

const cacheServeurs = new Map<string, { enseigne: Enseigne; expires: number }>();
const DUREE_CACHE_MS = 5 * 60_000;

export function enseigneParDefaut(): Enseigne {
  return {
    cle: null,
    nom: process.env.BOT_BRAND_NAME?.trim() || 'Twitch Community',
    couleur: COULEUR_DEFAUT,
    couleurPerso: false,
    pied: null,
    logo: null,
    fond: null,
    pseudoTwitch: null,
    liens: {},
    emojis: {},
  };
}

function versEnseigne(rangee: LigneEnseigne): Enseigne {
  const emojis: Partial<Record<CleEmoji, string>> = {};
  for (const [k, v] of Object.entries(lireJson<Record<string, string>>(rangee.emojis, {}))) {
    if (k in CLES_EMOJIS && typeof v === 'string' && estEmoji(v)) emojis[k as CleEmoji] = v;
  }
  return {
    cle: rangee.cle,
    nom: rangee.nom,
    couleur: rangee.couleur ?? COULEUR_DEFAUT,
    couleurPerso: rangee.couleur !== null,
    pied: rangee.pied,
    logo: rangee.logo,
    fond: rangee.fond,
    pseudoTwitch: rangee.pseudo_twitch,
    liens: lireJson<LiensEnseigne>(rangee.liens, {}),
    emojis,
  };
}

export function enseigneDe(serveurId: string | null | undefined): Enseigne {
  if (!serveurId) return enseigneParDefaut();
  const enCache = cacheServeurs.get(serveurId);
  if (enCache && enCache.expires > Date.now()) return enCache.enseigne;
  const rangee = lire<LigneEnseigne>(
    'SELECT s.* FROM enseignes s JOIN serveurs_enseignes g ON g.enseigne_cle = s.cle WHERE g.serveur_id = ?',
    serveurId,
  );
  const enseigne = rangee ? versEnseigne(rangee) : enseigneParDefaut();
  cacheServeurs.set(serveurId, { enseigne, expires: Date.now() + DUREE_CACHE_MS });
  return enseigne;
}

export function emojiPour(serveurId: string | null | undefined, cle: CleEmoji): string {
  return enseigneDe(serveurId).emojis[cle] ?? CLES_EMOJIS[cle];
}

export function oublierEnseignes(): void {
  cacheServeurs.clear();
}

export function listerEnseignes(): (LigneEnseigne & { guilds: string[] })[] {
  const rangees = lireTout<LigneEnseigne>('SELECT * FROM enseignes ORDER BY nom COLLATE NOCASE');
  const liens = lireTout<{ serveur_id: string; enseigne_cle: string }>('SELECT serveur_id, enseigne_cle FROM serveurs_enseignes');
  return rangees.map((r) => ({ ...r, guilds: liens.filter((l) => l.enseigne_cle === r.cle).map((l) => l.serveur_id) }));
}

export function lireEnseigne(cle: string): (LigneEnseigne & { guilds: string[] }) | null {
  const rangee = lire<LigneEnseigne>('SELECT * FROM enseignes WHERE cle = ?', cle);
  if (!rangee) return null;
  const serveurs = lireTout<{ serveur_id: string }>('SELECT serveur_id FROM serveurs_enseignes WHERE enseigne_cle = ?', cle).map((g) => g.serveur_id);
  return { ...rangee, guilds: serveurs };
}

export function creerEnseigne(cle: string, nom: string): void {
  if (!MOTIF_CLE.test(cle)) throw new Error('clé invalide');
  const maintenant = Date.now();
  executer('INSERT INTO enseignes (cle, nom, cree_le, modifie_le) VALUES (?, ?, ?, ?)', cle, nom.slice(0, 64), maintenant, maintenant);
  oublierEnseignes();
}

export type CorrectifEnseigne = Partial<{
  nom: string;
  couleur: number | null;
  pied: string | null;
  logo: string | null;
  fond: string | null;
  pseudo_twitch: string | null;
  liens: LiensEnseigne;
  emojis: Partial<Record<CleEmoji, string>>;
}>;

export function modifierEnseigne(cle: string, correctif: CorrectifEnseigne): void {
  const actuel = lireEnseigne(cle);
  if (!actuel) throw new Error('enseigne introuvable');
  executer(
    `UPDATE enseignes SET nom = ?, couleur = ?, pied = ?, logo = ?, fond = ?, pseudo_twitch = ?, liens = ?, emojis = ?, modifie_le = ? WHERE cle = ?`,
    (correctif.nom ?? actuel.nom).slice(0, 64),
    correctif.couleur !== undefined ? correctif.couleur : actuel.couleur,
    correctif.pied !== undefined ? correctif.pied?.slice(0, 128) ?? null : actuel.pied,
    correctif.logo !== undefined ? correctif.logo : actuel.logo,
    correctif.fond !== undefined ? correctif.fond : actuel.fond,
    correctif.pseudo_twitch !== undefined ? correctif.pseudo_twitch : actuel.pseudo_twitch,
    JSON.stringify(correctif.liens ?? lireJson(actuel.liens, {})),
    JSON.stringify(correctif.emojis ?? lireJson(actuel.emojis, {})),
    Date.now(),
    cle,
  );
  oublierEnseignes();
}

export function poserServeursEnseigne(cle: string, serveurIds: string[]): void {
  transaction(() => {
    executer('DELETE FROM serveurs_enseignes WHERE enseigne_cle = ?', cle);
    for (const id of [...new Set(serveurIds)].slice(0, 100)) {
      executer('INSERT INTO serveurs_enseignes (serveur_id, enseigne_cle) VALUES (?, ?) ON CONFLICT(serveur_id) DO UPDATE SET enseigne_cle = excluded.enseigne_cle', id, cle);
    }
  });
  oublierEnseignes();
}

export function supprimerEnseigne(cle: string): boolean {
  const r = executer('DELETE FROM enseignes WHERE cle = ?', cle);
  executer('DELETE FROM serveurs_enseignes WHERE enseigne_cle = ?', cle);
  oublierEnseignes();
  return r.changes > 0;
}
