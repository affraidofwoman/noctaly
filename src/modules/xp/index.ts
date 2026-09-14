import { randomInt } from 'node:crypto';
import { ChannelType, SlashCommandBuilder, type Guild, type GuildMember, type Message, type User } from 'discord.js';
import { emojiFor } from '../../core/brand';
import { brandEmbed, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { isModuleEnabled } from '../../core/moduleManager';
import { linesToPages, paginate } from '../../core/pagination';
import { assignableRoles } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { formatNumber, medal, progressBar } from '../../core/text';
import { renderTemplate } from '../../core/variables';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { grantBadge } from '../../services/badges';
import { onVoiceTime } from '../../services/voice';
import { addXp, getXp, leaderboard, levelFromXp, levelRoles, rankOf, removeLevelRole, setLevelRole, setXp, totalXpForLevel } from '../../services/xp';

const cooldowns = new Map<string, number>();

/** Rôles de niveau : empilés ou seulement le plus haut atteint. */
export async function syncLevelRoles(member: GuildMember, level: number): Promise<void> {
  const rewards = levelRoles(member.guild.id);
  if (!rewards.length) return;
  const stack = getConfig(member.guild.id).xp.stackRoles;
  const earned = rewards.filter((r) => r.level <= level);
  const target = stack ? earned : earned.filter((r) => r.level === Math.max(...earned.map((e) => e.level), -1));
  const targetIds = new Set(target.map((r) => r.role_id));
  const toAdd = assignableRoles(member.guild, [...targetIds]).filter((r) => !member.roles.cache.has(r.id));
  const toRemove = assignableRoles(member.guild, rewards.map((r) => r.role_id)).filter((r) => !targetIds.has(r.id) && member.roles.cache.has(r.id));
  if (toAdd.length) await member.roles.add(toAdd, `Niveau ${level}`).catch(() => undefined);
  if (toRemove.length) await member.roles.remove(toRemove, `Niveau ${level}`).catch(() => undefined);
  if (toAdd.length) {
    void journal(member.guild, 'autorole', { title: 'Rôle de niveau', tone: 'ok', lines: [`**Membre** : <@${member.id}>`, `**Niveau** : ${level}`, `**Rôles** : ${toAdd.map((r) => `<@&${r.id}>`).join(' ')}`] });
  }
}

async function announceLevel(member: GuildMember, level: number, source: Message | null): Promise<void> {
  const cfg = getConfig(member.guild.id).xp;
  if (level >= 10) grantBadge(member.guild.id, member.id, 'actif');
  await syncLevelRoles(member, level);
  if (cfg.announce === 'off') return;
  const text = renderTemplate(cfg.levelUpMessage, { member, guild: member.guild, extra: { level } });
  const embed = brandEmbed(member.guild).setDescription(`${emojiFor(member.guild.id, 'niveau')} ${text}`).setThumbnail(member.user.displayAvatarURL({ size: 128 }));
  if (cfg.announce === 'dm') {
    await member.send({ embeds: [embed] }).catch(() => undefined);
    return;
  }
  const channel = cfg.announce === 'channel' ? resolveTextChannel(member.guild, cfg.announceChannelId) : source?.channel;
  if (channel && 'send' in channel) await channel.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } }).catch(() => undefined);
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const cfg = getConfig(message.guildId).xp;
  if (cfg.noXpChannels.includes(message.channelId) || (message.channel.isThread() && message.channel.parentId && cfg.noXpChannels.includes(message.channel.parentId))) return;
  if (message.member.roles.cache.some((r) => cfg.noXpRoles.includes(r.id))) return;
  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  if ((cooldowns.get(key) ?? 0) > now) return;
  cooldowns.set(key, now + cfg.cooldownSeconds * 1000);
  if (cooldowns.size > 20_000) for (const [k, v] of cooldowns) if (v < now) cooldowns.delete(k);
  const gain = randomInt(Math.min(cfg.min, cfg.max), Math.max(cfg.min, cfg.max) + 1);
  const { oldLevel, newLevel } = addXp(message.guildId, message.author.id, gain, true);
  if (newLevel > oldLevel) await announceLevel(message.member, newLevel, message);
}

