import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { enseigneDe, lireCouleur, PALETTES, enHexa } from '../core/brand';
import { couleurPour } from '../core/embeds';
import { ErreurUtilisateur } from '../core/errors';
import { journal } from '../core/logService';
import { idCourt, CarteExpirante } from '../core/sessions';
import { tronquer } from '../core/text';
import { bouton, construireFormulaire, estLienHttp, boutonLien, rangee } from '../core/ui';
import { remplirModele } from '../core/variables';

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
  champs: { name: string; value: string; inline: boolean }[];
  boutons: { label: string; url: string }[];
  contenu: string;
  salonId: string | null;
  roleId: string | null;
  mentionTous: boolean;
  /** Message existant à modifier au lieu d'en publier un nouveau. */
  messageAModifier: { channelId: string; messageId: string } | null;
}

const brouillons = new CarteExpirante<string, Brouillon>(45 * 60_000);

/** Préfixe des composants : « an » pour les annonces, « eb » pour l’embed builder (modules indépendants). */
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
    boutons: genre === 'announce' && enseigne.pseudoTwitch ? [{ label: '🔴 Twitch', url: `https://twitch.tv/${enseigne.pseudoTwitch}` }] : [],
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
  for (const f of d.champs.slice(0, 25)) embed.addFields({ name: tronquer(f.name, 256), value: tronquer(f.value, 1024), inline: f.inline });
  if (!d.titre && !d.description && !d.champs.length && !d.image) embed.setDescription('​');
  return embed;
}

function rangeesLiens(d: Brouillon) {
  if (!d.boutons.length) return [];
  return [rangee(...d.boutons.slice(0, 5).map((b) => boutonLien(b.url, b.label)))];
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
    const salon = serveur.channels.cache.get(d.messageAModifier.channelId) as GuildTextBasedChannel | undefined;
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
      d.champs.push({ name: valeurChamp('name'), value: valeurChamp('value'), inline: /^o(ui)?|y(es)?$/i.test(valeurChamp('inline')) });
      break;
    case 'linkm':
      if (!estLienHttp(valeurChamp('url'))) throw new ErreurUtilisateur('Le lien du bouton doit commencer par http(s)://');
      d.boutons.push({ label: valeurChamp('label'), url: valeurChamp('url') });
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
        d.boutons = [{ label: libelle, url }];
      }
      Object.assign(d, { title: valeurChamp('title'), description: valeurChamp('message'), image: valeurChamp('image'), color: couleur });
      break;
    }
  }
  await repondreEcran(interaction, d, action === 'announcem' ? '📢 Vérifie l’aperçu, choisis le salon et la mention, puis publie.' : undefined);
}

