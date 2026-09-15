import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { environnement } from '../core/env';
import { creerRegistre } from '../core/logger';
import { migrations } from './migrations';

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
    } catch {
      /* déjà fermée */
    }
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
