import { EmbedBuilder, type GuildMember, type PartialGuildMember } from 'discord.js';
import { emojiFor } from '../../core/brand';
import { colorFor } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { resolveTextChannel } from '../../core/logService';
import { createLogger } from '../../core/logger';
import type { SetupPage } from '../../core/setup';
import { formatNumber, truncate } from '../../core/text';
import { formatDuration } from '../../core/time';
import { renderTemplate } from '../../core/variables';
import { on, type BotModule } from '../../core/types';
import { userActivity } from '../../services/stats';

const log = createLogger('depart');

export async function sendLeave(member: GuildMember | PartialGuildMember): Promise<string | null> {
  const guild = member.guild;
  const cfg = getConfig(guild.id).leave;
  const channel = resolveTextChannel(guild, cfg.channelId);
  if (!channel || !member.user) return null;
  const text = renderTemplate(cfg.message, { user: member.user, guild });
  if (!cfg.useEmbed) {
    await channel.send({ content: truncate(text, 2000), allowedMentions: { parse: [] } });
    return channel.id;
  }
  const activity = userActivity(guild.id, member.id);
  const stayed = member.joinedTimestamp ? Date.now() - member.joinedTimestamp : null;
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, 'error'))
    .setTitle(`${emojiFor(guild.id, 'depart')} Départ`)
    .setDescription(truncate(text, 4096))
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${member.user.tag} · ${guild.memberCount} membres` })
    .setTimestamp();
  const stats = [
    stayed ? `• Resté — **${formatDuration(stayed)}**` : null,
    activity ? `• Messages — **${formatNumber(activity.messages)}**` : null,
    activity?.voice_seconds ? `• Vocal — **${formatDuration(activity.voice_seconds * 1000)}**` : null,
  ].filter(Boolean);
  if (stats.length) embed.addFields({ name: 'Statistiques', value: stats.join('\n') });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return channel.id;
}

const setupPage: SetupPage = {
  id: 'leave',
  section: 'welcome',
  title: 'Départ',
  emoji: '🚪',
  moduleId: 'leave',
  order: 2,
  description: 'Le message posté quand quelqu’un quitte le serveur.\n-# Variables : `{user}` `{username}` `{server}` `{membercount}`',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des départs', get: (c) => c.leave.channelId, set: (c, v) => void (c.leave.channelId = v) },
    { kind: 'toggle', key: 'embed', label: 'Embed + statistiques', get: (c) => c.leave.useEmbed, set: (c, v) => void (c.leave.useEmbed = v) },
    { kind: 'text', key: 'message', label: 'Message', long: true, maxLength: 2000, required: true, get: (c) => c.leave.message, set: (c, v) => void (c.leave.message = v) },
  ],
};

export const leaveModule: BotModule = {
  id: 'leave',
  name: 'Départs',
  emoji: '🚪',
  description: 'Message de départ avec statistiques',
  toggleable: true,
  defaultEnabled: true,
  setupPages: [setupPage],
  events: [
    on('guildMemberRemove', async (member) => {
      if (member.user?.bot) return;
      await sendLeave(member).catch((err: Error) => log.warn(`Départ de ${member.id} non posté : ${err.message}`));
    }),
  ],
  tests: [
    {
      id: 'message',
      label: 'Message de départ',
      emoji: '🚪',
      description: 'Poster un faux départ à ton nom',
      async run(interaction) {
        const id = await sendLeave(interaction.member);
        return id ? `✅ Départ posté dans <#${id}>.` : '⚠️ Aucun salon de départ utilisable.';
      },
    },
  ],
};
