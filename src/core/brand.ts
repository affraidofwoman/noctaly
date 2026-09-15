import { lireTout, lire, lireJson, executer, transaction } from '../database/db';

/**
 * ENSEIGNES STREAMERS
 * Chaque streamer a sa direction artistique (nom, couleur, logo, pied, émojis, liens)
 * et la liste des serveurs qui la portent. Les messages du bot prennent celle du serveur où ils sont envoyés.
 */

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

/** Un émoji personnalisé Discord ou un émoji unicode court. */
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

/** Palettes proposées dans /custom, lisibles sur le fond sombre de Discord. */
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
      // Un serveur n'appartient qu'à une seule enseigne : il est retiré de l'ancienne.
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
