import { environnement } from './env';

const NIVEAUX = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type NiveauRegistre = keyof typeof NIVEAUX;

const seuil = NIVEAUX[(environnement.niveauRegistre as NiveauRegistre) in NIVEAUX ? (environnement.niveauRegistre as NiveauRegistre) : 'info'];

function ecrire(niveau: NiveauRegistre, portee: string, message: string, extra?: unknown): void {
  if (NIVEAUX[niveau] < seuil) return;
  const ligne = `${new Date().toISOString()} ${niveau.toUpperCase().padEnd(5)} [${portee}] ${message}`;
  const sortie = niveau === 'error' || niveau === 'warn' ? console.error : console.log;
  if (extra === undefined) sortie(ligne);
  else if (extra instanceof Error) sortie(ligne, '\n', extra.stack ?? extra.message);
  else sortie(ligne, extra);
}

export interface Registre {
  debogage(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  avertir(message: string, extra?: unknown): void;
  erreur(message: string, extra?: unknown): void;
  enfant(portee: string): Registre;
}

export function creerRegistre(portee: string): Registre {
  return {
    debogage: (m, e) => ecrire('debug', portee, m, e),
    info: (m, e) => ecrire('info', portee, m, e),
    avertir: (m, e) => ecrire('warn', portee, m, e),
    erreur: (m, e) => ecrire('error', portee, m, e),
    enfant: (sousCommande) => creerRegistre(`${portee}:${sousCommande}`),
  };
}

export const registre = creerRegistre('bot');
