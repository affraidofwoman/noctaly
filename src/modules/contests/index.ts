import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from 'discord.js';
import { all, get, run } from '../../database/db';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { isModuleEnabled } from '../../core/moduleManager';
import { canBotManageRole } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { medal, neutralizeMentions, truncate } from '../../core/text';
import { parseDuration, ts } from '../../core/time';
import { button, buildModal, isHttpUrl, row } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { addCoins } from '../../services/economy';
import { addXp } from '../../services/xp';

interface ContestRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  name: string;
  description: string;
  status: 'submissions' | 'voting' | 'ended';
  submit_ends_at: number;
  vote_ends_at: number;
  jury_role_id: string | null;
  reward_coins: number;
  reward_xp: number;
  reward_role_id: string | null;
  created_by: string;
}

interface EntryRow {
  id: number;
  contest_id: number;
  user_id: string;
  content: string;
  message_id: string | null;
  created_at: number;
}

const JURY_WEIGHT = 3;

function score(entryId: number): number {
  return get<{ s: number }>('SELECT COALESCE(SUM(score), 0) AS s FROM contest_votes WHERE entry_id = ?', entryId)?.s ?? 0;
}

function entriesOf(contestId: number): EntryRow[] {
  return all<EntryRow>('SELECT * FROM contest_entries WHERE contest_id = ? ORDER BY created_at', contestId);
}

function ranking(contestId: number): (EntryRow & { score: number })[] {
  return entriesOf(contestId)
    .map((e) => ({ ...e, score: score(e.id) }))
    .sort((a, b) => b.score - a.score || a.created_at - b.created_at);
}

function requireContest(guildId: string, id: number | string | undefined): ContestRow {
  const c = get<ContestRow>('SELECT * FROM contests WHERE id = ? AND guild_id = ?', Number(id), guildId);
  if (!c) throw new UserError('Concours introuvable.');
  return c;
}

function contestMessage(guild: Guild, c: ContestRow) {
  const entries = entriesOf(c.id).length;
  const rewards = [c.reward_coins ? `${c.reward_coins} ${getConfig(guild.id).economy.currencyEmoji}` : null, c.reward_xp ? `${c.reward_xp} XP` : null, c.reward_role_id ? `<@&${c.reward_role_id}>` : null].filter(Boolean);
  const phase = c.status === 'submissions' ? `📝 Participations jusqu’à ${ts(c.submit_ends_at, 'R')}` : c.status === 'voting' ? `🗳️ Votes jusqu’à ${ts(c.vote_ends_at, 'R')}` : '🏁 Concours terminé';
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, c.status === 'ended' ? 'info' : 'primary'))
    .setTitle(`🏆 CONCOURS — ${truncate(c.name.toUpperCase(), 230)}`)
    .setDescription([c.description, '', phase, `👥 **${entries}** participation(s)`, c.jury_role_id ? `⚖️ Jury : <@&${c.jury_role_id}> (vote ×${JURY_WEIGHT})` : null, rewards.length ? `🎁 Récompenses : ${rewards.join(' · ')}` : null].filter((l) => l !== null).join('\n'));
  if (c.status === 'ended') {
    const top = ranking(c.id).slice(0, 3);
    if (top.length) embed.addFields({ name: 'Classement', value: top.map((e, i) => `${medal(i + 1)} <@${e.user_id}> — **${e.score}** point(s)`).join('\n') });
  }
  return {
    embeds: [embed],
    components: c.status === 'submissions' ? [row(button(`ct:join:${c.id}`, 'Participer', ButtonStyle.Success, '📝'))] : [],
  };
}

function entryMessage(guild: Guild, c: ContestRow, e: EntryRow) {
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild))
    .setAuthor({ name: `Participation #${e.id} — ${c.name}` })
    .setDescription(`<@${e.user_id}>\n\n${truncate(e.content, 3500)}`);
  const link = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))/i.exec(e.content)?.[1];
  if (link && isHttpUrl(link)) embed.setImage(link);
  return { embeds: [embed], components: c.status === 'voting' ? [row(button(`ct:vote:${e.id}`, `Voter (${score(e.id)})`, ButtonStyle.Primary, '🗳️'))] : [], allowedMentions: { parse: [] as [] } };
}

