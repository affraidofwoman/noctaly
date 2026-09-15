import { lireTout, lire, executer, transaction } from '../database/db';
import { historiser } from '../core/logService';

export interface Portefeuille {
  solde: number;
  total_gagne: number;
  dernier_quotidien: number;
  serie_quotidien: number;
}

export function portefeuille(serveurId: string, utilisateurId: string): Portefeuille {
  return (
    lire<Portefeuille>('SELECT solde, total_gagne, dernier_quotidien, serie_quotidien FROM economie WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId) ?? {
      solde: 0,
      total_gagne: 0,
      dernier_quotidien: 0,
      serie_quotidien: 0,
    }
  );
}

/** Ajoute (ou retire si négatif) des pièces. Refuse de passer sous zéro. Retourne le nouveau solde. */
export function ajouterPieces(serveurId: string, utilisateurId: string, montant: number, raison = 'gain'): number {
  const valeur = Math.trunc(montant);
  return transaction(() => {
    const actuel = portefeuille(serveurId, utilisateurId);
    const suivant = actuel.solde + valeur;
    if (suivant < 0) throw new Error('solde insuffisant');
    executer(
      `INSERT INTO economie (serveur_id, utilisateur_id, solde, total_gagne) VALUES (?, ?, ?, ?)
       ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET solde = excluded.solde, total_gagne = economie.total_gagne + ?`,
      serveurId,
      utilisateurId,
      suivant,
      Math.max(0, valeur),
      Math.max(0, valeur),
    );
    if (Math.abs(valeur) >= 1000) historiser(serveurId, 'community', `coins-${raison}`, utilisateurId, null, { amount: valeur });
    return suivant;
  });
}

export function transferer(serveurId: string, depuis: string, vers: string, montant: number): { from: number; to: number } {
  if (!Number.isInteger(montant) || montant <= 0) throw new Error('montant invalide');
  return transaction(() => ({ from: ajouterPieces(serveurId, depuis, -montant, 'give'), to: ajouterPieces(serveurId, vers, montant, 'give') }));
}

export function noterQuotidien(serveurId: string, utilisateurId: string, instant: number, serie: number): void {
  executer(
    `INSERT INTO economie (serveur_id, utilisateur_id, dernier_quotidien, serie_quotidien) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET dernier_quotidien = excluded.dernier_quotidien, serie_quotidien = excluded.serie_quotidien`,
    serveurId,
    utilisateurId,
    instant,
    serie,
  );
}

export function plusRiches(serveurId: string, limite = 100): { utilisateur_id: string; solde: number }[] {
  return lireTout('SELECT utilisateur_id, solde FROM economie WHERE serveur_id = ? AND solde > 0 ORDER BY solde DESC LIMIT ?', serveurId, limite);
}

export interface ArticleBoutique {
  id: number;
  serveur_id: string;
  nom: string;
  description: string;
  emoji: string;
  prix: number;
  type: 'role' | 'badge' | 'item';
  valeur: string | null;
  stock: number | null;
}

export function articlesBoutique(serveurId: string): ArticleBoutique[] {
  return lireTout<ArticleBoutique>('SELECT * FROM articles_boutique WHERE serveur_id = ? ORDER BY prix', serveurId);
}

export function articleBoutique(serveurId: string, id: number): ArticleBoutique | undefined {
  return lire<ArticleBoutique>('SELECT * FROM articles_boutique WHERE serveur_id = ? AND id = ?', serveurId, id);
}

export function inventaire(serveurId: string, utilisateurId: string): { article_nom: string; prix: number; achete_le: number }[] {
  return lireTout('SELECT article_nom, prix, achete_le FROM inventaire WHERE serveur_id = ? AND utilisateur_id = ? ORDER BY achete_le DESC LIMIT 50', serveurId, utilisateurId);
}

/** Achat atomique : stock, solde et inventaire sont mis à jour ensemble. */
export function acheter(serveurId: string, utilisateurId: string, article: ArticleBoutique): number {
  return transaction(() => {
    const frais = articleBoutique(serveurId, article.id);
    if (!frais) throw new Error('article introuvable');
    if (frais.stock !== null && frais.stock <= 0) throw new Error('rupture de stock');
    const solde = ajouterPieces(serveurId, utilisateurId, -frais.prix, 'shop');
    if (frais.stock !== null) executer('UPDATE articles_boutique SET stock = stock - 1 WHERE id = ?', frais.id);
    executer('INSERT INTO inventaire (serveur_id, utilisateur_id, article_id, article_nom, prix, achete_le) VALUES (?, ?, ?, ?, ?, ?)', serveurId, utilisateurId, frais.id, frais.nom, frais.prix, Date.now());
    return solde;
  });
}
