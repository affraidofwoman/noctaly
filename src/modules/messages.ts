import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  type MessageReaction,
  type ModalSubmitInteraction,
  type PartialMessageReaction,
  type PartialUser,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type User,
} from 'discord.js';
import { botPeutGererRole, enHexa, enseigneDe, lireCouleur, PALETTES } from '../coeur/acces';
import {
  aideVariables,
  bouton,
  boutonLien,
  construireFormulaire,
  couleurPour,
  embedEnseigne,
  estLienHttp,
  info,
  ok,
  rangee,
  remplirModele,
  repondre,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout, transaction } from '../coeur/base';
import { journal } from '../coeur/journaux';
import { type CommandeSlash, type GestionnaireComposant, lireAiguilleur, type ModuleBot, type PanneauAffiche, prefixePanneau, sur } from '../coeur/noyau';
import { CarteExpirante, creerRegistre, Delais, ErreurUtilisateur, idCourt, neutraliserMentions, simplifier, tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';

export interface Brouillon {
  id: string;
  proprietaireId: string;
  serveurId: string;
  genre: 'embed' | 'announce';
  titre: string;
  description: string;
  couleur: number;
  url: string;
  nomAuteur: string;
  iconeAuteur: string;
  pied: string;
  image: string;
  miniature: string;
  horodatage: boolean;
  champs: { nom: string; valeur: string; enLigne: boolean }[];
  boutons: { libelle: string; url: string }[];
  contenu: string;
  salonId: string | null;
  roleId: string | null;
  mentionTous: boolean;
  messageAModifier: { salonId: string; messageId: string } | null;
}

const brouillons = new CarteExpirante<string, Brouillon>(45 * 60_000);

export const prefixeComposant = (d: Pick<Brouillon, 'genre'>) => (d.genre === 'announce' ? 'an' : 'eb');

export function nouveauBrouillon(serveur: Guild, proprietaireId: string, genre: Brouillon['genre']): Brouillon {
  const enseigne = enseigneDe(serveur.id);
  const brouillon: Brouillon = {
    id: idCourt(),
    proprietaireId,
    serveurId: serveur.id,
    genre,
    titre: genre === 'announce' ? '📢 NOUVELLE ANNONCE' : 'Titre de l’embed',
    description: genre === 'announce' ? 'Écris ton annonce ici.' : 'Description de l’embed.',
    couleur: couleurPour(serveur),
    url: '',
    nomAuteur: '',
    iconeAuteur: '',
    pied: enseigne.pied ?? (enseigne.cle ? enseigne.nom : serveur.name),
    image: '',
    miniature: '',
    horodatage: genre === 'announce',
    champs: [],
    boutons: genre === 'announce' && enseigne.pseudoTwitch ? [{ libelle: '🔴 Twitch', url: `https://twitch.tv/${enseigne.pseudoTwitch}` }] : [],
    contenu: '',
    salonId: null,
    roleId: null,
    mentionTous: false,
    messageAModifier: null,
  };
  brouillons.ecrire(brouillon.id, brouillon);
  return brouillon;
}

export function stockerBrouillon(brouillon: Brouillon): void {
  brouillons.ecrire(brouillon.id, brouillon);
}

function exigerBrouillon(id: string | undefined, utilisateurId: string): Brouillon {
  const brouillon = id ? brouillons.lire(id) : undefined;
  if (!brouillon) throw new ErreurUtilisateur('Ce brouillon a expiré (45 min). Relance la commande.');
  if (brouillon.proprietaireId !== utilisateurId) throw new ErreurUtilisateur('Ce brouillon appartient à quelqu’un d’autre.');
  brouillons.prolonger(id!);
  return brouillon;
}

export function construireEmbed(serveur: Guild, d: Brouillon): EmbedBuilder {
  const variables = { serveur };
  const embed = new EmbedBuilder().setColor(d.couleur);
  if (d.titre) embed.setTitle(tronquer(remplirModele(d.titre, variables), 256));
  if (d.description) embed.setDescription(tronquer(remplirModele(d.description, variables), 4096));
  if (d.url && estLienHttp(d.url)) embed.setURL(d.url);
  if (d.nomAuteur) embed.setAuthor({ name: tronquer(d.nomAuteur, 256), iconURL: estLienHttp(d.iconeAuteur) ? d.iconeAuteur : undefined });
  if (d.pied) embed.setFooter({ text: tronquer(remplirModele(d.pied, variables), 2048) });
  if (d.image && estLienHttp(d.image)) embed.setImage(d.image);
  if (d.miniature && estLienHttp(d.miniature)) embed.setThumbnail(d.miniature);
  if (d.horodatage) embed.setTimestamp();
  for (const f of d.champs.slice(0, 25)) embed.addFields({ name: tronquer(f.nom, 256), value: tronquer(f.valeur, 1024), inline: f.enLigne });
  if (!d.titre && !d.description && !d.champs.length && !d.image) embed.setDescription('​');
  return embed;
}

function rangeesLiens(d: Brouillon) {
  if (!d.boutons.length) return [];
  return [rangee(...d.boutons.slice(0, 5).map((b) => boutonLien(b.url, b.libelle)))];
}

export function affichageEditeur(serveur: Guild, d: Brouillon, note?: string) {
  const id = d.id;
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    rangee(
      bouton(`${prefixeComposant(d)}:text:${id}`, 'Modifier', ButtonStyle.Primary, '📝'),
      bouton(`${prefixeComposant(d)}:color:${id}`, 'Couleur', ButtonStyle.Secondary, '🎨'),
      bouton(`${prefixeComposant(d)}:image:${id}`, 'Image', ButtonStyle.Secondary, '🖼️'),
      bouton(`${prefixeComposant(d)}:field:${id}`, 'Champ', ButtonStyle.Secondary, '➕'),
      bouton(`${prefixeComposant(d)}:link:${id}`, 'Bouton', ButtonStyle.Secondary, '🔗'),
    ),
    rangee(
      bouton(`${prefixeComposant(d)}:meta:${id}`, 'Auteur & pied', ButtonStyle.Secondary, '👤'),
      bouton(`${prefixeComposant(d)}:ts:${id}`, d.horodatage ? 'Horodatage : oui' : 'Horodatage : non', d.horodatage ? ButtonStyle.Success : ButtonStyle.Secondary, '⏱️'),
      bouton(`${prefixeComposant(d)}:clear:${id}`, 'Vider champs & boutons', ButtonStyle.Secondary, '🧹').setDisabled(!d.champs.length && !d.boutons.length),
      bouton(`${prefixeComposant(d)}:publish:${id}`, d.messageAModifier ? 'Enregistrer' : 'Publier', ButtonStyle.Success, '📤'),
      bouton(`${prefixeComposant(d)}:cancel:${id}`, '', ButtonStyle.Danger, '✖️'),
    ),
  ];
  if (!d.messageAModifier) {
    const selecteurSalon = new ChannelSelectMenuBuilder()
      .setCustomId(`${prefixeComposant(d)}:chan:${id}`)
      .setPlaceholder('Salon de publication (ici par défaut)')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1);
    if (d.salonId) selecteurSalon.setDefaultChannels(d.salonId);
    const selecteurRole = new RoleSelectMenuBuilder().setCustomId(`${prefixeComposant(d)}:role:${id}`).setPlaceholder('Rôle à mentionner (aucun par défaut)').setMinValues(0).setMaxValues(1);
    if (d.roleId) selecteurRole.setDefaultRoles(d.roleId);
    composants.push(rangee(selecteurSalon), rangee(selecteurRole));
  }
  const entete = [
    note,
    `👁️ **Aperçu** — ${d.messageAModifier ? 'modification d’un message existant' : `publication dans ${d.salonId ? `<#${d.salonId}>` : 'ce salon'}${d.roleId ? ` avec <@&${d.roleId}>` : ''}`}`,
    `-# ${d.champs.length} champ(s) · ${d.boutons.length} bouton(s) · brouillon valable 45 min`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    content: entete,
    embeds: [construireEmbed(serveur, d)],
    components: [...composants, ...(rangeesLiens(d).length && composants.length < 5 ? rangeesLiens(d) : [])].slice(0, 5),
    allowedMentions: { parse: [] as [] },
  };
}

