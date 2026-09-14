import { SlashCommandBuilder } from 'discord.js';
import { get } from '../../database/db';
import { brandEmbed } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { isModuleEnabled } from '../../core/moduleManager';
import { formatNumber } from '../../core/text';
import { dayKey, formatDuration } from '../../core/time';
import { on, type BotModule, type SlashCommand } from '../../core/types';
import { bumpDaily, bumpUser } from '../../services/stats';
import { onVoiceTime } from '../../services/voice';

onVoiceTime((credit) => {
  if (!isModuleEnabled(credit.guildId, 'stats') || !getConfig(credit.guildId).stats.trackVoice) return;
  bumpDaily(credit.guildId, 'voice_seconds', credit.seconds);
  bumpUser(credit.guildId, credit.userId, 'voice_seconds', credit.seconds);
});

function sumDaily(guildId: string, column: string, sinceDay: string | null): number {
  const row = sinceDay
    ? get<{ n: number }>(`SELECT COALESCE(SUM(${column}), 0) AS n FROM stats_daily WHERE guild_id = ? AND day >= ?`, guildId, sinceDay)
    : get<{ n: number }>(`SELECT COALESCE(SUM(${column}), 0) AS n FROM stats_daily WHERE guild_id = ?`, guildId);
  return row?.n ?? 0;
}

const count = (sql: string, ...params: string[]) => get<{ n: number }>(sql, ...params)?.n ?? 0;

const stats: SlashCommand = {
  category: 'general',
  cooldownSeconds: 10,
  data: new SlashCommandBuilder().setName('stats').setDescription('Les statistiques du serveur'),
  async execute(interaction) {
    const guild = interaction.guild;
    const tz = getConfig(guild.id).general.timezone;
    const today = dayKey(Date.now(), tz);
    const week = dayKey(Date.now() - 6 * 86_400_000, tz);
    const bots = guild.members.cache.filter((m) => m.user.bot).size;
    const inVoice = guild.voiceStates.cache.filter((v) => !!v.channelId && !v.member?.user.bot).size;
    const embed = brandEmbed(guild)
      .setTitle(`📈 Statistiques — ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: '👥 Membres', value: `${formatNumber(guild.memberCount - bots)}\n-# +${sumDaily(guild.id, 'joins', week)} / -${sumDaily(guild.id, 'leaves', week)} sur 7 j`, inline: true },
        { name: '🤖 Bots', value: formatNumber(bots), inline: true },
        { name: '💬 Messages', value: `${formatNumber(sumDaily(guild.id, 'messages', today))} aujourd’hui\n-# ${formatNumber(sumDaily(guild.id, 'messages', week))} sur 7 j · ${formatNumber(sumDaily(guild.id, 'messages', null))} au total`, inline: true },
        { name: '🎙️ Vocal', value: `${inVoice} en ce moment\n-# ${formatDuration(sumDaily(guild.id, 'voice_seconds', week) * 1000) || '0 s'} sur 7 j`, inline: true },
        { name: '🎫 Tickets', value: `${count("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'", guild.id)} ouverts\n-# ${count('SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ?', guild.id)} au total`, inline: true },
        { name: '🎉 Giveaways', value: `${count("SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ? AND status = 'running'", guild.id)} en cours\n-# ${count('SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ?', guild.id)} au total`, inline: true },
        { name: '⭐ XP', value: `${formatNumber(count('SELECT COALESCE(SUM(xp), 0) AS n FROM xp WHERE guild_id = ?', guild.id))} XP\n-# ${count('SELECT COUNT(*) AS n FROM xp WHERE guild_id = ? AND xp > 0', guild.id)} membres classés`, inline: true },
        { name: '🔴 Twitch', value: `${count('SELECT COUNT(*) AS n FROM twitch_channels WHERE guild_id = ? AND live_stream_id IS NOT NULL', guild.id)} en live\n-# ${count('SELECT COUNT(*) AS n FROM twitch_channels WHERE guild_id = ?', guild.id)} chaîne(s) suivie(s)`, inline: true },
        { name: '⌨️ Commandes', value: `${formatNumber(sumDaily(guild.id, 'commands', today))} aujourd’hui\n-# ${formatNumber(sumDaily(guild.id, 'commands', week))} sur 7 j`, inline: true },
      );
    await reply(interaction, { embeds: [embed] });
  },
};

export const statsModule: BotModule = {
  id: 'stats',
  name: 'Statistiques',
  emoji: '📈',
  description: 'Messages, vocal, arrivées et activité du serveur',
  toggleable: true,
  defaultEnabled: true,
  commands: [stats],
  events: [
    on('messageCreate', (message) => {
      if (!message.inGuild() || message.author.bot) return;
      bumpDaily(message.guildId, 'messages');
      bumpUser(message.guildId, message.author.id, 'messages');
    }, 250),
    on('guildMemberAdd', (member) => {
      if (!member.user.bot) bumpDaily(member.guild.id, 'joins');
    }, 250),
    on('guildMemberRemove', (member) => {
      if (!member.user?.bot) bumpDaily(member.guild.id, 'leaves');
    }, 250),
  ],
};
