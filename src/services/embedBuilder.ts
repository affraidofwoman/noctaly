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
import { brandFor, parseColor, PALETTES, toHex } from '../core/brand';
import { colorFor } from '../core/embeds';
import { UserError } from '../core/errors';
import { journal } from '../core/logService';
import { shortId, TtlMap } from '../core/sessions';
import { truncate } from '../core/text';
import { button, buildModal, isHttpUrl, linkButton, row } from '../core/ui';
import { renderTemplate } from '../core/variables';

export interface Draft {
  id: string;
  ownerId: string;
  guildId: string;
  kind: 'embed' | 'announce';
  title: string;
  description: string;
  color: number;
  url: string;
  authorName: string;
  authorIcon: string;
  footer: string;
  image: string;
  thumbnail: string;
  timestamp: boolean;
  fields: { name: string; value: string; inline: boolean }[];
  buttons: { label: string; url: string }[];
  content: string;
  channelId: string | null;
  roleId: string | null;
  mentionEveryone: boolean;
  /** Message existant à modifier au lieu d'en publier un nouveau. */
  editMessage: { channelId: string; messageId: string } | null;
}

const drafts = new TtlMap<string, Draft>(45 * 60_000);

/** Préfixe des composants : « an » pour les annonces, « eb » pour l’embed builder (modules indépendants). */
export const pfx = (d: Pick<Draft, 'kind'>) => (d.kind === 'announce' ? 'an' : 'eb');

export function newDraft(guild: Guild, ownerId: string, kind: Draft['kind']): Draft {
  const brand = brandFor(guild.id);
  const draft: Draft = {
    id: shortId(),
    ownerId,
    guildId: guild.id,
    kind,
    title: kind === 'announce' ? '📢 NOUVELLE ANNONCE' : 'Titre de l’embed',
    description: kind === 'announce' ? 'Écris ton annonce ici.' : 'Description de l’embed.',
    color: colorFor(guild),
    url: '',
    authorName: '',
    authorIcon: '',
    footer: brand.footer ?? (brand.key ? brand.name : guild.name),
    image: '',
    thumbnail: '',
    timestamp: kind === 'announce',
    fields: [],
    buttons: kind === 'announce' && brand.twitchLogin ? [{ label: '🔴 Twitch', url: `https://twitch.tv/${brand.twitchLogin}` }] : [],
    content: '',
    channelId: null,
    roleId: null,
    mentionEveryone: false,
    editMessage: null,
  };
  drafts.set(draft.id, draft);
  return draft;
}

export function storeDraft(draft: Draft): void {
  drafts.set(draft.id, draft);
}

function requireDraft(id: string | undefined, userId: string): Draft {
  const draft = id ? drafts.get(id) : undefined;
  if (!draft) throw new UserError('Ce brouillon a expiré (45 min). Relance la commande.');
  if (draft.ownerId !== userId) throw new UserError('Ce brouillon appartient à quelqu’un d’autre.');
  drafts.touch(id!);
  return draft;
}

export function buildEmbed(guild: Guild, d: Draft): EmbedBuilder {
  const vars = { guild };
  const embed = new EmbedBuilder().setColor(d.color);
  if (d.title) embed.setTitle(truncate(renderTemplate(d.title, vars), 256));
  if (d.description) embed.setDescription(truncate(renderTemplate(d.description, vars), 4096));
  if (d.url && isHttpUrl(d.url)) embed.setURL(d.url);
  if (d.authorName) embed.setAuthor({ name: truncate(d.authorName, 256), iconURL: isHttpUrl(d.authorIcon) ? d.authorIcon : undefined });
  if (d.footer) embed.setFooter({ text: truncate(renderTemplate(d.footer, vars), 2048) });
  if (d.image && isHttpUrl(d.image)) embed.setImage(d.image);
  if (d.thumbnail && isHttpUrl(d.thumbnail)) embed.setThumbnail(d.thumbnail);
  if (d.timestamp) embed.setTimestamp();
  for (const f of d.fields.slice(0, 25)) embed.addFields({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: f.inline });
  if (!d.title && !d.description && !d.fields.length && !d.image) embed.setDescription('​');
  return embed;
}

