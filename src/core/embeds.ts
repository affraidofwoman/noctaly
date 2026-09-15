import { EmbedBuilder, type APIEmbedField, type Guild, type User } from 'discord.js';
import { enseigneDe, emojiPour, type Enseigne } from './brand';
import { lireConfig } from './guildConfig';
import { hexaEnEntier, THEMES, type CouleursTheme } from './themes';

export type GenreEmbed = keyof CouleursTheme;

type RefServeur = Guild | string | null | undefined;

function idDe(serveur: RefServeur): string | null {
  if (!serveur) return null;
  return typeof serveur === 'string' ? serveur : serveur.id;
}

/** Tons d'état repris du bot Airline, utilisés avec le thème "enseigne". */
const TONS_ENSEIGNE: Omit<CouleursTheme, 'primary'> = {
  success: '#3FE08F',
  error: '#E0455A',
  warning: '#F0B232',
  info: '#46C8FF',
};

export function couleurPour(serveur: RefServeur, genre: GenreEmbed = 'primary'): number {
  const id = idDe(serveur);
  const enseigne = enseigneDe(id);
  if (!id) return genre === 'primary' ? enseigne.couleur : hexaEnEntier(TONS_ENSEIGNE[genre]);
  const general = lireConfig(id).general;
  if (general.theme === 'brand') return genre === 'primary' ? enseigne.couleur : hexaEnEntier(TONS_ENSEIGNE[genre]);
  if (general.theme === 'custom') return hexaEnEntier(general.colors[genre]);
  return hexaEnEntier(THEMES[general.theme]?.colors[genre] ?? general.colors[genre]);
}

export function enseigneDuServeur(serveur: RefServeur): Enseigne {
  return enseigneDe(idDe(serveur));
}

/** Nom affiché : enseigne du streamer, sinon nom du serveur. */
export function nomEnseigne(serveur: RefServeur): string {
  const enseigne = enseigneDuServeur(serveur);
  if (enseigne.cle) return enseigne.nom;
  return serveur && typeof serveur !== 'string' ? serveur.name : enseigne.nom;
}

/** Embed à l'identité visuelle du serveur (enseigne du streamer ou thème choisi). */
export function embedEnseigne(serveur: RefServeur, genre: GenreEmbed = 'primary'): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(couleurPour(serveur, genre));
  if (serveur && typeof serveur !== 'string') {
    const enseigne = enseigneDuServeur(serveur);
    const enseignes = lireConfig(serveur.id).general.footer;
    const texte = enseignes || enseigne.pied || nomEnseigne(serveur);
    embed.setFooter({ text: texte.slice(0, 2048), iconURL: enseigne.logo ?? serveur.iconURL() ?? undefined });
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
export function signer(embed: EmbedBuilder, utilisateur: User | null | undefined): EmbedBuilder {
  if (!utilisateur) return embed;
  return embed.setFooter({ text: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) }).setTimestamp();
}

function bati(serveur: RefServeur, genre: GenreEmbed, emojiParDefaut: string, texte: string, options: ReponseOptions = {}): EmbedBuilder {
  const emoji = options.emoji ?? emojiParDefaut;
  const embed = new EmbedBuilder().setColor(couleurPour(serveur, genre));
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

export const ok = (serveur: RefServeur, texte: string, options?: ReponseOptions) => bati(serveur, 'success', emojiPour(idDe(serveur), 'valide'), texte, options);
export const erreur = (serveur: RefServeur, texte: string, options?: ReponseOptions) => bati(serveur, 'error', emojiPour(idDe(serveur), 'probleme'), texte, options);
export const refus = (serveur: RefServeur, texte: string, options?: ReponseOptions) => bati(serveur, 'error', emojiPour(idDe(serveur), 'refus'), texte, options);
export const info = (serveur: RefServeur, texte: string, options?: ReponseOptions) => bati(serveur, 'primary', emojiPour(idDe(serveur), 'info'), texte, options);
export const attention = (serveur: RefServeur, texte: string, options?: ReponseOptions) => bati(serveur, 'warning', emojiPour(idDe(serveur), 'attention'), texte, options);

export interface PanneauSection {
  emoji: string;
  nom: string;
  texte?: string;
  lignes?: (string | [string, string | number | null | undefined])[];
}

/** Panneau complet : titre, ouverture, sections à puces, totaux. */
export function panneau(
  serveur: RefServeur,
  opts: { sujet?: string; titre?: string; ouverture?: string; sections?: PanneauSection[]; totaux?: { emoji: string; libelle: string; valeur: string | number }[]; texte?: string; par?: User | null },
): EmbedBuilder {
  const embed = embedEnseigne(serveur);
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
export function embedSucces(serveur: RefServeur, description: string, titre = 'C’est fait'): EmbedBuilder {
  return ok(serveur, description, { titre });
}

export function embedErreur(serveur: RefServeur, description: string, titre = 'Une erreur est survenue'): EmbedBuilder {
  return erreur(serveur, description, { titre });
}

export function embedAvertissement(serveur: RefServeur, description: string, titre = 'Êtes-vous sûr ?'): EmbedBuilder {
  return attention(serveur, description, { titre });
}

export function embedInfo(serveur: RefServeur, description: string, titre = 'Information'): EmbedBuilder {
  return info(serveur, description, { titre });
}

export const SEPARATEUR = '━━━━━━━━━━━━━━━━━━';
