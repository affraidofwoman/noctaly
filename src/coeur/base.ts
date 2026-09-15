import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { creerRegistre, environnement } from './outils';

export interface Migration {
  version: number;
  nom: string;
  requete: string;
}

// - Migrations -
// Une migration publiée ne se modifie jamais : on en ajoute une nouvelle.
export const migrations: Migration[] = [
  {
    version: 1,
    nom: 'schema initial',
    requete: `
CREATE TABLE serveurs (
  serveur_id TEXT PRIMARY KEY,
  arrive_le INTEGER NOT NULL,
  parti_le INTEGER
);

CREATE TABLE reglages_serveurs (
  serveur_id TEXT PRIMARY KEY,
  donnees TEXT NOT NULL DEFAULT '{}',
  modifie_le INTEGER NOT NULL
);

CREATE TABLE modules_serveurs (
  serveur_id TEXT NOT NULL,
  module TEXT NOT NULL,
  actif INTEGER NOT NULL,
  PRIMARY KEY (serveur_id, module)
);

CREATE TABLE membres (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  vu_le INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  secondes_vocal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE avertissements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  moderateur_id TEXT NOT NULL,
  raison TEXT NOT NULL,
  cree_le INTEGER NOT NULL,
  actif INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_warnings_user ON avertissements (serveur_id, utilisateur_id, actif);

CREATE TABLE journaux (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  categorie TEXT NOT NULL,
  type TEXT NOT NULL,
  utilisateur_id TEXT,
  acteur_id TEXT,
  donnees TEXT NOT NULL DEFAULT '{}',
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_logs_guild ON journaux (serveur_id, cree_le);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  salon_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  categorie TEXT NOT NULL,
  sujet TEXT,
  statut TEXT NOT NULL DEFAULT 'open',
  pris_par TEXT,
  cree_le INTEGER NOT NULL,
  ferme_le INTEGER,
  ferme_par TEXT
);
CREATE UNIQUE INDEX idx_tickets_channel ON tickets (salon_id);
CREATE INDEX idx_tickets_user ON tickets (serveur_id, utilisateur_id, statut);

CREATE TABLE messages_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  auteur_id TEXT NOT NULL,
  auteur_pseudo TEXT NOT NULL,
  contenu TEXT NOT NULL,
  pieces_jointes TEXT NOT NULL DEFAULT '[]',
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_ticket_messages ON messages_tickets (ticket_id, cree_le);

CREATE TABLE tirages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  organisateur_id TEXT NOT NULL,
  lot TEXT NOT NULL,
  nombre_gagnants INTEGER NOT NULL,
  fin_le INTEGER NOT NULL,
  statut TEXT NOT NULL DEFAULT 'running',
  restant_pause INTEGER,
  conditions TEXT NOT NULL DEFAULT '{}',
  gagnants TEXT NOT NULL DEFAULT '[]',
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_giveaways_status ON tirages (statut, fin_le);

CREATE TABLE participations_tirages (
  tirage_id INTEGER NOT NULL REFERENCES tirages(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  inscrit_le INTEGER NOT NULL,
  PRIMARY KEY (tirage_id, utilisateur_id)
);

CREATE TABLE xp (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  niveau INTEGER NOT NULL DEFAULT 0,
  dernier_message_le INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, utilisateur_id)
);
CREATE INDEX idx_xp_rank ON xp (serveur_id, xp DESC);

CREATE TABLE roles_niveaux (
  serveur_id TEXT NOT NULL,
  niveau INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (serveur_id, niveau, role_id)
);

CREATE TABLE badges (
  serveur_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  emoji TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (serveur_id, badge_id)
);

CREATE TABLE badges_membres (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  donne_le INTEGER NOT NULL,
  donne_par TEXT,
  PRIMARY KEY (serveur_id, utilisateur_id, badge_id)
);

CREATE TABLE anniversaires (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  jour INTEGER NOT NULL,
  mois INTEGER NOT NULL,
  annee_annoncee INTEGER,
  role_donne_le INTEGER,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE rappels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT,
  salon_id TEXT,
  utilisateur_id TEXT NOT NULL,
  contenu TEXT NOT NULL,
  rappel_le INTEGER NOT NULL,
  cree_le INTEGER NOT NULL,
  envoye INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reminders_due ON rappels (envoye, rappel_le);

CREATE TABLE evenements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  createur_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  jeu TEXT,
  image TEXT,
  debut_le INTEGER NOT NULL,
  statut TEXT NOT NULL DEFAULT 'scheduled',
  rappele INTEGER NOT NULL DEFAULT 0,
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_events_status ON evenements (statut, debut_le);

CREATE TABLE reponses_evenements (
  evenement_id INTEGER NOT NULL REFERENCES evenements(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  statut TEXT NOT NULL,
  modifie_le INTEGER NOT NULL,
  PRIMARY KEY (evenement_id, utilisateur_id)
);

CREATE TABLE sondages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  auteur_id TEXT NOT NULL,
  question TEXT NOT NULL,
  propositions TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  fin_le INTEGER,
  statut TEXT NOT NULL DEFAULT 'open',
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_polls_status ON sondages (statut, fin_le);

CREATE TABLE votes_sondages (
  sondage_id INTEGER NOT NULL REFERENCES sondages(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  choix INTEGER NOT NULL,
  PRIMARY KEY (sondage_id, utilisateur_id, choix)
);

CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  auteur_id TEXT NOT NULL,
  contenu TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'pending',
  staff_id TEXT,
  raison_staff TEXT,
  cree_le INTEGER NOT NULL
);

CREATE TABLE votes_suggestions (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  vote INTEGER NOT NULL,
  PRIMARY KEY (suggestion_id, utilisateur_id)
);

CREATE TABLE commandes_perso (
  serveur_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reponse TEXT NOT NULL,
  en_embed INTEGER NOT NULL DEFAULT 0,
  commande_discord_id TEXT,
  utilisations INTEGER NOT NULL DEFAULT 0,
  cree_par TEXT NOT NULL,
  cree_le INTEGER NOT NULL,
  PRIMARY KEY (serveur_id, nom)
);

CREATE TABLE reponses_auto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  declencheur TEXT NOT NULL,
  correspondance TEXT NOT NULL DEFAULT 'contains',
  reponse TEXT NOT NULL,
  cree_par TEXT NOT NULL,
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_auto_responses ON reponses_auto (serveur_id);

CREATE TABLE panneaux_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  titre TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'button',
  mode TEXT NOT NULL DEFAULT 'toggle',
  genre TEXT NOT NULL DEFAULT 'general',
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_reaction_roles_message ON panneaux_roles (message_id);

CREATE TABLE roles_panneaux (
  panneau_id INTEGER NOT NULL REFERENCES panneaux_roles(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  emoji TEXT,
  libelle TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (panneau_id, role_id)
);

CREATE TABLE chaines_twitch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  pseudo TEXT NOT NULL,
  diffuseur_id TEXT,
  nom_affiche TEXT,
  salon_id TEXT NOT NULL,
  role_id TEXT,
  message TEXT,
  couleur TEXT,
  afficher_image INTEGER NOT NULL DEFAULT 1,
  notifier_fin INTEGER NOT NULL DEFAULT 1,
  notifier_changements INTEGER NOT NULL DEFAULT 1,
  notifier_clips INTEGER NOT NULL DEFAULT 0,
  notifier_evenements INTEGER NOT NULL DEFAULT 0,
  live_id TEXT,
  message_live_id TEXT,
  live_debut_le INTEGER,
  live_vu_le INTEGER,
  image_profil TEXT,
  dernier_titre TEXT,
  dernier_jeu TEXT,
  derniers_spectateurs INTEGER,
  pic_spectateurs INTEGER,
  dernier_clip_le INTEGER,
  cree_le INTEGER NOT NULL,
  UNIQUE (serveur_id, pseudo)
);

CREATE TABLE invitations (
  serveur_id TEXT NOT NULL,
  invite_id TEXT NOT NULL,
  parrain_id TEXT,
  code TEXT,
  arrive_le INTEGER NOT NULL,
  parti_le INTEGER,
  faux INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, invite_id)
);
CREATE INDEX idx_invites_inviter ON invitations (serveur_id, parrain_id);

CREATE TABLE economie (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  solde INTEGER NOT NULL DEFAULT 0,
  total_gagne INTEGER NOT NULL DEFAULT 0,
  dernier_quotidien INTEGER NOT NULL DEFAULT 0,
  serie_quotidien INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE articles_boutique (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🎁',
  prix INTEGER NOT NULL,
  type TEXT NOT NULL,
  valeur TEXT,
  stock INTEGER,
  cree_le INTEGER NOT NULL
);

CREATE TABLE inventaire (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  article_id INTEGER NOT NULL,
  article_nom TEXT NOT NULL,
  prix INTEGER NOT NULL,
  achete_le INTEGER NOT NULL
);

CREATE TABLE quetes (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  jour TEXT NOT NULL,
  quete_id TEXT NOT NULL,
  progression INTEGER NOT NULL DEFAULT 0,
  terminee INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, utilisateur_id, jour, quete_id)
);

CREATE TABLE series (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  actuelle INTEGER NOT NULL DEFAULT 0,
  record INTEGER NOT NULL DEFAULT 0,
  dernier_jour TEXT,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE formulaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  titre TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL,
  salon_id TEXT,
  cree_le INTEGER NOT NULL,
  UNIQUE (serveur_id, nom)
);

CREATE TABLE reponses_formulaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  formulaire TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  reponses TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'pending',
  traite_par TEXT,
  cree_le INTEGER NOT NULL
);

CREATE TABLE afk (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  raison TEXT NOT NULL,
  depuis INTEGER NOT NULL,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE boosts (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  nombre INTEGER NOT NULL DEFAULT 0,
  premier_boost_le INTEGER NOT NULL,
  dernier_boost_le INTEGER NOT NULL,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE concours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  message_id TEXT,
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'submissions',
  fin_participations_le INTEGER NOT NULL,
  fin_votes_le INTEGER NOT NULL,
  role_jury_id TEXT,
  recompense_pieces INTEGER NOT NULL DEFAULT 0,
  recompense_xp INTEGER NOT NULL DEFAULT 0,
  recompense_role_id TEXT,
  cree_par TEXT NOT NULL,
  cree_le INTEGER NOT NULL
);
CREATE INDEX idx_contests_status ON concours (statut);

CREATE TABLE participations_concours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concours_id INTEGER NOT NULL REFERENCES concours(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  contenu TEXT NOT NULL,
  message_id TEXT,
  cree_le INTEGER NOT NULL,
  UNIQUE (concours_id, utilisateur_id)
);

CREATE TABLE votes_concours (
  participation_id INTEGER NOT NULL REFERENCES participations_concours(id) ON DELETE CASCADE,
  utilisateur_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  jury INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (participation_id, utilisateur_id)
);

CREATE TABLE statistiques_jour (
  serveur_id TEXT NOT NULL,
  jour TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  arrivees INTEGER NOT NULL DEFAULT 0,
  departs INTEGER NOT NULL DEFAULT 0,
  secondes_vocal INTEGER NOT NULL DEFAULT 0,
  commandes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (serveur_id, jour)
);

CREATE TABLE sessions_vocales (
  serveur_id TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  salon_id TEXT NOT NULL,
  debut_le INTEGER NOT NULL,
  PRIMARY KEY (serveur_id, utilisateur_id)
);

CREATE TABLE verrouillages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  portee TEXT NOT NULL,
  cible_id TEXT NOT NULL,
  instantane TEXT NOT NULL,
  raison TEXT,
  cree_par TEXT NOT NULL,
  cree_le INTEGER NOT NULL,
  actif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE whitelists (
  portee TEXT NOT NULL,
  liste TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  ajoute_par TEXT,
  ajoute_le INTEGER NOT NULL,
  PRIMARY KEY (portee, liste, utilisateur_id)
);
CREATE INDEX idx_whitelists_user ON whitelists (utilisateur_id);

CREATE TABLE enseignes (
  cle TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  couleur INTEGER,
  pied TEXT,
  logo TEXT,
  fond TEXT,
  pseudo_twitch TEXT,
  liens TEXT NOT NULL DEFAULT '{}',
  emojis TEXT NOT NULL DEFAULT '{}',
  cree_le INTEGER NOT NULL,
  modifie_le INTEGER NOT NULL
);

CREATE TABLE serveurs_enseignes (
  serveur_id TEXT PRIMARY KEY,
  enseigne_cle TEXT NOT NULL REFERENCES enseignes(cle) ON DELETE CASCADE
);

CREATE TABLE liste_noire (
  portee TEXT NOT NULL,
  utilisateur_id TEXT NOT NULL,
  raison TEXT NOT NULL,
  ajoute_par TEXT NOT NULL,
  ajoute_le INTEGER NOT NULL,
  PRIMARY KEY (portee, utilisateur_id)
);

CREATE TABLE sauvegardes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serveur_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  fichier TEXT NOT NULL,
  taille INTEGER NOT NULL,
  cree_par TEXT NOT NULL,
  cree_le INTEGER NOT NULL
);
`,
  },
];