onVoiceTime((credit, client) => {
  if (credit.idle || !isModuleEnabled(credit.guildId, 'xp')) return;
  const perMinute = getConfig(credit.guildId).xp.voiceXpPerMinute;
  if (perMinute <= 0) return;
  const gain = Math.floor((credit.seconds / 60) * perMinute);
  if (gain <= 0) return;
  const { oldLevel, newLevel } = addXp(credit.guildId, credit.userId, gain);
  if (newLevel > oldLevel) {
    const member = client.guilds.cache.get(credit.guildId)?.members.cache.get(credit.userId);
    if (member) void announceLevel(member, newLevel, null);
  }
});

function rankEmbed(guild: Guild, user: User) {
  const row = getXp(guild.id, user.id);
  const progress = levelFromXp(row.xp);
  const rank = rankOf(guild.id, user.id);
  return brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle(`⭐ NIVEAU DE ${user.displayName.toUpperCase()}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `## Niveau ${progress.level}`,
        `**XP :** ${formatNumber(progress.current)} / ${formatNumber(progress.needed)}`,
        progressBar(progress.current / progress.needed, 16),
        '',
        `• XP totale — **${formatNumber(row.xp)}**`,
        `• Classement — **${rank ? `#${rank}` : '—'}**`,
      ].join('\n'),
    );
}

function leaderboardPages(guild: Guild) {
  const rows = leaderboard(guild.id, 200);
  const lines = rows.map((r, i) => `${medal(i + 1)} <@${r.user_id}> — Niveau **${r.level}** · ${formatNumber(r.xp)} XP`);
  if (!lines.length) lines.push('*Personne n’a encore d’XP.*');
  return linesToPages(lines, 10, (content, page, total) => brandEmbed(guild).setTitle('🏆 CLASSEMENT').setDescription(content).setFooter({ text: `Page ${page}/${total}` }));
}

const userOpt = (o: import('discord.js').SlashCommandUserOption) => o.setName('membre').setDescription('Qui (toi par défaut)');

