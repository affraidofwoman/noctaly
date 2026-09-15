import { lireTout, lire, executer } from '../database/db';

export interface DefinitionBadge {
  badge_id: string;
  nom: string;
  emoji: string;
  description: string;
}

/** Badges proposés par défaut sur chaque serveur (modifiables). */
export const BADGES_DEFAUT: DefinitionBadge[] = [
  { badge_id: 'og', nom: 'OG', emoji: '🏆', description: 'Membre de très longue date' },
  { badge_id: 'actif', nom: 'Actif', emoji: '⭐', description: 'Niveau 10 atteint' },
  { badge_id: 'giveaway', nom: 'Giveaway Winner', emoji: '🎉', description: 'A gagné un giveaway' },
  { badge_id: 'birthday', nom: 'Birthday', emoji: '🎂', description: 'A fêté son anniversaire ici' },
  { badge_id: 'vip', nom: 'VIP', emoji: '💎', description: 'Booste le serveur' },
  { badge_id: 'early', nom: 'Early Supporter', emoji: '🔥', description: 'Parmi les premiers membres' },
  { badge_id: 'gamer', nom: 'Gamer', emoji: '🎮', description: 'Participe aux événements gaming' },
  { badge_id: 'staff', nom: 'Staff', emoji: '🛡️', description: 'Membre de l’équipe' },
];

function assurerDefauts(serveurId: string): void {
  const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM badges WHERE serveur_id = ?', serveurId)?.n ?? 0;
  if (nombre > 0) return;
  for (const b of BADGES_DEFAUT) {
    executer('INSERT OR IGNORE INTO badges (serveur_id, badge_id, nom, emoji, description) VALUES (?, ?, ?, ?, ?)', serveurId, b.badge_id, b.nom, b.emoji, b.description);
  }
}

export function listerBadges(serveurId: string): DefinitionBadge[] {
  assurerDefauts(serveurId);
  return lireTout<DefinitionBadge>('SELECT badge_id, nom, emoji, description FROM badges WHERE serveur_id = ? ORDER BY nom COLLATE NOCASE', serveurId);
}

export function lireBadge(serveurId: string, badgeId: string): DefinitionBadge | undefined {
  assurerDefauts(serveurId);
  return lire<DefinitionBadge>('SELECT badge_id, nom, emoji, description FROM badges WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId);
}

export function enregistrerBadge(serveurId: string, badge: DefinitionBadge): void {
  assurerDefauts(serveurId);
  executer(
    `INSERT INTO badges (serveur_id, badge_id, nom, emoji, description) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, badge_id) DO UPDATE SET nom = excluded.nom, emoji = excluded.emoji, description = excluded.description`,
    serveurId,
    badge.badge_id,
    badge.nom,
    badge.emoji,
    badge.description,
  );
}

export function supprimerBadge(serveurId: string, badgeId: string): boolean {
  executer('DELETE FROM badges_membres WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId);
  return executer('DELETE FROM badges WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId).changes > 0;
}

/** Donne un badge (sans doublon). Retourne true s'il est nouveau. */
export function donnerBadge(serveurId: string, utilisateurId: string, badgeId: string, donnePar: string | null = null): boolean {
  if (!lireBadge(serveurId, badgeId)) return false;
  return executer('INSERT OR IGNORE INTO badges_membres (serveur_id, utilisateur_id, badge_id, donne_le, donne_par) VALUES (?, ?, ?, ?, ?)', serveurId, utilisateurId, badgeId, Date.now(), donnePar).changes > 0;
}

export function retirerBadge(serveurId: string, utilisateurId: string, badgeId: string): boolean {
  return executer('DELETE FROM badges_membres WHERE serveur_id = ? AND utilisateur_id = ? AND badge_id = ?', serveurId, utilisateurId, badgeId).changes > 0;
}

export function badgesMembre(serveurId: string, utilisateurId: string): (DefinitionBadge & { donne_le: number })[] {
  assurerDefauts(serveurId);
  return lireTout(
    `SELECT b.badge_id, b.nom, b.emoji, b.description, u.donne_le FROM badges_membres u
     JOIN badges b ON b.serveur_id = u.serveur_id AND b.badge_id = u.badge_id
     WHERE u.serveur_id = ? AND u.utilisateur_id = ? ORDER BY u.donne_le`,
    serveurId,
    utilisateurId,
  );
}
