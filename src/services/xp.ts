import { lireTout, lire, executer } from '../database/db';

/** XP nécessaire pour passer du niveau `level` au suivant (formule façon MEE6). */
export function xpPourSuivant(niveau: number): number {
  return 5 * niveau * niveau + 50 * niveau + 100;
}

/** XP totale nécessaire pour atteindre un niveau. */
export function xpTotalePourNiveau(niveau: number): number {
  let total = 0;
  for (let l = 0; l < niveau; l++) total += xpPourSuivant(l);
  return total;
}

export function niveauDepuisXp(xp: number): { niveau: number; actuel: number; requis: number } {
  let niveau = 0;
  let reste = Math.max(0, Math.floor(xp));
  while (reste >= xpPourSuivant(niveau) && niveau < 1000) {
    reste -= xpPourSuivant(niveau);
    niveau++;
  }
  return { niveau, actuel: reste, requis: xpPourSuivant(niveau) };
}

export interface LigneXp {
  utilisateur_id: string;
  xp: number;
  niveau: number;
  dernier_message_le: number;
}

export function lireXp(serveurId: string, utilisateurId: string): LigneXp {
  return lire<LigneXp>('SELECT utilisateur_id, xp, niveau, dernier_message_le FROM xp WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId) ?? { utilisateur_id: utilisateurId, xp: 0, niveau: 0, dernier_message_le: 0 };
}

export function niveauDe(serveurId: string, utilisateurId: string): number {
  return lireXp(serveurId, utilisateurId).niveau;
}

/** Ajoute (ou retire) de l'XP. Retourne l'ancien et le nouveau niveau. */
export function ajouterXp(serveurId: string, utilisateurId: string, montant: number, noterMessage = false): { ancienNiveau: number; nouveauNiveau: number; xp: number } {
  const avant = lireXp(serveurId, utilisateurId);
  const xp = Math.max(0, avant.xp + Math.round(montant));
  const nouveauNiveau = niveauDepuisXp(xp).niveau;
  executer(
    `INSERT INTO xp (serveur_id, utilisateur_id, xp, niveau, dernier_message_le) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET xp = excluded.xp, niveau = excluded.niveau, dernier_message_le = CASE WHEN ? THEN excluded.dernier_message_le ELSE xp.dernier_message_le END`,
    serveurId,
    utilisateurId,
    xp,
    nouveauNiveau,
    noterMessage ? Date.now() : avant.dernier_message_le,
    noterMessage ? 1 : 0,
  );
  return { ancienNiveau: avant.niveau, nouveauNiveau, xp };
}

export function poserXp(serveurId: string, utilisateurId: string, xp: number): number {
  const niveau = niveauDepuisXp(xp).niveau;
  executer(
    `INSERT INTO xp (serveur_id, utilisateur_id, xp, niveau) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET xp = excluded.xp, niveau = excluded.niveau`,
    serveurId,
    utilisateurId,
    Math.max(0, Math.floor(xp)),
    niveau,
  );
  return niveau;
}

export function classement(serveurId: string, limite = 100, decalage = 0): LigneXp[] {
  return lireTout<LigneXp>('SELECT utilisateur_id, xp, niveau, dernier_message_le FROM xp WHERE serveur_id = ? AND xp > 0 ORDER BY xp DESC LIMIT ? OFFSET ?', serveurId, limite, decalage);
}

export function rangDe(serveurId: string, utilisateurId: string): number {
  const moi = lireXp(serveurId, utilisateurId);
  if (!moi.xp) return 0;
  return (lire<{ n: number }>('SELECT COUNT(*) AS n FROM xp WHERE serveur_id = ? AND xp > ?', serveurId, moi.xp)?.n ?? 0) + 1;
}

export function rolesNiveau(serveurId: string): { niveau: number; role_id: string }[] {
  return lireTout('SELECT niveau, role_id FROM roles_niveaux WHERE serveur_id = ? ORDER BY niveau ASC', serveurId);
}

export function poserRoleNiveau(serveurId: string, niveau: number, roleId: string): void {
  executer('INSERT OR IGNORE INTO roles_niveaux (serveur_id, niveau, role_id) VALUES (?, ?, ?)', serveurId, niveau, roleId);
}

export function retirerRoleNiveau(serveurId: string, roleId: string): number {
  return executer('DELETE FROM roles_niveaux WHERE serveur_id = ? AND role_id = ?', serveurId, roleId).changes;
}
