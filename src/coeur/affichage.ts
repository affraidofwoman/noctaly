import {
  ActionRowBuilder,
  type APIEmbedField,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  ModalBuilder,
  type RepliableInteraction,
  type Role,
  TextInputBuilder,
  TextInputStyle,
  type User,
} from 'discord.js';
import { aNiveau, emojiPour, type Enseigne, enseigneDe } from './acces';
import { journal } from './journaux';
import { type GestionnaireComposant } from './noyau';
import {
  CarteExpirante,
  creerRegistre,
  decrireErreurDiscord,
  ERREUR_GENERIQUE,
  ErreurUtilisateur,
  formaterDate,
  idCourt,
  partiesFuseau, Niveau } from './outils';
import { type CouleursTheme, hexaEnEntier, lireConfig, THEMES } from './reglages';

export type GenreEmbed = keyof CouleursTheme;

type RefServeur = Guild | string | null | undefined;

function idDe(serveur: RefServeur): string | null {
  if (!serveur) return null;
  return typeof serveur === 'string' ? serveur : serveur.id;
}

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

export function nomEnseigne(serveur: RefServeur): string {
  const enseigne = enseigneDuServeur(serveur);
  if (enseigne.cle) return enseigne.nom;
  return serveur && typeof serveur !== 'string' ? serveur.name : enseigne.nom;
}

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
  sujet?: string;
  emoji?: string;
  par?: User | null;
  champs?: APIEmbedField[];
  image?: string | null;
  vignette?: string | null;
}

export function puce(libelle: string, valeur?: string | number | null): string {
  const v = valeur === undefined || valeur === null || valeur === '' ? '' : ` — **${String(valeur).trim()}**`;
  return `• ${libelle.trim()}${v}`;
}

export function section(emoji: string, nom: string): string {
  return `${emoji ? `${emoji} ` : ''}**${nom.trim()}**`;
}

export function total(emoji: string, libelle: string, valeur: string | number): string {
  return `${emoji ? `${emoji} ` : ''}${libelle.trim()} : \`${String(valeur).trim()}\``;
}

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

export interface ContexteVariables {
  serveur?: Guild | null;
  membre?: GuildMember | null;
  utilisateur?: User | null;
  salon?: GuildBasedChannel | { id: string; toString(): string } | null;
  role?: Role | null;
  extra?: Record<string, string | number | null | undefined>;
  maintenant?: number;
}

