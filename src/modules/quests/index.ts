import { EmbedBuilder, SlashCommandBuilder, type Client, type Guild, type User } from 'discord.js';
import { all, get, run } from '../../database/db';
import { brandEmbed, colorFor } from '../../core/embeds';
import { getConfig, type QuestDefinition } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { isModuleEnabled } from '../../core/moduleManager';
import type { SetupPage } from '../../core/setup';
import { formatNumber, progressBar } from '../../core/text';
import { dayKey, previousDayKey } from '../../core/time';
import { on, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { onActivity, type ActivityType } from '../../services/activity';
import { addCoins } from '../../services/economy';
import { onVoiceTime } from '../../services/voice';
import { addXp } from '../../services/xp';

const today = (guildId: string) => dayKey(Date.now(), getConfig(guildId).general.timezone);

async function notify(client: Client | null, guildId: string, userId: string, text: string): Promise<void> {
  if (!client || !getConfig(guildId).quests.announce) return;
  const guild = client.guilds.cache.get(guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!guild || !user) return;
  await user.send({ embeds: [new EmbedBuilder().setColor(colorFor(guild, 'success')).setAuthor({ name: guild.name, iconURL: guild.iconURL() ?? undefined }).setDescription(text)] }).catch(() => undefined);
}

function reward(guildId: string, userId: string, xp: number, coins: number): string {
  const parts: string[] = [];
  if (xp > 0 && isModuleEnabled(guildId, 'xp')) {
    addXp(guildId, userId, xp);
    parts.push(`+${formatNumber(xp)} XP`);
  }
  if (coins > 0 && isModuleEnabled(guildId, 'economy')) {
    addCoins(guildId, userId, coins, 'quest');
    const eco = getConfig(guildId).economy;
    parts.push(`+${formatNumber(coins)} ${eco.currencyEmoji} ${eco.currencyName}`);
  }
  return parts.join(' · ') || 'la gloire éternelle';
}

/** Avance les quêtes du jour d'un type donné et distribue les récompenses une seule fois. */
function progress(client: Client | null, guildId: string, userId: string, type: ActivityType, amount: number): void {
  if (!isModuleEnabled(guildId, 'quests') || amount <= 0) return;
  const day = today(guildId);
  for (const quest of getConfig(guildId).quests.list.filter((q) => q.type === type)) {
    const row = get<{ progress: number; completed: number }>('SELECT progress, completed FROM quests WHERE guild_id = ? AND user_id = ? AND day = ? AND quest_id = ?', guildId, userId, day, quest.id);
    if (row?.completed) continue;
    const value = Math.min(quest.target, (row?.progress ?? 0) + amount);
    const done = value >= quest.target;
    run(
      `INSERT INTO quests (guild_id, user_id, day, quest_id, progress, completed) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, day, quest_id) DO UPDATE SET progress = excluded.progress, completed = excluded.completed`,
      guildId,
      userId,
      day,
      quest.id,
      value,
      done ? 1 : 0,
    );
    if (done) {
      const gains = reward(guildId, userId, quest.rewardXp, quest.rewardCoins);
      void notify(client, guildId, userId, `🎯 **Quête du jour terminée !**\n${quest.label}\n\nRécompense : **${gains}**`);
    }
  }
}

/** Série quotidienne : +1 par jour d'activité consécutif, remise à 1 après un jour manqué. */
function bumpStreak(client: Client | null, guildId: string, userId: string): void {
  if (!isModuleEnabled(guildId, 'quests')) return;
  const day = today(guildId);
  const row = get<{ current: number; best: number; last_day: string | null }>('SELECT current, best, last_day FROM streaks WHERE guild_id = ? AND user_id = ?', guildId, userId);
  if (row?.last_day === day) return;
  const current = row?.last_day === previousDayKey(day) ? row.current + 1 : 1;
  const best = Math.max(current, row?.best ?? 0);
  run(
    `INSERT INTO streaks (guild_id, user_id, current, best, last_day) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET current = excluded.current, best = excluded.best, last_day = excluded.last_day`,
    guildId,
    userId,
    current,
    best,
    day,
  );
  const milestone = getConfig(guildId).quests.streakMilestones.find((m) => m.days === current);
  if (milestone) {
    const gains = reward(guildId, userId, milestone.xp, milestone.coins);
    void notify(client, guildId, userId, `🔥 **Série de ${current} jours !**\nMerci pour ta fidélité. Récompense : **${gains}**`);
  }
}

onActivity((event, client) => progress(client, event.guildId, event.userId, event.type, event.amount));
onVoiceTime((credit, client) => {
  if (credit.idle) return;
  progress(client, credit.guildId, credit.userId, 'voice_minutes', Math.floor(credit.seconds / 60));
});

function questsEmbed(guild: Guild, user: User) {
  const day = today(guild.id);
  const rows = all<{ quest_id: string; progress: number; completed: number }>('SELECT quest_id, progress, completed FROM quests WHERE guild_id = ? AND user_id = ? AND day = ?', guild.id, user.id, day);
  const streak = get<{ current: number; best: number }>('SELECT current, best FROM streaks WHERE guild_id = ? AND user_id = ?', guild.id, user.id);
  const eco = getConfig(guild.id).economy;
  const lines = getConfig(guild.id).quests.list.map((q: QuestDefinition) => {
    const r = rows.find((x) => x.quest_id === q.id);
    const value = r?.progress ?? 0;
    const rewards = [q.rewardXp ? `+${q.rewardXp} XP` : null, q.rewardCoins ? `+${q.rewardCoins} ${eco.currencyEmoji}` : null].filter(Boolean).join(' · ');
    return `${r?.completed ? '✅' : '🎯'} **${q.label}**\n${progressBar(value / q.target, 12)} ${value}/${q.target}${rewards ? ` · ${rewards}` : ''}`;
  });
  return brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle('🎯 QUÊTES DU JOUR')
    .setDescription(lines.join('\n\n') || '*Aucune quête configurée.*')
    .addFields({ name: '🔥 Série actuelle', value: `${streak?.current ?? 0} jour(s) · record ${streak?.best ?? 0}`, inline: false })
    .setFooter({ text: 'Les quêtes se renouvellent chaque jour à minuit.' });
}

const quest: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('quest')
    .setDescription('Tes quêtes du jour et ta série')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async execute(interaction) {
    await reply(interaction, { embeds: [questsEmbed(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'quetes',
    aliases: ['quests', 'quest', 'streak'],
    domain: 'general',
    category: 'economy',
    description: 'Tes quêtes et ta série',
    async execute(message) {
      await message.reply({ embeds: [questsEmbed(message.guild, message.author)], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'quests',
  section: 'community',
  title: 'Quêtes & séries',
  emoji: '🎯',
  moduleId: 'quests',
  order: 10,
  description:
    'Quêtes quotidiennes (messages, vocal, giveaways, /daily) et série de jours actifs.\n-# Format des quêtes : `type:objectif:xp:pièces:texte` séparées par des retours à la ligne.\n-# Paliers de série : `jours:pièces:xp` séparés par des virgules.',
  fields: [
    { kind: 'toggle', key: 'announce', label: 'Prévenir en MP', get: (c) => c.quests.announce, set: (c, v) => void (c.quests.announce = v) },
    {
      kind: 'text',
      key: 'list',
      label: 'Quêtes du jour',
      long: true,
      maxLength: 1500,
      get: (c) => c.quests.list.map((q) => `${q.type}:${q.target}:${q.rewardXp}:${q.rewardCoins}:${q.label}`).join('\n'),
      set: (c, v) => {
        const parsed = parseQuests(v);
        if (parsed) c.quests.list = parsed;
      },
      validate: (v) => (parseQuests(v) ? null : 'Format : `messages:20:100:50:Envoyer 20 messages` (types : messages, voice_minutes, giveaways, daily).'),
    },
    {
      kind: 'text',
      key: 'milestones',
      label: 'Paliers de série',
      maxLength: 300,
      get: (c) => c.quests.streakMilestones.map((m) => `${m.days}:${m.coins}:${m.xp}`).join(', '),
      set: (c, v) => {
        const parsed = parseMilestones(v);
        if (parsed) c.quests.streakMilestones = parsed;
      },
      validate: (v) => (parseMilestones(v) ? null : 'Format : `7:200:200, 30:1000:1000`.'),
    },
  ],
};

export function parseQuests(input: string): QuestDefinition[] | null {
  const out: QuestDefinition[] = [];
  for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(messages|voice_minutes|giveaways|daily)\s*:\s*(\d{1,6})\s*:\s*(\d{1,7})\s*:\s*(\d{1,7})\s*:\s*(.{2,100})$/.exec(line);
    if (!m) return null;
    out.push({ id: `${m[1]}${m[2]}-${out.length}`, type: m[1] as QuestDefinition['type'], target: Math.max(1, Number(m[2])), rewardXp: Number(m[3]), rewardCoins: Number(m[4]), label: m[5]!.trim() });
  }
  return out.slice(0, 10);
}

export function parseMilestones(input: string): { days: number; coins: number; xp: number }[] | null {
  if (!input.trim()) return [];
  const out: { days: number; coins: number; xp: number }[] = [];
  for (const part of input.split(',')) {
    const m = /^\s*(\d{1,4})\s*:\s*(\d{1,7})\s*:\s*(\d{1,7})\s*$/.exec(part);
    if (!m) return null;
    out.push({ days: Number(m[1]), coins: Number(m[2]), xp: Number(m[3]) });
  }
  return out.sort((a, b) => a.days - b.days).slice(0, 10);
}

export const questsModule: BotModule = {
  id: 'quests',
  name: 'Quêtes & séries',
  emoji: '🎯',
  description: 'Quêtes quotidiennes et récompenses de série',
  toggleable: true,
  defaultEnabled: false,
  commands: [quest],
  prefixCommands,
  setupPages: [setupPage],
  events: [
    on('messageCreate', (message) => {
      if (!message.inGuild() || message.author.bot) return;
      bumpStreak(message.client, message.guildId, message.author.id);
      progress(message.client, message.guildId, message.author.id, 'messages', 1);
    }, 190),
  ],
  tasks: [
    {
      name: 'quests-cleanup',
      intervalMs: 12 * 3_600_000,
      async run() {
        run('DELETE FROM quests WHERE day < ?', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
      },
    },
  ],
};