async function refresh(client: Client, c: ContestRow): Promise<void> {
  const guild = client.guilds.cache.get(c.guild_id);
  const channel = guild ? resolveTextChannel(guild, c.channel_id) : null;
  if (!guild || !channel || !c.message_id) return;
  const message = await channel.messages.fetch(c.message_id).catch(() => null);
  await message?.edit(contestMessage(guild, c)).catch(() => undefined);
}

async function startVoting(client: Client, c: ContestRow): Promise<void> {
  run("UPDATE contests SET status = 'voting' WHERE id = ?", c.id);
  const updated = { ...c, status: 'voting' as const };
  const guild = client.guilds.cache.get(c.guild_id);
  const channel = guild ? resolveTextChannel(guild, c.channel_id) : null;
  if (guild && channel) {
    await channel.send({ embeds: [new EmbedBuilder().setColor(colorFor(guild)).setDescription(`🗳️ Les votes du concours **${c.name}** sont ouverts jusqu’à ${ts(c.vote_ends_at, 'f')} !`)] }).catch(() => undefined);
    for (const e of entriesOf(c.id)) {
      const sent = await channel.send(entryMessage(guild, updated, e)).catch(() => null);
      if (sent) run('UPDATE contest_entries SET message_id = ? WHERE id = ?', sent.id, e.id);
    }
  }
  await refresh(client, updated);
}

async function finish(client: Client, c: ContestRow): Promise<void> {
  run("UPDATE contests SET status = 'ended' WHERE id = ?", c.id);
  const updated = { ...c, status: 'ended' as const };
  const guild = client.guilds.cache.get(c.guild_id);
  const channel = guild ? resolveTextChannel(guild, c.channel_id) : null;
  const top = ranking(c.id);
  const winner = top[0];
  if (guild && winner && winner.score > 0) {
    const member = await guild.members.fetch(winner.user_id).catch(() => null);
    if (c.reward_coins && isModuleEnabled(guild.id, 'economy')) addCoins(guild.id, winner.user_id, c.reward_coins, 'contest');
    if (c.reward_xp && isModuleEnabled(guild.id, 'xp')) addXp(guild.id, winner.user_id, c.reward_xp);
    const role = c.reward_role_id ? guild.roles.cache.get(c.reward_role_id) : null;
    if (member && role && canBotManageRole(guild, role)) await member.roles.add(role, `Gagnant du concours ${c.name}`).catch(() => undefined);
  }
  if (guild && channel) {
    // Désactive les boutons de vote.
    for (const e of entriesOf(c.id)) {
      if (!e.message_id) continue;
      const m = await channel.messages.fetch(e.message_id).catch(() => null);
      await m?.edit(entryMessage(guild, updated, e)).catch(() => undefined);
    }
    const text = winner && winner.score > 0 ? `🏆 Bravo <@${winner.user_id}>, tu remportes le concours **${c.name}** avec **${winner.score}** point(s) !` : `🏁 Le concours **${c.name}** est terminé, sans vote.`;
    await channel.send({ content: text, allowedMentions: { users: winner ? [winner.user_id] : [] } }).catch(() => undefined);
    void journal(guild, 'community', { title: 'Concours terminé', tone: 'ok', lines: [text, `**Participations** : ${top.length}`] });
  }
  await refresh(client, updated);
}

