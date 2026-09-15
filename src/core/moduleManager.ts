import { lireTout, executer } from '../database/db';
import type { ModuleBot } from './types';

const modules = new Map<string, ModuleBot>();
const cache = new Map<string, Map<string, boolean>>();

export function enregistrerModules(liste: ModuleBot[]): void {
  modules.clear();
  for (const m of liste) {
    if (modules.has(m.id)) throw new Error(`Module en double : ${m.id}`);
    modules.set(m.id, m);
  }
}

export function lireModules(): ModuleBot[] {
  return [...modules.values()];
}

export function lireModule(id: string): ModuleBot | undefined {
  return modules.get(id);
}

function etatsServeur(serveurId: string): Map<string, boolean> {
  let etats = cache.get(serveurId);
  if (!etats) {
    etats = new Map();
    for (const rangee of lireTout<{ module: string; actif: number }>('SELECT module, actif FROM modules_serveurs WHERE serveur_id = ?', serveurId)) {
      etats.set(rangee.module, rangee.actif === 1);
    }
    cache.set(serveurId, etats);
  }
  return etats;
}

export function moduleActif(serveurId: string | null | undefined, moduleId: string): boolean {
  const module = modules.get(moduleId);
  // Module retiré du registre : considéré comme inactif, sans jamais planter.
  if (!module) return false;
  if (!module.desactivable) return true;
  if (!serveurId) return module.actifParDefaut;
  const etat = etatsServeur(serveurId).get(moduleId);
  return etat ?? module.actifParDefaut;
}

export function activerModule(serveurId: string, moduleId: string, actif: boolean): void {
  const module = modules.get(moduleId);
  if (!module) throw new Error(`Module inconnu : ${moduleId}`);
  if (!module.desactivable) return;
  executer(
    `INSERT INTO modules_serveurs (serveur_id, module, actif) VALUES (?, ?, ?)
     ON CONFLICT(serveur_id, module) DO UPDATE SET actif = excluded.actif`,
    serveurId,
    moduleId,
    actif ? 1 : 0,
  );
  etatsServeur(serveurId).set(moduleId, actif);
}

export function lireEtatsModules(serveurId: string): { module: ModuleBot; enabled: boolean }[] {
  return lireModules().map((module) => ({ module, enabled: moduleActif(serveurId, module.id) }));
}

export function viderCacheModules(serveurId?: string): void {
  if (serveurId) cache.delete(serveurId);
  else cache.clear();
}
