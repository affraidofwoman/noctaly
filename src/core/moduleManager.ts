import { all, run } from '../database/db';
import type { BotModule } from './types';

const modules = new Map<string, BotModule>();
const cache = new Map<string, Map<string, boolean>>();

export function registerModules(list: BotModule[]): void {
  modules.clear();
  for (const m of list) {
    if (modules.has(m.id)) throw new Error(`Module en double : ${m.id}`);
    modules.set(m.id, m);
  }
}

export function getModules(): BotModule[] {
  return [...modules.values()];
}

export function getModule(id: string): BotModule | undefined {
  return modules.get(id);
}

function guildStates(guildId: string): Map<string, boolean> {
  let states = cache.get(guildId);
  if (!states) {
    states = new Map();
    for (const row of all<{ module: string; enabled: number }>('SELECT module, enabled FROM guild_modules WHERE guild_id = ?', guildId)) {
      states.set(row.module, row.enabled === 1);
    }
    cache.set(guildId, states);
  }
  return states;
}

export function isModuleEnabled(guildId: string | null | undefined, moduleId: string): boolean {
  const mod = modules.get(moduleId);
  // Module retiré du registre : considéré comme inactif, sans jamais planter.
  if (!mod) return false;
  if (!mod.toggleable) return true;
  if (!guildId) return mod.defaultEnabled;
  const state = guildStates(guildId).get(moduleId);
  return state ?? mod.defaultEnabled;
}

export function setModuleEnabled(guildId: string, moduleId: string, enabled: boolean): void {
  const mod = modules.get(moduleId);
  if (!mod) throw new Error(`Module inconnu : ${moduleId}`);
  if (!mod.toggleable) return;
  run(
    `INSERT INTO guild_modules (guild_id, module, enabled) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, module) DO UPDATE SET enabled = excluded.enabled`,
    guildId,
    moduleId,
    enabled ? 1 : 0,
  );
  guildStates(guildId).set(moduleId, enabled);
}

export function getModuleStates(guildId: string): { module: BotModule; enabled: boolean }[] {
  return getModules().map((module) => ({ module, enabled: isModuleEnabled(guildId, module.id) }));
}

export function clearModuleCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}