async function repondreEcran(interaction: ModalSubmitInteraction<'cached'> | ButtonInteraction<'cached'> | AnySelectMenuInteraction<'cached'>, d: Brouillon, note?: string) {
  const charge = affichageEditeur(interaction.guild, d, note);
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
  else await (interaction as ButtonInteraction<'cached'>).update(charge);
}

export async function surBoutonRedaction(interaction: ButtonInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = exigerBrouillon(id, interaction.user.id);
  switch (action) {
    case 'text':
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:textm:${d.id}`, 'Texte de l’embed', [
          { id: 'title', libelle: 'Titre', valeur: d.titre, obligatoire: false, longueurMax: 256 },
          { id: 'description', libelle: 'Description', long: true, valeur: d.description, obligatoire: false, longueurMax: 4000 },
          { id: 'url', libelle: 'Lien du titre (facultatif)', valeur: d.url, obligatoire: false, longueurMax: 500 },
          { id: 'content', libelle: 'Texte au-dessus de l’embed (facultatif)', long: true, valeur: d.contenu, obligatoire: false, longueurMax: 1500 },
        ]),
      );
    case 'color':
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:colorm:${d.id}`, 'Couleur', [
          { id: 'color', libelle: 'Code hexadécimal ou nom de ton', valeur: enHexa(d.couleur), longueurMax: 30, description: PALETTES.flatMap((p) => p.tons.map((t) => t.name)).slice(0, 12).join(', ') },
        ]),
      );
    case 'image':
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:imagem:${d.id}`, 'Images', [
          { id: 'image', libelle: 'Grande image (lien https)', valeur: d.image, obligatoire: false, longueurMax: 500 },
          { id: 'thumbnail', libelle: 'Miniature (lien https)', valeur: d.miniature, obligatoire: false, longueurMax: 500 },
        ]),
      );
    case 'field':
      if (d.champs.length >= 25) throw new ErreurUtilisateur('25 champs maximum.');
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:fieldm:${d.id}`, 'Nouveau champ', [
          { id: 'name', libelle: 'Titre du champ', longueurMax: 256 },
          { id: 'value', libelle: 'Contenu', long: true, longueurMax: 1024 },
          { id: 'inline', libelle: 'Sur la même ligne ? (oui/non)', valeur: 'non', obligatoire: false, longueurMax: 3 },
        ]),
      );
    case 'link':
      if (d.boutons.length >= 5) throw new ErreurUtilisateur('5 boutons maximum.');
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:linkm:${d.id}`, 'Bouton lien', [
          { id: 'label', libelle: 'Texte du bouton', longueurMax: 80, indication: '🔴 Twitch' },
          { id: 'url', libelle: 'Lien', longueurMax: 500, indication: 'https://twitch.tv/…' },
        ]),
      );
    case 'meta':
      return interaction.showModal(
        construireFormulaire(`${prefixeComposant(d)}:metam:${d.id}`, 'Auteur & pied de page', [
          { id: 'authorName', libelle: 'Auteur', valeur: d.nomAuteur, obligatoire: false, longueurMax: 256 },
          { id: 'authorIcon', libelle: 'Icône de l’auteur (lien)', valeur: d.iconeAuteur, obligatoire: false, longueurMax: 500 },
          { id: 'footer', libelle: 'Pied de page', valeur: d.pied, obligatoire: false, longueurMax: 2048 },
        ]),
      );
    case 'ts':
      d.horodatage = !d.horodatage;
      return repondreEcran(interaction, d);
    case 'clear':
      d.champs = [];
      d.boutons = [];
      return repondreEcran(interaction, d, '🧹 Champs et boutons vidés.');
    case 'cancel':
      brouillons.supprimer(d.id);
      await interaction.update({ content: '✖️ Brouillon abandonné.', embeds: [], components: [] });
      return;
    case 'publish':
      return publier(interaction, d);
  }
}

async function publier(interaction: ButtonInteraction<'cached'>, d: Brouillon): Promise<void> {
  const serveur = interaction.guild;
  const embed = construireEmbed(serveur, d);
  const composants = rangeesLiens(d);
  if (d.messageAModifier) {
    const salon = serveur.channels.cache.get(d.messageAModifier.salonId) as GuildTextBasedChannel | undefined;
    const message = salon?.isTextBased() ? await salon.messages.fetch(d.messageAModifier.messageId).catch(() => null) : null;
    if (!message || message.author.id !== interaction.client.user.id) throw new ErreurUtilisateur('Le message à modifier est introuvable (ou n’a pas été envoyé par le bot).');
    await message.edit({ content: d.contenu || null, embeds: [embed], components: composants });
    brouillons.supprimer(d.id);
    await interaction.update({ content: `✅ Message modifié : ${message.url}`, embeds: [], components: [] });
    return;
  }
  const salon = (d.salonId ? serveur.channels.cache.get(d.salonId) : interaction.channel) as GuildTextBasedChannel | null | undefined;
  if (!salon?.isTextBased()) throw new ErreurUtilisateur('Salon de publication introuvable.');
  const moi = serveur.members.me!;
  if (!salon.permissionsFor(moi)?.has(['SendMessages', 'EmbedLinks'])) throw new ErreurUtilisateur(`Je ne peux pas écrire dans <#${salon.id}>.`);
  const mention = d.roleId ? `<@&${d.roleId}>` : '';
  const contenu = [mention, d.contenu ? remplirModele(d.contenu, { serveur }) : ''].filter(Boolean).join(' ');
  const envoye = await salon.send({ content: contenu || undefined, embeds: [embed], components: composants, allowedMentions: { roles: d.roleId ? [d.roleId] : [], parse: [] } });
  if (d.genre === 'announce' && envoye.crosspostable) await envoye.crosspost().catch(() => undefined);
  brouillons.supprimer(d.id);
  void journal(serveur, 'community', { titre: d.genre === 'announce' ? 'Annonce publiée' : 'Embed publié', ton: 'info', lignes: [`**Salon** : <#${salon.id}> · [voir](${envoye.url})`, d.titre ? `**Titre** : ${tronquer(d.titre, 200)}` : null], par: interaction.user });
  await interaction.update({ content: `✅ Publié : ${envoye.url}`, embeds: [], components: [] });
}

export async function surMenuRedaction(interaction: AnySelectMenuInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = exigerBrouillon(id, interaction.user.id);
  if (action === 'chan') d.salonId = interaction.values[0] ?? null;
  if (action === 'role') d.roleId = interaction.values[0] ?? null;
  await repondreEcran(interaction, d);
}

