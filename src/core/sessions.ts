import { randomBytes } from 'node:crypto';

/** Map avec expiration, nettoyée paresseusement (aucun timer permanent par entrée). */
export class TtlMap<K, V> {
  private readonly store = new Map<K, { value: V; expires: number }>();
  private lastSweep = Date.now();

  constructor(private readonly ttlMs: number) {}

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    this.sweep();
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  touch(key: K, ttlMs = this.ttlMs): void {
    const entry = this.store.get(key);
    if (entry) entry.expires = Date.now() + ttlMs;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  get size(): number {
    this.sweep(true);
    return this.store.size;
  }

  values(): V[] {
    this.sweep(true);
    return [...this.store.values()].map((e) => e.value);
  }

  private sweep(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, e] of this.store) if (e.expires < now) this.store.delete(k);
  }
}

export function shortId(bytes = 6): string {
  return randomBytes(bytes).toString('base64url');
}