const registre = creerRegistre('db');

export type Parametre = string | number | bigint | null | boolean | undefined;

let base: DatabaseSync | null = null;
const requetes = new Map<string, StatementSync>();

function normaliser(parametres: Parametre[]): SQLInputValue[] {
  return parametres.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function preparer(requete: string): StatementSync {
  const d = lireBase();
  let instruction = requetes.get(requete);
  if (!instruction) {
    instruction = d.prepare(requete);
    requetes.set(requete, instruction);
  }
  return instruction;
}

export function lireBase(): DatabaseSync {
  if (!base) throw new Error('Base de données non initialisée (appeler openDatabase)');
  return base;
}

export function ouvrirBase(fichier: string = environnement.cheminBase): DatabaseSync {
  if (base) return base;
  if (fichier !== ':memory:') fs.mkdirSync(path.dirname(fichier), { recursive: true });
  base = new DatabaseSync(fichier);
  base.exec('PRAGMA journal_mode = WAL;');
  base.exec('PRAGMA foreign_keys = ON;');
  base.exec('PRAGMA busy_timeout = 5000;');
  base.exec('PRAGMA synchronous = NORMAL;');
  migrer(base);
  return base;
}

export function fermerBase(): void {
  requetes.clear();
  if (base) {
    try {
      base.close();
    } catch {}
  }
  base = null;
}

function migrer(d: DatabaseSync): void {
  d.exec('CREATE TABLE IF NOT EXISTS migrations_schema (version INTEGER PRIMARY KEY, nom TEXT NOT NULL, applique_le INTEGER NOT NULL)');
  const rangee = d.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM migrations_schema').get() as { v: number };
  const actuel = Number(rangee.v);
  for (const m of migrations) {
    if (m.version <= actuel) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.requete);
      d.prepare('INSERT INTO migrations_schema (version, nom, applique_le) VALUES (?, ?, ?)').run(m.version, m.nom, Date.now());
      d.exec('COMMIT');
      registre.info(`Migration ${m.version} appliquée : ${m.nom}`);
    } catch (echec) {
      d.exec('ROLLBACK');
      throw new Error(`Échec de la migration ${m.version} (${m.nom}) : ${(echec as Error).message}`);
    }
  }
}

