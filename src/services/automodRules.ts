import type { ConfigServeur } from '../core/guildConfig';
import { trouverMotInterdit } from './badwords';

export type RegleAutomod = 'invites' | 'links' | 'badWords' | 'mentions' | 'caps' | 'spam' | 'duplicates';

export const LIBELLES_REGLES: Record<RegleAutomod, { label: string; avertissement: string }> = {
  invites: { label: 'Invitation Discord', avertissement: 'les invitations Discord ne sont pas autorisées ici' },
  links: { label: 'Lien non autorisé', avertissement: 'ce lien n’est pas autorisé ici' },
  badWords: { label: 'Mot interdit', avertissement: 'ce message contient un mot interdit' },
  mentions: { label: 'Mentions excessives', avertissement: 'trop de mentions dans un seul message' },
  caps: { label: 'Majuscules excessives', avertissement: 'merci d’éviter d’écrire tout en majuscules' },
  spam: { label: 'Spam', avertissement: 'tu envoies des messages trop vite' },
  duplicates: { label: 'Répétition', avertissement: 'merci de ne pas répéter le même message' },
};

const INVITATION = /(?:discord(?:app)?\.(?:gg|com\/invite|io|me|li)|dsc\.gg|invite\.gg)\/[\w-]+/i;
const LIEN = /\bhttps?:\/\/([^\s/$.?#][^\s/]*)/gi;

export function contientInvitation(contenu: string): boolean {
  return INVITATION.test(contenu);
}

/** Domaine autorisé si identique ou sous-domaine d'une entrée de la whitelist. */
export function domaineAutorise(organisateur: string, whitelist: string[]): boolean {
  const h = organisateur.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  return whitelist.some((d) => {
    const domaine = d.toLowerCase().trim().replace(/^www\./, '');
    return domaine && (h === domaine || h.endsWith(`.${domaine}`));
  });
}

export function lienInterdit(contenu: string, whitelist: string[]): string | null {
  LIEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIEN.exec(contenu)) !== null) {
    if (!domaineAutorise(m[1]!, whitelist)) return m[1]!;
  }
  return null;
}

export function tauxMajuscules(contenu: string): { lettres: number; taux: number } {
  const lettres = contenu.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (!lettres.length) return { lettres: 0, taux: 0 };
  const majuscule = lettres.filter((l) => l !== l.toLowerCase() && l === l.toUpperCase()).length;
  return { lettres: lettres.length, taux: majuscule / lettres.length };
}

export interface VerdictContenu {
  regle: RegleAutomod;
  detail: string;
}

/** Règles sans état (évaluées sur un seul message). */
export function verifierContenu(reglages: ConfigServeur['automod'], contenu: string, nombreMentions: number, mentionneTous: boolean): VerdictContenu | null {
  if (reglages.invites.enabled && contientInvitation(contenu)) return { regle: 'invites', detail: contenu.match(INVITATION)?.[0] ?? '' };
  if (reglages.liens.enabled) {
    const lien = lienInterdit(contenu, reglages.liens.whitelist);
    if (lien) return { regle: 'links', detail: lien };
  }
  if (reglages.motsInterdits.enabled) {
    const mot = trouverMotInterdit(reglages.motsInterdits.mots, contenu);
    if (mot) return { regle: 'badWords', detail: mot };
  }
  if (reglages.mentions.enabled && (nombreMentions > reglages.mentions.max || mentionneTous)) {
    return { regle: 'mentions', detail: mentionneTous ? '@everyone/@here' : `${nombreMentions} mentions` };
  }
  if (reglages.majuscules.enabled) {
    const { lettres, taux } = tauxMajuscules(contenu);
    if (lettres >= reglages.majuscules.minLength && taux * 100 >= reglages.majuscules.percent) return { regle: 'caps', detail: `${Math.round(taux * 100)} %` };
  }
  return null;
}

export function normaliserPourRepetition(contenu: string): string {
  return contenu.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}
