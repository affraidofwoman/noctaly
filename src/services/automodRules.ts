import type { GuildConfig } from '../core/guildConfig';
import { findBannedWord } from './badwords';

export type AutoModRule = 'invites' | 'links' | 'badWords' | 'mentions' | 'caps' | 'spam' | 'duplicates';

export const RULE_LABELS: Record<AutoModRule, { label: string; notice: string }> = {
  invites: { label: 'Invitation Discord', notice: 'les invitations Discord ne sont pas autorisées ici' },
  links: { label: 'Lien non autorisé', notice: 'ce lien n’est pas autorisé ici' },
  badWords: { label: 'Mot interdit', notice: 'ce message contient un mot interdit' },
  mentions: { label: 'Mentions excessives', notice: 'trop de mentions dans un seul message' },
  caps: { label: 'Majuscules excessives', notice: 'merci d’éviter d’écrire tout en majuscules' },
  spam: { label: 'Spam', notice: 'tu envoies des messages trop vite' },
  duplicates: { label: 'Répétition', notice: 'merci de ne pas répéter le même message' },
};

const INVITE = /(?:discord(?:app)?\.(?:gg|com\/invite|io|me|li)|dsc\.gg|invite\.gg)\/[\w-]+/i;
const URL = /\bhttps?:\/\/([^\s/$.?#][^\s/]*)/gi;

export function hasInvite(content: string): boolean {
  return INVITE.test(content);
}

/** Domaine autorisé si identique ou sous-domaine d'une entrée de la whitelist. */
export function isAllowedDomain(host: string, whitelist: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  return whitelist.some((d) => {
    const domain = d.toLowerCase().trim().replace(/^www\./, '');
    return domain && (h === domain || h.endsWith(`.${domain}`));
  });
}

export function forbiddenLink(content: string, whitelist: string[]): string | null {
  URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL.exec(content)) !== null) {
    if (!isAllowedDomain(m[1]!, whitelist)) return m[1]!;
  }
  return null;
}

export function capsRatio(content: string): { letters: number; ratio: number } {
  const letters = content.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (!letters.length) return { letters: 0, ratio: 0 };
  const upper = letters.filter((l) => l !== l.toLowerCase() && l === l.toUpperCase()).length;
  return { letters: letters.length, ratio: upper / letters.length };
}

export interface ContentVerdict {
  rule: AutoModRule;
  detail: string;
}

/** Règles sans état (évaluées sur un seul message). */
export function checkContent(cfg: GuildConfig['automod'], content: string, mentionCount: number, mentionsEveryone: boolean): ContentVerdict | null {
  if (cfg.invites.enabled && hasInvite(content)) return { rule: 'invites', detail: content.match(INVITE)?.[0] ?? '' };
  if (cfg.links.enabled) {
    const link = forbiddenLink(content, cfg.links.whitelist);
    if (link) return { rule: 'links', detail: link };
  }
  if (cfg.badWords.enabled) {
    const word = findBannedWord(cfg.badWords.words, content);
    if (word) return { rule: 'badWords', detail: word };
  }
  if (cfg.mentions.enabled && (mentionCount > cfg.mentions.max || mentionsEveryone)) {
    return { rule: 'mentions', detail: mentionsEveryone ? '@everyone/@here' : `${mentionCount} mentions` };
  }
  if (cfg.caps.enabled) {
    const { letters, ratio } = capsRatio(content);
    if (letters >= cfg.caps.minLength && ratio * 100 >= cfg.caps.percent) return { rule: 'caps', detail: `${Math.round(ratio * 100)} %` };
  }
  return null;
}

export function normalizeForDuplicate(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}
