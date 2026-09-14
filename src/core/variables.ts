import type { Guild, GuildBasedChannel, GuildMember, Role, User } from 'discord.js';
import { brandFor } from './brand';
import { getConfig } from './guildConfig';
import { formatDate, zonedParts } from './time';

export interface VariableContext {
  guild?: Guild | null;
  member?: GuildMember | null;
  user?: User | null;
  channel?: GuildBasedChannel | { id: string; toString(): string } | null;
  role?: Role | null;
  extra?: Record<string, string | number | null | undefined>;
  now?: number;
}

export const VARIABLE_DOCS: Record<string, string> = {
  user: "Nom d'affichage de l'utilisateur",
  mention: "Mention de l'utilisateur",
  username: "Nom d'utilisateur",
  userid: "Identifiant de l'utilisateur",
  createdat: 'Date de création du compte',
  server: 'Nom du serveur',
  membercount: 'Nombre de membres',
  channel: 'Mention du salon',
  role: 'Mention du rôle',
  date: 'Date du jour',
  time: 'Heure actuelle',
  streamer: 'Nom du streamer (Twitch)',
  game: 'Jeu/catégorie (Twitch)',
  title: 'Titre du live (Twitch)',
  viewers: 'Nombre de viewers (Twitch)',
  url: 'Lien du live (Twitch)',
  level: 'Niveau (XP)',
  boosts: 'Nombre de boosts du serveur',
  brand: 'Nom de l’enseigne du streamer',
  twitch: 'Lien de la chaîne Twitch de l’enseigne',
};

/** Remplace les variables {nom} connues. Les variables inconnues sont laissées intactes. */
export function renderTemplate(template: string, ctx: VariableContext): string {
  const user = ctx.member?.user ?? ctx.user ?? null;
  const guild = ctx.guild ?? ctx.member?.guild ?? null;
  const timezone = guild ? getConfig(guild.id).general.timezone : 'Europe/Paris';
  const now = ctx.now ?? Date.now();
  const parts = zonedParts(now, timezone);

  const values: Record<string, string | undefined> = {
    user: ctx.member?.displayName ?? user?.globalName ?? user?.username,
    mention: user ? `<@${user.id}>` : undefined,
    username: user?.username,
    userid: user?.id,
    createdat: user ? formatDate(user.createdTimestamp, timezone, false) : undefined,
    server: guild?.name,
    membercount: guild ? String(guild.memberCount) : undefined,
    channel: ctx.channel ? `<#${ctx.channel.id}>` : undefined,
    role: ctx.role ? `<@&${ctx.role.id}>` : undefined,
    date: `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`,
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    boosts: guild ? String(guild.premiumSubscriptionCount ?? 0) : undefined,
    brand: guild ? (brandFor(guild.id).key ? brandFor(guild.id).name : guild.name) : brandFor(null).name,
    twitch: guild && brandFor(guild.id).twitchLogin ? `https://twitch.tv/${brandFor(guild.id).twitchLogin}` : undefined,
  };
  for (const [k, v] of Object.entries(ctx.extra ?? {})) {
    if (v !== undefined && v !== null) values[k.toLowerCase()] = String(v);
  }

  return template.replace(/\{([a-z_]+)\}/gi, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

export function variablesHelp(names: string[]): string {
  return names.map((n) => `\`{${n}}\` — ${VARIABLE_DOCS[n] ?? n}`).join('\n');
}
