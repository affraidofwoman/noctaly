import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type User,
} from 'discord.js';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { journal, recordLog, resolveTextChannel } from '../../core/logService';
import { isModuleEnabled } from '../../core/moduleManager';
import { hasLevel } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { neutralizeMentions, truncate } from '../../core/text';
import { button, buildModal, row } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { createTicket } from '../../services/tickets';

async function sendReport(member: GuildMember, target: User, reason: string, evidence: string | null): Promise<string> {
  const guild = member.guild;
  if (target.id === member.id) throw new UserError('Tu ne peux pas te signaler toi-même.');
  const cfg = getConfig(guild.id);
  const clean = truncate(neutralizeMentions(reason), 1000);

  if (cfg.reports.mode === 'ticket' && isModuleEnabled(guild.id, 'tickets')) {
    const category = cfg.tickets.categories.find((c) => c.id === 'sanction' || c.id === 'support') ?? cfg.tickets.categories[0];
    if (category) {
      const { channel } = await createTicket(member, category.id, `Signalement de ${target.tag}`);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(colorFor(guild, 'warning'))
            .setTitle('🚨 Signalement')
            .setDescription(`**Signalé :** <@${target.id}> \`${target.id}\`\n**Raison :** ${clean}${evidence ? `\n**Preuve :** ${truncate(evidence, 500)}` : ''}`),
        ],
        allowedMentions: { parse: [] },
      });
      recordLog(guild.id, 'community', 'report', target.id, member.id, { reason: clean, ticket: channel.id });
      return `Ton signalement a ouvert un ticket privé : <#${channel.id}>`;
    }
  }

  const channel = resolveTextChannel(guild, cfg.reports.channelId ?? cfg.general.staffChannelId);
  if (!channel) throw new UserError('Le salon des signalements n’est pas configuré. Ouvre plutôt un ticket.');
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(colorFor(guild, 'warning'))
        .setAuthor({ name: `Signalé par ${member.user.tag}`, iconURL: member.user.displayAvatarURL({ size: 64 }) })
        .setTitle('🚨 Nouveau signalement')
        .setThumbnail(target.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Membre signalé', value: `<@${target.id}>\n\`${target.id}\``, inline: true },
          { name: 'Par', value: `<@${member.id}>`, inline: true },
          { name: 'Raison', value: clean, inline: false },
          ...(evidence ? [{ name: 'Preuve', value: truncate(evidence, 1000), inline: false }] : []),
        )
        .setTimestamp(),
    ],
    components: [row(button(`rep:take:${member.id}`, 'Je m’en occupe', ButtonStyle.Primary, '🙋'), button(`rep:done:${member.id}`, 'Traité', ButtonStyle.Success, '✅'))],
    allowedMentions: { parse: [] },
  });
  recordLog(guild.id, 'community', 'report', target.id, member.id, { reason: clean });
  void journal(guild, 'community', { title: 'Signalement', tone: 'alerte', lines: [`**Signalé** : <@${target.id}>`, `**Par** : <@${member.id}>`, `**Raison** : ${clean}`] });
  return 'Merci, ton signalement a été transmis au staff.';
}

const report: SlashCommand = {
  category: 'community',
  cooldownSeconds: 60,
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Signaler un membre au staff')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Ce qui s’est passé').setRequired(true).setMaxLength(1000))
    .addStringOption((o) => o.setName('preuve').setDescription('Lien vers un message ou une capture').setMaxLength(500)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = await sendReport(interaction.member, interaction.options.getUser('membre', true), interaction.options.getString('raison', true), interaction.options.getString('preuve'));
    await interaction.editReply({ embeds: [ok(interaction.guild, text)] });
  },
};

