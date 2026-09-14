import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommandPayload } from '../src/core/deploy';
import { Dispatcher } from '../src/core/dispatcher';
import { clearSetupPages, registerSetupPages } from '../src/core/setup';
import { modules } from '../src/modules';
import { freshDatabase } from './helpers';

describe('intégrité du bot', () => {
  freshDatabase(modules);

  it('toutes les commandes slash sont valides et sous la limite Discord', () => {
    const payload = buildCommandPayload(modules);
    assert.ok(payload.length <= 100, `${payload.length} commandes`);
    for (const cmd of payload) {
      assert.match(cmd.name, /^[\p{Ll}\p{N}_-]{1,32}$/u, cmd.name);
      assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100, `description de /${cmd.name}`);
      assert.ok(JSON.stringify(cmd).length < 8000, `/${cmd.name} trop volumineuse`);
    }
  });

  it('aucun doublon de commande, préfixe ou composant (le dispatcher refuse les doublons)', () => {
    assert.doesNotThrow(() => new Dispatcher(modules, []));
  });

  it('chaque page de /setup tient dans les limites de composants Discord', () => {
    clearSetupPages();
    assert.doesNotThrow(() => registerSetupPages(modules.flatMap((m) => m.setupPages ?? [])));
  });

  it('chaque module a un identifiant unique et une description', () => {
    const ids = modules.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const m of modules) assert.ok(m.name && m.description && m.emoji, m.id);
    assert.ok(modules.some((m) => !m.toggleable), 'au moins un module cœur');
  });

  it('les pages de configuration pointent vers des modules existants', () => {
    for (const page of modules.flatMap((m) => m.setupPages ?? [])) {
      if (page.moduleId) assert.ok(ids().includes(page.moduleId), `${page.id} → ${page.moduleId}`);
    }
  });

  it('les tâches planifiées ont un nom unique et un intervalle raisonnable', () => {
    const tasks = modules.flatMap((m) => m.tasks ?? []);
    assert.equal(new Set(tasks.map((t) => t.name)).size, tasks.length);
    for (const t of tasks) assert.ok(t.intervalMs >= 5_000, t.name);
  });
});

function ids(): string[] {
  return modules.map((m) => m.id);
}
