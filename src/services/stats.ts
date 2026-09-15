import { lire, executer } from '../database/db';
import { lireConfig } from '../core/guildConfig';
import { cleJour } from '../core/time';

export const COLONNES_JOUR = ['messages', 'arrivees', 'departs', 'secondes_vocal', 'commandes'] as const;
type ColonneJour = (typeof COLONNES_JOUR)[number];

/** Incrémente un compteur journalier du serveur (dans son fuseau horaire). */
export function incrementerJour(serveurId: string, colonne: ColonneJour, montant = 1): void {
  const jour = cleJour(Date.now(), lireConfig(serveurId).general.fuseau);
  executer(
    `INSERT INTO statistiques_jour (serveur_id, jour, ${colonne}) VALUES (?, ?, ?)
     ON CONFLICT(serveur_id, jour) DO UPDATE SET ${colonne} = ${colonne} + excluded.${colonne}`,
    serveurId,
    jour,
    montant,
  );
}

/** Profil d'activité d'un membre (créé à la première rencontre). */
export function noterMembre(serveurId: string, utilisateurId: string): void {
  executer('INSERT OR IGNORE INTO membres (serveur_id, utilisateur_id, vu_le) VALUES (?, ?, ?)', serveurId, utilisateurId, Date.now());
}

export function incrementerMembre(serveurId: string, utilisateurId: string, colonne: 'messages' | 'secondes_vocal', montant = 1): void {
  executer(
    `INSERT INTO membres (serveur_id, utilisateur_id, vu_le, ${colonne}) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET ${colonne} = ${colonne} + excluded.${colonne}`,
    serveurId,
    utilisateurId,
    Date.now(),
    montant,
  );
}

export function activiteMembre(serveurId: string, utilisateurId: string): { messages: number; secondes_vocal: number; vu_le: number } | undefined {
  return lire('SELECT messages, secondes_vocal, vu_le FROM membres WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId);
}