const rank: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder().setName('rank').setDescription('Ton niveau').addUserOption(userOpt),
  async execute(i) {
    await reply(i, { embeds: [rankEmbed(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const level: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder().setName('level').setDescription('Le niveau d’un membre').addUserOption(userOpt),
  async execute(i) {
    await reply(i, { embeds: [rankEmbed(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const leaderboardCmd: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Le classement XP'),
  async execute(i) {
    await paginate(i, leaderboardPages(i.guild));
  },
};

const xpAdmin: SlashCommand = {
  category: 'community',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Gérer l’XP et les rôles de niveau')
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner ou retirer de l’XP')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('quantite').setDescription('XP (négatif pour retirer)').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000)),
    )
    .addSubcommand((s) =>
      s
        .setName('niveau')
        .setDescription('Fixer le niveau d’un membre')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((s) => s.setName('reset').setDescription('Remettre à zéro un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('role-ajouter')
        .setDescription('Récompenser un niveau par un rôle')
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('role-retirer').setDescription('Retirer une récompense de niveau').addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('roles').setDescription('Les rôles de niveau')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const guild = i.guild;
    if (sub === 'roles') {
      const rows = levelRoles(guild.id);
      return reply(i, { embeds: [info(guild, rows.map((r) => `Niveau **${r.level}** → <@&${r.role_id}>`).join('\n') || 'Aucun rôle de niveau.', { titre: 'Rôles de niveau', sujet: '🏆' })], ephemeral: true });
    }
    if (sub === 'role-ajouter') {
      const role = i.options.getRole('role', true);
      if (!assignableRoles(guild, [role.id]).length) throw new UserError('Je ne peux pas attribuer ce rôle (il est au-dessus du mien ou géré par une intégration).');
      setLevelRole(guild.id, i.options.getInteger('niveau', true), role.id);
      return reply(i, { embeds: [ok(guild, `Niveau **${i.options.getInteger('niveau', true)}** → <@&${role.id}>`)], ephemeral: true });
    }
    if (sub === 'role-retirer') {
      const n = removeLevelRole(guild.id, i.options.getRole('role', true).id);
      return reply(i, { embeds: [n ? ok(guild, 'Récompense retirée.') : info(guild, 'Ce rôle n’était pas une récompense de niveau.')], ephemeral: true });
    }
    const user = i.options.getUser('membre', true);
    let newLevel: number;
    if (sub === 'donner') newLevel = addXp(guild.id, user.id, i.options.getInteger('quantite', true)).newLevel;
    else if (sub === 'niveau') newLevel = setXp(guild.id, user.id, totalXpForLevel(i.options.getInteger('niveau', true)));
    else newLevel = setXp(guild.id, user.id, 0);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await syncLevelRoles(member, newLevel);
    return reply(i, { embeds: [ok(guild, `<@${user.id}> est maintenant niveau **${newLevel}** (${formatNumber(getXp(guild.id, user.id).xp)} XP).`)], ephemeral: true });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'rank',
    aliases: ['level', 'niveau'],
    domain: 'general',
    category: 'community',
    description: 'Ton niveau',
    usage: '[membre]',
    async execute(message, args) {
      const id = args[0]?.replace(/\D/g, '');
      const user = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [rankEmbed(message.guild, user)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'top',
    aliases: ['leaderboard', 'lb'],
    domain: 'general',
    category: 'community',
    description: 'Le classement XP',
    async execute(message) {
      await message.reply({ embeds: [leaderboardPages(message.guild)[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'xp',
  section: 'community',
  title: 'XP & niveaux',
  emoji: '⭐',
  moduleId: 'xp',
  order: 1,
  description: 'Gain d’XP par message (avec cooldown) et en vocal (à plusieurs, non sourd).\n-# Rôles de niveau : `/xp role-ajouter`. Variables du message : `{mention}` `{user}` `{level}`',
  fields: [
    {
      kind: 'choice',
      key: 'announce',
      label: 'Annonce des niveaux',
      options: [
        { value: 'same', label: 'Dans le salon du message', emoji: '💬' },
        { value: 'channel', label: 'Dans un salon dédié', emoji: '📢' },
        { value: 'dm', label: 'En message privé', emoji: '✉️' },
        { value: 'off', label: 'Aucune annonce', emoji: '🔕' },
      ],
      get: (c) => c.xp.announce,
      set: (c, v) => void (c.xp.announce = v as 'off' | 'same' | 'channel' | 'dm'),
    },
    { kind: 'channel', key: 'channel', label: 'Salon des annonces de niveau', get: (c) => c.xp.announceChannelId, set: (c, v) => void (c.xp.announceChannelId = v) },
    {
      kind: 'channels',
      key: 'noxp',
      label: 'Salons sans XP',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
      get: (c) => c.xp.noXpChannels,
      set: (c, v) => void (c.xp.noXpChannels = v),
    },
    { kind: 'toggle', key: 'stack', label: 'Cumuler les rôles de niveau', get: (c) => c.xp.stackRoles, set: (c, v) => void (c.xp.stackRoles = v) },
    { kind: 'text', key: 'message', label: 'Message de niveau', long: true, maxLength: 500, required: true, get: (c) => c.xp.levelUpMessage, set: (c, v) => void (c.xp.levelUpMessage = v) },
    { kind: 'number', key: 'min', label: 'XP min par message', min: 1, max: 500, get: (c) => c.xp.min, set: (c, v) => void (c.xp.min = v) },
    { kind: 'number', key: 'max', label: 'XP max par message', min: 1, max: 1000, get: (c) => c.xp.max, set: (c, v) => void (c.xp.max = v) },
    { kind: 'number', key: 'cooldown', label: 'Cooldown entre deux gains', min: 0, max: 3600, unit: 's', get: (c) => c.xp.cooldownSeconds, set: (c, v) => void (c.xp.cooldownSeconds = v) },
    { kind: 'number', key: 'voice', label: 'XP par minute de vocal', min: 0, max: 100, get: (c) => c.xp.voiceXpPerMinute, set: (c, v) => void (c.xp.voiceXpPerMinute = v) },
  ],
};

export const xpModule: BotModule = {
  id: 'xp',
  name: 'XP & niveaux',
  emoji: '⭐',
  description: 'XP messages et vocal, niveaux, rôles de niveau, classement',
  toggleable: true,
  defaultEnabled: false,
  commands: [rank, level, leaderboardCmd, xpAdmin],
  prefixCommands,
  setupPages: [setupPage],
  events: [on('messageCreate', (m) => onMessage(m), 150)],
};
