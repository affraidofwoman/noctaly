import fs from 'node:fs';
import path from 'node:path';
import type { Guild } from 'discord.js';
import { lireTout, lire, executer, transaction } from '../database/db';
import { environnement } from '../core/env';
import { viderCacheConfig } from '../core/guildConfig';
import { viderCacheModules } from '../core/moduleManager';
import { viderCacheWhitelists } from '../core/whitelists';

/** Tables de configuration sauvegardées par serveur (les données d'activité restent en place). */
export const TABLES: { table: string; filtre: string }[] = [
  { table: 'reglages_serveurs', filtre: 'serveur_id = ?' },
  { table: 'modules_serveurs', filtre: 'serveur_id = ?' },
  { table: 'whitelists', filtre: 'portee = ?' },
  { table: 'chaines_twitch', filtre: 'serveur_id = ?' },
  { table: 'panneaux_roles', filtre: 'serveur_id = ?' },
  { table: 'commandes_perso', filtre: 'serveur_id = ?' },
  { table: 'reponses_auto', filtre: 'serveur_id = ?' },
  { table: 'roles_niveaux', filtre: 'serveur_id = ?' },
  { table: 'badges', filtre: 'serveur_id = ?' },
  { table: 'articles_boutique', filtre: 'serveur_id = ?' },
  { table: 'formulaires', filtre: 'serveur_id = ?' },
  { table: 'liste_noire', filtre: 'portee = ?' },
];

export interface FichierSauvegarde {
  version: 1;
  serveurId: string;
  nomServeur: string;
  createdAt: number;
  tables: Record<string, Record<string, unknown>[]>;
  entrees: Record<string, unknown>[];
  structure: { roles: { name: string; color: number; position: number }[]; channels: { name: string; type: number; parent: string | null }[] };
}

function dossierDe(serveurId: string): string {
  const dossier = path.join(environnement.dossierSauvegardes, serveurId);
  fs.mkdirSync(dossier, { recursive: true });
  return dossier;
}

export function creerSauvegarde(serveur: Guild, creePar: string, nom = 'manuelle'): { id: number; file: string; size: number; data: FichierSauvegarde } {
  const tables: FichierSauvegarde['tables'] = {};
  for (const { table, filtre } of TABLES) tables[table] = lireTout<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${filtre}`, serveur.id);
  const panneauxIds = (tables.panneaux_roles ?? []).map((r) => Number(r.id));
  const entrees = panneauxIds.length ? lireTout<Record<string, unknown>>(`SELECT * FROM roles_panneaux WHERE panneau_id IN (${panneauxIds.map(() => '?').join(',')})`, ...panneauxIds) : [];
  const donnees: FichierSauvegarde = {
    version: 1,
    serveurId: serveur.id,
    nomServeur: serveur.name,
    createdAt: Date.now(),
    tables,
    entrees,
    structure: {
      roles: serveur.roles.cache.filter((r) => r.id !== serveur.id && !r.managed).map((r) => ({ name: r.name, color: r.color, position: r.position })),
      channels: serveur.channels.cache.map((c) => ({ name: c.name, type: c.type, parent: c.parent?.name ?? null })),
    },
  };
  const json = JSON.stringify(donnees);
  const fichier = path.join(dossierDe(serveur.id), `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(fichier, json, { mode: 0o600 });
  const r = executer('INSERT INTO sauvegardes (serveur_id, nom, fichier, taille, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?)', serveur.id, nom, fichier, json.length, creePar, Date.now());
  return { id: r.lastInsertRowid, file: fichier, size: json.length, data: donnees };
}

export function listerSauvegardes(serveurId: string): { id: number; nom: string; fichier: string; taille: number; cree_par: string; cree_le: number }[] {
  return lireTout('SELECT id, nom, fichier, taille, cree_par, cree_le FROM sauvegardes WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 25', serveurId);
}

/** Garde les N sauvegardes automatiques les plus récentes. */
export function purgerSauvegardesAuto(serveurId: string, garder = 7): void {
  const autos = lireTout<{ id: number; fichier: string }>("SELECT id, fichier FROM sauvegardes WHERE serveur_id = ? AND nom = 'automatique' ORDER BY cree_le DESC", serveurId);
  for (const ancien of autos.slice(garder)) {
    fs.rmSync(ancien.fichier, { force: true });
    executer('DELETE FROM sauvegardes WHERE id = ?', ancien.id);
  }
}

/** Restaure la configuration du bot d'un serveur. Ne modifie jamais les salons ni les rôles Discord. */
export function restaurerSauvegarde(serveurId: string, sauvegardeId: number): { tables: number; rows: number } {
  const rangee = lire<{ fichier: string }>('SELECT fichier FROM sauvegardes WHERE id = ? AND serveur_id = ?', sauvegardeId, serveurId);
  if (!rangee || !fs.existsSync(rangee.fichier)) throw new Error('Sauvegarde introuvable');
  const donnees = JSON.parse(fs.readFileSync(rangee.fichier, 'utf8')) as FichierSauvegarde;
  if (donnees.version !== 1 || donnees.serveurId !== serveurId) throw new Error('Cette sauvegarde ne correspond pas à ce serveur');
  let rangees = 0;
  transaction(() => {
    const anciensPanneaux = lireTout<{ id: number }>('SELECT id FROM panneaux_roles WHERE serveur_id = ?', serveurId).map((p) => p.id);
    for (const id of anciensPanneaux) executer('DELETE FROM roles_panneaux WHERE panneau_id = ?', id);
    for (const { table, filtre } of TABLES) {
      executer(`DELETE FROM ${table} WHERE ${filtre}`, serveurId);
      for (const enregistrer of donnees.tables[table] ?? []) {
        const cles = Object.keys(enregistrer);
        if (!cles.length || cles.some((k) => !/^[a-z_]+$/.test(k))) continue;
        executer(`INSERT INTO ${table} (${cles.join(', ')}) VALUES (${cles.map(() => '?').join(', ')})`, ...cles.map((k) => enregistrer[k] as string | number | null));
        rangees++;
      }
    }
    for (const enregistrer of donnees.entrees ?? []) {
      const cles = Object.keys(enregistrer);
      if (cles.some((k) => !/^[a-z_]+$/.test(k))) continue;
      executer(`INSERT OR IGNORE INTO roles_panneaux (${cles.join(', ')}) VALUES (${cles.map(() => '?').join(', ')})`, ...cles.map((k) => enregistrer[k] as string | number | null));
      rangees++;
    }
  });
  viderCacheConfig(serveurId);
  viderCacheModules(serveurId);
  viderCacheWhitelists();
  return { tables: TABLES.length, rows: rangees };
}