function linkRows(d: Draft) {
  if (!d.buttons.length) return [];
  return [row(...d.buttons.slice(0, 5).map((b) => linkButton(b.url, b.label)))];
}

export function editorPayload(guild: Guild, d: Draft, note?: string) {
  const id = d.id;
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      button(`${pfx(d)}:text:${id}`, 'Modifier', ButtonStyle.Primary, '📝'),
      button(`${pfx(d)}:color:${id}`, 'Couleur', ButtonStyle.Secondary, '🎨'),
      button(`${pfx(d)}:image:${id}`, 'Image', ButtonStyle.Secondary, '🖼️'),
      button(`${pfx(d)}:field:${id}`, 'Champ', ButtonStyle.Secondary, '➕'),
      button(`${pfx(d)}:link:${id}`, 'Bouton', ButtonStyle.Secondary, '🔗'),
    ),
    row(
      button(`${pfx(d)}:meta:${id}`, 'Auteur & pied', ButtonStyle.Secondary, '👤'),
      button(`${pfx(d)}:ts:${id}`, d.timestamp ? 'Horodatage : oui' : 'Horodatage : non', d.timestamp ? ButtonStyle.Success : ButtonStyle.Secondary, '⏱️'),
      button(`${pfx(d)}:clear:${id}`, 'Vider champs & boutons', ButtonStyle.Secondary, '🧹').setDisabled(!d.fields.length && !d.buttons.length),
      button(`${pfx(d)}:publish:${id}`, d.editMessage ? 'Enregistrer' : 'Publier', ButtonStyle.Success, '📤'),
      button(`${pfx(d)}:cancel:${id}`, '', ButtonStyle.Danger, '✖️'),
    ),
  ];
  if (!d.editMessage) {
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${pfx(d)}:chan:${id}`)
      .setPlaceholder('Salon de publication (ici par défaut)')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1);
    if (d.channelId) channelSelect.setDefaultChannels(d.channelId);
    const roleSelect = new RoleSelectMenuBuilder().setCustomId(`${pfx(d)}:role:${id}`).setPlaceholder('Rôle à mentionner (aucun par défaut)').setMinValues(0).setMaxValues(1);
    if (d.roleId) roleSelect.setDefaultRoles(d.roleId);
    components.push(row(channelSelect), row(roleSelect));
  }
  const header = [
    note,
    `👁️ **Aperçu** — ${d.editMessage ? 'modification d’un message existant' : `publication dans ${d.channelId ? `<#${d.channelId}>` : 'ce salon'}${d.roleId ? ` avec <@&${d.roleId}>` : ''}`}`,
    `-# ${d.fields.length} champ(s) · ${d.buttons.length} bouton(s) · brouillon valable 45 min`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    content: header,
    embeds: [buildEmbed(guild, d)],
    components: [...components, ...(linkRows(d).length && components.length < 5 ? linkRows(d) : [])].slice(0, 5),
    allowedMentions: { parse: [] as [] },
  };
}

async function respond(interaction: ModalSubmitInteraction<'cached'> | ButtonInteraction<'cached'> | AnySelectMenuInteraction<'cached'>, d: Draft, note?: string) {
  const payload = editorPayload(interaction.guild, d, note);
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  else await (interaction as ButtonInteraction<'cached'>).update(payload);
}

