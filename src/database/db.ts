import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { env } from '../core/env';
import { createLogger } from '../core/logger';
import { migrations } from './migrations';

const log = createLogger('db');

export type Param = string | number | bigint | null | boolean | undefined;

let database: DatabaseSync | null = null;
const statements = new Map<string, StatementSync>();

function normalize(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function prepare(sql: string): StatementSync {
  const d = getDb();
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = d.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

export function getDb(): DatabaseSync {
  if (!database) throw new Error('Base de données non initialisée (appeler openDatabase)');
  return database;
}

export function openDatabase(file: string = env.databasePath): DatabaseSync {
  if (database) return database;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA synchronous = NORMAL;');
  migrate(database);
  return database;
}

export function closeDatabase(): void {
  statements.clear();
  if (database) {
    try {
      database.close();
    } catch {
      /* déjà fermée */
    }
  }
  database = null;
}

function migrate(d: DatabaseSync): void {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const row = d.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  const current = Number(row.v);
  for (const m of migrations) {
    if (m.version <= current) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
      d.exec('COMMIT');
      log.info(`Migration ${m.version} appliquée : ${m.name}`);
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`Échec de la migration ${m.version} (${m.name}) : ${(err as Error).message}`);
    }
  }
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const r = prepare(sql).run(...normalize(params));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return prepare(sql).get(...normalize(params)) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return prepare(sql).all(...normalize(params)) as T[];
}

let txDepth = 0;
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  if (txDepth > 0) {
    txDepth++;
    try {
      return fn();
    } finally {
      txDepth--;
    }
  }
  d.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth = 0;
  }
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
