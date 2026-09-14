import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { brandFor, parseColor, toHex } from '../../core/brand';
import { brandEmbed, info, ok } from '../../core/embeds';
import { env } from '../../core/env';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { createLogger } from '../../core/logger';
import { getSetupPage, renderPage, type SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { ts } from '../../core/time';
import { button, buildModal, row } from '../../core/ui';
import { variablesHelp } from '../../core/variables';
import { PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { getStreams, isTwitchConfigured, LOGIN_PATTERN, normalizeLogin, type TwitchStream } from '../../services/twitch/api';
import { EventSubClient } from '../../services/twitch/eventsub';
import {
  addChannel,
  buildLiveMessage,
  getChannel,
  getChannelById,
  listChannels,
  pollClips,
  pollStreams,
  removeChannel,
  updateChannel,
  type TwitchChannelRow,
} from '../../services/twitch/notifier';

const log = createLogger('twitch');
let eventSub: EventSubClient | null = null;

function requireConfigured(): void {
  if (!isTwitchConfigured()) throw new UserError('Twitch n’est pas relié : l’hébergeur doit renseigner `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` dans le fichier .env.');
}

function requireRow(guildId: string, id: string | number | undefined): TwitchChannelRow {
  const row = getChannelById(Number(id));
  if (!row || row.guild_id !== guildId) throw new UserError('Cette chaîne n’est plus suivie.');
  return row;
}

async function follow(guild: Guild, loginRaw: string, channelId: string | null, roleId: string | null): Promise<TwitchChannelRow> {
  requireConfigured();
  const login = normalizeLogin(loginRaw);
  if (!LOGIN_PATTERN.test(login)) throw new UserError('Pseudo Twitch invalide (3 à 25 caractères : lettres, chiffres, _).');
  if (listChannels(guild.id).length >= 25 && !getChannel(guild.id, login)) throw new UserError('25 chaînes maximum par serveur.');
  const cfg = getConfig(guild.id).twitch;
  const target = channelId ?? cfg.defaultChannelId;
  if (!target) throw new UserError('Choisis un salon d’annonce (option `salon`, ou salon par défaut dans `/twitch setup`).');
  const row = await addChannel(guild.id, login, target, roleId ?? cfg.defaultRoleId).catch((err: Error) => {
    if (err.message === 'introuvable') throw new UserError(`La chaîne **${login}** n’existe pas sur Twitch.`);
    throw err;
  });
  eventSub?.resync();
  return row;
}

// ─── Écrans ────────────────────────────────────────────────────────────────

function listScreen(guild: Guild, note?: string) {
  const rows = listChannels(guild.id);
  const embed = brandEmbed(guild)
    .setTitle('🔴 Chaînes Twitch suivies')
    .setDescription(
      [
        note,
        rows.length ? 'Choisis une chaîne pour régler son salon, son rôle, son message et ses notifications.' : '*Aucune chaîne suivie. Ajoute la première !*',
        isTwitchConfigured() ? null : '\n⚠️ `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` manquants dans le .env : aucune notification ne partira.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  for (const r of rows.slice(0, 24)) {
    embed.addFields({
      name: `${r.live_stream_id ? '🔴' : '⚫'} ${r.display_name ?? r.login}`,
      value: truncate(`<#${r.channel_id}>${r.role_id ? ` · <@&${r.role_id}>` : ''}${r.live_stream_id ? `\n-# en live depuis ${ts(r.live_started_at ?? Date.now(), 'R')}` : ''}`, 1024),
      inline: true,
    });
  }
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (rows.length) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('twc:open')
          .setPlaceholder('Régler une chaîne')
          .addOptions(rows.slice(0, 25).map((r) => ({ label: r.display_name ?? r.login, value: String(r.id), emoji: r.live_stream_id ? '🔴' : '⚫', description: `twitch.tv/${r.login}` }))),
      ),
    );
  }
  components.push(row(button('twc:add', 'Ajouter une chaîne', ButtonStyle.Success, '➕'), button('twc:back', 'Réglages Twitch', ButtonStyle.Secondary, '⚙️')));
  return { embeds: [embed], components };
}

function channelScreen(guild: Guild, r: TwitchChannelRow, note?: string) {
  const flag = (v: number) => (v ? '🟢' : '🔴');
  const embed = brandEmbed(guild)
    .setAuthor({ name: `twitch.tv/${r.login}`, iconURL: r.profile_image ?? undefined, url: `https://twitch.tv/${r.login}` })
    .setTitle(`🔴 ${r.display_name ?? r.login}`)
    .setDescription(
      [
        note,
        `• Salon — <#${r.channel_id}>`,
        `• Rôle mentionné — ${r.role_id ? `<@&${r.role_id}>` : '*aucun*'}`,
        `• Couleur — ${r.color ?? '*par défaut*'}`,
        `• Message — ${r.message ? `\`${truncate(r.message, 150)}\`` : '*celui du serveur*'}`,
        '',
        `${flag(r.show_image)} Miniature du live · ${flag(r.notify_end)} Fin de live · ${flag(r.notify_changes)} Jeu/titre · ${flag(r.notify_clips)} Clips · ${flag(r.notify_events)} Raids/follows/subs`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  if (r.profile_image) embed.setThumbnail(r.profile_image);
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`twc:chan:${r.id}`)
    .setPlaceholder('Salon d’annonce')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (guild.channels.cache.has(r.channel_id)) channelSelect.setDefaultChannels(r.channel_id);
  const roleSelect = new RoleSelectMenuBuilder().setCustomId(`twc:role:${r.id}`).setPlaceholder('Rôle mentionné (aucun = personne)').setMinValues(0).setMaxValues(1);
  if (r.role_id && guild.roles.cache.has(r.role_id)) roleSelect.setDefaultRoles(r.role_id);
  const toggle = (key: string, labelText: string, on: number) => button(`twc:tog:${r.id}:${key}`, labelText, on ? ButtonStyle.Success : ButtonStyle.Secondary, on ? '🟢' : '🔴');
  return {
    embeds: [embed],
    components: [
      row(channelSelect),
      row(roleSelect),
      row(toggle('show_image', 'Miniature', r.show_image), toggle('notify_end', 'Fin', r.notify_end), toggle('notify_changes', 'Jeu/titre', r.notify_changes), toggle('notify_clips', 'Clips', r.notify_clips), toggle('notify_events', 'Événements', r.notify_events)),
      row(
        button(`twc:msg:${r.id}`, 'Message & couleur', ButtonStyle.Primary, '📝'),
        button(`twc:test:${r.id}`, 'Tester', ButtonStyle.Secondary, '🧪'),
        button(`twc:del:${r.id}`, 'Ne plus suivre', ButtonStyle.Danger, '🗑️'),
        button('twc:list', 'Toutes les chaînes', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function fakeStream(r: TwitchChannelRow): TwitchStream {
  return {
    id: 'test',
    user_id: r.broadcaster_id ?? '0',
    user_login: r.login,
    user_name: r.display_name ?? r.login,
    game_id: '',
    game_name: r.last_game || 'Just Chatting',
    title: r.last_title || 'Live de test — tout fonctionne !',
    viewer_count: 42,
    started_at: new Date().toISOString(),
    thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${r.login}-{width}x{height}.jpg`,
  };
}

async function sendTest(guild: Guild, client: Client, r: TwitchChannelRow): Promise<string> {
  const [live] = isTwitchConfigured() ? await getStreams([r.login]).catch(() => []) : [];
  const channel = guild.channels.cache.get(r.channel_id);
  if (!channel?.isTextBased()) throw new UserError('Le salon d’annonce est introuvable.');
  const payload = buildLiveMessage(guild, r, live ?? fakeStream(r));
  await channel.send({ ...payload, content: `🧪 **Test** — ${payload.content}`, allowedMentions: { parse: [] } });
  void client;
  return `✅ Notification de test postée dans <#${channel.id}>${live ? ' (avec le live réel en cours)' : ''}.`;
}

// ─── Setup ─────────────────────────────────────────────────────────────────

const setupPage: SetupPage = {
  id: 'twitch',
  section: 'twitch',
  title: 'Twitch',
  emoji: '🔴',
  moduleId: 'twitch',
  description: `Les réglages par défaut des annonces de live. Chaque chaîne peut avoir son salon, son rôle, son message et sa couleur.\n-# Variables : ${['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand'].map((v) => `\`{${v}}\``).join(' ')}`,
  fields: [
    {
      kind: 'channel',
      key: 'channel',
      label: 'Salon d’annonce par défaut',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      get: (c) => c.twitch.defaultChannelId,
      set: (c, v) => void (c.twitch.defaultChannelId = v),
    },
    { kind: 'role', key: 'role', label: 'Rôle mentionné par défaut', get: (c) => c.twitch.defaultRoleId, set: (c, v) => void (c.twitch.defaultRoleId = v) },
    { kind: 'text', key: 'live', label: 'Message de live', long: true, maxLength: 1500, required: true, get: (c) => c.twitch.liveMessage, set: (c, v) => void (c.twitch.liveMessage = v) },
    { kind: 'text', key: 'end', label: 'Message de fin (vide = aucun)', long: true, maxLength: 1500, get: (c) => c.twitch.endMessage, set: (c, v) => void (c.twitch.endMessage = v) },
    {
      kind: 'text',
      key: 'color',
      label: 'Couleur (#hex)',
      maxLength: 7,
      get: (c) => c.twitch.color,
      set: (c, v) => void (c.twitch.color = toHex(parseColor(v) ?? 0x9146ff)),
      validate: (v) => (parseColor(v) !== null ? null : 'Code hexadécimal attendu (ex : #9146FF).'),
    },
  ],
  actions: [
    {
      id: 'channels',
      label: 'Chaînes suivies',
      emoji: '📺',
      async run(interaction) {
        await interaction.update(listScreen(interaction.guild));
      },
    },
    {
      id: 'brand',
      label: 'Suivre la chaîne de l’enseigne',
      emoji: '💜',
      async run(interaction) {
        const login = brandFor(interaction.guildId).twitchLogin;
        if (!login) throw new UserError('L’enseigne de ce serveur n’a pas de chaîne Twitch (réglable par l’owner bot avec /custom).');
        await interaction.deferUpdate();
        const r = await follow(interaction.guild, login, null, null);
        await interaction.editReply(channelScreen(interaction.guild, r, `✅ **${r.display_name}** est suivie.`));
      },
    },
  ],
};

// ─── Commandes ─────────────────────────────────────────────────────────────

const loginOption = (o: import('discord.js').SlashCommandStringOption) => o.setName('chaine').setDescription('Pseudo ou lien Twitch').setRequired(true).setMaxLength(100);

const twitch: SlashCommand = {
  category: 'twitch',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('Les annonces de live Twitch')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les annonces de live'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Suivre une chaîne')
        .addStringOption(loginOption)
        .addChannelOption((o) => o.setName('salon').setDescription('Salon d’annonce').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner')),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Ne plus suivre une chaîne').addStringOption((o) => loginOption(o).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Les chaînes suivies'))
    .addSubcommand((s) => s.setName('test').setDescription('Envoyer une notification de test').addStringOption((o) => loginOption(o).setAutocomplete(true))),
  subLevels: { list: PermLevel.STAFF },
  async autocomplete(interaction) {
    const focused = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listChannels(interaction.guildId)
        .filter((r) => r.login.includes(focused))
        .slice(0, 25)
        .map((r) => ({ name: r.display_name ?? r.login, value: r.login })),
    );
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'setup':
        return reply(interaction, { ...renderPage(guild, getSetupPage('twitch')!), ephemeral: true });
      case 'list':
        return reply(interaction, { ...listScreen(guild), ephemeral: true });
      case 'add': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await follow(guild, interaction.options.getString('chaine', true), interaction.options.getChannel('salon')?.id ?? null, interaction.options.getRole('role')?.id ?? null);
        return interaction.editReply(channelScreen(guild, r, `✅ **${r.display_name}** est suivie.`));
      }
      case 'remove': {
        const login = normalizeLogin(interaction.options.getString('chaine', true));
        if (!removeChannel(guild.id, login)) throw new UserError(`**${login}** n’est pas suivie ici.`);
        return reply(interaction, { embeds: [ok(guild, `**${login}** n’est plus suivie.`)], ephemeral: true });
      }
      case 'test': {
        const r = getChannel(guild.id, normalizeLogin(interaction.options.getString('chaine', true)));
        if (!r) throw new UserError('Cette chaîne n’est pas suivie ici.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ embeds: [info(guild, await sendTest(guild, interaction.client, r))] });
      }
    }
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'twitch',
    aliases: ['lives'],
    domain: 'general',
    category: 'twitch',
    description: 'Les chaînes suivies',
    level: PermLevel.STAFF,
    async execute(message) {
      const { embeds } = listScreen(message.guild);
      await message.reply({ embeds, allowedMentions: { repliedUser: false } });
    },
  },
];

export const twitchModule: BotModule = {
  id: 'twitch',
  name: 'Twitch',
  emoji: '🔴',
  description: 'Annonces de live multi-chaînes, fin de live, clips, raids',
  toggleable: true,
  defaultEnabled: true,
  commands: [twitch],
  prefixCommands,
  setupPages: [setupPage],
  components: [
    {
      prefix: 'twc',
      level: PermLevel.ADMIN,
      async button(interaction: ButtonInteraction<'cached'>, [action, id, key]) {
        const guild = interaction.guild;
        switch (action) {
          case 'list':
            return interaction.update(listScreen(guild));
          case 'back':
            return interaction.update(renderPage(guild, getSetupPage('twitch')!));
          case 'add':
            return interaction.showModal(
              buildModal('twc:addm', 'Suivre une chaîne', [{ id: 'login', label: 'Pseudo ou lien Twitch', placeholder: 'ex : zerator', maxLength: 100 }]),
            );
          case 'tog': {
            const r = requireRow(guild.id, id);
            const allowed = ['show_image', 'notify_end', 'notify_changes', 'notify_clips', 'notify_events'] as const;
            const field = allowed.find((k) => k === key);
            if (!field) return;
            updateChannel(r.id, { [field]: r[field] ? 0 : 1 });
            if (field === 'notify_events') eventSub?.resync();
            const next = requireRow(guild.id, id);
            const note = field === 'notify_events' && next.notify_events && !eventSub?.enabled ? '⚠️ Les événements (raids, follows, subs) demandent `TWITCH_USER_TOKEN` dans le .env.' : undefined;
            return interaction.update(channelScreen(guild, next, note));
          }
          case 'msg': {
            const r = requireRow(guild.id, id);
            return interaction.showModal(
              buildModal(`twc:msgm:${r.id}`, `Annonce de ${r.display_name ?? r.login}`.slice(0, 45), [
                { id: 'message', label: 'Message (vide = celui du serveur)', long: true, value: r.message, required: false, maxLength: 1500, placeholder: '🔴 {streamer} est en LIVE ! {role}' },
                { id: 'color', label: 'Couleur #hex (vide = par défaut)', value: r.color, required: false, maxLength: 7 },
              ]),
            );
          }
          case 'test': {
            const r = requireRow(guild.id, id);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return interaction.editReply({ embeds: [info(guild, await sendTest(guild, interaction.client, r))] });
          }
          case 'del': {
            const r = requireRow(guild.id, id);
            removeChannel(guild.id, r.login);
            return interaction.update(listScreen(guild, `✅ **${r.display_name ?? r.login}** n’est plus suivie.`));
          }
        }
      },
      async select(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const guild = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(channelScreen(guild, requireRow(guild.id, interaction.values[0])));
        const r = requireRow(guild.id, id);
        if (action === 'chan' && interaction.isChannelSelectMenu()) updateChannel(r.id, { channel_id: interaction.values[0]! });
        if (action === 'role' && interaction.isRoleSelectMenu()) updateChannel(r.id, { role_id: interaction.values[0] ?? null });
        return interaction.update(channelScreen(guild, requireRow(guild.id, id), '✅ C’est enregistré.'));
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const guild = interaction.guild;
        const respond = async (payload: ReturnType<typeof channelScreen>) => {
          if (interaction.isFromMessage()) await interaction.update(payload);
          else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        };
        if (action === 'addm') {
          await interaction.deferUpdate().catch(() => undefined);
          const r = await follow(guild, interaction.fields.getTextInputValue('login'), null, null);
          await interaction.editReply(channelScreen(guild, r, `✅ **${r.display_name}** est suivie.`));
          return;
        }
        if (action === 'msgm') {
          const r = requireRow(guild.id, id);
          const colorRaw = interaction.fields.getTextInputValue('color').trim();
          const color = colorRaw ? parseColor(colorRaw) : null;
          if (colorRaw && color === null) throw new UserError('Couleur attendue au format #9146FF.');
          updateChannel(r.id, { message: interaction.fields.getTextInputValue('message').trim() || null, color: color !== null ? toHex(color) : null });
          await respond(channelScreen(guild, requireRow(guild.id, id), '✅ C’est enregistré.'));
        }
      },
    },
  ],
  tasks: [
    {
      name: 'twitch-streams',
      intervalMs: env.twitchPollSeconds * 1000,
      runOnStart: true,
      async run(client) {
        if (isTwitchConfigured()) await pollStreams(client);
      },
    },
    {
      name: 'twitch-clips',
      intervalMs: 5 * 60_000,
      async run(client) {
        if (isTwitchConfigured()) await pollClips(client);
      },
    },
  ],
  async onReady(client) {
    if (!isTwitchConfigured()) {
      log.warn('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET absents : les annonces de live sont inactives.');
      return;
    }
    eventSub = new EventSubClient(client);
    await eventSub.start().catch((err: unknown) => log.warn(`EventSub non démarré : ${(err as Error).message}`));
  },
  onShutdown() {
    eventSub?.stop();
  },
  tests: [
    {
      id: 'variables',
      label: 'Variables des annonces',
      emoji: '🧩',
      description: 'Les variables utilisables dans les messages de live',
      async run() {
        return variablesHelp(['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand', 'server']);
      },
    },
    {
      id: 'status',
      label: 'État de la connexion Twitch',
      emoji: '📡',
      description: 'Clés API, EventSub et chaînes suivies',
      async run(interaction) {
        const rows = listChannels(interaction.guildId);
        return [
          `${isTwitchConfigured() ? '✅' : '❌'} Clés API Twitch`,
          `${eventSub?.enabled ? '✅' : 'ℹ️'} EventSub (raids, follows, subs)${eventSub?.enabled ? '' : ' — nécessite TWITCH_USER_TOKEN'}`,
          `📺 ${rows.length} chaîne(s) suivie(s), ${rows.filter((r) => r.live_stream_id).length} en live`,
          `⏱️ Vérification toutes les ${env.twitchPollSeconds} s`,
        ].join('\n');
      },
    },
  ],
};

