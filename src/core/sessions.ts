import { randomBytes } from 'node:crypto';

/** Map avec expiration, nettoyée paresseusement (aucun timer permanent par entrée). */
export class CarteExpirante<K, V> {
  private readonly stockage = new Map<K, { value: V; expires: number }>();
  private dernierNettoyage = Date.now();

  constructor(private readonly dureeVieMs: number) {}

  ecrire(cle: K, valeur: V, dureeVieMs = this.dureeVieMs): void {
    this.nettoyer();
    this.stockage.set(cle, { value: valeur, expires: Date.now() + dureeVieMs });
  }

  lire(cle: K): V | undefined {
    const entree = this.stockage.get(cle);
    if (!entree) return undefined;
    if (entree.expires < Date.now()) {
      this.stockage.delete(cle);
      return undefined;
    }
    return entree.value;
  }

  prolonger(cle: K, dureeVieMs = this.dureeVieMs): void {
    const entree = this.stockage.get(cle);
    if (entree) entree.expires = Date.now() + dureeVieMs;
  }

  possede(cle: K): boolean {
    return this.lire(cle) !== undefined;
  }

  supprimer(cle: K): boolean {
    return this.stockage.delete(cle);
  }

  get size(): number {
    this.nettoyer(true);
    return this.stockage.size;
  }

  valeurs(): V[] {
    this.nettoyer(true);
    return [...this.stockage.values()].map((e) => e.value);
  }

  private nettoyer(forcer = false): void {
    const maintenant = Date.now();
    if (!forcer && maintenant - this.dernierNettoyage < 60_000) return;
    this.dernierNettoyage = maintenant;
    for (const [k, e] of this.stockage) if (e.expires < maintenant) this.stockage.delete(k);
  }
}

export function idCourt(octets = 6): string {
  return randomBytes(octets).toString('base64url');
}
