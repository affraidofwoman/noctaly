/** Limiteur à fenêtre glissante, en mémoire. */
export class LimiteurFenetre {
  private readonly passages = new Map<string, number[]>();
  private dernierNettoyage = Date.now();

  constructor(
    private readonly limite: number,
    private readonly fenetreMs: number,
  ) {}

  /** Enregistre un passage ; retourne false si la limite est dépassée. */
  compter(cle: string, maintenant = Date.now()): boolean {
    this.nettoyer(maintenant);
    const liste = (this.passages.get(cle) ?? []).filter((t) => maintenant - t < this.fenetreMs);
    if (liste.length >= this.limite) {
      this.passages.set(cle, liste);
      return false;
    }
    liste.push(maintenant);
    this.passages.set(cle, liste);
    return true;
  }

  nombre(cle: string, maintenant = Date.now()): number {
    return (this.passages.get(cle) ?? []).filter((t) => maintenant - t < this.fenetreMs).length;
  }

  reinitialiser(cle: string): void {
    this.passages.delete(cle);
  }

  private nettoyer(maintenant: number): void {
    if (maintenant - this.dernierNettoyage < 60_000) return;
    this.dernierNettoyage = maintenant;
    for (const [k, liste] of this.passages) {
      if (liste.every((t) => maintenant - t >= this.fenetreMs)) this.passages.delete(k);
    }
  }
}

/** Cooldowns par clé (ex : commande + utilisateur). */
export class Delais {
  private readonly jusqua = new Map<string, number>();

  /** Retourne le temps restant en ms (0 = disponible, et le cooldown est alors armé). */
  prendre(cle: string, dureeMs: number, maintenant = Date.now()): number {
    const fin = this.jusqua.get(cle) ?? 0;
    if (fin > maintenant) return fin - maintenant;
    this.jusqua.set(cle, maintenant + dureeMs);
    if (this.jusqua.size > 5_000) {
      for (const [k, v] of this.jusqua) if (v <= maintenant) this.jusqua.delete(k);
    }
    return 0;
  }
}