function resoudreCouleur(brut: string): number | null {
  const hexa = lireCouleur(brut);
  if (hexa !== null) return hexa;
  const ton = PALETTES.flatMap((p) => p.tons).find((t) => t.name.toLowerCase() === brut.trim().toLowerCase());
  return ton?.color ?? null;
}

export async function surFenetreRedaction(interaction: ModalSubmitInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = exigerBrouillon(id, interaction.user.id);
  const valeurChamp = (k: string) => interaction.fields.getTextInputValue(k).trim();
  const lienInvalide = (v: string) => v && !estLienHttp(v);
  switch (action) {
    case 'textm':
      if (lienInvalide(valeurChamp('url'))) throw new ErreurUtilisateur('Le lien du titre doit commencer par http(s)://');
      Object.assign(d, { title: valeurChamp('title'), description: valeurChamp('description'), url: valeurChamp('url'), content: valeurChamp('content') });
      break;
    case 'colorm': {
      const couleur = resoudreCouleur(valeurChamp('color'));
      if (couleur === null) throw new ErreurUtilisateur('Couleur inconnue : donne un code comme `#9146FF` ou un nom de ton (Twitch, Lavande, Cyan…).');
      d.couleur = couleur;
      break;
    }
    case 'imagem':
      if (lienInvalide(valeurChamp('image')) || lienInvalide(valeurChamp('thumbnail'))) throw new ErreurUtilisateur('Les images doivent être des liens http(s).');
      d.image = valeurChamp('image');
      d.miniature = valeurChamp('thumbnail');
      break;
    case 'fieldm':
      d.champs.push({ nom: valeurChamp('name'), valeur: valeurChamp('value'), enLigne: /^o(ui)?|y(es)?$/i.test(valeurChamp('inline')) });
      break;
    case 'linkm':
      if (!estLienHttp(valeurChamp('url'))) throw new ErreurUtilisateur('Le lien du bouton doit commencer par http(s)://');
      d.boutons.push({ libelle: valeurChamp('label'), url: valeurChamp('url') });
      break;
    case 'metam':
      if (lienInvalide(valeurChamp('authorIcon'))) throw new ErreurUtilisateur('L’icône doit être un lien http(s).');
      Object.assign(d, { authorName: valeurChamp('authorName'), authorIcon: valeurChamp('authorIcon'), footer: valeurChamp('footer') });
      break;
    case 'announcem': {
      if (lienInvalide(valeurChamp('image'))) throw new ErreurUtilisateur('L’image doit être un lien http(s).');
      const couleur = valeurChamp('color') ? resoudreCouleur(valeurChamp('color')) : d.couleur;
      if (couleur === null) throw new ErreurUtilisateur('Couleur inconnue (ex : `#9146FF`).');
      const boutonSaisi = valeurChamp('button');
      if (boutonSaisi) {
        const [libelle, url] = boutonSaisi.split('|').map((s) => s.trim());
        if (!libelle || !url || !estLienHttp(url)) throw new ErreurUtilisateur('Bouton attendu au format `Texte | https://lien`.');
        d.boutons = [{ libelle, url }];
      }
      Object.assign(d, { title: valeurChamp('title'), description: valeurChamp('message'), image: valeurChamp('image'), color: couleur });
      break;
    }
  }
  await repondreEcran(interaction, d, action === 'announcem' ? '📢 Vérifie l’aperçu, choisis le salon et la mention, puis publie.' : undefined);
}

// - /annonce : publier ou retoucher un message -
function ecranPublier(serveur: Guild) {
  const embeds = moduleActif(serveur.id, 'embeds');
  const embed = embedEnseigne(serveur)
    .setTitle('📢 Publier')
    .setDescription(
      [
        '📢 **Annonce** — titre, texte, image et bouton, avec un aperçu avant de publier',
        embeds ? '📦 **Embed libre** — chaque détail se règle au clic' : null,
        embeds ? '✏️ **Modifier** — un message déjà posté par le bot' : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton('pub:annonce', 'Annonce', ButtonStyle.Primary, '📢'),
        ...(embeds ? [bouton('pub:embed', 'Embed libre', ButtonStyle.Secondary, '📦'), bouton('pub:modifier', 'Modifier un message', ButtonStyle.Secondary, '✏️')] : []),
      ),
    ],
  };
}

function fenetreAnnonce(serveur: Guild, utilisateurId: string) {
  const brouillon = nouveauBrouillon(serveur, utilisateurId, 'announce');
  brouillon.salonId = lireConfig(serveur.id).annonces.salonDefautId;
  stockerBrouillon(brouillon);
  const boutonParDefaut = brouillon.boutons[0] ? `${brouillon.boutons[0].libelle} | ${brouillon.boutons[0].url}` : '';
  return construireFormulaire(`an:announcem:${brouillon.id}`, 'Nouvelle annonce', [
    { id: 'title', libelle: 'Titre', valeur: '📢 Nouvelle annonce', longueurMax: 256, indication: '🎮 Live ce soir !' },
    { id: 'message', libelle: 'Message', long: true, longueurMax: 4000, indication: 'Rendez-vous à 21h !' },
    { id: 'image', libelle: 'Image (lien, facultatif)', obligatoire: false, longueurMax: 500 },
    { id: 'color', libelle: 'Couleur (facultatif)', obligatoire: false, valeur: enHexa(brouillon.couleur), longueurMax: 30 },
    { id: 'button', libelle: 'Bouton « Texte | lien » (facultatif)', obligatoire: false, valeur: boutonParDefaut, longueurMax: 300 },
  ]);
}

async function brouillonDepuisLien(serveur: Guild, utilisateurId: string, lien: string): Promise<Brouillon> {
  const brouillon = nouveauBrouillon(serveur, utilisateurId, 'embed');
  const m = /channels\/(\d+)\/(\d+)\/(\d+)/.exec(lien);
  if (!m || m[1] !== serveur.id) throw new ErreurUtilisateur('Lien de message invalide (il doit venir de ce serveur).');
  const salon = serveur.channels.cache.get(m[2]!);
  const message = salon?.isTextBased() ? await salon.messages.fetch(m[3]!).catch(() => null) : null;
  if (!message) throw new ErreurUtilisateur('Message introuvable.');
  if (message.author.id !== serveur.client.user.id) throw new ErreurUtilisateur('Je ne peux modifier que mes propres messages.');
  const source = message.embeds[0];
  Object.assign(brouillon, {
    title: source?.title ?? '',
    description: source?.description ?? '',
    color: source?.color ?? brouillon.couleur,
    url: source?.url ?? '',
    authorName: source?.author?.name ?? '',
    authorIcon: source?.author?.iconURL ?? '',
    footer: source?.footer?.text ?? '',
    image: source?.image?.url ?? '',
    thumbnail: source?.thumbnail?.url ?? '',
    timestamp: !!source?.timestamp,
    fields: source?.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })) ?? [],
    content: message.content,
    editMessage: { channelId: salon!.id, messageId: message.id },
  });
  stockerBrouillon(brouillon);
  return brouillon;
}

const annonce: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder().setName('annonce').setDescription('Publier un message'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranPublier(interaction.guild), ephemeral: true });
  },
};

