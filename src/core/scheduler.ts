import type { Client } from 'discord.js';
import { creerRegistre } from './logger';
import type { TachePlanifiee } from './types';

const registre = creerRegistre('scheduler');

interface EtatTache {
  tache: TachePlanifiee;
  prochainPassage: number;
  enCours: boolean;
  echecs: number;
}

/**
 * Planificateur unique : un seul timer pour toutes les tâches périodiques.
 * Une tâche ne peut jamais s'exécuter deux fois en parallèle, et une erreur n'affecte pas les autres.
 */
export class Planificateur {
  private readonly taches = new Map<string, EtatTache>();
  private minuteur: NodeJS.Timeout | null = null;

  constructor(private readonly battementMs = 5_000) {}

  ajouter(tache: TachePlanifiee): void {
    if (this.taches.has(tache.nom)) throw new Error(`Tâche en double : ${tache.nom}`);
    this.taches.set(tache.nom, {
      tache,
      prochainPassage: Date.now() + (tache.auDemarrage ? 3_000 : tache.intervalleMs),
      enCours: false,
      echecs: 0,
    });
  }

  demarrer(client: Client<true>): void {
    if (this.minuteur) return;
    this.minuteur = setInterval(() => this.battement(client), this.battementMs);
    this.minuteur.unref();
  }

  arreter(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
  }

  private battement(client: Client<true>): void {
    const maintenant = Date.now();
    for (const etat of this.taches.values()) {
      if (etat.enCours || etat.prochainPassage > maintenant) continue;
      etat.enCours = true;
      const commence = Date.now();
      etat.tache
        .executer(client)
        .then(() => {
          etat.echecs = 0;
          const ecoule = Date.now() - commence;
          if (ecoule > 10_000) registre.avertir(`Tâche lente « ${etat.tache.nom} » : ${ecoule} ms`);
        })
        .catch((echec: unknown) => {
          etat.echecs++;
          registre.erreur(`Tâche « ${etat.tache.nom} » en échec (${etat.echecs})`, echec);
        })
        .finally(() => {
          etat.enCours = false;
          // Recul progressif en cas d'échecs répétés (max x8)
          const recul = Math.min(8, 2 ** Math.max(0, etat.echecs - 1));
          etat.prochainPassage = Date.now() + etat.tache.intervalleMs * (etat.echecs ? recul : 1);
        });
    }
  }
}

export const planificateur = new Planificateur();