export const DOCS_VARIABLES: Record<string, string> = {
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

export function remplirModele(modele: string, contexte: ContexteVariables): string {
  const utilisateur = contexte.membre?.user ?? contexte.utilisateur ?? null;
  const serveur = contexte.serveur ?? contexte.membre?.guild ?? null;
  const fuseau = serveur ? lireConfig(serveur.id).general.fuseau : 'Europe/Paris';
  const maintenant = contexte.maintenant ?? Date.now();
  const parties = partiesFuseau(maintenant, fuseau);

  const valeurs: Record<string, string | undefined> = {
    user: contexte.membre?.displayName ?? utilisateur?.globalName ?? utilisateur?.username,
    mention: utilisateur ? `<@${utilisateur.id}>` : undefined,
    username: utilisateur?.username,
    userid: utilisateur?.id,
    createdat: utilisateur ? formaterDate(utilisateur.createdTimestamp, fuseau, false) : undefined,
    server: serveur?.name,
    membercount: serveur ? String(serveur.memberCount) : undefined,
    channel: contexte.salon ? `<#${contexte.salon.id}>` : undefined,
    role: contexte.role ? `<@&${contexte.role.id}>` : undefined,
    date: `${String(parties.jour).padStart(2, '0')}/${String(parties.mois).padStart(2, '0')}/${parties.annee}`,
    time: `${String(parties.heure).padStart(2, '0')}:${String(parties.minute).padStart(2, '0')}`,
    boosts: serveur ? String(serveur.premiumSubscriptionCount ?? 0) : undefined,
    brand: serveur ? (enseigneDe(serveur.id).cle ? enseigneDe(serveur.id).nom : serveur.name) : enseigneDe(null).nom,
    twitch: serveur && enseigneDe(serveur.id).pseudoTwitch ? `https://twitch.tv/${enseigneDe(serveur.id).pseudoTwitch}` : undefined,
  };
  for (const [k, v] of Object.entries(contexte.extra ?? {})) {
    if (v !== undefined && v !== null) valeurs[k.toLowerCase()] = String(v);
  }

  return modele.replace(/\{([a-z_]+)\}/gi, (entier, nom: string) => {
    const valeur = valeurs[nom.toLowerCase()];
    return valeur === undefined ? entier : valeur;
  });
}

export function aideVariables(noms: string[]): string {
  return noms.map((n) => `\`{${n}}\` — ${DOCS_VARIABLES[n] ?? n}`).join('\n');
}

export interface ChampFenetre {
  id: string;
  libelle: string;
  description?: string;
  long?: boolean;
  obligatoire?: boolean;
  indication?: string;
  valeur?: string | null;
  longueurMin?: number;
  longueurMax?: number;
}

export function construireFormulaire(idPersonnalise: string, titre: string, champs: ChampFenetre[]): ModalBuilder {
  const fenetre = new ModalBuilder().setCustomId(idPersonnalise).setTitle(titre.slice(0, 45));
  for (const champ of champs.slice(0, 5)) {
    const saisie = new TextInputBuilder()
      .setCustomId(champ.id)
      .setStyle(champ.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(champ.obligatoire ?? true)
      .setMaxLength(Math.min(champ.longueurMax ?? (champ.long ? 4000 : 200), 4000));
    if (champ.longueurMin) saisie.setMinLength(champ.longueurMin);
    if (champ.indication) saisie.setPlaceholder(champ.indication.slice(0, 100));
    if (champ.valeur) saisie.setValue(champ.valeur.slice(0, champ.longueurMax ?? 4000));
    const libelle = new LabelBuilder().setLabel(champ.libelle.slice(0, 45)).setTextInputComponent(saisie);
    if (champ.description) libelle.setDescription(champ.description.slice(0, 100));
    fenetre.addLabelComponents(libelle);
  }
  return fenetre;
}

export function rangee<T extends MessageActionRowComponentBuilder>(...composants: T[]): ActionRowBuilder<T> {
  return new ActionRowBuilder<T>().addComponents(...composants);
}

export function bouton(idPersonnalise: string, libelle: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(idPersonnalise).setStyle(style);
  if (libelle) b.setLabel(libelle.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function boutonLien(url: string, libelle: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setURL(url).setLabel(libelle.slice(0, 80)).setStyle(ButtonStyle.Link);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function boutonBascule(idPersonnalise: string, libelle: string, actif: boolean): ButtonBuilder {
  return bouton(idPersonnalise, `${libelle} : ${actif ? 'activé' : 'désactivé'}`, actif ? ButtonStyle.Success : ButtonStyle.Secondary, actif ? '🟢' : '🔴');
}

export function estLienHttp(valeur: string): boolean {
  try {
    const u = new URL(valeur);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const registre = creerRegistre('interaction');

type ChargeReponse = Omit<InteractionReplyOptions, 'flags'> & { ephemeral?: boolean };

export async function repondre(interaction: RepliableInteraction, charge: ChargeReponse): Promise<void> {
  const { ephemeral: prive, ...reste } = charge;
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(reste as InteractionEditReplyOptions);
    } else if (interaction.replied) {
      await interaction.followUp({ ...reste, flags: prive ? MessageFlags.Ephemeral : undefined });
    } else {
      await interaction.reply({ ...reste, flags: prive ? MessageFlags.Ephemeral : undefined });
    }
  } catch (echec) {
    const code = (echec as { code?: number }).code;
    if (code !== 10062 && code !== 40060) registre.avertir('Réponse impossible', echec);
  }
}

export function repondreEmbed(interaction: RepliableInteraction, embed: EmbedBuilder, prive = true): Promise<void> {
  return repondre(interaction, { embeds: [embed], components: [], ephemeral: prive });
}

export function repondreSucces(interaction: RepliableInteraction, description: string, titre?: string, prive = true): Promise<void> {
  return repondreEmbed(interaction, ok(interaction.guild, description, titre ? { titre } : undefined), prive);
}

export function repondreErreur(interaction: RepliableInteraction, description: string, titre?: string): Promise<void> {
  return repondreEmbed(interaction, erreur(interaction.guild, description, titre ? { titre } : undefined), true);
}

export async function differerPrive(interaction: RepliableInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

export async function traiterErreurInteraction(interaction: RepliableInteraction, echec: unknown, portee: string): Promise<void> {
  if (echec instanceof ErreurUtilisateur) {
    await repondreErreur(interaction, echec.message);
    return;
  }
  const messageDiscord = decrireErreurDiscord(echec);
  if (messageDiscord) {
    registre.avertir(`[${portee}] ${messageDiscord}`);
    await repondreErreur(interaction, messageDiscord);
    return;
  }
  registre.erreur(`[${portee}] Erreur non gérée`, echec);
  if (interaction.guild) {
    void journal(interaction.guild, 'health', {
      titre: 'Erreur technique',
      ton: 'alerte',
      lignes: [`**Où** : \`${portee}\``, `**Par** : <@${interaction.user.id}>`, `\`\`\`${String((echec as Error)?.stack ?? echec).slice(0, 1500)}\`\`\``],
    });
  }
  await repondreErreur(interaction, `Une erreur est survenue.\n${ERREUR_GENERIQUE}`);
}

interface SessionPagination {
  proprietaireId: string;
  pages: EmbedBuilder[];
  indice: number;
}

const sessions = new CarteExpirante<string, SessionPagination>(10 * 60_000);

function rangees(id: string, session: SessionPagination) {
  const total = session.pages.length;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pg:${id}:prev`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(session.indice === 0),
      new ButtonBuilder()
        .setCustomId(`pg:${id}:noop`)
        .setLabel(`${session.indice + 1} / ${total}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder().setCustomId(`pg:${id}:next`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(session.indice >= total - 1),
      new ButtonBuilder().setCustomId(`pg:${id}:close`).setEmoji('❌').setStyle(ButtonStyle.Danger),
    ),
  ];
}

export async function paginer(interaction: RepliableInteraction, pages: EmbedBuilder[], prive = false): Promise<void> {
  if (pages.length === 0) return;
  if (pages.length === 1) {
    await repondre(interaction, { embeds: [pages[0]!], components: [], ephemeral: prive });
    return;
  }
  const id = idCourt();
  const session: SessionPagination = { proprietaireId: interaction.user.id, pages, indice: 0 };
  sessions.ecrire(id, session);
  await repondre(interaction, { embeds: [pages[0]!], components: rangees(id, session), ephemeral: prive });
}

export function lignesEnPages(lignes: string[], parPage: number, construire: (contenu: string, page: number, total: number) => EmbedBuilder): EmbedBuilder[] {
  const total = Math.max(1, Math.ceil(lignes.length / parPage));
  const pages: EmbedBuilder[] = [];
  for (let p = 0; p < total; p++) {
    pages.push(construire(lignes.slice(p * parPage, (p + 1) * parPage).join('\n'), p + 1, total));
  }
  return pages;
}

export const composantPagination: GestionnaireComposant = {
  prefixe: 'pg',
  async bouton(interaction: ButtonInteraction<'cached'>, [id, action]) {
    const session = id ? sessions.lire(id) : undefined;
    if (!session) {
      await interaction.reply({ content: '⌛ Cette pagination a expiré. Relance la commande.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== session.proprietaireId) {
      await interaction.reply({ content: "🔒 Seule la personne ayant lancé la commande peut utiliser ces boutons.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'close') {
      sessions.supprimer(id!);
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.update({ components: [] });
      } else {
        await interaction.message.delete().catch(() => interaction.update({ components: [] }));
      }
      return;
    }
    if (action === 'prev') session.indice = Math.max(0, session.indice - 1);
    if (action === 'next') session.indice = Math.min(session.pages.length - 1, session.indice + 1);
    sessions.prolonger(id!);
    await interaction.update({ embeds: [session.pages[session.indice]!], components: rangees(id!, session) });
  },
};

interface SessionConfirmation {
  proprietaireId: string;
  surConfirmation(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  surAnnulation?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

const sessionsConfirmation = new CarteExpirante<string, SessionConfirmation>(2 * 60_000);

export interface OptionsConfirmation {
  titre?: string;
  description?: string;
  libelleConfirmation?: string;
  surConfirmation(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  surAnnulation?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

export async function demanderConfirmation(interaction: RepliableInteraction, options: OptionsConfirmation): Promise<void> {
  const id = idCourt();
  sessionsConfirmation.ecrire(id, { proprietaireId: interaction.user.id, surConfirmation: options.surConfirmation, surAnnulation: options.surAnnulation });
  const embed = embedAvertissement(
    interaction.guild,
    `${options.description ?? 'Cette action est irréversible.'}\n\n-# Cette demande expire dans 2 minutes.`,
    options.titre ?? '⚠️ Êtes-vous sûr ?',
  );
  const rangee = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cf:${id}:yes`).setLabel(options.libelleConfirmation ?? 'Confirmer').setEmoji('✅').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cf:${id}:no`).setLabel('Annuler').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );
  await repondre(interaction, { embeds: [embed], components: [rangee], ephemeral: true });
}

export const composantConfirmation: GestionnaireComposant = {
  prefixe: 'cf',
  async bouton(interaction, [id, action]) {
    const session = id ? sessionsConfirmation.lire(id) : undefined;
    if (!session) {
      await interaction.update({ content: '⌛ Cette confirmation a expiré.', embeds: [], components: [] }).catch(() => undefined);
      return;
    }
    if (interaction.user.id !== session.proprietaireId) {
      await interaction.reply({ content: '🔒 Cette confirmation ne te concerne pas.', flags: MessageFlags.Ephemeral });
      return;
    }
    sessionsConfirmation.supprimer(id!);
    try {
      if (action === 'yes') await session.surConfirmation(interaction);
      else if (session.surAnnulation) await session.surAnnulation(interaction);
      else await interaction.update({ content: '❌ Action annulée.', embeds: [], components: [] });
    } catch (echec) {
      await traiterErreurInteraction(interaction, echec, 'confirmation');
    }
  },
};

export function rangeeCorbeille(serveurId: string | null, proprietaireId: string) {
  return rangee(bouton(`del:${proprietaireId}`, '', ButtonStyle.Secondary, emojiPour(serveurId, 'corbeille')));
}

export function boutonCorbeille(serveurId: string | null, proprietaireId: string) {
  return bouton(`del:${proprietaireId}`, '', ButtonStyle.Secondary, emojiPour(serveurId, 'corbeille'));
}

export const composantCorbeille: GestionnaireComposant = {
  prefixe: 'del',
  async bouton(interaction, [proprietaireId]) {
    const proprietaire = proprietaireId ?? interaction.message.interactionMetadata?.user.id ?? null;
    if (proprietaire && interaction.user.id !== proprietaire && !aNiveau(interaction.member, Niveau.MODERATEUR)) {
      await interaction.reply({
        embeds: [info(interaction.guild, 'Ce message appartient à la personne qui l’a ouvert.', { emoji: emojiPour(interaction.guildId, 'refus') })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    await interaction.message.delete().catch(async () => {
      await interaction.editReply({ components: [] }).catch(() => undefined);
    });
  },
};
