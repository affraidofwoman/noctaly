import {
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  createStreamer,
  DEFAULT_COLOR,
  deleteStreamer,
  EMOJI_KEYS,
  getStreamer,
  isEmojiValue,
  isImageUrl,
  KEY_PATTERN,
  listStreamers,
  PALETTES,
  parseColor,
  setStreamerGuilds,
  toHex,
  updateStreamer,
  type EmojiKey,
  type StreamerLinks,
} from '../../core/brand';
import { askConfirmation } from '../../core/confirm';
import { parseJson } from '../../database/db';
import { truncate } from '../../core/text';
import { button, buildModal, isHttpUrl, row } from '../../core/ui';
import { PermLevel, type ComponentHandler } from '../../core/types';
import { UserError } from '../../core/errors';

const NONE = '—';
const EMOJIS_PER_PAGE = 25;

function streamerOrThrow(key: string | undefined) {
  const s = key ? getStreamer(key) : null;
  if (!s) throw new UserError('Cette enseigne n’existe plus.');
  return s;
}

/** La liste des enseignes. */
export function customHome(client: Client, note?: string) {
  const all = listStreamers();
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('🎨 Enseignes')
    .setDescription(note ?? 'Chaque streamer a sa couleur, son nom, son logo et ses émojis. Les messages du bot prennent ceux du serveur où ils sont envoyés.');
  if (all.length) {
    embed.addFields(
      all.slice(0, 24).map((s) => ({
        name: truncate(s.name, 256),
        value: `${toHex(s.color ?? DEFAULT_COLOR)} · ${s.guilds.length} serveur(s)${s.twitch_login ? ` · 🔴 ${s.twitch_login}` : ''}`,
        inline: true,
      })),
    );
  } else {
    embed.addFields({ name: 'Aucune enseigne', value: 'Le bot garde ses couleurs d’origine partout.', inline: false });
  }
  const components = [];
  if (all.length) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cu:open')
          .setPlaceholder('Ouvrir une enseigne')
          .addOptions(
            all.slice(0, 25).map((s) => ({
              label: truncate(s.name, 100),
              value: s.key,
              description: truncate(`${s.guilds.length} serveur(s) · ${toHex(s.color ?? DEFAULT_COLOR)}`, 100),
            })),
          ),
      ),
    );
  }
  components.push(row(button('cu:new', 'Nouvelle enseigne', ButtonStyle.Success, '➕')));
  void client;
  return { embeds: [embed], components };
}