export function executer(requete: string, ...parametres: Parametre[]): { changes: number; lastInsertRowid: number } {
  const r = preparer(requete).run(...normaliser(parametres));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function lire<T>(requete: string, ...parametres: Parametre[]): T | undefined {
  return preparer(requete).get(...normaliser(parametres)) as T | undefined;
}

export function lireTout<T>(requete: string, ...parametres: Parametre[]): T[] {
  return preparer(requete).all(...normaliser(parametres)) as T[];
}

let profondeurTransaction = 0;
export function transaction<T>(fonction: () => T): T {
  const d = lireBase();
  if (profondeurTransaction > 0) {
    profondeurTransaction++;
    try {
      return fonction();
    } finally {
      profondeurTransaction--;
    }
  }
  d.exec('BEGIN IMMEDIATE');
  profondeurTransaction = 1;
  try {
    const resultat = fonction();
    d.exec('COMMIT');
    return resultat;
  } catch (echec) {
    d.exec('ROLLBACK');
    throw echec;
  } finally {
    profondeurTransaction = 0;
  }
}

export function lireJson<T>(brut: unknown, secours: T): T {
  if (typeof brut !== 'string' || brut === '') return secours;
  try {
    return JSON.parse(brut) as T;
  } catch {
    return secours;
  }
}