const composantPublier: GestionnaireComposant = {
  prefixe: 'pub',
  niveau: Niveau.STAFF,
  async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
    if (action === 'annonce') return interaction.showModal(fenetreAnnonce(interaction.guild, interaction.user.id));
    if (action === 'modifier') return interaction.showModal(construireFormulaire('pub:lien', 'Modifier un message', [{ id: 'lien', libelle: 'Lien du message (clic droit → Copier le lien)', longueurMax: 200 }]));
    if (action === 'embed') return interaction.update(affichageEditeur(interaction.guild, nouveauBrouillonStocke(interaction.guild, interaction.user.id)));
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>) {
    const brouillon = await brouillonDepuisLien(interaction.guild, interaction.user.id, interaction.fields.getTextInputValue('lien').trim());
    if (interaction.isFromMessage()) await interaction.update(affichageEditeur(interaction.guild, brouillon));
    else await interaction.reply({ ...affichageEditeur(interaction.guild, brouillon), flags: MessageFlags.Ephemeral });
  },
};

function nouveauBrouillonStocke(serveur: Guild, utilisateurId: string): Brouillon {
  const brouillon = nouveauBrouillon(serveur, utilisateurId, 'embed');
  stockerBrouillon(brouillon);
  return brouillon;
}

const pageReglage: PageReglage = {
  id: 'announcements',
  section: 'community',
  titre: 'Annonces',
  emoji: '📣',
  moduleId: 'announcements',
  ordre: 7,
  description: '`/annonce` ouvre un formulaire, montre l’aperçu, puis publie (et diffuse automatiquement dans un salon d’annonces).',
  champs: [{ genre: 'channel', cle: 'channel', libelle: 'Salon des annonces par défaut', lire: (c) => c.annonces.salonDefautId, ecrire: (c, v) => void (c.annonces.salonDefautId = v) }],
};

export const moduleAnnonces: ModuleBot = {
  id: 'announcements',
  nom: 'Annonces',
  emoji: '📣',
  description: 'Générateur d’annonces avec aperçu avant publication',
  desactivable: true,
  actifParDefaut: true,
  commandes: [annonce],
  pagesReglage: [pageReglage],
  composants: [
    composantPublier,
    {
      prefixe: 'an',
      niveau: Niveau.STAFF,
      bouton: (i, parametres) => surBoutonRedaction(i, parametres),
      menu: (i, parametres) => surMenuRedaction(i, parametres),
      fenetre: (i, parametres) => surFenetreRedaction(i, parametres),
    },
  ],
};

export const moduleRedaction: ModuleBot = {
  id: 'embeds',
  nom: 'Embed builder',
  emoji: '📦',
  description: 'Créer et modifier des embeds au clic',
  desactivable: true,
  actifParDefaut: true,
  composants: [
    {
      prefixe: 'eb',
      niveau: Niveau.STAFF,
      bouton: (i, parametres) => surBoutonRedaction(i, parametres),
      menu: (i, parametres) => surMenuRedaction(i, parametres),
      fenetre: (i, parametres) => surFenetreRedaction(i, parametres),
    },
  ],
};

const registre = creerRegistre('commandes-perso');

interface LigneCommandePerso {
  serveur_id: string;
  nom: string;
  description: string;
  reponse: string;
  en_embed: number;
  commande_discord_id: string | null;
  utilisations: number;
}

const MOTIF_NOM = /^[a-z0-9_-]{1,32}$/;

function trouverCommande(serveurId: string, nom: string): LigneCommandePerso | undefined {
  return lire<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? AND nom = ?', serveurId, nom.toLowerCase());
}

function charge(serveur: Guild, rangee: LigneCommandePerso, contexte: Parameters<typeof remplirModele>[1]) {
  executer('UPDATE commandes_perso SET utilisations = utilisations + 1 WHERE serveur_id = ? AND nom = ?', rangee.serveur_id, rangee.nom);
  const texte = remplirModele(rangee.reponse, contexte);
  if (rangee.en_embed) return { embeds: [embedEnseigne(serveur).setDescription(tronquer(texte, 4096))], allowedMentions: { parse: [] as [] } };
  return { content: tronquer(texte, 2000), allowedMentions: { parse: [] as [] } };
}

async function enregistrerCommandeServeur(serveur: Guild, rangee: LigneCommandePerso): Promise<string | null> {
  if (lireAiguilleur().commandes.has(rangee.nom)) return null;
  try {
    const cree = await serveur.commands.create({ name: rangee.nom, description: tronquer(rangee.description || `Commande personnalisée /${rangee.nom}`, 100) });
    executer('UPDATE commandes_perso SET commande_discord_id = ? WHERE serveur_id = ? AND nom = ?', cree.id, serveur.id, rangee.nom);
    return cree.id;
  } catch (echec) {
    registre.avertir(`Commande /${rangee.nom} non enregistrée sur ${serveur.id} : ${(echec as Error).message}`);
    return null;
  }
}

async function retirerCommandeServeur(serveur: Guild, rangee: LigneCommandePerso): Promise<void> {
  if (rangee.commande_discord_id) await serveur.commands.delete(rangee.commande_discord_id).catch(() => undefined);
}

// - /reponses : commandes perso et réponses automatiques -
function ecranReponses(serveur: Guild, note?: string) {
  const prefixe = lireConfig(serveur.id).commandesPerso.prefixe;
  const commandes = lireTout<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? ORDER BY nom', serveur.id);
  const auto = moduleActif(serveur.id, 'autoresponses') ? liste(serveur.id) : null;
  const embed = embedEnseigne(serveur)
    .setTitle('🧩 Réponses du bot')
    .setDescription(note ?? 'Des réponses toutes prêtes : une commande qu’on tape, ou un mot qui déclenche une réponse.')
    .addFields({ name: `🧩 Commandes (${commandes.length})`, value: tronquer(commandes.map((r) => `**${prefixe}${r.nom}** — ${tronquer(r.description || r.reponse, 50)}`).join('\n') || '—', 1024), inline: false });
  if (auto) embed.addFields({ name: `💬 Réponses automatiques (${auto.length})`, value: tronquer(auto.map((r) => `« ${tronquer(r.declencheur, 30)} » → ${tronquer(r.reponse, 50)}`).join('\n') || '—', 1024), inline: false });
  const supprimables = [
    ...commandes.map((r) => ({ label: tronquer(`${prefixe}${r.nom}`, 100), value: `c:${r.nom}`, emoji: '🧩' })),
    ...(auto ?? []).map((r) => ({ label: tronquer(`« ${r.declencheur} »`, 100), value: `a:${r.id}`, emoji: '💬' })),
  ].slice(0, 25);
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    rangee(bouton('rpn:cmd', 'Nouvelle commande', ButtonStyle.Success, '🧩'), ...(auto ? [bouton('rpn:auto', 'Nouvelle réponse auto', ButtonStyle.Success, '💬')] : [])),
  ];
  if (supprimables.length) composants.push(rangee(new StringSelectMenuBuilder().setCustomId('rpn:del').setPlaceholder('Supprimer…').addOptions(supprimables)));
  return { embeds: [embed], components: composants };
}

const commandePerso: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('reponses').setDescription('Réponses du bot'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranReponses(interaction.guild), ephemeral: true });
  },
};

