import {
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type TextChannel,
} from 'discord.js';
import { emojiFor } from '../../core/brand';
import { askConfirmation } from '../../core/confirm';
import { brandEmbed, brandName, colorFor, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig, updateConfig, type TicketButtonStyle, type TicketCategory } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { linesToPages, paginate } from '../../core/pagination';
import { hasLevel } from '../../core/permissions';
import { getSetupPage, renderPage, type SetupPage } from '../../core/setup';
import { slugify, truncate } from '../../core/text';
import { ts } from '../../core/time';
import { button, buildModal, row } from '../../core/ui';
import { renderTemplate } from '../../core/variables';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import {
  archiveTranscript,
  categoryOf,
  createTicket,
  isTicketStaff,
  listTickets,
  loadTicketChannels,
  lockCreator,
  markClaimed,
  markClosed,
  markDeleted,
  markReopened,
  rolesAboveBot,
  storeTicketMessage,
  ticketByChannel,
  ticketChannels,
  type TicketRow,
} from '../../services/tickets';
import { buildTranscriptHtml, fetchAllMessages } from '../../services/transcript';
import { AttachmentBuilder } from 'discord.js';

const STYLES: Record<TicketButtonStyle, ButtonStyle> = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

// ─── Panneau ───────────────────────────────────────────────────────────────

function vars(guild: Guild) {
  return { guild, extra: { brand: brandName(guild) } };
}

export function buildPanel(guild: Guild): MessageCreateOptions {
  const cfg = getConfig(guild.id).tickets;
  const title = renderTemplate(cfg.panelTitle, vars(guild));
  const intro = renderTemplate(cfg.panelIntro, vars(guild));
  const footer = renderTemplate(cfg.panelFooter, vars(guild));
  const categories = cfg.categories.slice(0, 20);

  if (cfg.panelStyle === 'v2') {
    const container = new ContainerBuilder().setAccentColor(colorFor(guild));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`), new TextDisplayBuilder().setContent(intro));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    categories.forEach((cat, i) => {
      if (i > 0) container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${cat.emoji} **${cat.label}**\n-# ${cat.description || '—'}`))
          .setButtonAccessory(new ButtonBuilder().setCustomId(`tk:open:${cat.id}`).setLabel('Ouvrir').setStyle(STYLES[cat.style] ?? ButtonStyle.Secondary)),
      );
    });
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  const embed = brandEmbed(guild)
    .setTitle(title.slice(0, 256))
    .setDescription(truncate([intro, '', ...categories.map((c) => `${c.emoji} **${c.label}** — ${c.description}`)].join('\n'), 4096))
    .setFooter({ text: footer.slice(0, 2048) });

  if (cfg.panelStyle === 'menu') {
    return { embeds: [embed], components: [row(button('tk:menu', 'Ouvrir un ticket', ButtonStyle.Primary, emojiFor(guild.id, 'ticket')))] };
  }
  const buttons = categories.map((c) => button(`tk:open:${c.id}`, c.label, STYLES[c.style] ?? ButtonStyle.Secondary, c.emoji));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 3) rows.push(row(...buttons.slice(i, i + 3)));
  return { embeds: [embed], components: rows };
}

async function publishPanel(channel: GuildTextBasedChannel): Promise<string> {
  const sent = await channel.send(buildPanel(channel.guild));
  updateConfig(channel.guild.id, (c) => void (c.tickets.panelChannelId = channel.id));
  return sent.url;
}

function categoryMenu(guild: Guild) {
  const cats = getConfig(guild.id).tickets.categories.slice(0, 25);
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('tk:pick')
      .setPlaceholder('Quel est le sujet ?')
      .addOptions(cats.map((c) => ({ label: c.label, value: c.id, emoji: c.emoji, description: truncate(c.description || c.label, 100) }))),
  );
}

// ─── Contrôles dans le ticket ──────────────────────────────────────────────

