import { EmbedBuilder, type APIEmbedField, type Guild, type User } from 'discord.js';
import { brandFor, emojiFor, type Brand } from './brand';
import { getConfig } from './guildConfig';
import { hexToInt, THEMES, type ThemeColors } from './themes';

export type EmbedKind = keyof ThemeColors;

type GuildRef = Guild | string | null | undefined;

function idOf(guild: GuildRef): string | null {
  if (!guild) return null;
  return typeof guild === 'string' ? guild : guild.id;
}

/** Tons d'état repris du bot Airline, utilisés avec le thème "enseigne". */
const BRAND_TONES: Omit<ThemeColors, 'primary'> = {
  success: '#3FE08F',
  error: '#E0455A',
  warning: '#F0B232',
  info: '#46C8FF',
};

export function colorFor(guild: GuildRef, kind: EmbedKind = 'primary'): number {
  const id = idOf(guild);
  const brand = brandFor(id);
  if (!id) return kind === 'primary' ? brand.color : hexToInt(BRAND_TONES[kind]);
  const general = getConfig(id).general;
  if (general.theme === 'brand') return kind === 'primary' ? brand.color : hexToInt(BRAND_TONES[kind]);
  if (general.theme === 'custom') return hexToInt(general.colors[kind]);
  return hexToInt(THEMES[general.theme]?.colors[kind] ?? general.colors[kind]);
}

export function brandOf(guild: GuildRef): Brand {
  return brandFor(idOf(guild));
}

/** Nom affiché : enseigne du streamer, sinon nom du serveur. */
export function brandName(guild: GuildRef): string {
  const brand = brandOf(guild);
  if (brand.key) return brand.name;
  return guild && typeof guild !== 'string' ? guild.name : brand.name;
}

/** Embed à l'identité visuelle du serveur (enseigne du streamer ou thème choisi). */
export function brandEmbed(guild: GuildRef, kind: EmbedKind = 'primary'): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(colorFor(guild, kind));
  if (guild && typeof guild !== 'string') {
    const brand = brandOf(guild);
    const custom = getConfig(guild.id).general.footer;
    const text = custom || brand.footer || brandName(guild);
    embed.setFooter({ text: text.slice(0, 2048), iconURL: brand.logo ?? guild.iconURL() ?? undefined });
  }
  return embed;
}

export interface ReponseOptions {
  titre?: string;
  /** Émoji devant le titre (par défaut celui du type de réponse). */
  sujet?: string;
  emoji?: string;
  par?: User | null;
  champs?: APIEmbedField[];
  image?: string | null;
  vignette?: string | null;
}

/** Une ligne de liste : « • Libellé — **valeur** ». */
export function puce(libelle: string, valeur?: string | number | null): string {
  const v = valeur === undefined || valeur === null || valeur === '' ? '' : ` — **${String(valeur).trim()}**`;
  return `• ${libelle.trim()}${v}`;
}

/** Un intitulé de section : « emoji **Nom** ». */
export function section(emoji: string, nom: string): string {
  return `${emoji ? `${emoji} ` : ''}**${nom.trim()}**`;
}

/** Un chiffre mis en évidence : « emoji Libellé : `valeur` ». */
export function total(emoji: string, libelle: string, valeur: string | number): string {
  return `${emoji ? `${emoji} ` : ''}${libelle.trim()} : \`${String(valeur).trim()}\``;
}

/** Signe un embed : pied « tag » + horodatage. */
export function signer(embed: EmbedBuilder, user: User | null | undefined): EmbedBuilder {
  if (!user) return embed;
  return embed.setFooter({ text: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) }).setTimestamp();
}

function bati(guild: GuildRef, kind: EmbedKind, defaultEmoji: string, texte: string, options: ReponseOptions = {}): EmbedBuilder {
  const emoji = options.emoji ?? defaultEmoji;
  const embed = new EmbedBuilder().setColor(colorFor(guild, kind));
  if (options.titre) {
    embed.setTitle(`${options.sujet ?? emoji} ${options.titre}`.trim().slice(0, 256));
    embed.setDescription(texte.trim().slice(0, 4096) || null);
  } else {
    embed.setDescription(`${emoji} ${texte.trim()}`.slice(0, 4096));
  }
  if (options.champs?.length) embed.addFields(options.champs.slice(0, 25));
  if (options.image) embed.setImage(options.image);
  if (options.vignette) embed.setThumbnail(options.vignette);
  return signer(embed, options.par);
}

export const ok = (guild: GuildRef, texte: string, options?: ReponseOptions) => bati(guild, 'success', emojiFor(idOf(guild), 'valide'), texte, options);
export const erreur = (guild: GuildRef, texte: string, options?: ReponseOptions) => bati(guild, 'error', emojiFor(idOf(guild), 'probleme'), texte, options);
export const refus = (guild: GuildRef, texte: string, options?: ReponseOptions) => bati(guild, 'error', emojiFor(idOf(guild), 'refus'), texte, options);
export const info = (guild: GuildRef, texte: string, options?: ReponseOptions) => bati(guild, 'primary', emojiFor(idOf(guild), 'info'), texte, options);
export const attention = (guild: GuildRef, texte: string, options?: ReponseOptions) => bati(guild, 'warning', emojiFor(idOf(guild), 'attention'), texte, options);

export interface PanneauSection {
  emoji: string;
  nom: string;
  texte?: string;
  lignes?: (string | [string, string | number | null | undefined])[];
}

/** Panneau complet : titre, ouverture, sections à puces, totaux. */
export function panneau(
  guild: GuildRef,
  opts: { sujet?: string; titre?: string; ouverture?: string; sections?: PanneauSection[]; totaux?: { emoji: string; libelle: string; valeur: string | number }[]; texte?: string; par?: User | null },
): EmbedBuilder {
  const embed = brandEmbed(guild);
  if (opts.titre) embed.setTitle(`${opts.sujet ? `${opts.sujet} ` : ''}${opts.titre}`.slice(0, 256));
  const bloc: string[] = [];
  if (opts.ouverture) bloc.push(opts.ouverture.trim());
  for (const s of opts.sections ?? []) {
    const lignes = (s.lignes ?? []).map((l) => (Array.isArray(l) ? puce(l[0], l[1]) : puce(l)));
    if (!lignes.length && !s.texte) continue;
    bloc.push('', section(s.emoji, s.nom));
    if (s.texte) bloc.push(s.texte.trim());
    bloc.push(...lignes);
  }
  if (opts.totaux?.length) bloc.push('', ...opts.totaux.map((t) => total(t.emoji, t.libelle, t.valeur)));
  if (opts.texte) bloc.push('', opts.texte.trim());
  const corps = bloc.join('\n').trim();
  if (corps) embed.setDescription(corps.slice(0, 4096));
  return opts.par ? signer(embed, opts.par) : embed;
}

// Raccourcis historiques utilisés par le cœur.
export function successEmbed(guild: GuildRef, description: string, title = 'C’est fait'): EmbedBuilder {
  return ok(guild, description, { titre: title });
}

export function errorEmbed(guild: GuildRef, description: string, title = 'Une erreur est survenue'): EmbedBuilder {
  return erreur(guild, description, { titre: title });
}

export function warningEmbed(guild: GuildRef, description: string, title = 'Êtes-vous sûr ?'): EmbedBuilder {
  return attention(guild, description, { titre: title });
}

export function infoEmbed(guild: GuildRef, description: string, title = 'Information'): EmbedBuilder {
  return info(guild, description, { titre: title });
}

export const SEPARATOR = '━━━━━━━━━━━━━━━━━━';
