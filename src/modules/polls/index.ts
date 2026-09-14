import { ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, type ButtonInteraction, type Client, type Guild } from 'discord.js';
import { all, get, parseJson, run } from '../../database/db';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { recordLog } from '../../core/logService';
import { hasLevel } from '../../core/permissions';
import { neutralizeMentions, progressBar, truncate } from '../../core/text';
import { parseDuration, ts } from '../../core/time';
import { button, row } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';

interface PollRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  author_id: string;
  question: string;
  choices: string;
  multiple: number;
  ends_at: number | null;
  status: 'open' | 'closed';
  created_at: number;
}

const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function tally(poll: PollRow): { counts: number[]; voters: number } {
  const choices = parseJson<string[]>(poll.choices, []);
  const counts = choices.map(() => 0);
  for (const r of all<{ choice: number; n: number }>('SELECT choice, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY choice', poll.id)) {
    if (counts[r.choice] !== undefined) counts[r.choice] = r.n;
  }
  const voters = get<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE poll_id = ?', poll.id)?.n ?? 0;
  return { counts, voters };
}

function render(guild: Guild, poll: PollRow) {
  const choices = parseJson<string[]>(poll.choices, []);
  const { counts, voters } = tally(poll);
  const total = counts.reduce((a, b) => a + b, 0);
  const closed = poll.status === 'closed';
  const max = Math.max(...counts);
  const lines = choices.map((c, i) => {
    const pct = total ? Math.round((counts[i]! / total) * 100) : 0;
    const win = closed && max > 0 && counts[i] === max ? ' 🏆' : '';
    return `${NUMBERS[i]} **${truncate(c, 80)}**${win}\n${progressBar(total ? counts[i]! / total : 0, 14)} ${pct}% · ${counts[i]} vote${counts[i]! > 1 ? 's' : ''}`;
  });
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, closed ? 'info' : 'primary'))
    .setAuthor({ name: closed ? '📊 SONDAGE TERMINÉ' : '📊 SONDAGE' })
    .setTitle(truncate(poll.question, 256))
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `${voters} participant${voters > 1 ? 's' : ''} · ${poll.multiple ? 'plusieurs choix possibles' : 'un seul choix'} · #${poll.id}` });
  if (poll.ends_at && !closed) embed.addFields({ name: 'Fin', value: `${ts(poll.ends_at, 'R')}`, inline: true });
  const buttons = choices.map((_, i) => button(`poll:vote:${poll.id}:${i}`, String(counts[i]), ButtonStyle.Secondary, NUMBERS[i]).setDisabled(closed));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  if (!closed) rows.push(row(button(`poll:end:${poll.id}`, 'Terminer', ButtonStyle.Danger, '⏹️')));
  return { embeds: [embed], components: rows };
}

function requirePoll(guildId: string, id: string | undefined): PollRow {
  const poll = get<PollRow>('SELECT * FROM polls WHERE id = ? AND guild_id = ?', Number(id), guildId);
  if (!poll) throw new UserError('Sondage introuvable.');
  return poll;
}

async function closePoll(client: Client, poll: PollRow): Promise<void> {
  run("UPDATE polls SET status = 'closed' WHERE id = ?", poll.id);
  const guild = client.guilds.cache.get(poll.guild_id);
  const channel = guild?.channels.cache.get(poll.channel_id);
  if (!guild || !channel?.isTextBased() || !poll.message_id) return;
  const message = await channel.messages.fetch(poll.message_id).catch(() => null);
  await message?.edit(render(guild, { ...poll, status: 'closed' })).catch(() => undefined);
}

const poll: SlashCommand = {
  category: 'community',
  level: PermLevel.MEMBER,
  cooldownSeconds: 20,
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Créer un sondage')
    .addStringOption((o) => o.setName('question').setDescription('La question').setRequired(true).setMaxLength(250))
    .addStringOption((o) => o.setName('choix').setDescription('Les choix séparés par | (2 à 10). Vide = Oui | Non').setMaxLength(1000))
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 1h, 2j (vide = sans fin)'))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Autoriser plusieurs choix')),
  async execute(interaction) {
    const raw = interaction.options.getString('choix');
    const choices = (raw ? raw.split('|') : ['Oui', 'Non']).map((c) => neutralizeMentions(c.trim())).filter(Boolean).slice(0, 10);
    if (choices.length < 2) throw new UserError('Il faut au moins 2 choix, séparés par `|`.');
    const durationRaw = interaction.options.getString('duree');
    const duration = durationRaw ? parseDuration(durationRaw) : null;
    if (durationRaw && (!duration || duration > 30 * 86_400_000)) throw new UserError('Durée invalide (ex : `1h`, `2j`, 30 jours max).');
    const r = run(
      'INSERT INTO polls (guild_id, channel_id, author_id, question, choices, multiple, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      neutralizeMentions(interaction.options.getString('question', true)),
      JSON.stringify(choices),
      interaction.options.getBoolean('multiple') ? 1 : 0,
      duration ? Date.now() + duration : null,
      Date.now(),
    );
    const created = requirePoll(interaction.guildId, String(r.lastInsertRowid));
    const message = await interaction.reply({ ...render(interaction.guild, created), withResponse: true });
    run('UPDATE polls SET message_id = ? WHERE id = ?', message.resource?.message?.id ?? null, created.id);
    recordLog(interaction.guildId, 'community', 'poll', null, interaction.user.id, { id: created.id });
  },
};

export const pollsModule: BotModule = {
  id: 'polls',
  name: 'Sondages',
  emoji: '📊',
  description: 'Sondages à boutons avec résultats en direct',
  toggleable: true,
  defaultEnabled: true,
  commands: [poll],
  components: [
    {
      prefix: 'poll',
      async button(interaction: ButtonInteraction<'cached'>, [action, id, choice]) {
        const p = requirePoll(interaction.guildId, id);
        if (p.status === 'closed') throw new UserError('Ce sondage est terminé.');
        if (action === 'end') {
          if (p.author_id !== interaction.user.id && !hasLevel(interaction.member, PermLevel.STAFF)) throw new UserError('Seul l’auteur ou le staff peut terminer ce sondage.');
          await interaction.deferUpdate();
          await closePoll(interaction.client, p);
          return;
        }
        const index = Number(choice);
        const count = parseJson<string[]>(p.choices, []).length;
        if (!Number.isInteger(index) || index < 0 || index >= count) return;
        const already = get('SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? AND choice = ?', p.id, interaction.user.id, index);
        if (already) run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND choice = ?', p.id, interaction.user.id, index);
        else {
          if (!p.multiple) run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', p.id, interaction.user.id);
          run('INSERT OR IGNORE INTO poll_votes (poll_id, user_id, choice) VALUES (?, ?, ?)', p.id, interaction.user.id, index);
        }
        await interaction.update(render(interaction.guild, p));
        if (!already) await interaction.followUp({ embeds: [ok(interaction.guild, `Vote enregistré : **${truncate(parseJson<string[]>(p.choices, [])[index] ?? '', 80)}**`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  tasks: [
    {
      name: 'polls-end',
      intervalMs: 30_000,
      runOnStart: true,
      async run(client) {
        for (const p of all<PollRow>("SELECT * FROM polls WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= ? LIMIT 20", Date.now())) {
          await closePoll(client, p);
        }
      },
    },
  ],
};