function openControls(guildId: string, claimed: boolean) {
  return [
    row(
      button('tk:close', 'Fermer', ButtonStyle.Danger, '🔒'),
      button('tk:claim', claimed ? 'Libérer' : 'Claim', ButtonStyle.Success, '📌'),
      button('tk:add', 'Ajouter', ButtonStyle.Secondary, '👤'),
      button('tk:remove', 'Retirer', ButtonStyle.Secondary, '❌'),
      button('tk:transcript', '', ButtonStyle.Secondary, emojiFor(guildId, 'message')),
    ),
  ];
}

function closedControls() {
  return [
    row(
      button('tk:reopen', 'Rouvrir', ButtonStyle.Success, '🔓'),
      button('tk:transcript', 'Transcript', ButtonStyle.Secondary, '📄'),
      button('tk:delete', 'Supprimer', ButtonStyle.Danger, '🗑️'),
    ),
  ];
}

async function openFlow(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, categoryId: string) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { channel, category, pingRoles, ticket } = await createTicket(interaction.member, categoryId);
  const cfg = getConfig(interaction.guild.id).tickets;
  const embed = brandEmbed(interaction.guild)
    .setTitle(renderTemplate(cfg.welcomeTitle, vars(interaction.guild)).slice(0, 256))
    .setDescription(truncate(renderTemplate(cfg.welcomeMessage, { member: interaction.member, guild: interaction.guild, extra: { brand: brandName(interaction.guild) } }), 4096))
    .addFields({ name: `${emojiFor(interaction.guild.id, 'ticket')} Motif`, value: `${category.emoji} ${category.label}`, inline: true }, { name: 'Numéro', value: `#${ticket.number}`, inline: true })
    .setFooter({ text: cfg.welcomeFooter || brandName(interaction.guild) })
    .setTimestamp();
  await channel.send({
    content: [`<@${interaction.user.id}>`, ...pingRoles.map((id) => `<@&${id}>`)].join(' '),
    embeds: [embed],
    components: openControls(interaction.guild.id, false),
    allowedMentions: { users: [interaction.user.id], roles: pingRoles },
  });
  await interaction.editReply({ embeds: [ok(interaction.guild, `Ticket créé : <#${channel.id}>`, { titre: 'Ticket', sujet: emojiFor(interaction.guild.id, 'ticket') })] });
}

function requireTicket(channelId: string | null): TicketRow {
  const ticket = channelId ? ticketByChannel(channelId) : undefined;
  if (!ticket) throw new UserError('Cette action se fait dans un salon de ticket.');
  return ticket;
}

function requireStaff(member: GuildMember, ticket: TicketRow): void {
  if (!isTicketStaff(member, ticket)) throw new UserError('Réservé au staff des tickets.');
}

async function closeFlow(interaction: ButtonInteraction<'cached'> | import('discord.js').ChatInputCommandInteraction<'cached'>, ticket: TicketRow) {
  const channel = interaction.channel as TextChannel;
  const guild = interaction.guild;
  const mode = getConfig(guild.id).tickets.closeMode;
  if (ticket.user_id !== interaction.user.id && !isTicketStaff(interaction.member, ticket)) throw new UserError('Seul le créateur ou le staff peut fermer ce ticket.');
  if (ticket.status === 'closed') throw new UserError('Ce ticket est déjà fermé.');

  const run = async (i: RepliableInteraction) => {
    await reply(i, { embeds: [info(guild, 'Fermeture du ticket en cours…', { emoji: emojiFor(guild.id, 'ticket') })] });
    markClosed(ticket, interaction.user.id);
    const { messages, dmSent } = await archiveTranscript(guild, channel, ticket, interaction.user);
    if (mode === 'delete') {
      await channel.send({ embeds: [info(guild, `Transcript enregistré (${messages} messages)${dmSent ? ', envoyé en MP' : ''}. Suppression du salon…`)] }).catch(() => undefined);
      setTimeout(() => {
        markDeleted(channel.id);
        void channel.delete(`Ticket fermé par ${interaction.user.tag}`).catch(() => undefined);
      }, 3_000).unref();
      return;
    }
    await lockCreator(channel, ticket, false);
    await channel.setName(`fermé-${channel.name}`.slice(0, 100)).catch(() => undefined);
    await channel.send({
      embeds: [
        brandEmbed(guild)
          .setTitle('🔒 Ticket fermé')
          .setDescription(`Fermé par <@${interaction.user.id}> · ${messages} messages archivés${dmSent ? ' · transcript envoyé en MP' : ''}.`),
      ],
      components: closedControls(),
    });
  };

  await askConfirmation(interaction, {
    title: 'Fermer le ticket ?',
    description: mode === 'delete' ? 'Le transcript est enregistré puis le salon est supprimé.' : 'Le transcript est enregistré et le salon est archivé.',
    confirmLabel: 'Fermer',
    onConfirm: async (i) => {
      await i.update({ embeds: [info(guild, 'C’est parti.')], components: [] });
      await run(i);
    },
  });
}