export async function onBuilderButton(interaction: ButtonInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = requireDraft(id, interaction.user.id);
  switch (action) {
    case 'text':
      return interaction.showModal(
        buildModal(`${pfx(d)}:textm:${d.id}`, 'Texte de l’embed', [
          { id: 'title', label: 'Titre', value: d.title, required: false, maxLength: 256 },
          { id: 'description', label: 'Description', long: true, value: d.description, required: false, maxLength: 4000 },
          { id: 'url', label: 'Lien du titre (facultatif)', value: d.url, required: false, maxLength: 500 },
          { id: 'content', label: 'Texte au-dessus de l’embed (facultatif)', long: true, value: d.content, required: false, maxLength: 1500 },
        ]),
      );
    case 'color':
      return interaction.showModal(
        buildModal(`${pfx(d)}:colorm:${d.id}`, 'Couleur', [
          { id: 'color', label: 'Code hexadécimal ou nom de ton', value: toHex(d.color), maxLength: 30, description: PALETTES.flatMap((p) => p.tones.map((t) => t.name)).slice(0, 12).join(', ') },
        ]),
      );
    case 'image':
      return interaction.showModal(
        buildModal(`${pfx(d)}:imagem:${d.id}`, 'Images', [
          { id: 'image', label: 'Grande image (lien https)', value: d.image, required: false, maxLength: 500 },
          { id: 'thumbnail', label: 'Miniature (lien https)', value: d.thumbnail, required: false, maxLength: 500 },
        ]),
      );
    case 'field':
      if (d.fields.length >= 25) throw new UserError('25 champs maximum.');
      return interaction.showModal(
        buildModal(`${pfx(d)}:fieldm:${d.id}`, 'Nouveau champ', [
          { id: 'name', label: 'Titre du champ', maxLength: 256 },
          { id: 'value', label: 'Contenu', long: true, maxLength: 1024 },
          { id: 'inline', label: 'Sur la même ligne ? (oui/non)', value: 'non', required: false, maxLength: 3 },
        ]),
      );
    case 'link':
      if (d.buttons.length >= 5) throw new UserError('5 boutons maximum.');
      return interaction.showModal(
        buildModal(`${pfx(d)}:linkm:${d.id}`, 'Bouton lien', [
          { id: 'label', label: 'Texte du bouton', maxLength: 80, placeholder: '🔴 Twitch' },
          { id: 'url', label: 'Lien', maxLength: 500, placeholder: 'https://twitch.tv/…' },
        ]),
      );
    case 'meta':
      return interaction.showModal(
        buildModal(`${pfx(d)}:metam:${d.id}`, 'Auteur & pied de page', [
          { id: 'authorName', label: 'Auteur', value: d.authorName, required: false, maxLength: 256 },
          { id: 'authorIcon', label: 'Icône de l’auteur (lien)', value: d.authorIcon, required: false, maxLength: 500 },
          { id: 'footer', label: 'Pied de page', value: d.footer, required: false, maxLength: 2048 },
        ]),
      );
    case 'ts':
      d.timestamp = !d.timestamp;
      return respond(interaction, d);
    case 'clear':
      d.fields = [];
      d.buttons = [];
      return respond(interaction, d, '🧹 Champs et boutons vidés.');
    case 'cancel':
      drafts.delete(d.id);
      await interaction.update({ content: '✖️ Brouillon abandonné.', embeds: [], components: [] });
      return;
    case 'publish':
      return publish(interaction, d);
  }
}

async function publish(interaction: ButtonInteraction<'cached'>, d: Draft): Promise<void> {
  const guild = interaction.guild;
  const embed = buildEmbed(guild, d);
  const components = linkRows(d);
  if (d.editMessage) {
    const channel = guild.channels.cache.get(d.editMessage.channelId) as GuildTextBasedChannel | undefined;
    const message = channel?.isTextBased() ? await channel.messages.fetch(d.editMessage.messageId).catch(() => null) : null;
    if (!message || message.author.id !== interaction.client.user.id) throw new UserError('Le message à modifier est introuvable (ou n’a pas été envoyé par le bot).');
    await message.edit({ content: d.content || null, embeds: [embed], components });
    drafts.delete(d.id);
    await interaction.update({ content: `✅ Message modifié : ${message.url}`, embeds: [], components: [] });
    return;
  }
  const channel = (d.channelId ? guild.channels.cache.get(d.channelId) : interaction.channel) as GuildTextBasedChannel | null | undefined;
  if (!channel?.isTextBased()) throw new UserError('Salon de publication introuvable.');
  const me = guild.members.me!;
  if (!channel.permissionsFor(me)?.has(['SendMessages', 'EmbedLinks'])) throw new UserError(`Je ne peux pas écrire dans <#${channel.id}>.`);
  const mention = d.roleId ? `<@&${d.roleId}>` : '';
  const content = [mention, d.content ? renderTemplate(d.content, { guild }) : ''].filter(Boolean).join(' ');
  const sent = await channel.send({ content: content || undefined, embeds: [embed], components, allowedMentions: { roles: d.roleId ? [d.roleId] : [], parse: [] } });
  if (d.kind === 'announce' && sent.crosspostable) await sent.crosspost().catch(() => undefined);
  drafts.delete(d.id);
  void journal(guild, 'community', { title: d.kind === 'announce' ? 'Annonce publiée' : 'Embed publié', tone: 'info', lines: [`**Salon** : <#${channel.id}> · [voir](${sent.url})`, d.title ? `**Titre** : ${truncate(d.title, 200)}` : null], by: interaction.user });
  await interaction.update({ content: `✅ Publié : ${sent.url}`, embeds: [], components: [] });
}