const contest: SlashCommand = {
  category: 'community',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder()
    .setName('contest')
    .setDescription('Les concours')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un concours')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Meilleur fan art').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('participations').setDescription('Durée des participations (ex : 3j)').setRequired(true))
        .addStringOption((o) => o.setName('votes').setDescription('Durée des votes (ex : 2j)').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Règles et thème').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('jury').setDescription('Rôle du jury (vote ×3)'))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces pour le gagnant').setMinValue(0).setMaxValue(10_000_000))
        .addIntegerOption((o) => o.setName('xp').setDescription('XP pour le gagnant').setMinValue(0).setMaxValue(1_000_000))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle pour le gagnant')),
    )
    .addSubcommand((s) =>
      s
        .setName('next')
        .setDescription('Passer à la phase suivante maintenant')
        .addIntegerOption((o) => o.setName('concours').setDescription('Le concours').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les concours')),
  subLevels: { list: PermLevel.MEMBER },
  async autocomplete(interaction) {
    const rows = all<ContestRow>("SELECT * FROM contests WHERE guild_id = ? AND status != 'ended' ORDER BY created_at DESC LIMIT 25", interaction.guildId);
    await interaction.respond(rows.map((c) => ({ name: truncate(`#${c.id} · ${c.name} (${c.status})`, 100), value: c.id })));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const rows = all<ContestRow>('SELECT * FROM contests WHERE guild_id = ? ORDER BY created_at DESC LIMIT 15', guild.id);
      return reply(interaction, {
        embeds: [new EmbedBuilder().setColor(colorFor(guild)).setTitle('🏆 Concours').setDescription(rows.map((c) => `**#${c.id}** ${truncate(c.name, 60)} — ${c.status === 'submissions' ? '📝 participations' : c.status === 'voting' ? '🗳️ votes' : '🏁 terminé'} · ${entriesOf(c.id).length} participation(s)`).join('\n') || '*Aucun concours.*')],
        ephemeral: true,
      });
    }
    if (sub === 'next') {
      const c = requireContest(guild.id, interaction.options.getInteger('concours', true));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (c.status === 'submissions') {
        run('UPDATE contests SET submit_ends_at = ?, vote_ends_at = MAX(vote_ends_at - (submit_ends_at - ?), ? + 3600000) WHERE id = ?', Date.now(), Date.now(), Date.now(), c.id);
        await startVoting(interaction.client, requireContest(guild.id, c.id));
      } else if (c.status === 'voting') await finish(interaction.client, c);
      return interaction.editReply({ embeds: [ok(guild, 'Phase suivante lancée.')] });
    }
    const submit = parseDuration(interaction.options.getString('participations', true));
    const vote = parseDuration(interaction.options.getString('votes', true));
    if (!submit || !vote || submit > 60 * 86_400_000 || vote > 60 * 86_400_000) throw new UserError('Durées invalides (ex : `3j`, `12h`, 60 jours max).');
    const role = interaction.options.getRole('role');
    if (role && !canBotManageRole(guild, guild.roles.cache.get(role.id)!)) throw new UserError('Je ne peux pas donner ce rôle de récompense.');
    const channel = (interaction.options.getChannel('salon') ?? resolveTextChannel(guild, getConfig(guild.id).contests.defaultChannelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!channel) throw new UserError('Salon introuvable.');
    const now = Date.now();
    const r = run(
      'INSERT INTO contests (guild_id, channel_id, name, description, submit_ends_at, vote_ends_at, jury_role_id, reward_coins, reward_xp, reward_role_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      guild.id,
      channel.id,
      neutralizeMentions(interaction.options.getString('nom', true)),
      neutralizeMentions(interaction.options.getString('description') ?? ''),
      now + submit,
      now + submit + vote,
      interaction.options.getRole('jury')?.id ?? null,
      interaction.options.getInteger('pieces') ?? 0,
      interaction.options.getInteger('xp') ?? 0,
      role?.id ?? null,
      interaction.user.id,
      now,
    );
    const c = requireContest(guild.id, r.lastInsertRowid);
    const message = await channel.send(contestMessage(guild, c));
    run('UPDATE contests SET message_id = ? WHERE id = ?', message.id, c.id);
    return reply(interaction, { embeds: [ok(guild, `Concours publié : ${message.url}`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'contests',
  section: 'community',
  title: 'Concours',
  emoji: '🏆',
  moduleId: 'contests',
  order: 14,
  description: 'Concours en deux phases : participations (texte ou lien d’image) puis votes, avec jury optionnel et récompenses pour le gagnant.',
  fields: [{ kind: 'channel', key: 'channel', label: 'Salon des concours', get: (c) => c.contests.defaultChannelId, set: (c, v) => void (c.contests.defaultChannelId = v) }],
};

export const contestsModule: BotModule = {
  id: 'contests',
  name: 'Concours',
  emoji: '🏆',
  description: 'Concours avec participations, votes, jury et classement',
  toggleable: true,
  defaultEnabled: false,
  commands: [contest],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'ct',
      async button(interaction: ButtonInteraction<'cached'>, [action, id]) {
        if (action === 'join') {
          const c = requireContest(interaction.guildId, id);
          if (c.status !== 'submissions') throw new UserError('Les participations sont closes.');
          const existing = get<EntryRow>('SELECT * FROM contest_entries WHERE contest_id = ? AND user_id = ?', c.id, interaction.user.id);
          return interaction.showModal(
            buildModal(`ct:entry:${c.id}`, `Participer — ${c.name}`.slice(0, 45), [
              { id: 'content', label: 'Ta participation (texte et/ou lien d’image)', long: true, value: existing?.content, maxLength: 1500, minLength: 5 },
            ]),
          );
        }
        if (action === 'vote') {
          const entry = get<EntryRow>('SELECT * FROM contest_entries WHERE id = ?', Number(id));
          if (!entry) throw new UserError('Participation introuvable.');
          const c = requireContest(interaction.guildId, entry.contest_id);
          if (c.status !== 'voting') throw new UserError('Les votes sont clos.');
          if (entry.user_id === interaction.user.id) throw new UserError('Tu ne peux pas voter pour ta propre participation.');
          const jury = !!c.jury_role_id && interaction.member.roles.cache.has(c.jury_role_id);
          // Un seul vote par personne dans le concours : voter ailleurs déplace le vote.
          const previous = get<{ entry_id: number }>('SELECT v.entry_id FROM contest_votes v JOIN contest_entries e ON e.id = v.entry_id WHERE e.contest_id = ? AND v.user_id = ?', c.id, interaction.user.id);
          if (previous?.entry_id === entry.id) {
            run('DELETE FROM contest_votes WHERE entry_id = ? AND user_id = ?', entry.id, interaction.user.id);
          } else {
            if (previous) run('DELETE FROM contest_votes WHERE entry_id = ? AND user_id = ?', previous.entry_id, interaction.user.id);
            run('INSERT INTO contest_votes (entry_id, user_id, score, jury) VALUES (?, ?, ?, ?)', entry.id, interaction.user.id, jury ? JURY_WEIGHT : 1, jury ? 1 : 0);
          }
          await interaction.update(entryMessage(interaction.guild, c, entry));
          if (previous && previous.entry_id !== entry.id) {
            const prev = get<EntryRow>('SELECT * FROM contest_entries WHERE id = ?', previous.entry_id);
            const channel = resolveTextChannel(interaction.guild, c.channel_id);
            const m = prev?.message_id ? await channel?.messages.fetch(prev.message_id).catch(() => null) : null;
            if (prev && m) await m.edit(entryMessage(interaction.guild, c, prev)).catch(() => undefined);
          }
          await interaction.followUp({ embeds: [ok(interaction.guild, previous?.entry_id === entry.id ? 'Vote retiré.' : `Vote enregistré${jury ? ' (jury ×3)' : ''} pour la participation #${entry.id}.`)], flags: MessageFlags.Ephemeral });
        }
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        if (action !== 'entry') return;
        const c = requireContest(interaction.guildId, id);
        if (c.status !== 'submissions') throw new UserError('Les participations sont closes.');
        const content = neutralizeMentions(interaction.fields.getTextInputValue('content').trim());
        run(
          `INSERT INTO contest_entries (contest_id, user_id, content, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(contest_id, user_id) DO UPDATE SET content = excluded.content`,
          c.id,
          interaction.user.id,
          content,
          Date.now(),
        );
        await refresh(interaction.client, c);
        await interaction.reply({ embeds: [ok(interaction.guild, `Participation enregistrée pour **${c.name}** ! Les votes ouvrent ${ts(c.submit_ends_at, 'R')}.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  tasks: [
    {
      name: 'contests',
      intervalMs: 60_000,
      runOnStart: true,
      async run(client) {
        const now = Date.now();
        for (const c of all<ContestRow>("SELECT * FROM contests WHERE status = 'submissions' AND submit_ends_at <= ?", now)) await startVoting(client, c);
        for (const c of all<ContestRow>("SELECT * FROM contests WHERE status = 'voting' AND vote_ends_at <= ?", now)) await finish(client, c);
      },
    },
  ],
};