async function sendTranscriptEphemeral(interaction: RepliableInteraction, channel: TextChannel) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = await fetchAllMessages(channel);
  const html = buildTranscriptHtml(channel, messages);
  await interaction.editReply({
    embeds: [ok(interaction.guild, `${messages.length} message(s).`, { titre: 'Transcript' })],
    files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${channel.name}.html` })],
  });
}

// ─── Catégories & rôles (« Qui voit les tickets ») ─────────────────────────

function categoriesScreen(guild: Guild, note?: string) {
  const cats = getConfig(guild.id).tickets.categories;
  const embed = brandEmbed(guild)
    .setTitle(`${emojiFor(guild.id, 'cle')} Qui voit les tickets`)
    .setDescription(note ?? 'Choisis une catégorie pour changer ses rôles, son texte ou la supprimer.\n-# Sans rôle, ce sont les rôles staff des tickets puis les rôles d’accès du bot qui prennent le relais.');
  for (const c of cats.slice(0, 24)) {
    const blocked = rolesAboveBot(guild, c.roles);
    embed.addFields({
      name: `${c.emoji} ${c.label}`,
      value: truncate(`${c.roles.length ? c.roles.map((r) => `<@&${r}>`).join(' ') : '*rôles par défaut*'}${blocked.length ? '\n⚠️ rôle(s) introuvable(s) ou au-dessus du bot' : ''}\n-# \`${c.id}\` · ${c.style}`, 1024),
      inline: true,
    });
  }
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (cats.length) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('tkc:open')
          .setPlaceholder('Catégorie de ticket à configurer')
          .addOptions(cats.slice(0, 25).map((c) => ({ label: c.label, value: c.id, emoji: c.emoji, description: `${c.roles.length} rôle(s)` }))),
      ),
    );
  }
  components.push(
    row(
      button('tkc:new', 'Ajouter une catégorie', ButtonStyle.Success, '➕').setDisabled(cats.length >= 20),
      button('tkc:back', 'Retour aux réglages', ButtonStyle.Secondary, '⬅️'),
    ),
  );
  return { embeds: [embed], components };
}

