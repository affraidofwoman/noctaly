import type { Client } from 'discord.js';
import { createLogger } from './logger';
import type { ScheduledTask } from './types';

const log = createLogger('scheduler');

interface TaskState {
  task: ScheduledTask;
  nextRun: number;
  running: boolean;
  failures: number;
}

/**
 * Planificateur unique : un seul timer pour toutes les tâches périodiques.
 * Une tâche ne peut jamais s'exécuter deux fois en parallèle, et une erreur n'affecte pas les autres.
 */
export class Scheduler {
  private readonly tasks = new Map<string, TaskState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly tickMs = 5_000) {}

  add(task: ScheduledTask): void {
    if (this.tasks.has(task.name)) throw new Error(`Tâche en double : ${task.name}`);
    this.tasks.set(task.name, {
      task,
      nextRun: Date.now() + (task.runOnStart ? 3_000 : task.intervalMs),
      running: false,
      failures: 0,
    });
  }

  start(client: Client<true>): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(client), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(client: Client<true>): void {
    const now = Date.now();
    for (const state of this.tasks.values()) {
      if (state.running || state.nextRun > now) continue;
      state.running = true;
      const started = Date.now();
      state.task
        .run(client)
        .then(() => {
          state.failures = 0;
          const elapsed = Date.now() - started;
          if (elapsed > 10_000) log.warn(`Tâche lente « ${state.task.name} » : ${elapsed} ms`);
        })
        .catch((err: unknown) => {
          state.failures++;
          log.error(`Tâche « ${state.task.name} » en échec (${state.failures})`, err);
        })
        .finally(() => {
          state.running = false;
          // Recul progressif en cas d'échecs répétés (max x8)
          const backoff = Math.min(8, 2 ** Math.max(0, state.failures - 1));
          state.nextRun = Date.now() + state.task.intervalMs * (state.failures ? backoff : 1);
        });
    }
  }
}

export const scheduler = new Scheduler();
