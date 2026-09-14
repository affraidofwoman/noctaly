import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from 'discord.js';
import { all, get, run } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig, updateConfig } from '../../core/guildConfig';
import { journal, recordLog, resolveTextChannel } from '../../core/logService';
import { hasLevel } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { neutralizeMentions, progressBar, truncate } from '../../core/text';
import { button, buildModal, row } from '../../core/ui';
import { PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';

interface SuggestionRow {
  id: number;
  guild_id: string;
  number: number;
  channel_id: string;
  message_id: string | null;
  author_id: string;
  content: string;
  status: 'pending' | 'accepted' | 'denied';
  staff_id: string | null;
  staff_reason: string | null;
  created_at: number;
}

const STATUS = {
  pending: { label: 'En attente', emoji: '⏳', kind: 'primary' as const },
  accepted: { label: 'Acceptée', emoji: '✅', kind: 'success' as const },
  denied: { label: 'Refusée', emoji: '❌', kind: 'error' as const },
};

function votes(id: number): { up: number; down: number } {
  const r = get<{ up: number; down: number }>('SELECT SUM(vote = 1) AS up, SUM(vote = -1) AS down FROM suggestion_votes WHERE suggestion_id = ?', id);
  return { up: r?.up ?? 0, down: r?.down ?? 0 };
}

function render(guild: Guild, s: SuggestionRow) {
  const { up, down } = votes(s.id);
  const total = up + down;
  const status = STATUS[s.status];
  const author = guild.members.cache.get(s.author_id);
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, status.kind))
    .setAuthor({ name: author?.user.tag ?? 'Membre', iconURL: author?.user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiFor(guild.id, 'suggestion')} SUGGESTION #${s.number}`)
    .setDescription(`<@${s.author_id}> propose :\n\n>>> ${truncate(s.content, 3500)}`)
    .addFields(
      { name: 'Votes', value: `👍 **${up}** · 👎 **${down}**\n${progressBar(total ? up / total : 0.5, 14)}`, inline: true },
      { name: 'Statut', value: `${status.emoji} ${status.label}`, inline: true },
    )
    .setFooter({ text: `Suggestion #${s.number}` })
    .setTimestamp(s.created_at);
  if (s.staff_id) embed.addFields({ name: `Réponse du staff`, value: `${s.staff_reason ? truncate(s.staff_reason, 900) : '*Sans commentaire.*'}\n-# par <@${s.staff_id}>`, inline: false });
  const closed = s.status !== 'pending';
  return {
    embeds: [embed],
    components: [
      row(
        button(`sg:up:${s.id}`, String(up), ButtonStyle.Success, '👍').setDisabled(closed),
        button(`sg:down:${s.id}`, String(down), ButtonStyle.Danger, '👎').setDisabled(closed),
        button(`sg:accept:${s.id}`, 'Accepter', ButtonStyle.Secondary, '✅').setDisabled(closed),
        button(`sg:deny:${s.id}`, 'Refuser', ButtonStyle.Secondary, '❌').setDisabled(closed),
      ),
    ],
  };
}

function requireSuggestion(guildId: string, id: string | undefined): SuggestionRow {
  const s = get<SuggestionRow>('SELECT * FROM suggestions WHERE id = ? AND guild_id = ?', Number(id), guildId);
  if (!s) throw new UserError('Suggestion introuvable.');
  return s;
}

