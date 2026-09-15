export function tronquer(valeur: string, max: number): string {
  if (valeur.length <= max) return valeur;
  return `${valeur.slice(0, Math.max(0, max - 1))}…`;
}

export { escapeMarkdown } from 'discord.js';

/** Neutralise les mentions de masse dans un texte fourni par un utilisateur. */
export function neutraliserMentions(valeur: string): string {
  return valeur.replace(/@(everyone|here)/gi, '@\u200b$1');
}

export function barreProgression(taux: number, taille = 12): string {
  const r = Math.min(1, Math.max(0, Number.isFinite(taux) ? taux : 0));
  const rempli = Math.round(r * taille);
  return `${'▰'.repeat(rempli)}${'▱'.repeat(taille - rempli)}`;
}

export function pluriel(nombre: number, singulier: string, formePlurielle = `${singulier}s`): string {
  return `${nombre} ${Math.abs(nombre) > 1 ? formePlurielle : singulier}`;
}

export function formaterNombre(valeur: number): string {
  return new Intl.NumberFormat('fr-FR').format(valeur);
}

export function identifiantDepuisTexte(valeur: string, max = 90): string {
  return (
    valeur
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'x'
  );
}

export function decouper<T>(articles: T[], taille: number): T[][] {
  const sortie: T[][] = [];
  for (let i = 0; i < articles.length; i += taille) sortie.push(articles.slice(i, i + taille));
  return sortie;
}

export function estIdentifiant(valeur: string): boolean {
  return /^\d{17,20}$/.test(valeur);
}

export function medaille(rang: number): string {
  return rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉' : `**${rang}.**`;
}