const composantReponses: GestionnaireComposant = {
  prefixe: 'rpn',
  niveau: Niveau.ADMIN,
  async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
    if (action === 'cmd') {
      return interaction.showModal(
        construireFormulaire('cc:nouveau', 'Nouvelle commande', [
          { id: 'nom', libelle: 'Nom (a-z, 0-9, - et _)', indication: 'reseaux', longueurMax: 32 },
          { id: 'response', libelle: 'Réponse', long: true, longueurMax: 2000, indication: '🐦 Twitter : https://x.com/…  ({user}, {server}, {membercount})' },
          { id: 'description', libelle: 'Description courte (facultatif)', obligatoire: false, longueurMax: 100 },
          { id: 'embed', libelle: 'Dans un joli cadre ? (oui / non)', obligatoire: false, valeur: 'oui', longueurMax: 3 },
        ]),
      );
    }
    return interaction.showModal(
      construireFormulaire('ar:nouveau', 'Nouvelle réponse automatique', [
        { id: 'trigger', libelle: 'Le mot ou la phrase', indication: 'youtube', longueurMax: 100 },
        { id: 'mode', libelle: 'Quand ? contient / mot / début / exact', valeur: 'contient', longueurMax: 10 },
        { id: 'response', libelle: 'Réponse', long: true, longueurMax: 2000, indication: '🎥 Tu peux retrouver les vidéos ici !' },
      ]),
    );
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>) {
    const serveur = interaction.guild;
    const [genre, cle] = (interaction.values[0] ?? '').split(':');
    if (genre === 'c') {
      const rangee = trouverCommande(serveur.id, cle ?? '');
      if (rangee) {
        await retirerCommandeServeur(serveur, rangee);
        executer('DELETE FROM commandes_perso WHERE serveur_id = ? AND nom = ?', serveur.id, rangee.nom);
      }
    } else {
      executer('DELETE FROM reponses_auto WHERE id = ? AND serveur_id = ?', Number(cle), serveur.id);
      cache.delete(serveur.id);
    }
    await interaction.update(ecranReponses(serveur, '🗑️ Supprimé.'));
  },
};

export const MODES_REPONSE: Record<string, TypeCorrespondance> = { contient: 'contains', mot: 'word', debut: 'startswith', exact: 'exact' };

async function traiterSlash(interaction: ChatInputCommandInteraction<'cached'>): Promise<boolean> {
  if (!moduleActif(interaction.guildId, 'customcommands')) return false;
  const rangee = trouverCommande(interaction.guildId, interaction.commandName);
  if (!rangee) return false;
  await interaction.reply(charge(interaction.guild, rangee, { membre: interaction.member, serveur: interaction.guild, salon: interaction.channel }));
  return true;
}

async function traiterMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const prefixe = lireConfig(message.guildId).commandesPerso.prefixe;
  if (!prefixe || !message.content.startsWith(prefixe)) return;
  const nom = message.content.slice(prefixe.length).split(/\s+/)[0]?.toLowerCase();
  if (!nom || !MOTIF_NOM.test(nom)) return;
  const rangee = trouverCommande(message.guildId, nom);
  if (!rangee) return;
  await message.reply({ ...charge(message.guild, rangee, { membre: message.member, serveur: message.guild, salon: message.channel }), allowedMentions: { parse: [], repliedUser: false } });
}

