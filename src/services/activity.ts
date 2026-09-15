import type { Client } from 'discord.js';
import { creerRegistre } from '../core/logger';

const registre = creerRegistre('activite');

export type TypeActivite = 'messages' | 'voice_minutes' | 'giveaways' | 'daily';

export interface EvenementActivite {
  serveurId: string;
  utilisateurId: string;
  type: TypeActivite;
  montant: number;
}

type Ecouteur = (evenement: EvenementActivite, client: Client | null) => void;
const ecouteurs: Ecouteur[] = [];
let clientLie: Client | null = null;

export function lierClientActivite(client: Client): void {
  clientLie = client;
}

/** Les modules (quêtes, succès…) s'abonnent à l'activité sans dépendre des modules qui la produisent. */
export function surActivite(ecouteur: Ecouteur): void {
  ecouteurs.push(ecouteur);
}

export function emettreActivite(evenement: EvenementActivite): void {
  for (const l of ecouteurs) {
    try {
      l(evenement, clientLie);
    } catch (echec) {
      registre.avertir(`Écouteur d’activité en échec : ${(echec as Error).message}`);
    }
  }
}
