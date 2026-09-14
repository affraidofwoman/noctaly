import { EmbedBuilder, SlashCommandBuilder, type Client } from 'discord.js';
import { all, get, run } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { brandEmbed, colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { linesToPages, paginate } from '../../core/pagination';
import { neutralizeMentions, truncate } from '../../core/text';
import { formatDuration, parseDuration, ts } from '../../core/time';
import type { BotModule, PrefixCommand, SlashCommand } from '../../core/types';

interface ReminderRow {
  id: number;
  guild_id: string | null;
  channel_id: string | null;
  user_id: string;
  content: string;
  remind_at: number;
  created_at: number;
}

const MAX_DELAY = 365 * 86_400_000;

function create(guildId: string, channelId: string, userId: string, delay: number, content: string): ReminderRow {
  if (delay < 10_000 || delay > MAX_DELAY) throw new UserError('Durée entre 10 secondes et 1 an (ex : `2h30`, `1j`, `45m`).');
  const max = getConfig(guildId).reminders.maxPerUser;
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND sent = 0', userId)?.n ?? 0;
  if (count >= max) throw new UserError(`Tu as déjà ${count} rappels en attente (maximum ${max}).`);
  const r = run(
    'INSERT INTO reminders (guild_id, channel_id, user_id, content, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guildId,
    channelId,
    userId,
    truncate(neutralizeMentions(content.trim() || 'Rappel'), 1000),
    Date.now() + delay,
    Date.now(),
  );
  return get<ReminderRow>('SELECT * FROM reminders WHERE id = ?', r.lastInsertRowid)!;
}

/** « 2h30 live Twitch » → durée + texte ; la durée peut contenir plusieurs morceaux (« 1j 2h »). */
export function splitReminder(input: string): { delay: number; text: string } | null {
  const words = input.trim().split(/\s+/);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const delay = parseDuration(words.slice(0, n).join(' '));
    if (delay && !/^\d+$/.test(words[0]!)) return { delay, text: words.slice(n).join(' ') };
  }
  return null;
}

async function deliver(client: Client, r: ReminderRow): Promise<void> {
  run('UPDATE reminders SET sent = 1 WHERE id = ?', r.id);
  const guild = r.guild_id ? client.guilds.cache.get(r.guild_id) : null;
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild ?? null))
    .setTitle(`${emojiFor(r.guild_id, 'rappel')} RAPPEL`)
    .setDescription(`Tu avais demandé un rappel :\n\n**${r.content}**`)
    .setFooter({ text: `Programmé ${guild ? `sur ${guild.name} ` : ''}` })
    .setTimestamp(r.created_at);
  const user = await client.users.fetch(r.user_id).catch(() => null);
  const dm = await user?.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (dm) return;
  // MP fermés : on rappelle dans le salon d'origine.
  const channel = guild && r.channel_id ? guild.channels.cache.get(r.channel_id) : null;
  if (channel?.isTextBased()) await channel.send({ content: `<@${r.user_id}>`, embeds: [embed], allowedMentions: { users: [r.user_id] } }).catch(() => undefined);
}

const remind: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Les rappels')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Programmer un rappel')
        .addStringOption((o) => o.setName('duree').setDescription('Dans combien de temps (ex : 2h30, 1j)').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('De quoi te rappeler').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Tes rappels en attente'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un rappel')
        .addIntegerOption((o) => o.setName('rappel').setDescription('Le rappel').setRequired(true).setAutocomplete(true)),
    ),
  async autocomplete(interaction) {
    const rows = all<ReminderRow>('SELECT * FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY remind_at LIMIT 25', interaction.user.id);
    await interaction.respond(rows.map((r) => ({ name: truncate(`#${r.id} · ${r.content}`, 100), value: r.id })));
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (sub === 'set') {
      const delay = parseDuration(interaction.options.getString('duree', true));
      if (!delay) throw new UserError('Durée incomprise : exemples `2h30`, `45m`, `1j 2h`.');
      const r = create(guild.id, interaction.channelId, interaction.user.id, delay, interaction.options.getString('texte', true));
      return reply(interaction, { embeds: [ok(guild, `⏰ Rappel **#${r.id}** programmé ${ts(r.remind_at, 'R')} (${formatDuration(delay)}).\n> ${r.content}`)], ephemeral: true });
    }
    if (sub === 'cancel') {
      const res = run('DELETE FROM reminders WHERE id = ? AND user_id = ? AND sent = 0', interaction.options.getInteger('rappel', true), interaction.user.id);
      return reply(interaction, { embeds: [ok(guild, res.changes ? 'Rappel annulé.' : 'Rappel introuvable.')], ephemeral: true });
    }
    const rows = all<ReminderRow>('SELECT * FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY remind_at', interaction.user.id);
    const lines = rows.map((r) => `**#${r.id}** ${ts(r.remind_at, 'R')} — ${truncate(r.content, 100)}`);
    if (!lines.length) lines.push('*Aucun rappel en attente.*');
    return paginate(interaction, linesToPages(lines, 10, (content, page, total) => brandEmbed(guild).setTitle('⏰ Tes rappels').setDescription(content).setFooter({ text: `Page ${page}/${total}` })), true);
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'remind',
    aliases: ['rappel', 'rm'],
    domain: 'general',
    category: 'community',
    description: 'Programmer un rappel',
    usage: '<durée> <texte>',
    async execute(message, args) {
      const parsed = splitReminder(args.join(' '));
      if (!parsed) throw new UserError('Usage : `=remind 2h30 live Twitch`.');
      const r = create(message.guildId, message.channelId, message.author.id, parsed.delay, parsed.text);
      await message.reply({ embeds: [ok(message.guild, `⏰ Rappel **#${r.id}** ${ts(r.remind_at, 'R')}.`)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const remindersModule: BotModule = {
  id: 'reminders',
  name: 'Rappels',
  emoji: '⏰',
  description: 'Rappels persistants en MP (ou dans le salon)',
  toggleable: true,
  defaultEnabled: true,
  commands: [remind],
  prefixCommands,
  tasks: [
    {
      name: 'reminders',
      intervalMs: 10_000,
      runOnStart: true,
      async run(client) {
        for (const r of all<ReminderRow>('SELECT * FROM reminders WHERE sent = 0 AND remind_at <= ? ORDER BY remind_at LIMIT 50', Date.now())) {
          await deliver(client, r);
        }
        run('DELETE FROM reminders WHERE sent = 1 AND remind_at < ?', Date.now() - 7 * 86_400_000);
      },
    },
  ],
};