const pageReglageCommandesPerso: PageReglage = {
  id: 'customcommands',
  section: 'community',
  titre: 'Commandes personnalisées',
  emoji: '🧩',
  moduleId: 'customcommands',
  ordre: 8,
  description: `Des réponses rapides créées avec \`/reponses\`, utilisables avec le préfixe choisi et en commande slash du serveur.\n-# Variables : ${['user', 'username', 'server', 'membercount', 'brand', 'twitch'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    {
      genre: 'text',
      cle: 'prefix',
      libelle: 'Préfixe des commandes perso',
      longueurMax: 5,
      obligatoire: true,
      lire: (c) => c.commandesPerso.prefixe,
      ecrire: (c, v) => void (c.commandesPerso.prefixe = v),
      validate: (v) => (/^\S{1,5}$/.test(v) ? null : '1 à 5 caractères sans espace.'),
    },
  ],
};

export const moduleCommandesPerso: ModuleBot = {
  id: 'customcommands',
  nom: 'Commandes personnalisées',
  emoji: '🧩',
  description: 'Réponses personnalisées en préfixe et en slash',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandePerso],
  pagesReglage: [pageReglageCommandesPerso],
  composants: [
    composantReponses,
    {
      prefixe: 'cc',
      niveau: Niveau.ADMIN,
      async fenetre(interaction, [action, nomBrut, embedBrut]) {
        const serveur = interaction.guild;
        const nouveau = action === 'nouveau';
        const nom = nouveau ? interaction.fields.getTextInputValue('nom').trim().toLowerCase() : nomBrut;
        const enEmbed = nouveau ? (/^n/i.test(interaction.fields.getTextInputValue('embed').trim()) ? '0' : '1') : embedBrut;
        if (!nom || !MOTIF_NOM.test(nom)) throw new ErreurUtilisateur('Nom invalide : 1 à 32 caractères parmi a-z, 0-9, - et _.');
        const reponse = interaction.fields.getTextInputValue('response').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM commandes_perso WHERE serveur_id = ?', serveur.id)?.n ?? 0;
        const existant = trouverCommande(serveur.id, nom);
        if (!existant && nombre >= 100) throw new ErreurUtilisateur('100 commandes personnalisées maximum.');
        executer(
          `INSERT INTO commandes_perso (serveur_id, nom, description, reponse, en_embed, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(serveur_id, nom) DO UPDATE SET description = excluded.description, reponse = excluded.reponse, en_embed = excluded.en_embed`,
          serveur.id,
          nom,
          description,
          reponse,
          enEmbed === '1' ? 1 : 0,
          interaction.user.id,
          Date.now(),
        );
        const rangee = trouverCommande(serveur.id, nom)!;
        const slashId = rangee.commande_discord_id ?? (await enregistrerCommandeServeur(serveur, rangee));
        if (rangee.commande_discord_id && description !== existant?.description) {
          await serveur.commands.edit(rangee.commande_discord_id, { description: tronquer(description || `Commande personnalisée /${nom}`, 100) }).catch(() => undefined);
        }
        const prefixe = lireConfig(serveur.id).commandesPerso.prefixe;
        if (nouveau && interaction.isFromMessage()) {
          await interaction.update(ecranReponses(serveur, `✅ **${prefixe}${nom}** ${existant ? 'modifiée' : 'créée'}${slashId ? ` · aussi en **/${nom}**` : ''}.`));
          return;
        }
        await interaction.reply({
          embeds: [ok(serveur, `Commande **${prefixe}${nom}** ${existant ? 'modifiée' : 'créée'}${slashId ? ` · aussi disponible en **/${nom}**` : ''}.\n\n**Variables :**\n${aideVariables(['user', 'username', 'server', 'membercount'])}`)],
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
  evenements: [sur('messageCreate', (m) => traiterMessage(m), 160)],
  async auDemarrage(client: Client<true>) {
    lireAiguilleur().surCommandeInconnue(traiterSlash);
    for (const serveur of client.guilds.cache.values()) {
      for (const rangee of lireTout<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? AND commande_discord_id IS NULL', serveur.id).slice(0, 20)) {
        await enregistrerCommandeServeur(serveur, rangee);
      }
    }
  },
};

type TypeCorrespondance = 'contains' | 'exact' | 'startswith' | 'word';

interface LigneReponseAuto {
  id: number;
  serveur_id: string;
  declencheur: string;
  correspondance: TypeCorrespondance;
  reponse: string;
}

const LIBELLE_CORRESPONDANCE: Record<TypeCorrespondance, string> = { contains: 'contient', exact: 'exactement', startswith: 'commence par', word: 'mot entier' };

const cache = new Map<string, LigneReponseAuto[]>();
const delais = new Delais();

function liste(serveurId: string): LigneReponseAuto[] {
  let rangees = cache.get(serveurId);
  if (!rangees) {
    rangees = lireTout<LigneReponseAuto>('SELECT id, serveur_id, declencheur, correspondance, reponse FROM reponses_auto WHERE serveur_id = ? ORDER BY id', serveurId);
    cache.set(serveurId, rangees);
  }
  return rangees;
}

function normaliser(texte: string): string {
  return texte.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function correspond(rangee: Pick<LigneReponseAuto, 'declencheur' | 'correspondance'>, contenu: string): boolean {
  const texte = normaliser(contenu);
  const declencheur = normaliser(rangee.declencheur);
  if (!declencheur) return false;
  switch (rangee.correspondance) {
    case 'exact':
      return texte === declencheur;
    case 'startswith':
      return texte.startsWith(declencheur);
    case 'word':
      return ` ${texte.replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${declencheur} `);
    default:
      return texte.includes(declencheur);
  }
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const rangee = liste(message.guildId).find((r) => correspond(r, message.content));
  if (!rangee) return;
  if (delais.prendre(`${message.channelId}:${rangee.id}`, 15_000) > 0) return;
  await message
    .reply({ content: tronquer(remplirModele(rangee.reponse, { membre: message.member, serveur: message.guild, salon: message.channel }), 2000), allowedMentions: { parse: [], repliedUser: false } })
    .catch(() => undefined);
}

export const moduleReponsesAuto: ModuleBot = {
  id: 'autoresponses',
  nom: 'Réponses automatiques',
  emoji: '💬',
  description: 'Le bot répond quand un mot-clé est écrit',
  desactivable: true,
  actifParDefaut: true,
  composants: [
    {
      prefixe: 'ar',
      niveau: Niveau.ADMIN,
      async fenetre(interaction, [action, modeBrut]) {
        const mode = action === 'nouveau' ? MODES_REPONSE[simplifier(interaction.fields.getTextInputValue('mode')).replace(/^d.*/, 'debut')] ?? 'contains' : modeBrut;
        const declencheur = interaction.fields.getTextInputValue('trigger').trim();
        const reponse = neutraliserMentions(interaction.fields.getTextInputValue('response').trim());
        if (normaliser(declencheur).length < 2) throw new ErreurUtilisateur('Déclencheur trop court (2 caractères minimum).');
        executer(
          'INSERT INTO reponses_auto (serveur_id, declencheur, correspondance, reponse, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?)',
          interaction.guildId,
          declencheur,
          ['contains', 'exact', 'startswith', 'word'].includes(mode ?? '') ? mode : 'contains',
          reponse,
          interaction.user.id,
          Date.now(),
        );
        cache.delete(interaction.guildId);
        if (action === 'nouveau' && interaction.isFromMessage()) {
          await interaction.update(ecranReponses(interaction.guild, `✅ Réponse à « **${tronquer(declencheur, 60)}** » enregistrée.`));
          return;
        }
        await interaction.reply({ embeds: [ok(interaction.guild, `Quand un message ${LIBELLE_CORRESPONDANCE[(mode as TypeCorrespondance) ?? 'contains']} « **${tronquer(declencheur, 60)}** », je répondrai :\n> ${tronquer(reponse, 300)}`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [sur('messageCreate', (m) => surMessage(m), 170)],
};

type TypePanneau = 'button' | 'reaction' | 'select';
type ModePanneau = 'toggle' | 'unique' | 'add';

interface LignePanneau {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  titre: string;
  description: string;
  type: TypePanneau;
  mode: ModePanneau;
  genre: string;
  cree_le: number;
}

interface LigneParticipation {
  panneau_id: number;
  role_id: string;
  emoji: string | null;
  libelle: string;
  position: number;
}

const LIBELLE_MODE: Record<ModePanneau, string> = { toggle: 'Cliquer ajoute / enlève', unique: 'Un seul rôle à la fois', add: 'Ajout seulement' };

function entrees(panneauId: number): LigneParticipation[] {
  return lireTout<LigneParticipation>('SELECT * FROM roles_panneaux WHERE panneau_id = ? ORDER BY position, libelle', panneauId);
}

function exigerPanneau(serveurId: string, id: number | string | undefined): LignePanneau {
  const panneauBoutons = lire<LignePanneau>('SELECT * FROM panneaux_roles WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!panneauBoutons) throw new ErreurUtilisateur('Panneau introuvable.');
  return panneauBoutons;
}

function cleEmoji(brut: string | null): string | null {
  if (!brut) return null;
  const enseignes = /<a?:\w+:(\d+)>/.exec(brut);
  return enseignes ? enseignes[1]! : brut.trim();
}

function afficher(serveur: Guild, panneauBoutons: LignePanneau) {
  const liste = entrees(panneauBoutons.id);
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(tronquer(panneauBoutons.titre, 256))
    .setDescription(
      tronquer(
        [panneauBoutons.description, '', ...liste.map((e) => `${e.emoji ?? '•'} **${e.libelle}** — <@&${e.role_id}>`), '', `-# ${panneauBoutons.type === 'reaction' ? 'Réagis' : 'Clique'} pour choisir · ${LIBELLE_MODE[panneauBoutons.mode]}`]
          .filter((l, i) => l !== '' || i > 0)
          .join('\n'),
        4096,
      ),
    );
  if (panneauBoutons.type === 'button') {
    const boutons = liste.slice(0, 25).map((e) => bouton(`rr:b:${panneauBoutons.id}:${e.role_id}`, e.libelle, ButtonStyle.Secondary, e.emoji ?? undefined));
    const rangees = [];
    for (let i = 0; i < boutons.length; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
    return { embeds: [embed], components: rangees };
  }
  if (panneauBoutons.type === 'select' && liste.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rr:s:${panneauBoutons.id}`)
      .setPlaceholder('Choisis tes rôles')
      .setMinValues(0)
      .setMaxValues(panneauBoutons.mode === 'unique' ? 1 : liste.length)
      .addOptions(liste.slice(0, 25).map((e) => ({ label: e.libelle, value: e.role_id, emoji: e.emoji ?? undefined })));
    return { embeds: [embed], components: [rangee(menu)] };
  }
  return { embeds: [embed], components: [] };
}

// - Panneau de rôles prêt à l’emploi -
export async function poserPanneauRolesModele(salon: GuildTextBasedChannel, modele: { titre: string; description: string; mode: ModePanneau; genre: string; roles: { id: string; emoji: string; libelle: string }[] }): Promise<string> {
  const serveur = salon.guild;
  const id = transaction(() => {
    const r = executer(
      "INSERT INTO panneaux_roles (serveur_id, salon_id, titre, description, type, mode, genre, cree_le) VALUES (?, ?, ?, ?, 'button', ?, ?, ?)",
      serveur.id,
      salon.id,
      modele.titre,
      modele.description,
      modele.mode,
      modele.genre,
      Date.now(),
    );
    modele.roles.forEach((e, i) => executer('INSERT INTO roles_panneaux (panneau_id, role_id, emoji, libelle, position) VALUES (?, ?, ?, ?, ?)', r.lastInsertRowid, e.id, e.emoji, e.libelle, i));
    return r.lastInsertRowid;
  });
  return publierPanneauxRoles(serveur, exigerPanneau(serveur.id, Number(id)));
}

async function publierPanneauxRoles(serveur: Guild, panneauBoutons: LignePanneau): Promise<string> {
  const salon = serveur.channels.cache.get(panneauBoutons.salon_id) as GuildTextBasedChannel | undefined;
  if (!salon?.isTextBased()) throw new ErreurUtilisateur('Le salon du panneau est introuvable.');
  const charge = afficher(serveur, panneauBoutons);
  let message = panneauBoutons.message_id ? await salon.messages.fetch(panneauBoutons.message_id).catch(() => null) : null;
  if (message) await message.edit(charge);
  else {
    message = await salon.send(charge);
    executer('UPDATE panneaux_roles SET message_id = ? WHERE id = ?', message.id, panneauBoutons.id);
  }
  if (panneauBoutons.type === 'reaction') {
    for (const e of entrees(panneauBoutons.id)) if (e.emoji) await message.react(e.emoji).catch(() => undefined);
  }
  return message.url;
}

async function appliquerChoix(membre: GuildMember, panneauBoutons: LignePanneau, roleId: string, forcerAjout?: boolean): Promise<string> {
  const role = membre.guild.roles.cache.get(roleId);
  if (!role) throw new ErreurUtilisateur('Ce rôle n’existe plus.');
  if (!botPeutGererRole(membre.guild, role)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle (il est au-dessus du mien).');
  const possede = membre.roles.cache.has(roleId);
  const ajouter = forcerAjout ?? !possede;
  if (!ajouter) {
    if (panneauBoutons.mode === 'add') return `Tu gardes <@&${roleId}>.`;
    await membre.roles.remove(roleId, `Panneau de rôles #${panneauBoutons.id}`);
    return `➖ <@&${roleId}> retiré.`;
  }
  if (possede) return `Tu as déjà <@&${roleId}>.`;
  if (panneauBoutons.mode === 'unique') {
    const autres = entrees(panneauBoutons.id).map((e) => e.role_id).filter((id) => id !== roleId && membre.roles.cache.has(id));
    if (autres.length) await membre.roles.remove(autres, `Panneau de rôles #${panneauBoutons.id} (unique)`).catch(() => undefined);
  }
  await membre.roles.add(roleId, `Panneau de rôles #${panneauBoutons.id}`);
  void journal(membre.guild, 'autorole', { titre: 'Rôle choisi', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Rôle** : <@&${roleId}>`, `**Panneau** : ${panneauBoutons.titre}`] });
  return `➕ <@&${roleId}> ajouté.`;
}

async function surReaction(reaction: MessageReaction | PartialMessageReaction, utilisateur: User | PartialUser, ajoute: boolean) {
  if (utilisateur.bot) return;
  const message = reaction.message;
  if (!message.guildId) return;
  const panneauBoutons = lire<LignePanneau>("SELECT * FROM panneaux_roles WHERE message_id = ? AND type = 'reaction'", message.id);
  if (!panneauBoutons) return;
  const cle = reaction.emoji.id ?? reaction.emoji.name;
  const entree = entrees(panneauBoutons.id).find((e) => cleEmoji(e.emoji) === cle);
  if (!entree) return;
  const serveur = message.guild ?? (await reaction.client.guilds.fetch(message.guildId));
  const membre = await serveur.members.fetch(utilisateur.id).catch(() => null);
  if (!membre) return;
  if (!ajoute && panneauBoutons.mode === 'add') return;
  await appliquerChoix(membre, panneauBoutons, entree.role_id, ajoute).catch(() => undefined);
  if (ajoute && panneauBoutons.mode === 'unique') {
    const complet = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
    const charge = complet?.message;
    if (charge) {
      for (const autre of charge.reactions.cache.values()) {
        if ((autre.emoji.id ?? autre.emoji.name) !== cle) await autre.users.remove(utilisateur.id).catch(() => undefined);
      }
    }
  }
}

// - /roles : les panneaux de rôles au clic -
function ecranRoles(serveur: Guild, note?: string) {
  const panneaux = lireTout<LignePanneau>('SELECT * FROM panneaux_roles WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 25', serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🎭 Rôles à choisir')
    .setDescription(
      [
        note,
        panneaux.map((p) => `**${tronquer(p.titre, 60)}** — ${entrees(p.id).length} rôle(s) · <#${p.salon_id}>`).join('\n') || 'Aucun panneau pour l’instant.',
        '',
        '-# Un nouveau panneau est posé dans ce salon. `/affiche` le déplace ailleurs.',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    rangee(bouton('rra:nouveau', 'Nouveau panneau', ButtonStyle.Success, '➕'), bouton('rra:notifs', 'Panneau de notifications', ButtonStyle.Primary, '🔔')),
  ];
  if (panneaux.length) {
    const options = panneaux.map((p) => ({ label: tronquer(p.titre, 100), value: String(p.id), description: `${entrees(p.id).length} rôle(s)` }));
    composants.push(rangee(new StringSelectMenuBuilder().setCustomId('rra:modifier').setPlaceholder('Changer les rôles d’un panneau').addOptions(options)));
    composants.push(rangee(new StringSelectMenuBuilder().setCustomId('rra:suppr').setPlaceholder('Supprimer un panneau').addOptions(options)));
  }
  return { embeds: [embed], components: composants };
}

function choixRoles(serveur: Guild, panneau: LignePanneau) {
  const actuels = entrees(panneau.id).map((e) => e.role_id);
  return {
    embeds: [info(serveur, 'Coche les rôles à proposer (25 maximum). Ceux que tu décoches disparaissent du panneau.', { titre: panneau.titre, sujet: '🎭' })],
    components: [rangee(new RoleSelectMenuBuilder().setCustomId(`rra:roles:${panneau.id}`).setPlaceholder('Les rôles').setMinValues(0).setMaxValues(25).setDefaultRoles(actuels.slice(0, 25)))],
  };
}

// - Les rôles de notification -
// Repris s’ils existent, créés sinon : le panneau est prêt en un clic.
export const NOTIFICATIONS = [
  { nom: 'Notif Lives', emoji: '🔴', libelle: 'Lives' },
  { nom: 'Notif Annonces', emoji: '📢', libelle: 'Annonces' },
  { nom: 'Notif Giveaways', emoji: '🎉', libelle: 'Giveaways' },
  { nom: 'Notif Événements', emoji: '📅', libelle: 'Événements' },
];

const commandeRoles: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('roles').setDescription('Les rôles à choisir'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranRoles(interaction.guild), ephemeral: true });
  },
};