function categoryScreen(guild: Guild, id: string, note?: string) {
  const cat = getConfig(guild.id).tickets.categories.find((c) => c.id === id);
  if (!cat) return categoriesScreen(guild, '⚠️ Cette catégorie n’existe plus.');
  const embed = brandEmbed(guild)
    .setTitle(`${cat.emoji} ${cat.label}`)
    .setDescription(
      [
        note,
        cat.description,
        '',
        `**Rôles** : ${cat.roles.length ? cat.roles.map((r) => `<@&${r}>`).join(' ') : '*par défaut*'}`,
        '-# Eux et le membre, personne d’autre. Ils sont mentionnés à l’ouverture.',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const select = new RoleSelectMenuBuilder().setCustomId(`tkc:roles:${cat.id}`).setPlaceholder('Rôles ayant accès (aucun = par défaut)').setMinValues(0).setMaxValues(10);
  const valid = cat.roles.filter((r) => guild.roles.cache.has(r));
  if (valid.length) select.setDefaultRoles(...valid);
  return {
    embeds: [embed],
    components: [
      row(select),
      row(
        button(`tkc:edit:${cat.id}`, 'Modifier', ButtonStyle.Primary, '✏️'),
        button(`tkc:del:${cat.id}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
        button('tkc:home', 'Toutes les catégories', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function parseStyle(raw: string): TicketButtonStyle {
  const v = raw.trim().toLowerCase();
  if (['rouge', 'danger', 'red'].includes(v)) return 'Danger';
  if (['vert', 'success', 'green'].includes(v)) return 'Success';
  if (['bleu', 'primary', 'blue', 'violet', 'blurple'].includes(v)) return 'Primary';
  return 'Secondary';
}

const STYLE_LABEL: Record<TicketButtonStyle, string> = { Primary: 'bleu', Secondary: 'gris', Success: 'vert', Danger: 'rouge' };

// ─── Setup ─────────────────────────────────────────────────────────────────

const pages: SetupPage[] = [
  {
    id: 'tickets',
    section: 'tickets',
    title: 'Tickets',
    emoji: '🎫',
    moduleId: 'tickets',
    order: 1,
    description: 'Le panneau, la catégorie Discord des tickets et le staff qui les voit.\n-# Les transcripts partent dans `#ticket-logs`.',
    fields: [
      { kind: 'channel', key: 'panel', label: 'Salon du panneau', get: (c) => c.tickets.panelChannelId, set: (c, v) => void (c.tickets.panelChannelId = v) },
      {
        kind: 'channel',
        key: 'parent',
        label: 'Catégorie des tickets',
        channelTypes: [ChannelType.GuildCategory],
        get: (c) => c.tickets.parentCategoryId,
        set: (c, v) => void (c.tickets.parentCategoryId = v),
      },
      { kind: 'roles', key: 'staff', label: 'Rôles staff (tous les tickets)', max: 10, get: (c) => c.tickets.staffRoles, set: (c, v) => void (c.tickets.staffRoles = v) },
      { kind: 'toggle', key: 'dm', label: 'Transcript en MP', get: (c) => c.tickets.transcriptToUser, set: (c, v) => void (c.tickets.transcriptToUser = v) },
      {
        kind: 'toggle',
        key: 'delete',
        label: 'Supprimer à la fermeture',
        get: (c) => c.tickets.closeMode === 'delete',
        set: (c, v) => void (c.tickets.closeMode = v ? 'delete' : 'archive'),
      },
      { kind: 'number', key: 'max', label: 'Tickets ouverts max par membre', min: 1, max: 10, get: (c) => c.tickets.maxOpenPerUser, set: (c, v) => void (c.tickets.maxOpenPerUser = v) },
      { kind: 'text', key: 'wfooter', label: 'Pied du message d’ouverture', maxLength: 200, get: (c) => c.tickets.welcomeFooter, set: (c, v) => void (c.tickets.welcomeFooter = v) },
    ],
    actions: [
      {
        id: 'publish',
        label: 'Publier le panneau',
        emoji: '📤',
        async run(interaction) {
          const channel = resolveTextChannel(interaction.guild, getConfig(interaction.guildId).tickets.panelChannelId);
          if (!channel) throw new UserError('Choisis d’abord le salon du panneau (et vérifie que je peux y écrire).');
          const url = await publishPanel(channel);
          await interaction.reply({ embeds: [ok(interaction.guild, `Panneau posté : ${url}`)], flags: MessageFlags.Ephemeral });
        },
      },
      {
        id: 'cats',
        label: 'Catégories & rôles',
        emoji: '🔑',
        async run(interaction) {
          await interaction.update(categoriesScreen(interaction.guild));
        },
      },
    ],
  },
  {
    id: 'tickets-look',
    section: 'tickets',
    title: 'Tickets — textes',
    emoji: '📝',
    order: 2,
    description: 'L’apparence du panneau et du message d’ouverture.\n-# Variables : `{brand}` `{server}` `{mention}` `{user}`',
    fields: [
      {
        kind: 'choice',
        key: 'style',
        label: 'Style du panneau',
        options: [
          { value: 'buttons', label: 'Un bouton par motif', emoji: '🔘' },
          { value: 'v2', label: 'Sections avec bouton « Ouvrir »', emoji: '🧩' },
          { value: 'menu', label: 'Un bouton puis « Quel est le sujet ? »', emoji: '📋' },
        ],
        get: (c) => c.tickets.panelStyle,
        set: (c, v) => void (c.tickets.panelStyle = v as 'buttons' | 'v2' | 'menu'),
      },
      { kind: 'text', key: 'ptitle', label: 'Titre du panneau', maxLength: 200, required: true, get: (c) => c.tickets.panelTitle, set: (c, v) => void (c.tickets.panelTitle = v) },
      { kind: 'text', key: 'pintro', label: 'Phrase du panneau', long: true, maxLength: 1000, get: (c) => c.tickets.panelIntro, set: (c, v) => void (c.tickets.panelIntro = v) },
      { kind: 'text', key: 'pfooter', label: 'Pied du panneau', maxLength: 200, get: (c) => c.tickets.panelFooter, set: (c, v) => void (c.tickets.panelFooter = v) },
      { kind: 'text', key: 'wtitle', label: 'Titre à l’ouverture', maxLength: 200, required: true, get: (c) => c.tickets.welcomeTitle, set: (c, v) => void (c.tickets.welcomeTitle = v) },
      { kind: 'text', key: 'wmessage', label: 'Message à l’ouverture', long: true, maxLength: 2000, required: true, get: (c) => c.tickets.welcomeMessage, set: (c, v) => void (c.tickets.welcomeMessage = v) },
    ],
  },
];

// ─── Commandes ─────────────────────────────────────────────────────────────

function ticketListPages(guild: Guild, status: 'open' | 'closed' | 'all') {
  const rows = listTickets(guild.id, status);
  const lines = rows.map((t) => {
    const cat = categoryOf(guild.id, t.category);
    const state = t.status === 'open' ? '🟢' : '🔒';
    return `${state} **#${t.number}** <#${t.channel_id}> — ${cat.emoji} ${cat.label} · <@${t.user_id}> · ${ts(t.created_at, 'R')}${t.claimed_by ? ` · 📌 <@${t.claimed_by}>` : ''}`;
  });
  if (!lines.length) lines.push('*Aucun ticket.*');
  return linesToPages(lines, 10, (content, page, total) =>
    brandEmbed(guild).setTitle(`🎫 Tickets (${rows.length})`).setDescription(content).setFooter({ text: `Page ${page}/${total}` }),
  );
}

const ticketCommand: SlashCommand = {
  category: 'tickets',
  level: PermLevel.MEMBER,
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Les tickets')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les tickets'))
    .addSubcommand((s) => s.setName('config').setDescription('Catégories et qui voit les tickets'))
    .addSubcommand((s) =>
      s
        .setName('panneau')
        .setDescription('Poster le panneau')
        .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('close').setDescription('Fermer ce ticket'))
    .addSubcommand((s) => s.setName('reopen').setDescription('Rouvrir ce ticket'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Ajouter quelqu’un au ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer quelqu’un du ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('claim').setDescription('Prendre ce ticket en charge'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Le transcript de ce ticket'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Les tickets du serveur')
        .addStringOption((o) => o.setName('etat').setDescription('Lesquels').addChoices({ name: 'Ouverts', value: 'open' }, { name: 'Fermés', value: 'closed' }, { name: 'Tous', value: 'all' })),
    ),
  subLevels: {
    setup: PermLevel.ADMIN,
    config: PermLevel.ADMIN,
    panneau: PermLevel.ADMIN,
    reopen: PermLevel.SUPPORT,
    add: PermLevel.SUPPORT,
    remove: PermLevel.SUPPORT,
    claim: PermLevel.SUPPORT,
    transcript: PermLevel.SUPPORT,
    list: PermLevel.SUPPORT,
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    switch (sub) {
      case 'setup':
        return reply(interaction, { ...renderPage(guild, getSetupPage('tickets')!), ephemeral: true });
      case 'config':
        return reply(interaction, { ...categoriesScreen(guild), ephemeral: true });
      case 'panneau': {
        const channel = (interaction.options.getChannel('salon') ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!channel) return;
        const url = await publishPanel(channel);
        return reply(interaction, { embeds: [ok(guild, `Panneau posté : ${url}`)], ephemeral: true });
      }
      case 'list':
        return paginate(interaction, ticketListPages(guild, (interaction.options.getString('etat') ?? 'open') as 'open' | 'closed' | 'all'), true);
    }
    const ticket = requireTicket(interaction.channelId);
    const channel = interaction.channel as TextChannel;
    switch (sub) {
      case 'close':
        return closeFlow(interaction, ticket);
      case 'reopen':
        return reopen(interaction, ticket, channel);
      case 'claim':
        return claim(interaction, ticket);
      case 'transcript':
        return sendTranscriptEphemeral(interaction, channel);
      case 'add':
      case 'remove': {
        const user = interaction.options.getUser('membre', true);
        await setMemberAccess(guild, channel, ticket, user.id, sub === 'add', interaction.member);
        return reply(interaction, { embeds: [ok(guild, `<@${user.id}> ${sub === 'add' ? 'ajouté au' : 'retiré du'} ticket.`)] });
      }
    }
  },
};

async function reopen(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: TicketRow, channel: TextChannel) {
  requireStaff(interaction.member, ticket);
  if (ticket.status !== 'closed') throw new UserError('Ce ticket est déjà ouvert.');
  markReopened(ticket);
  ticketChannels.add(channel.id);
  await lockCreator(channel, ticket, true);
  if (channel.name.startsWith('fermé-')) await channel.setName(channel.name.slice('fermé-'.length)).catch(() => undefined);
  void journal(interaction.guild, 'ticket', { title: 'Ticket rouvert', tone: 'ok', lines: [`**Ticket** : <#${channel.id}>`], by: interaction.user });
  await reply(interaction, { embeds: [ok(interaction.guild, `🔓 Ticket rouvert par <@${interaction.user.id}>.`)], components: openControls(interaction.guild.id, !!ticket.claimed_by) });
}

async function claim(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: TicketRow) {
  requireStaff(interaction.member, ticket);
  if (ticket.claimed_by && ticket.claimed_by !== interaction.user.id && !hasLevel(interaction.member, PermLevel.ADMIN)) {
    throw new UserError(`Ce ticket est déjà pris en charge par <@${ticket.claimed_by}>.`);
  }
  const release = ticket.claimed_by === interaction.user.id;
  markClaimed(ticket, release ? null : interaction.user.id);
  void journal(interaction.guild, 'ticket', {
    title: release ? 'Ticket libéré' : 'Ticket pris en charge',
    tone: 'info',
    lines: [`**Ticket** : <#${ticket.channel_id}>`, `**Staff** : <@${interaction.user.id}>`],
    by: interaction.user,
  });
  await reply(interaction, {
    embeds: [info(interaction.guild, release ? `📌 <@${interaction.user.id}> a libéré ce ticket.` : `📌 Ticket pris en charge par <@${interaction.user.id}>.`)],
    allowedMentions: { parse: [] },
  });
}

async function setMemberAccess(guild: Guild, channel: TextChannel, ticket: TicketRow, userId: string, add: boolean, actor: GuildMember) {
  requireStaff(actor, ticket);
  if (!add && userId === ticket.user_id) throw new UserError('Impossible de retirer le créateur du ticket.');
  if (add) await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  else await channel.permissionOverwrites.delete(userId);
  void journal(guild, 'ticket', {
    title: add ? 'Membre ajouté au ticket' : 'Membre retiré du ticket',
    tone: 'info',
    lines: [`**Ticket** : <#${channel.id}>`, `**Membre** : <@${userId}>`],
    by: actor.user,
  });
}

const prefixCommands: PrefixCommand[] = [
  {
    name: 'ticket',
    domain: 'general',
    category: 'tickets',
    description: 'Poster le panneau ici',
    level: PermLevel.ADMIN,
    async execute(message) {
      await publishPanel(message.channel);
      await message.delete().catch(() => undefined);
    },
  },
  {
    name: 'tickets',
    domain: 'general',
    category: 'tickets',
    description: 'Les tickets ouverts',
    level: PermLevel.SUPPORT,
    async execute(message) {
      await message.reply({ embeds: [ticketListPages(message.guild, 'open')[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

// ─── Composants ────────────────────────────────────────────────────────────

export const ticketsModule: BotModule = {
  id: 'tickets',
  name: 'Tickets',
  emoji: '🎫',
  description: 'Panneau, salons privés, claim, transcripts HTML',
  toggleable: true,
  defaultEnabled: true,
  commands: [ticketCommand],
  prefixCommands,
  setupPages: pages,
  components: [
    {
      prefix: 'tk',
      async button(interaction: ButtonInteraction<'cached'>, [action, arg]) {
        const guild = interaction.guild;
        if (action === 'open' && arg) return openFlow(interaction, arg);
        if (action === 'menu') return interaction.reply({ components: [categoryMenu(guild)], flags: MessageFlags.Ephemeral });
        const ticket = requireTicket(interaction.channelId);
        const channel = interaction.channel as TextChannel;
        switch (action) {
          case 'close':
            return closeFlow(interaction, ticket);
          case 'claim':
            return claim(interaction, ticket);
          case 'reopen':
            return reopen(interaction, ticket, channel);
          case 'transcript':
            requireStaff(interaction.member, ticket);
            return sendTranscriptEphemeral(interaction, channel);
          case 'add':
          case 'remove':
            requireStaff(interaction.member, ticket);
            return interaction.reply({
              components: [
                row(
                  new UserSelectMenuBuilder()
                    .setCustomId(`tk:${action}sel`)
                    .setPlaceholder(action === 'add' ? 'Qui ajouter ?' : 'Qui retirer ?')
                    .setMinValues(1)
                    .setMaxValues(5),
                ),
              ],
              flags: MessageFlags.Ephemeral,
            });
          case 'delete':
            requireStaff(interaction.member, ticket);
            return askConfirmation(interaction, {
              title: 'Supprimer le ticket ?',
              description: 'Le salon est supprimé définitivement (le transcript a déjà été enregistré à la fermeture).',
              confirmLabel: 'Supprimer',
              onConfirm: async (i) => {
                await i.update({ embeds: [info(guild, 'Suppression…')], components: [] });
                markDeleted(channel.id);
                void journal(guild, 'ticket', { title: 'Ticket supprimé', tone: 'alerte', lines: [`**Ticket** : \`#${channel.name}\``], by: i.user });
                setTimeout(() => void channel.delete(`Ticket supprimé par ${i.user.tag}`).catch(() => undefined), 2_000).unref();
              },
            });
        }
      },
      async select(interaction: AnySelectMenuInteraction<'cached'>, [action]) {
        if (action === 'pick' && interaction.isStringSelectMenu()) return openFlow(interaction, interaction.values[0]!);
        if ((action === 'addsel' || action === 'removesel') && interaction.isUserSelectMenu()) {
          const ticket = requireTicket(interaction.channelId);
          const channel = interaction.channel as TextChannel;
          const add = action === 'addsel';
          const done: string[] = [];
          for (const user of interaction.users.values()) {
            if (user.bot) continue;
            await setMemberAccess(interaction.guild, channel, ticket, user.id, add, interaction.member).then(() => done.push(`<@${user.id}>`)).catch(() => undefined);
          }
          await interaction.update({ embeds: [ok(interaction.guild, done.length ? `${done.join(', ')} ${add ? 'ajouté(s)' : 'retiré(s)'}.` : 'Personne n’a été modifié.')], components: [] });
          if (done.length) await channel.send({ embeds: [info(interaction.guild, `${done.join(', ')} ${add ? 'ajouté(s) au' : 'retiré(s) du'} ticket par <@${interaction.user.id}>.`)], allowedMentions: { parse: [] } });
        }
      },
    },
    {
      prefix: 'tkc',
      level: PermLevel.ADMIN,
      async button(interaction: ButtonInteraction<'cached'>, [action, id]) {
        const guild = interaction.guild;
        switch (action) {
          case 'home':
            return interaction.update(categoriesScreen(guild));
          case 'back':
            return interaction.update(renderPage(guild, getSetupPage('tickets')!));
          case 'new':
            return interaction.showModal(
              buildModal('tkc:newm', 'Nouvelle catégorie', [
                { id: 'label', label: 'Nom', placeholder: 'ex : Support', maxLength: 40 },
                { id: 'emoji', label: 'Émoji', placeholder: '🎫', maxLength: 64, required: false },
                { id: 'description', label: 'Description', placeholder: 'Une question ou un souci ? On t’aide.', maxLength: 100, required: false },
                { id: 'style', label: 'Couleur du bouton (bleu, vert, rouge, gris)', value: 'gris', maxLength: 10, required: false },
              ]),
            );
          case 'edit': {
            const cat = getConfig(guild.id).tickets.categories.find((c) => c.id === id);
            if (!cat) return interaction.update(categoriesScreen(guild));
            return interaction.showModal(
              buildModal(`tkc:editm:${cat.id}`, `Catégorie ${cat.label}`.slice(0, 45), [
                { id: 'label', label: 'Nom', value: cat.label, maxLength: 40 },
                { id: 'emoji', label: 'Émoji', value: cat.emoji, maxLength: 64, required: false },
                { id: 'description', label: 'Description', value: cat.description, maxLength: 100, required: false },
                { id: 'style', label: 'Couleur du bouton (bleu, vert, rouge, gris)', value: STYLE_LABEL[cat.style], maxLength: 10, required: false },
              ]),
            );
          }
          case 'del': {
            if (getConfig(guild.id).tickets.categories.length <= 1) throw new UserError('Il faut garder au moins une catégorie.');
            updateConfig(guild.id, (c) => void (c.tickets.categories = c.tickets.categories.filter((x) => x.id !== id)));
            return interaction.update(categoriesScreen(guild, '✅ Catégorie supprimée. Pense à republier le panneau.'));
          }
        }
      },
      async select(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const guild = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(categoryScreen(guild, interaction.values[0]!));
        if (action === 'roles' && interaction.isRoleSelectMenu() && id) {
          updateConfig(guild.id, (c) => {
            const cat = c.tickets.categories.find((x) => x.id === id);
            if (cat) cat.roles = [...interaction.values];
          });
          return interaction.update(categoryScreen(guild, id, `✅ C’est enregistré.`));
        }
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const guild = interaction.guild;
        const label = interaction.fields.getTextInputValue('label').trim();
        const emoji = interaction.fields.getTextInputValue('emoji').trim() || '🎫';
        const description = interaction.fields.getTextInputValue('description').trim();
        const style = parseStyle(interaction.fields.getTextInputValue('style'));
        if (!label) throw new UserError('Le nom est obligatoire.');
        let target = id;
        updateConfig(guild.id, (c) => {
          if (action === 'newm') {
            let slug = slugify(label, 20);
            while (c.tickets.categories.some((x) => x.id === slug)) slug = `${slugify(label, 16)}-${Math.random().toString(36).slice(2, 4)}`;
            c.tickets.categories.push({ id: slug, label, emoji, description, style, roles: [] } satisfies TicketCategory);
            target = slug;
          } else {
            const cat = c.tickets.categories.find((x) => x.id === id);
            if (cat) Object.assign(cat, { label, emoji, description, style });
          }
        });
        const payload = categoryScreen(guild, target!, '✅ C’est enregistré. Pense à republier le panneau.');
        if (interaction.isFromMessage()) await interaction.update(payload);
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [
    on('messageCreate', (message) => {
      if (!message.inGuild() || !ticketChannels.has(message.channelId) || message.author.bot) return;
      const ticket = ticketByChannel(message.channelId);
      if (!ticket) return;
      storeTicketMessage(ticket.id, message.id, message.author.id, message.author.tag, message.content, [...message.attachments.values()].map((a) => a.url));
    }, 300),
    on('channelDelete', (channel) => {
      if (ticketChannels.has(channel.id)) markDeleted(channel.id);
    }),
  ],
  async onReady() {
    loadTicketChannels();
  },
  tests: [
    {
      id: 'panel',
      label: 'Aperçu du panneau',
      emoji: '🎫',
      description: 'Poster le panneau ici, en privé',
      async run(interaction) {
        const panel = buildPanel(interaction.guild);
        const v2 = panel.flags !== undefined;
        await interaction.followUp({
          embeds: panel.embeds,
          components: panel.components,
          flags: v2 ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : MessageFlags.Ephemeral,
        } as Parameters<typeof interaction.followUp>[0]);
        return '✅ Aperçu envoyé juste en dessous (les boutons fonctionnent vraiment).';
      },
    },
  ],
};