export async function onBuilderSelect(interaction: AnySelectMenuInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = requireDraft(id, interaction.user.id);
  if (action === 'chan') d.channelId = interaction.values[0] ?? null;
  if (action === 'role') d.roleId = interaction.values[0] ?? null;
  await respond(interaction, d);
}

function resolveColor(raw: string): number | null {
  const hex = parseColor(raw);
  if (hex !== null) return hex;
  const tone = PALETTES.flatMap((p) => p.tones).find((t) => t.name.toLowerCase() === raw.trim().toLowerCase());
  return tone?.color ?? null;
}

export async function onBuilderModal(interaction: ModalSubmitInteraction<'cached'>, [action, id]: string[]): Promise<void> {
  const d = requireDraft(id, interaction.user.id);
  const val = (k: string) => interaction.fields.getTextInputValue(k).trim();
  const badLink = (v: string) => v && !isHttpUrl(v);
  switch (action) {
    case 'textm':
      if (badLink(val('url'))) throw new UserError('Le lien du titre doit commencer par http(s)://');
      Object.assign(d, { title: val('title'), description: val('description'), url: val('url'), content: val('content') });
      break;
    case 'colorm': {
      const color = resolveColor(val('color'));
      if (color === null) throw new UserError('Couleur inconnue : donne un code comme `#9146FF` ou un nom de ton (Twitch, Lavande, Cyan…).');
      d.color = color;
      break;
    }
    case 'imagem':
      if (badLink(val('image')) || badLink(val('thumbnail'))) throw new UserError('Les images doivent être des liens http(s).');
      d.image = val('image');
      d.thumbnail = val('thumbnail');
      break;
    case 'fieldm':
      d.fields.push({ name: val('name'), value: val('value'), inline: /^o(ui)?|y(es)?$/i.test(val('inline')) });
      break;
    case 'linkm':
      if (!isHttpUrl(val('url'))) throw new UserError('Le lien du bouton doit commencer par http(s)://');
      d.buttons.push({ label: val('label'), url: val('url') });
      break;
    case 'metam':
      if (badLink(val('authorIcon'))) throw new UserError('L’icône doit être un lien http(s).');
      Object.assign(d, { authorName: val('authorName'), authorIcon: val('authorIcon'), footer: val('footer') });
      break;
    case 'announcem': {
      if (badLink(val('image'))) throw new UserError('L’image doit être un lien http(s).');
      const color = val('color') ? resolveColor(val('color')) : d.color;
      if (color === null) throw new UserError('Couleur inconnue (ex : `#9146FF`).');
      const btn = val('button');
      if (btn) {
        const [label, url] = btn.split('|').map((s) => s.trim());
        if (!label || !url || !isHttpUrl(url)) throw new UserError('Bouton attendu au format `Texte | https://lien`.');
        d.buttons = [{ label, url }];
      }
      Object.assign(d, { title: val('title'), description: val('message'), image: val('image'), color });
      break;
    }
  }
  await respond(interaction, d, action === 'announcem' ? '📢 Vérifie l’aperçu, choisis le salon et la mention, puis publie.' : undefined);
}