const composantRolesAdmin: GestionnaireComposant = {
  prefixe: 'rra',
  niveau: Niveau.ADMIN,
  async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
    const serveur = interaction.guild;
    if (action === 'nouveau') {
      return interaction.showModal(
        construireFormulaire('rra:creer', 'Nouveau panneau de rôles', [
          { id: 'titre', libelle: 'Titre', indication: '🎮 Tes jeux', longueurMax: 200 },
          { id: 'description', libelle: 'Texte (facultatif)', long: true, obligatoire: false, longueurMax: 1000, indication: 'Choisis les jeux auxquels tu joues.' },
          { id: 'forme', libelle: 'Boutons ou menu ?', valeur: 'boutons', longueurMax: 10 },
          { id: 'regle', libelle: 'Plusieurs rôles ou un seul ?', valeur: 'plusieurs', longueurMax: 10 },
        ]),
      );
    }
    const salon = interaction.channel as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    await interaction.deferUpdate();
    const roles: { id: string; emoji: string; libelle: string }[] = [];
    for (const n of NOTIFICATIONS) {
      const role = serveur.roles.cache.find((r) => simplifier(r.name) === simplifier(n.nom)) ?? (await serveur.roles.create({ name: n.nom, mentionable: false, reason: 'Panneau de notifications' }));
      roles.push({ id: role.id, emoji: n.emoji, libelle: n.libelle });
    }
    const url = await poserPanneauRolesModele(salon, { titre: '🔔 Tes notifications', description: 'Choisis ce qui mérite une mention. Tu peux changer d’avis quand tu veux.', mode: 'toggle', genre: 'notification', roles });
    await interaction.editReply(ecranRoles(serveur, `✅ Panneau posé : ${url}`));
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
    const serveur = interaction.guild;
    if (action === 'suppr') {
      const panneau = exigerPanneau(serveur.id, interaction.values[0]);
      const salon = serveur.channels.cache.get(panneau.salon_id);
      if (salon?.isTextBased() && panneau.message_id) await salon.messages.delete(panneau.message_id).catch(() => undefined);
      executer('DELETE FROM panneaux_roles WHERE id = ?', panneau.id);
      return interaction.update(ecranRoles(serveur, `🗑️ **${panneau.titre}** supprimé.`));
    }
    if (action === 'modifier') return interaction.update(choixRoles(serveur, exigerPanneau(serveur.id, interaction.values[0])));
    if (action !== 'roles') return;
    const panneau = exigerPanneau(serveur.id, id);
    const bloques = interaction.values.filter((r) => !botPeutGererRole(serveur, serveur.roles.cache.get(r)!));
    if (bloques.length) throw new ErreurUtilisateur(`Je ne peux pas donner ${bloques.map((r) => `<@&${r}>`).join(', ')} : place mon rôle au-dessus.`);
    const anciens = new Map(entrees(panneau.id).map((e) => [e.role_id, e]));
    transaction(() => {
      executer('DELETE FROM roles_panneaux WHERE panneau_id = ?', panneau.id);
      interaction.values.forEach((roleId, i) => {
        const ancien = anciens.get(roleId);
        executer('INSERT INTO roles_panneaux (panneau_id, role_id, emoji, libelle, position) VALUES (?, ?, ?, ?, ?)', panneau.id, roleId, ancien?.emoji ?? null, ancien?.libelle ?? serveur.roles.cache.get(roleId)?.name ?? 'Rôle', i);
      });
    });
    await interaction.deferUpdate();
    const url = interaction.values.length ? await publierPanneauxRoles(serveur, panneau) : null;
    await interaction.editReply(ecranRoles(serveur, url ? `✅ **${panneau.titre}** : ${interaction.values.length} rôle(s) · ${url}` : `**${panneau.titre}** n’a plus de rôle.`));
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>) {
    const serveur = interaction.guild;
    const champ = (id: string) => interaction.fields.getTextInputValue(id).trim();
    const r = executer(
      'INSERT INTO panneaux_roles (serveur_id, salon_id, titre, description, type, mode, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
      serveur.id,
      interaction.channelId,
      champ('titre'),
      champ('description'),
      /^m/i.test(champ('forme')) ? 'select' : 'button',
      /^(un|1|u)/i.test(simplifier(champ('regle'))) ? 'unique' : 'toggle',
      Date.now(),
    );
    const charge = choixRoles(serveur, exigerPanneau(serveur.id, Number(r.lastInsertRowid)));
    if (interaction.isFromMessage()) await interaction.update(charge);
    else await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
  },
};

