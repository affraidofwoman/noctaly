import {
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from 'discord.js';
import { parseJson } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { brandEmbed, erreur, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { resolveTextChannel } from '../../core/logService';
import { linesToPages, paginate } from '../../core/pagination';
import { hasAccess } from '../../core/permissions';
import { resolveRole } from '../../core/resolve';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { parseDuration, ts } from '../../core/time';
import { button, buildModal, row } from '../../core/ui';
import { PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import {
  buildGiveawayMessage,
  describeRequirements,
  dueGiveaways,
  endGiveaway,
  getGiveaway,
  guildGiveaways,
  joinGiveaway,
  leaveGiveaway,
  participantCount,
  pauseGiveaway,
  refreshMessage,
  requirementsOf,
  rerollGiveaway,
  resumeGiveaway,
  startGiveaway,
  type GiveawayRequirements,
  type GiveawayRow,
} from '../../services/giveaways';

const MAX_DURATION = 60 * 86_400_000;
const dirty = new Set<number>();

function requireGiveaway(guildId: string, id: number | string | null | undefined): GiveawayRow {
  const g = getGiveaway(Number(id));
  if (!g || g.guild_id !== guildId) throw new UserError('Giveaway introuvable.');
  return g;
}

function label(g: GiveawayRow): string {
  const state = g.status === 'running' ? '🟢' : g.status === 'paused' ? '⏸️' : '⚫';
  return truncate(`${state} #${g.id} · ${g.prize}`, 100);
}

// ─── Menu façon Airline ────────────────────────────────────────────────────

function menu(guild: Guild, note?: string) {
  const all = guildGiveaways(guild.id);
  const running = all.filter((g) => g.status === 'running').length;
  const ended = all.filter((g) => g.status === 'ended').length;
  const embed = brandEmbed(guild)
    .setTitle(`${emojiFor(guild.id, 'cadeau')} Giveaways`)
    .setDescription(
      [
        note,
        '**Lancer** — tu écris le lot, le nombre de gagnants et la durée.',
        '**Arrêter** — tire les gagnants tout de suite, sans attendre la fin.',
        '**Retirer au sort** — refait le tirage d’un giveaway déjà fini.',
        '',
        `${running} en cours · ${ended} terminé${ended > 1 ? 's' : ''} sur ce serveur.`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      row(
        button('gwm:create', 'Lancer', ButtonStyle.Success, emojiFor(guild.id, 'cadeau')),
        button('gwm:end', 'Arrêter', ButtonStyle.Danger, '⏹️'),
        button('gwm:reroll', 'Retirer au sort', ButtonStyle.Secondary, '🔁'),
        button('gwm:list', 'Liste', ButtonStyle.Secondary, '📋'),
      ),
    ],
  };
}

function pickMenu(guild: Guild, action: 'end' | 'reroll') {
  const list = guildGiveaways(guild.id).filter((g) => (action === 'end' ? g.status !== 'ended' : g.status === 'ended' && participantCount(g.id) > 0));
  if (!list.length) return null;
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(`gwm:pick:${action}`)
      .setPlaceholder(action === 'end' ? 'Lequel arrêter maintenant ?' : 'Lequel retirer au sort ?')
      .addOptions(list.slice(0, 25).map((g) => ({ label: label(g), value: String(g.id), description: `${participantCount(g.id)} participant(s) · ${g.winners_count} gagnant(s)` }))),
  );
}

function listPages(guild: Guild) {
  const lines = guildGiveaways(guild.id).map((g) => {
    const winners = parseJson<string[]>(g.winners, []);
    const state = g.status === 'running' ? `fin ${ts(g.ends_at, 'R')}` : g.status === 'paused' ? 'en pause' : winners.length ? `gagné par ${winners.map((w) => `<@${w}>`).join(', ')}` : 'sans gagnant';
    return `${label(g)}\n-# ${participantCount(g.id)} participant(s) · ${state}${g.message_id ? ` · [message](https://discord.com/channels/${g.guild_id}/${g.channel_id}/${g.message_id})` : ''}`;
  });
  if (!lines.length) lines.push('*Aucun giveaway.*');
  return linesToPages(lines, 8, (content, page, total) => brandEmbed(guild).setTitle('🎉 Giveaways').setDescription(content).setFooter({ text: `Page ${page}/${total}` }));
}

// ─── Commande ──────────────────────────────────────────────────────────────

const idOption = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('id').setDescription('Le giveaway').setRequired(true).setAutocomplete(true);

const giveaway: SlashCommand = {
  category: 'giveaways',
  level: PermLevel.STAFF,
  whitelist: 'giveaway',
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Les giveaways')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un giveaway')
        .addStringOption((o) => o.setName('recompense').setDescription('Ce qu’on gagne').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duree').setDescription('Ex : 30m, 1h, 2j, 1h30m').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Combien de gagnants (1 par défaut)').setMinValue(1).setMaxValue(50))
        .addChannelOption((o) => o.setName('salon').setDescription('Où (salon giveaways par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle obligatoire'))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau XP minimum').setMinValue(1).setMaxValue(500))
        .addIntegerOption((o) => o.setName('compte').setDescription('Âge minimum du compte Discord (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('anciennete').setDescription('Présence minimum sur le serveur (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('participants').setDescription('Participants minimum pour tirer au sort').setMinValue(2).setMaxValue(100000))
        .addStringOption((o) => o.setName('condition').setDescription('Condition personnalisée affichée (ex : suivre la chaîne)').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('end').setDescription('Arrêter et tirer au sort').addIntegerOption(idOption))
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Refaire le tirage')
        .addIntegerOption(idOption)
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de nouveaux gagnants').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Mettre en pause').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('resume').setDescription('Reprendre').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('list').setDescription('Les giveaways du serveur'))
    .addSubcommand((s) => s.setName('menu').setDescription('Le menu Lancer / Arrêter / Retirer au sort')),
  async autocomplete(interaction) {
    const focused = String(interaction.options.getFocused()).toLowerCase();
    const sub = interaction.options.getSubcommand();
    const list = guildGiveaways(interaction.guildId).filter((g) =>
      sub === 'reroll' ? g.status === 'ended' : sub === 'resume' ? g.status === 'paused' : sub === 'pause' ? g.status === 'running' : g.status !== 'ended',
    );
    await interaction.respond(list.filter((g) => label(g).toLowerCase().includes(focused)).slice(0, 25).map((g) => ({ name: label(g), value: g.id })));
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const client = interaction.client;
    switch (sub) {
      case 'start': {
        const duration = parseDuration(interaction.options.getString('duree', true));
        if (!duration || duration < 10_000 || duration > MAX_DURATION) throw new UserError('Durée incomprise : écris par exemple `30m`, `1h`, `2j`, `1h30m` (60 jours max).');
        const channel = (interaction.options.getChannel('salon') ?? resolveTextChannel(guild, getConfig(guild.id).giveaways.defaultChannelId) ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!channel) throw new UserError('Salon introuvable.');
        const requirements: GiveawayRequirements = {
          roleId: interaction.options.getRole('role')?.id ?? null,
          minLevel: interaction.options.getInteger('niveau'),
          minAccountDays: interaction.options.getInteger('compte'),
          minMemberDays: interaction.options.getInteger('anciennete'),
          minParticipants: interaction.options.getInteger('participants'),
          note: interaction.options.getString('condition'),
        };
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const g = await startGiveaway({
          channel,
          host: interaction.member,
          prize: interaction.options.getString('recompense', true),
          winners: interaction.options.getInteger('gagnants') ?? 1,
          durationMs: duration,
          requirements,
        });
        return interaction.editReply({ embeds: [ok(guild, `Giveaway **#${g.id}** lancé dans <#${channel.id}>, tirage ${ts(g.ends_at, 'R')}.`)] });
      }
      case 'list':
        return paginate(interaction, listPages(guild), true);
      case 'menu':
        return reply(interaction, { ...menu(guild), ephemeral: true });
    }
    const g = requireGiveaway(guild.id, interaction.options.getInteger('id', true));
    switch (sub) {
      case 'end': {
        if (g.status === 'ended') throw new UserError('Ce giveaway est déjà terminé.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const winners = await endGiveaway(client, g.id, interaction.user.id);
        return interaction.editReply({ embeds: [ok(guild, winners.length ? `Tirage fait : ${winners.map((w) => `<@${w}>`).join(', ')}.` : 'Tirage fait, sans gagnant.')] });
      }
      case 'reroll': {
        if (g.status !== 'ended') throw new UserError('Le giveaway doit être terminé pour refaire le tirage.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const winners = await rerollGiveaway(client, g, interaction.user.id, interaction.options.getInteger('gagnants') ?? undefined);
        return interaction.editReply({ embeds: [winners.length ? ok(guild, 'C’est retiré au sort.') : erreur(guild, 'Personne n’a participé à ce giveaway.')] });
      }
      case 'pause':
        if (g.status !== 'running') throw new UserError('Ce giveaway n’est pas en cours.');
        pauseGiveaway(g);
        await refreshMessage(client, getGiveaway(g.id)!);
        return reply(interaction, { embeds: [ok(guild, `⏸️ Giveaway **#${g.id}** en pause.`)], ephemeral: true });
      case 'resume':
        if (g.status !== 'paused') throw new UserError('Ce giveaway n’est pas en pause.');
        resumeGiveaway(g);
        await refreshMessage(client, getGiveaway(g.id)!);
        return reply(interaction, { embeds: [ok(guild, `▶️ Giveaway **#${g.id}** repris, tirage ${ts(getGiveaway(g.id)!.ends_at, 'R')}.`)], ephemeral: true });
    }
  },
};

// ─── Composants ────────────────────────────────────────────────────────────

async function onJoin(interaction: ButtonInteraction<'cached'>, id: string | undefined) {
  const g = requireGiveaway(interaction.guildId, id);
  const result = joinGiveaway(interaction.member, g);
  const gift = emojiFor(interaction.guildId, 'cadeau');
  if ('alreadyIn' in result) {
    await interaction.reply({
      embeds: [info(interaction.guild, `Tu participes déjà pour **${truncate(g.prize, 200)}**.`, { emoji: gift })],
      components: [row(button(`gw:leave:${g.id}`, 'Me retirer', ButtonStyle.Secondary, '🚪'))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!result.joined) {
    await interaction.reply({ embeds: [erreur(interaction.guild, result.reason)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  dirty.add(g.id);
  await interaction.reply({ embeds: [ok(interaction.guild, `C’est noté, tu participes pour **${truncate(g.prize, 200)}**.`)], flags: MessageFlags.Ephemeral });
}

async function onCreateModal(interaction: ModalSubmitInteraction<'cached'>) {
  const guild = interaction.guild;
  const prize = interaction.fields.getTextInputValue('prize').trim();
  const winners = Number(interaction.fields.getTextInputValue('winners').trim());
  const duration = parseDuration(interaction.fields.getTextInputValue('duration'));
  const roleRaw = interaction.fields.getTextInputValue('role').trim();
  const levelRaw = interaction.fields.getTextInputValue('level').trim();
  if (!Number.isInteger(winners) || winners < 1 || winners > 50) throw new UserError('Le nombre de gagnants doit être un entier entre 1 et 50.');
  if (!duration || duration < 10_000 || duration > MAX_DURATION) throw new UserError('Durée incomprise. Écris un nombre suivi de l’unité : `30m`, `1h`, `2j`, `1h30m`.');
  let roleId: string | null = null;
  if (roleRaw) {
    const role = resolveRole(guild, roleRaw.replace(/^@/, ''));
    if (!role) throw new UserError(`Rôle « ${roleRaw} » introuvable. Laisse vide pour ouvrir à tout le monde.`);
    roleId = role.id;
  }
  const minLevel = levelRaw ? Number(levelRaw) : null;
  if (minLevel !== null && (!Number.isInteger(minLevel) || minLevel < 1)) throw new UserError('Le niveau minimum doit être un entier positif.');
  const channel = resolveTextChannel(guild, getConfig(guild.id).giveaways.defaultChannelId) ?? (interaction.channel as GuildTextBasedChannel | null);
  if (!channel) throw new UserError('Salon introuvable.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = await startGiveaway({ channel, host: interaction.member, prize, winners, durationMs: duration, requirements: { roleId, minLevel } });
  await interaction.editReply({ embeds: [ok(guild, `Giveaway **#${g.id}** lancé dans <#${channel.id}>, tirage ${ts(g.ends_at, 'R')}.`)] });
}

const components = [
  {
    prefix: 'gw',
    async button(interaction: ButtonInteraction<'cached'>, [action, id]: string[]) {
      if (action === 'join') return onJoin(interaction, id);
      const g = requireGiveaway(interaction.guildId, id);
      if (action === 'leave') {
        const left = leaveGiveaway(interaction.user.id, g);
        if (left) dirty.add(g.id);
        return interaction.update({ embeds: [left ? ok(interaction.guild, 'Tu ne participes plus.') : info(interaction.guild, 'Tu ne participais pas.')], components: [] });
      }
      if (action === 'info') {
        const req = describeRequirements(requirementsOf(g));
        return interaction.reply({
          embeds: [
            brandEmbed(interaction.guild)
              .setTitle(`${emojiFor(interaction.guildId, 'cadeau')} ${truncate(g.prize, 240)}`)
              .setDescription(
                [
                  `• Gagnants — **${g.winners_count}**`,
                  `• Participants — **${participantCount(g.id)}**`,
                  g.status === 'running' ? `• Tirage — ${ts(g.ends_at, 'R')}` : `• État — **${g.status === 'paused' ? 'en pause' : 'terminé'}**`,
                  req.length ? `\n**Conditions**\n${req.join('\n')}` : '\n*Ouvert à tout le monde.*',
                  `\n-# Giveaway #${g.id} · lancé par <@${g.host_id}>`,
                ].join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    },
  },
  {
    prefix: 'gwm',
    level: PermLevel.STAFF,
    whitelist: 'giveaway',
    async button(interaction: ButtonInteraction<'cached'>, [action]: string[]) {
      const guild = interaction.guild;
      if (action === 'create') {
        return interaction.showModal(
          buildModal('gwm:createm', 'Nouveau giveaway', [
            { id: 'prize', label: 'Ce qu’on gagne', placeholder: '1 mois de Nitro', maxLength: 200 },
            { id: 'winners', label: 'Combien de gagnants', value: '1', maxLength: 2 },
            { id: 'duration', label: 'Ça dure combien de temps', placeholder: '1h — ou 30m, 2j, 1h30m', maxLength: 20 },
            { id: 'role', label: 'Rôle requis (vide = tout le monde)', placeholder: 'Présent — ou @Présent, ou son ID', required: false, maxLength: 100 },
            { id: 'level', label: 'Niveau XP minimum (vide = aucun)', required: false, maxLength: 3 },
          ]),
        );
      }
      if (action === 'end' || action === 'reroll') {
        const pick = pickMenu(guild, action);
        if (!pick) return interaction.update(menu(guild, action === 'end' ? '⚠️ Aucun giveaway en cours sur ce serveur.\n' : '⚠️ Aucun giveaway terminé avec des participants.\n'));
        return interaction.update({ ...menu(guild), components: [pick, row(button('gwm:home', 'Retour', ButtonStyle.Secondary, '⬅️'))] });
      }
      if (action === 'list') return paginate(interaction, listPages(guild), true);
      if (action === 'home') return interaction.update(menu(guild));
    },
    async select(interaction: AnySelectMenuInteraction<'cached'>, [action, which]: string[]) {
      if (action !== 'pick' || !interaction.isStringSelectMenu()) return;
      const g = requireGiveaway(interaction.guildId, interaction.values[0]);
      await interaction.update({ embeds: [info(interaction.guild, 'Tirage en cours…')], components: [] });
      const winners = which === 'end' ? (g.status === 'ended' ? [] : await endGiveaway(interaction.client, g.id, interaction.user.id)) : await rerollGiveaway(interaction.client, g, interaction.user.id);
      await interaction.editReply(menu(interaction.guild, winners.length ? `✅ Gagnant(s) : ${winners.map((w) => `<@${w}>`).join(', ')}\n` : '⚠️ Aucun gagnant.\n'));
    },
    async modal(interaction: ModalSubmitInteraction<'cached'>, [action]: string[]) {
      if (action === 'createm') return onCreateModal(interaction);
    },
  },
];

const prefixCommands: PrefixCommand[] = [
  {
    name: 'giveaway',
    aliases: ['gw'],
    domain: 'general',
    category: 'giveaways',
    description: 'Lancer, arrêter, retirer au sort',
    level: PermLevel.STAFF,
    whitelist: 'giveaway',
    async execute(message) {
      await message.reply({ ...menu(message.guild), allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'giveaways',
  section: 'giveaways',
  title: 'Giveaways',
  emoji: '🎉',
  moduleId: 'giveaways',
  description: 'Où partent les giveaways et qui est prévenu.\n-# Pour les lancer : `/giveaway start` ou le menu `=giveaway` (staff ou whitelist Giveaway).',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon par défaut', get: (c) => c.giveaways.defaultChannelId, set: (c, v) => void (c.giveaways.defaultChannelId = v) },
    { kind: 'role', key: 'ping', label: 'Rôle mentionné au lancement', get: (c) => c.giveaways.pingRoleId, set: (c, v) => void (c.giveaways.pingRoleId = v) },
    { kind: 'toggle', key: 'dm', label: 'MP aux gagnants', get: (c) => c.giveaways.dmWinners, set: (c, v) => void (c.giveaways.dmWinners = v) },
    { kind: 'toggle', key: 'logjoin', label: 'Journaliser les participations', get: (c) => c.giveaways.logParticipations, set: (c, v) => void (c.giveaways.logParticipations = v) },
  ],
};

export const giveawaysModule: BotModule = {
  id: 'giveaways',
  name: 'Giveaways',
  emoji: '🎉',
  description: 'Giveaways avec conditions, pause et tirages persistants',
  toggleable: true,
  defaultEnabled: true,
  commands: [giveaway],
  prefixCommands,
  components,
  setupPages: [setupPage],
  tasks: [
    {
      name: 'giveaways-end',
      intervalMs: 10_000,
      runOnStart: true,
      async run(client) {
        for (const g of dueGiveaways()) await endGiveaway(client, g.id);
      },
    },
    {
      name: 'giveaways-refresh',
      intervalMs: 5_000,
      async run(client) {
        // Les compteurs « Participer (n) » sont regroupés pour ne pas éditer le message à chaque clic.
        const ids = [...dirty].slice(0, 10);
        for (const id of ids) {
          dirty.delete(id);
          const g = getGiveaway(id);
          if (g) await refreshMessage(client, g);
        }
      },
    },
  ],
  tests: [
    {
      id: 'preview',
      label: 'Aperçu d’un giveaway',
      emoji: '🎉',
      description: 'Voir le rendu sans rien lancer',
      async run(interaction) {
        const fake: GiveawayRow = {
          id: 0,
          guild_id: interaction.guildId,
          channel_id: interaction.channelId,
          message_id: null,
          host_id: interaction.user.id,
          prize: '20€ Steam',
          winners_count: 1,
          ends_at: Date.now() + 86_400_000,
          status: 'running',
          paused_remaining: null,
          requirements: JSON.stringify({ roleId: null, minLevel: 5 }),
          winners: '[]',
          created_at: Date.now(),
        };
        const preview = buildGiveawayMessage(interaction.guild, fake);
        await interaction.followUp({ embeds: preview.embeds, flags: MessageFlags.Ephemeral });
        return '✅ Aperçu envoyé juste en dessous.';
      },
    },
  ],
};

export function canManageGiveaways(member: import('discord.js').GuildMember): boolean {
  return hasAccess(member, PermLevel.STAFF, 'giveaway');
}