/** L'écran d'une enseigne, avec son rendu sous les yeux. */
export function customStreamer(client: Client, key: string, note?: string) {
  const s = streamerOrThrow(key);
  const color = s.color ?? DEFAULT_COLOR;
  const links = parseJson<StreamerLinks>(s.links, {});
  const emojis = parseJson<Record<string, string>>(s.emojis, {});

  const preview = new EmbedBuilder()
    .setColor(color)
    .setTitle(s.name)
    .setDescription('Voilà de quoi auront l’air les messages de cette enseigne.')
    .addFields(
      { name: 'Couleur', value: `${toHex(color)}${s.color === null ? ' *(celle du bot)*' : ''}`, inline: true },
      { name: 'Émojis repris', value: String(Object.keys(emojis).length), inline: true },
      { name: 'Serveurs couverts', value: String(s.guilds.length), inline: true },
    );
  if (s.logo) preview.setThumbnail(s.logo);
  if (s.footer) preview.setFooter({ text: s.footer, iconURL: s.logo ?? undefined });
  if (s.background) preview.setImage(s.background);

  const guildName = (id: string) => client.guilds.cache.get(id)?.name ?? id;
  const linkLines = (Object.entries(links) as [string, string][]).filter(([, v]) => v).map(([k, v]) => `• ${k} — ${v}`);
  const settings = new EmbedBuilder()
    .setColor(color)
    .setTitle('Réglages')
    .addFields(
      { name: 'Clé', value: `\`${s.key}\``, inline: true },
      { name: 'Chaîne Twitch', value: s.twitch_login ? `[${s.twitch_login}](https://twitch.tv/${s.twitch_login})` : NONE, inline: true },
      { name: 'Pied de page', value: s.footer || NONE, inline: true },
      { name: 'Liens', value: truncate(linkLines.join('\n') || NONE, 1024), inline: false },
      { name: 'Serveurs de l’enseigne', value: truncate(s.guilds.length ? s.guilds.map((g) => `• ${guildName(g)}`).join('\n') : NONE, 1024), inline: false },
    );
  if (note) settings.setDescription(note);

  const what = new StringSelectMenuBuilder()
    .setCustomId(`cu:what:${key}`)
    .setPlaceholder('Que veux-tu changer ?')
    .addOptions(
      { label: 'La couleur', value: 'color', description: 'Une palette, ou ton code exact', emoji: '🎨' },
      { label: 'Le nom', value: 'name', description: 'Ce qui s’affiche en tête des écrans', emoji: '🏷️' },
      { label: 'Le pied de page', value: 'footer', description: 'La signature sous chaque message', emoji: '✍️' },
      { label: 'Le logo', value: 'logo', description: 'Une image, en https', emoji: '🖼️' },
      { label: 'Le fond de bienvenue', value: 'background', description: 'L’image derrière la carte d’arrivée', emoji: '🌄' },
      { label: 'La chaîne Twitch', value: 'twitch', description: 'Le pseudo Twitch du streamer', emoji: '🔴' },
      { label: 'Les liens', value: 'links', description: 'Twitch, YouTube, X, TikTok, Instagram', emoji: '🔗' },
      { label: 'Les serveurs couverts', value: 'guilds', description: 'Où cette enseigne s’applique', emoji: '🌐' },
      { label: 'Les émojis', value: 'emojis', description: 'Seulement ceux que tu veux changer', emoji: '😀' },
    );

  return {
    embeds: [preview, settings],
    components: [
      row(what),
      row(button('cu:home', 'Toutes les enseignes', ButtonStyle.Secondary, '⬅️'), button(`cu:del:${key}`, 'Supprimer', ButtonStyle.Danger, '🗑️')),
    ],
  };
}

function colorScreen(key: string) {
  const s = streamerOrThrow(key);
  const current = s.color ?? DEFAULT_COLOR;
  const embed = new EmbedBuilder()
    .setColor(current)
    .setTitle('Couleur')
    .setDescription('Quatre familles, six tons chacune. Ou donne ton code exact.')
    .addFields(PALETTES.map((p) => ({ name: p.name, value: `${p.description}\n${p.tones.map((t) => t.name).join(' · ')}`, inline: false })))
    .setFooter({ text: `Actuellement : ${toHex(current)}` });
  const tones = PALETTES.flatMap((p) => p.tones.map((t) => ({ ...t, palette: p.name }))).slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cu:col:${key}`)
    .setPlaceholder('Choisir un ton')
    .addOptions(tones.map((t) => ({ label: `${t.name} — ${t.palette}`, value: String(t.color), description: toHex(t.color), default: t.color === current })));
  return {
    embeds: [embed],
    components: [
      row(select),
      row(
        button(`cu:hex:${key}`, 'Code exact', ButtonStyle.Primary),
        button(`cu:reset:${key}`, 'Couleur du bot', ButtonStyle.Secondary),
        button(`cu:m:${key}`, 'Retour', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function guildsScreen(client: Client, key: string) {
  const s = streamerOrThrow(key);
  const guilds = [...client.guilds.cache.values()].slice(0, 25);
  const embed = new EmbedBuilder()
    .setColor(s.color ?? DEFAULT_COLOR)
    .setTitle('Serveurs de l’enseigne')
    .setDescription('Les messages envoyés sur ces serveurs prennent les couleurs de l’enseigne.\n-# Un serveur ne peut appartenir qu’à une seule enseigne.');
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cu:srv:${key}`)
    .setPlaceholder('Choisir les serveurs')
    .setMinValues(0)
    .setMaxValues(Math.max(1, guilds.length))
    .addOptions(
      guilds.length
        ? guilds.map((g) => ({ label: truncate(g.name, 100), value: g.id, description: `${g.memberCount} membre(s)`, default: s.guilds.includes(g.id) }))
        : [{ label: 'Aucun serveur', value: 'none' }],
    );
  return { embeds: [embed], components: [row(select), row(button(`cu:m:${key}`, 'Retour', ButtonStyle.Secondary, '⬅️'))] };
}