const feedback: SlashCommand = {
  category: 'community',
  cooldownSeconds: 60,
  data: new SlashCommandBuilder().setName('feedback').setDescription('Donner ton avis au staff'),
  async execute(interaction) {
    await interaction.showModal(
      buildModal('rep:feedback', 'Ton avis compte', [
        { id: 'subject', label: 'Sujet', maxLength: 100, placeholder: 'Le bot, les lives, le serveur…' },
        { id: 'content', label: 'Ton message', long: true, maxLength: 2000 },
        { id: 'rating', label: 'Note sur 5 (facultatif)', required: false, maxLength: 1 },
      ]),
    );
  },
};

const setupPage: SetupPage = {
  id: 'reports',
  section: 'community',
  title: 'Signalements & feedback',
  emoji: '🚨',
  moduleId: 'reports',
  order: 5,
  description: 'Où arrivent `/report` et `/feedback`. Sans salon, c’est le salon staff général qui est utilisé.',
  fields: [
    { kind: 'channel', key: 'reports', label: 'Salon des signalements', get: (c) => c.reports.channelId, set: (c, v) => void (c.reports.channelId = v) },
    { kind: 'channel', key: 'feedback', label: 'Salon des feedbacks', get: (c) => c.feedback.channelId, set: (c, v) => void (c.feedback.channelId = v) },
    {
      kind: 'choice',
      key: 'mode',
      label: 'Signalement',
      options: [
        { value: 'channel', label: 'Envoyé dans le salon staff', emoji: '📨' },
        { value: 'ticket', label: 'Ouvre un ticket privé', emoji: '🎫' },
      ],
      get: (c) => c.reports.mode,
      set: (c, v) => void (c.reports.mode = v as 'channel' | 'ticket'),
    },
  ],
};

export const reportsModule: BotModule = {
  id: 'reports',
  name: 'Signalements & feedback',
  emoji: '🚨',
  description: '/report et /feedback vers le staff',
  toggleable: true,
  defaultEnabled: true,
  commands: [report, feedback],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'rep',
      async button(interaction: ButtonInteraction<'cached'>, [action]) {
        if (!hasLevel(interaction.member, PermLevel.STAFF)) throw new UserError('Réservé au staff.');
        const embed = EmbedBuilder.from(interaction.message.embeds[0]!);
        if (action === 'take') {
          embed.setFooter({ text: `Pris en charge par ${interaction.user.tag}` });
          await interaction.update({ embeds: [embed], components: [row(button('rep:done:x', 'Traité', ButtonStyle.Success, '✅'))] });
        } else {
          embed.setColor(colorFor(interaction.guild, 'success')).setFooter({ text: `Traité par ${interaction.user.tag}` });
          await interaction.update({ embeds: [embed], components: [] });
        }
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action]) {
        if (action !== 'feedback') return;
        const guild = interaction.guild;
        const cfg = getConfig(guild.id);
        const channel = resolveTextChannel(guild, cfg.feedback.channelId ?? cfg.general.staffChannelId);
        if (!channel) throw new UserError('Le salon des feedbacks n’est pas configuré.');
        const rating = Number(interaction.fields.getTextInputValue('rating'));
        const stars = Number.isInteger(rating) && rating >= 1 && rating <= 5 ? `${'⭐'.repeat(rating)}${'☆'.repeat(5 - rating)}` : null;
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(colorFor(guild, 'info'))
              .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
              .setTitle(`💬 Feedback — ${truncate(neutralizeMentions(interaction.fields.getTextInputValue('subject')), 200)}`)
              .setDescription(truncate(neutralizeMentions(interaction.fields.getTextInputValue('content')), 4000))
              .addFields(stars ? [{ name: 'Note', value: stars, inline: true }] : [])
              .setFooter({ text: `ID ${interaction.user.id}` })
              .setTimestamp(),
          ],
          allowedMentions: { parse: [] },
        });
        recordLog(guild.id, 'community', 'feedback', interaction.user.id, interaction.user.id, {});
        await interaction.reply({ embeds: [ok(guild, 'Merci pour ton retour, il a bien été transmis au staff !')], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
