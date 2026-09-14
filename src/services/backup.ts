import fs from 'node:fs';
import path from 'node:path';
import type { Guild } from 'discord.js';
import { all, get, run, transaction } from '../database/db';
import { env } from '../core/env';
import { resetConfigCache } from '../core/guildConfig';
import { clearModuleCache } from '../core/moduleManager';
import { clearWhitelistCache } from '../core/whitelists';

/** Tables de configuration sauvegardées par serveur (les données d'activité restent en place). */
const TABLES: { table: string; where: string }[] = [
  { table: 'guild_settings', where: 'guild_id = ?' },
  { table: 'guild_modules', where: 'guild_id = ?' },
  { table: 'whitelists', where: 'scope = ?' },
  { table: 'twitch_channels', where: 'guild_id = ?' },
  { table: 'reaction_roles', where: 'guild_id = ?' },
  { table: 'custom_commands', where: 'guild_id = ?' },
  { table: 'auto_responses', where: 'guild_id = ?' },
  { table: 'levels', where: 'guild_id = ?' },
  { table: 'badges', where: 'guild_id = ?' },
  { table: 'shop_items', where: 'guild_id = ?' },
  { table: 'forms', where: 'guild_id = ?' },
  { table: 'blacklist', where: 'scope = ?' },
];

export interface BackupFile {
  version: 1;
  guildId: string;
  guildName: string;
  createdAt: number;
  tables: Record<string, Record<string, unknown>[]>;
  entries: Record<string, unknown>[];
  structure: { roles: { name: string; color: number; position: number }[]; channels: { name: string; type: number; parent: string | null }[] };
}

function dirFor(guildId: string): string {
  const dir = path.join(env.backupDir, guildId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createBackup(guild: Guild, createdBy: string, name = 'manuelle'): { id: number; file: string; size: number; data: BackupFile } {
  const tables: BackupFile['tables'] = {};
  for (const { table, where } of TABLES) tables[table] = all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where}`, guild.id);
  const panelIds = (tables.reaction_roles ?? []).map((r) => Number(r.id));
  const entries = panelIds.length ? all<Record<string, unknown>>(`SELECT * FROM reaction_role_entries WHERE panel_id IN (${panelIds.map(() => '?').join(',')})`, ...panelIds) : [];
  const data: BackupFile = {
    version: 1,
    guildId: guild.id,
    guildName: guild.name,
    createdAt: Date.now(),
    tables,
    entries,
    structure: {
      roles: guild.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => ({ name: r.name, color: r.color, position: r.position })),
      channels: guild.channels.cache.map((c) => ({ name: c.name, type: c.type, parent: c.parent?.name ?? null })),
    },
  };
  const json = JSON.stringify(data);
  const file = path.join(dirFor(guild.id), `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, json, { mode: 0o600 });
  const r = run('INSERT INTO backups (guild_id, name, file, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', guild.id, name, file, json.length, createdBy, Date.now());
  return { id: r.lastInsertRowid, file, size: json.length, data };
}

export function listBackups(guildId: string): { id: number; name: string; file: string; size: number; created_by: string; created_at: number }[] {
  return all('SELECT id, name, file, size, created_by, created_at FROM backups WHERE guild_id = ? ORDER BY created_at DESC LIMIT 25', guildId);
}

/** Garde les N sauvegardes automatiques les plus récentes. */
export function pruneAutoBackups(guildId: string, keep = 7): void {
  const autos = all<{ id: number; file: string }>("SELECT id, file FROM backups WHERE guild_id = ? AND name = 'automatique' ORDER BY created_at DESC", guildId);
  for (const old of autos.slice(keep)) {
    fs.rmSync(old.file, { force: true });
    run('DELETE FROM backups WHERE id = ?', old.id);
  }
}

/** Restaure la configuration du bot d'un serveur. Ne modifie jamais les salons ni les rôles Discord. */
export function restoreBackup(guildId: string, backupId: number): { tables: number; rows: number } {
  const row = get<{ file: string }>('SELECT file FROM backups WHERE id = ? AND guild_id = ?', backupId, guildId);
  if (!row || !fs.existsSync(row.file)) throw new Error('Sauvegarde introuvable');
  const data = JSON.parse(fs.readFileSync(row.file, 'utf8')) as BackupFile;
  if (data.version !== 1 || data.guildId !== guildId) throw new Error('Cette sauvegarde ne correspond pas à ce serveur');
  let rows = 0;
  transaction(() => {
    const oldPanels = all<{ id: number }>('SELECT id FROM reaction_roles WHERE guild_id = ?', guildId).map((p) => p.id);
    for (const id of oldPanels) run('DELETE FROM reaction_role_entries WHERE panel_id = ?', id);
    for (const { table, where } of TABLES) {
      run(`DELETE FROM ${table} WHERE ${where}`, guildId);
      for (const record of data.tables[table] ?? []) {
        const keys = Object.keys(record);
        if (!keys.length || keys.some((k) => !/^[a-z_]+$/.test(k))) continue;
        run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => record[k] as string | number | null));
        rows++;
      }
    }
    for (const record of data.entries ?? []) {
      const keys = Object.keys(record);
      if (keys.some((k) => !/^[a-z_]+$/.test(k))) continue;
      run(`INSERT OR IGNORE INTO reaction_role_entries (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => record[k] as string | number | null));
      rows++;
    }
  });
  resetConfigCache(guildId);
  clearModuleCache(guildId);
  clearWhitelistCache();
  return { tables: TABLES.length, rows };
}