function emojisScreen(key: string, page = 0) {
  const s = streamerOrThrow(key);
  const custom = parseJson<Record<string, string>>(s.emojis, {});
  const keys = (Object.keys(EMOJI_KEYS) as EmojiKey[]).sort();
  const pages = Math.max(1, Math.ceil(keys.length / EMOJIS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = keys.slice(p * EMOJIS_PER_PAGE, (p + 1) * EMOJIS_PER_PAGE);
  const taken = Object.entries(custom);
  const embed = new EmbedBuilder()
    .setColor(s.color ?? DEFAULT_COLOR)
    .setTitle('Émojis')
    .setDescription('Choisis une clé pour lui donner ton émoji. Celles que tu laisses gardent celui du bot — pas besoin de tout fournir.')
    .addFields({ name: `Repris par l’enseigne (${taken.length})`, value: truncate(taken.length ? taken.map(([n, c]) => `${c} \`${n}\``).join(' · ') : NONE, 1024) })
    .setFooter({ text: `Page ${p + 1} sur ${pages} · ${keys.length} clés en tout` });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cu:emo:${key}`)
    .setPlaceholder('Quelle clé changer ?')
    .addOptions(
      slice.map((k) => ({
        label: k,
        value: k,
        description: custom[k] ? 'repris par l’enseigne' : `garde ${EMOJI_KEYS[k]}`,
      })),
    );
  return {
    embeds: [embed],
    components: [
      row(select),
      row(
        button(`cu:emop:${key}:${p - 1}`, 'Précédent', ButtonStyle.Secondary, '⬅️').setDisabled(p === 0),
        button(`cu:emop:${key}:${p + 1}`, 'Suivant', ButtonStyle.Secondary, '➡️').setDisabled(p >= pages - 1),
        button(`cu:m:${key}`, 'Retour', ButtonStyle.Secondary),
      ),
    ],
  };
}

const TEXT_FIELDS: Record<string, { title: string; label: string; long?: boolean; required: boolean; max: number }> = {
  name: { title: 'Le nom', label: 'Nom de l’enseigne', required: true, max: 64 },
  footer: { title: 'Le pied de page', label: 'Signature (vide = aucune)', required: false, max: 128 },
  logo: { title: 'Le logo', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  background: { title: 'Le fond de bienvenue', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  twitch: { title: 'La chaîne Twitch', label: 'Pseudo Twitch (vide = aucune)', required: false, max: 25 },
};

export const customComponent: ComponentHandler = {
  prefix: 'cu',
  level: PermLevel.BOT_OWNER,
  async button(interaction: ButtonInteraction<'cached'>, [action, key, extra]) {
    const client = interaction.client;
    switch (action) {
      case 'home':
        await interaction.update(customHome(client));
        return;
      case 'm':
        await interaction.update(customStreamer(client, key!));
        return;
      case 'new':
        await interaction.showModal(
          buildModal('cu:newm', 'Nouvelle enseigne', [
            { id: 'key', label: 'Clé (minuscules, chiffres, - et _)', placeholder: 'ex : zerator', maxLength: 32, minLength: 2 },
            { id: 'name', label: 'Nom affiché', placeholder: 'ex : ZeratoR', maxLength: 64 },
          ]),
        );
        return;
      case 'hex':
        await interaction.showModal(buildModal(`cu:hexm:${key}`, 'Code couleur', [{ id: 'value', label: 'Code hexadécimal', placeholder: '#9146FF', maxLength: 7 }]));
        return;
      case 'reset':
        updateStreamer(key!, { color: null });
        await interaction.update(customStreamer(client, key!, '✅ Couleur remise à celle du bot.'));
        return;
      case 'emop':
        await interaction.update(emojisScreen(key!, Number(extra) || 0));
        return;
      case 'del': {
        const s = streamerOrThrow(key);
        await askConfirmation(interaction, {
          title: 'Supprimer l’enseigne ?',
          description: `L’enseigne **${s.name}** sera supprimée. Ses ${s.guilds.length} serveur(s) reprendront les couleurs du bot.`,
          confirmLabel: 'Supprimer',
          onConfirm: async (i) => {
            deleteStreamer(s.key);
            await i.update({ embeds: [new EmbedBuilder().setColor(0x3fe08f).setDescription(`✅ Enseigne **${s.name}** supprimée.`)], components: [] });
          },
        });
        return;
      }
    }
  },
  async select(interaction: AnySelectMenuInteraction<'cached'>, [action, key]) {
    if (!interaction.isStringSelectMenu()) return;
    const client = interaction.client;
    const value = interaction.values[0] ?? '';
    switch (action) {
      case 'open':
        await interaction.update(customStreamer(client, value));
        return;
      case 'what': {
        const s = streamerOrThrow(key);
        if (value === 'color') return void (await interaction.update(colorScreen(s.key)));
        if (value === 'guilds') return void (await interaction.update(guildsScreen(client, s.key)));
        if (value === 'emojis') return void (await interaction.update(emojisScreen(s.key)));
        if (value === 'links') {
          const links = parseJson<StreamerLinks>(s.links, {});
          await interaction.showModal(
            buildModal(`cu:linksm:${s.key}`, 'Les liens', [
              { id: 'twitch', label: 'Twitch', value: links.twitch, required: false, maxLength: 200 },
              { id: 'youtube', label: 'YouTube', value: links.youtube, required: false, maxLength: 200 },
              { id: 'x', label: 'X / Twitter', value: links.x, required: false, maxLength: 200 },
              { id: 'tiktok', label: 'TikTok', value: links.tiktok, required: false, maxLength: 200 },
              { id: 'instagram', label: 'Instagram', value: links.instagram, required: false, maxLength: 200 },
            ]),
          );
          return;
        }
        const field = TEXT_FIELDS[value];
        if (!field) return;
        const current = value === 'twitch' ? s.twitch_login : (s as unknown as Record<string, string | null>)[value];
        await interaction.showModal(
          buildModal(`cu:txtm:${s.key}:${value}`, field.title, [{ id: 'value', label: field.label, value: current, required: field.required, maxLength: field.max }]),
        );
        return;
      }
      case 'col': {
        const color = parseColor(Number(value));
        if (color === null) throw new UserError('Couleur invalide.');
        updateStreamer(key!, { color });
        await interaction.update(customStreamer(client, key!, `✅ Couleur : **${toHex(color)}**`));
        return;
      }
      case 'srv': {
        const ids = interaction.values.filter((v) => v !== 'none');
        setStreamerGuilds(key!, ids);
        await interaction.update(customStreamer(client, key!, `✅ ${ids.length} serveur(s) couvert(s).`));
        return;
      }
      case 'emo': {
        const s = streamerOrThrow(key);
        const current = parseJson<Record<string, string>>(s.emojis, {})[value];
        await interaction.showModal(
          buildModal(`cu:emom:${s.key}:${value}`, `Émoji « ${value} »`, [
            { id: 'value', label: 'Émoji (vide = celui du bot)', placeholder: '<:nom:123456789012345678> ou 🎉', value: current, required: false, maxLength: 64 },
          ]),
        );
        return;
      }
    }
  },
  async modal(interaction: ModalSubmitInteraction<'cached'>, [action, key, extra]) {
    const client = interaction.client;
    const respond = async (payload: ReturnType<typeof customStreamer>) => {
      if (interaction.isFromMessage()) await interaction.update(payload);
      else await interaction.reply({ ...payload, flags: 64 });
    };
    switch (action) {
      case 'newm': {
        const newKey = interaction.fields.getTextInputValue('key').trim().toLowerCase();
        const name = interaction.fields.getTextInputValue('name').trim();
        if (!KEY_PATTERN.test(newKey)) throw new UserError('Clé invalide : 2 à 32 caractères parmi a-z, 0-9, - et _.');
        if (getStreamer(newKey)) throw new UserError('Cette clé existe déjà.');
        createStreamer(newKey, name || newKey);
        await respond(customStreamer(client, newKey, '✅ Enseigne créée. Choisis maintenant ce que tu veux régler.'));
        return;
      }
      case 'hexm': {
        const color = parseColor(interaction.fields.getTextInputValue('value'));
        if (color === null) throw new UserError('Code attendu : 6 caractères hexadécimaux, ex. `#9146FF`.');
        updateStreamer(key!, { color });
        await respond(customStreamer(client, key!, `✅ Couleur : **${toHex(color)}**`));
        return;
      }
      case 'txtm': {
        const raw = interaction.fields.getTextInputValue('value').trim();
        if (extra === 'name') {
          if (!raw) throw new UserError('Le nom ne peut pas être vide.');
          updateStreamer(key!, { name: raw });
        } else if (extra === 'footer') {
          updateStreamer(key!, { footer: raw || null });
        } else if (extra === 'logo' || extra === 'background') {
          if (raw && !isImageUrl(raw)) throw new UserError('Lien attendu : https, terminé par .png, .jpg, .gif ou .webp.');
          updateStreamer(key!, { [extra]: raw || null });
        } else if (extra === 'twitch') {
          const login = raw.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
          if (login && !/^[a-z0-9_]{3,25}$/.test(login)) throw new UserError('Pseudo Twitch invalide.');
          updateStreamer(key!, { twitch_login: login || null });
        }
        await respond(customStreamer(client, key!, '✅ C’est enregistré.'));
        return;
      }
      case 'linksm': {
        const links: StreamerLinks = {};
        const bad: string[] = [];
        for (const k of ['twitch', 'youtube', 'x', 'tiktok', 'instagram'] as const) {
          const v = interaction.fields.getTextInputValue(k).trim();
          if (!v) continue;
          if (!isHttpUrl(v)) bad.push(k);
          else links[k] = v;
        }
        updateStreamer(key!, { links });
        await respond(customStreamer(client, key!, bad.length ? `⚠️ Ignorés (lien http(s) attendu) : ${bad.join(', ')}` : '✅ Liens enregistrés.'));
        return;
      }
      case 'emom': {
        const s = streamerOrThrow(key);
        const emojiKey = extra as EmojiKey;
        if (!(emojiKey in EMOJI_KEYS)) throw new UserError('Clé d’émoji inconnue.');
        const raw = interaction.fields.getTextInputValue('value').trim();
        const emojis = parseJson<Partial<Record<EmojiKey, string>>>(s.emojis, {});
        if (!raw) delete emojis[emojiKey];
        else if (!isEmojiValue(raw)) throw new UserError('Émoji attendu : un émoji unicode ou `<:nom:id>`.');
        else emojis[emojiKey] = raw;
        updateStreamer(s.key, { emojis });
        if (interaction.isFromMessage()) await interaction.update(emojisScreen(s.key));
        else await interaction.reply({ ...emojisScreen(s.key), flags: 64 });
        return;
      }
    }
  },
};