// - Reposer un panneau de rôles ici -
// L’ancien message disparaît : un seul exemplaire, là où on l’a demandé.
const panneauRoles_: PanneauAffiche = {
  id: 'roles',
  alias: ['rolespanel'],
  nom: 'Rôles à choisir',
  emoji: '🎭',
  groupe: 'Rôles',
  quoi: 'Un panneau de rôles, déplacé dans ce salon',
  choix(serveur) {
    return lireTout<LignePanneau>('SELECT * FROM panneaux_roles WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 25', serveur.id).map((p) => ({ label: tronquer(p.titre, 100), value: String(p.id), description: `Panneau #${p.id}` }));
  },
  async poser(salon, membre, valeur) {
    const panneau = exigerPanneau(membre.guild.id, valeur);
    if (panneau.message_id && panneau.salon_id !== salon.id) {
      const ancien = membre.guild.channels.cache.get(panneau.salon_id);
      if (ancien?.isTextBased()) await ancien.messages.delete(panneau.message_id).catch(() => undefined);
    }
    if (panneau.salon_id !== salon.id) executer('UPDATE panneaux_roles SET salon_id = ?, message_id = NULL WHERE id = ?', salon.id, panneau.id);
    return `Panneau posté : ${await publierPanneauxRoles(membre.guild, exigerPanneau(membre.guild.id, panneau.id))}`;
  },
};

export const moduleRolesAChoisir: ModuleBot = {
  id: 'reactionroles',
  nom: 'Rôles à choisir',
  emoji: '🎭',
  description: 'Panneaux de rôles : réactions, boutons, menus et notifications',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeRoles],
  panneaux: [panneauRoles_],
  commandesPrefixe: [prefixePanneau(panneauRoles_, 'Poser des rôles')],
  composants: [
    composantRolesAdmin,
    {
      prefixe: 'rr',
      async bouton(interaction: ButtonInteraction<'cached'>, [, panneauId, roleId]) {
        const panneauBoutons = exigerPanneau(interaction.guildId, panneauId);
        if (!entrees(panneauBoutons.id).some((e) => e.role_id === roleId)) throw new ErreurUtilisateur('Ce rôle n’est plus proposé.');
        const texte = await appliquerChoix(interaction.member, panneauBoutons, roleId!);
        await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [, panneauId]) {
        if (!interaction.isStringSelectMenu()) return;
        const panneauBoutons = exigerPanneau(interaction.guildId, panneauId);
        const proposes = entrees(panneauBoutons.id).map((e) => e.role_id);
        const voulus = new Set(interaction.values.filter((v) => proposes.includes(v)));
        const resultats: string[] = [];
        for (const roleId of proposes) {
          const possede = interaction.member.roles.cache.has(roleId);
          if (voulus.has(roleId) && !possede) resultats.push(await appliquerChoix(interaction.member, panneauBoutons, roleId, true).catch((e: Error) => `⚠️ ${e.message}`));
          if (!voulus.has(roleId) && possede && panneauBoutons.mode !== 'add') resultats.push(await appliquerChoix(interaction.member, panneauBoutons, roleId, false).catch((e: Error) => `⚠️ ${e.message}`));
        }
        await interaction.reply({ embeds: [ok(interaction.guild, resultats.join('\n') || 'Aucun changement.')], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('messageReactionAdd', (reaction, utilisateur) => surReaction(reaction, utilisateur, true)),
    sur('messageReactionRemove', (reaction, utilisateur) => surReaction(reaction, utilisateur, false)),
    sur('messageDelete', (message) => {
      executer('UPDATE panneaux_roles SET message_id = NULL WHERE message_id = ?', message.id);
    }),
  ],
};
