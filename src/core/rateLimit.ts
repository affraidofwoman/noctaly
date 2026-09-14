/** Limiteur à fenêtre glissante, en mémoire. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Enregistre un passage ; retourne false si la limite est dépassée. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  count(key: string, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Cooldowns par clé (ex : commande + utilisateur). */
export class Cooldowns {
  private readonly until = new Map<string, number>();

  /** Retourne le temps restant en ms (0 = disponible, et le cooldown est alors armé). */
  take(key: string, durationMs: number, now = Date.now()): number {
    const end = this.until.get(key) ?? 0;
    if (end > now) return end - now;
    this.until.set(key, now + durationMs);
    if (this.until.size > 5_000) {
      for (const [k, v] of this.until) if (v <= now) this.until.delete(k);
    }
    return 0;
  }
}
