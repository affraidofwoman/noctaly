import { SlashCommandBuilder, type Message } from 'discord.js';
import { get, run } from '../../database/db';
import { info, ok } from '../../core/embeds';
import { reply } from '../../core/interactions';
import { neutralizeMentions, truncate } from '../../core/text';
import { formatDuration, ts } from '../../core/time';
import { on, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';

interface AfkRow {
  reason: string;
  since: number;
}

const notified = new Map<string, number>();

function setAfk(guildId: string, userId: string, reason: string): void {
  run('INSERT OR REPLACE INTO afk (guild_id, user_id, reason, since) VALUES (?, ?, ?, ?)', guildId, userId, truncate(neutralizeMentions(reason || 'AFK'), 200), Date.now());
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;
  const self = get<AfkRow>('SELECT reason, since FROM afk WHERE guild_id = ? AND user_id = ?', message.guildId, message.author.id);
  // Le message qui active l'AFK ne doit pas le retirer aussitôt.
  if (self && Date.now() - self.since > 5_000) {
    run('DELETE FROM afk WHERE guild_id = ? AND user_id = ?', message.guildId, message.author.id);
    const note = await message.reply({ embeds: [ok(message.guild, `👋 Bienvenue de retour <@${message.author.id}> ! Tu étais AFK depuis **${formatDuration(Date.now() - self.since)}**.`)], allowedMentions: { repliedUser: false } }).catch(() => null);
    if (note) setTimeout(() => void note.delete().catch(() => undefined), 10_000).unref();
  }
  const mentioned = [...message.mentions.users.values()].filter((u) => u.id !== message.author.id && !u.bot).slice(0, 5);
  const lines: string[] = [];
  for (const user of mentioned) {
    const row = get<AfkRow>('SELECT reason, since FROM afk WHERE guild_id = ? AND user_id = ?', message.guildId, user.id);
    if (!row) continue;
    const key = `${message.channelId}:${user.id}`;
    if ((notified.get(key) ?? 0) > Date.now()) continue;
    notified.set(key, Date.now() + 60_000);
    lines.push(`💤 <@${user.id}> est actuellement AFK ${ts(row.since, 'R')}.\n**Raison :** ${row.reason}`);
  }
  if (notified.size > 5_000) for (const [k, v] of notified) if (v < Date.now()) notified.delete(k);
  if (lines.length) await message.reply({ embeds: [info(message.guild, lines.join('\n\n'), { emoji: '💤' })], allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
}

const afk: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Te mettre AFK')
    .addStringOption((o) => o.setName('raison').setDescription('Ex : En train de dormir').setMaxLength(200)),
  async execute(interaction) {
    const reason = interaction.options.getString('raison') ?? 'AFK';
    setAfk(interaction.guildId, interaction.user.id, reason);
    await reply(interaction, { embeds: [info(interaction.guild, `💤 <@${interaction.user.id}> est maintenant AFK.\n**Raison :** ${neutralizeMentions(reason)}`)], allowedMentions: { parse: [] } });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'afk',
    domain: 'general',
    category: 'community',
    description: 'Te mettre AFK',
    usage: '[raison]',
    async execute(message, args) {
      const reason = args.join(' ') || 'AFK';
      setAfk(message.guildId, message.author.id, reason);
      await message.reply({ embeds: [info(message.guild, `💤 Tu es maintenant AFK.\n**Raison :** ${neutralizeMentions(reason)}`)], allowedMentions: { parse: [], repliedUser: false } });
    },
  },
];

export const afkModule: BotModule = {
  id: 'afk',
  name: 'AFK',
  emoji: '💤',
  description: 'Statut AFK avec rappel quand on te mentionne',
  toggleable: true,
  defaultEnabled: true,
  commands: [afk],
  prefixCommands,
  events: [on('messageCreate', (m) => onMessage(m), 120)],
};
