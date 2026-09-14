export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export { escapeMarkdown } from 'discord.js';

/** Neutralise les mentions de masse dans un texte fourni par un utilisateur. */
export function neutralizeMentions(value: string): string {
  return value.replace(/@(everyone|here)/gi, '@\u200b$1');
}

export function progressBar(ratio: number, size = 12): string {
  const r = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(r * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${Math.abs(count) > 1 ? pluralForm : singular}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR').format(value);
}

export function slugify(value: string, max = 90): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'x'
  );
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

export function medal(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
}