async function create(member: GuildMember, content: string): Promise<string> {
  const guild = member.guild;
  const cfg = getConfig(guild.id).suggestions;
  const channel = resolveTextChannel(guild, cfg.channelId);
  if (!channel) throw new UserError('Le salon des suggestions n’est pas configuré (`/setup` → Communauté).');
  const text = neutralizeMentions(content.trim());
  if (text.length < 10) throw new UserError('Ta suggestion est trop courte (10 caractères minimum).');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM suggestions WHERE guild_id = ? AND author_id = ? AND created_at > ?', guild.id, member.id, Date.now() - 3_600_000)?.n ?? 0;
  if (recent >= 5 && !hasLevel(member, PermLevel.STAFF)) throw new UserError('Tu as déjà proposé 5 suggestions cette heure-ci. Reviens un peu plus tard !');
  const number = updateConfig(guild.id, (c) => void (c.suggestions.counter += 1)).suggestions.counter;
  const r = run('INSERT INTO suggestions (guild_id, number, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', guild.id, number, channel.id, member.id, text, Date.now());
  const s = requireSuggestion(guild.id, String(r.lastInsertRowid));
  const message = await channel.send(render(guild, s));
  run('UPDATE suggestions SET message_id = ? WHERE id = ?', message.id, s.id);
  if (cfg.createThread && 'threads' in channel) {
    await message.startThread({ name: `Suggestion #${number}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }).catch(() => undefined);
  }
  recordLog(guild.id, 'community', 'suggestion', member.id, member.id, { number });
  void journal(guild, 'community', { title: 'Nouvelle suggestion', tone: 'info', lines: [`**#${number}** par <@${member.id}> · [voir](${message.url})`, truncate(text, 500)] });
  return message.url;
}

async function refresh(guild: Guild, s: SuggestionRow): Promise<void> {
  const channel = resolveTextChannel(guild, s.channel_id);
  const message = s.message_id ? await channel?.messages.fetch(s.message_id).catch(() => null) : null;
  await message?.edit(render(guild, s)).catch(() => undefined);
}

const suggest: SlashCommand = {
  category: 'community',
  cooldownSeconds: 30,
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Proposer une idée')
    .addStringOption((o) => o.setName('idee').setDescription('Ta suggestion (vide = formulaire)').setMaxLength(2000)),
  async execute(interaction) {
    const idea = interaction.options.getString('idee');
    if (!idea) {
      await interaction.showModal(buildModal('sg:new', 'Nouvelle suggestion', [{ id: 'content', label: 'Ton idée', long: true, minLength: 10, maxLength: 2000, placeholder: 'Créer une soirée communautaire…' }]));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const url = await create(interaction.member, idea);
    await interaction.editReply({ embeds: [ok(interaction.guild, `Merci ! Ta suggestion est publiée : ${url}`)] });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'suggest',
    aliases: ['suggestion', 'idee'],
    domain: 'general',
    category: 'community',
    description: 'Proposer une idée',
    usage: '<idée>',
    async execute(message, args) {
      if (!message.member) return;
      const url = await create(message.member, args.join(' '));
      await message.reply({ embeds: [ok(message.guild, `Merci ! Ta suggestion est publiée : ${url}`)], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'suggestions',
  section: 'community',
  title: 'Suggestions',
  emoji: '💡',
  moduleId: 'suggestions',
  order: 2,
  description: 'Les membres proposent avec `/suggest`, votent 👍/👎, et le staff accepte ou refuse avec un commentaire.',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des suggestions', get: (c) => c.suggestions.channelId, set: (c, v) => void (c.suggestions.channelId = v) },
    { kind: 'toggle', key: 'thread', label: 'Fil de discussion', get: (c) => c.suggestions.createThread, set: (c, v) => void (c.suggestions.createThread = v) },
  ],
};

export const suggestionsModule: BotModule = {
  id: 'suggestions',
  name: 'Suggestions',
  emoji: '💡',
  description: 'Suggestions avec votes et réponse du staff',
  toggleable: true,
  defaultEnabled: true,
  commands: [suggest],
  prefixCommands,
  setupPages: [setupPage],
  components: [
    {
      prefix: 'sg',
      async button(interaction: ButtonInteraction<'cached'>, [action, id]) {
        const s = requireSuggestion(interaction.guildId, id);
        if (action === 'up' || action === 'down') {
          if (s.status !== 'pending') throw new UserError('Cette suggestion est close.');
          const value = action === 'up' ? 1 : -1;
          const existing = get<{ vote: number }>('SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', s.id, interaction.user.id);
          if (existing?.vote === value) run('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', s.id, interaction.user.id);
          else run('INSERT OR REPLACE INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?, ?, ?)', s.id, interaction.user.id, value);
          await interaction.update(render(interaction.guild, s));
          return;
        }
        if (!hasLevel(interaction.member, PermLevel.STAFF)) throw new UserError('Réservé au staff.');
        await interaction.showModal(
          buildModal(`sg:decide:${s.id}:${action}`, action === 'accept' ? `Accepter la suggestion #${s.number}` : `Refuser la suggestion #${s.number}`, [
            { id: 'reason', label: 'Commentaire (facultatif)', long: true, required: false, maxLength: 900 },
          ]),
        );
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action, id, decision]) {
        if (action === 'new') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const url = await create(interaction.member, interaction.fields.getTextInputValue('content'));
          await interaction.editReply({ embeds: [ok(interaction.guild, `Merci ! Ta suggestion est publiée : ${url}`)] });
          return;
        }
        if (action !== 'decide') return;
        if (!hasLevel(interaction.member, PermLevel.STAFF)) throw new UserError('Réservé au staff.');
        const s = requireSuggestion(interaction.guildId, id);
        const status = decision === 'accept' ? 'accepted' : 'denied';
        const reason = interaction.fields.getTextInputValue('reason').trim() || null;
        run('UPDATE suggestions SET status = ?, staff_id = ?, staff_reason = ? WHERE id = ?', status, interaction.user.id, reason, s.id);
        const updated = requireSuggestion(interaction.guildId, id);
        await refresh(interaction.guild, updated);
        const author = await interaction.client.users.fetch(s.author_id).catch(() => null);
        await author
          ?.send({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild, STATUS[status].kind)).setDescription(`${STATUS[status].emoji} Ta suggestion **#${s.number}** sur **${interaction.guild.name}** a été **${STATUS[status].label.toLowerCase()}**.${reason ? `\n\n> ${truncate(reason, 900)}` : ''}`)] })
          .catch(() => undefined);
        recordLog(interaction.guildId, 'community', `suggestion-${status}`, s.author_id, interaction.user.id, { number: s.number, reason });
        void journal(interaction.guild, 'community', { title: `Suggestion ${STATUS[status].label.toLowerCase()}`, tone: status === 'accepted' ? 'ok' : 'alerte', lines: [`**#${s.number}** de <@${s.author_id}>`, reason ? `**Commentaire** : ${reason}` : null], by: interaction.user });
        await interaction.reply({ embeds: [ok(interaction.guild, `Suggestion #${s.number} ${STATUS[status].label.toLowerCase()}.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  tests: [
    {
      id: 'count',
      label: 'Résumé des suggestions',
      emoji: '💡',
      description: 'Combien sont en attente, acceptées, refusées',
      async run(interaction) {
        const rows = all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM suggestions WHERE guild_id = ? GROUP BY status', interaction.guildId);
        const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
        return `⏳ ${n('pending')} en attente · ✅ ${n('accepted')} acceptées · ❌ ${n('denied')} refusées`;
      },
    },
  ],
};
