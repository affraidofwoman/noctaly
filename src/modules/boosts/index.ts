import { EmbedBuilder, MessageType, SlashCommandBuilder, type GuildMember, type Message } from 'discord.js';
import { all, get, run } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { brandEmbed, colorFor, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig, updateConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { isModuleEnabled } from '../../core/moduleManager';
import { canBotManageRole } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { medal, truncate } from '../../core/text';
import { renderTemplate } from '../../core/variables';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { getBadge, grantBadge } from '../../services/badges';
import { addCoins } from '../../services/economy';

const BOOST_TYPES = new Set([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);
const recentBoosts = new Map<string, number>();

async function applyRewards(member: GuildMember, count: number): Promise<string[]> {
  const guild = member.guild;
  const given: string[] = [];
  for (const r of getConfig(guild.id).boosts.rewards.filter((x) => x.count === count)) {
    const role = r.roleId ? guild.roles.cache.get(r.roleId) : null;
    if (role && canBotManageRole(guild, role)) {
      await member.roles.add(role, `Récompense de ${count} boost(s)`).catch(() => undefined);
      given.push(`<@&${role.id}>`);
    }
    if (r.badgeId && grantBadge(guild.id, member.id, r.badgeId)) given.push(`${getBadge(guild.id, r.badgeId)?.emoji ?? '🏅'} badge`);
    if (r.coins > 0 && isModuleEnabled(guild.id, 'economy')) {
      addCoins(guild.id, member.id, r.coins, 'boost');
      given.push(`${r.coins} ${getConfig(guild.id).economy.currencyEmoji}`);
    }
  }
  return given;
}

/** Un boost : compteur, rôle booster, badge VIP, récompenses et annonce. */
async function recordBoost(member: GuildMember): Promise<void> {
  const guild = member.guild;
  const key = `${guild.id}:${member.id}`;
  if ((recentBoosts.get(key) ?? 0) > Date.now()) return;
  recentBoosts.set(key, Date.now() + 30_000);
  const now = Date.now();
  run(
    `INSERT INTO boosts (guild_id, user_id, count, first_boost_at, last_boost_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET count = count + 1, last_boost_at = excluded.last_boost_at`,
    guild.id,
    member.id,
    now,
    now,
  );
  const count = get<{ count: number }>('SELECT count FROM boosts WHERE guild_id = ? AND user_id = ?', guild.id, member.id)?.count ?? 1;
  const cfg = getConfig(guild.id).boosts;
  const boosterRole = cfg.boosterRoleId ? guild.roles.cache.get(cfg.boosterRoleId) : null;
  if (boosterRole && canBotManageRole(guild, boosterRole)) await member.roles.add(boosterRole, 'Booster').catch(() => undefined);
  grantBadge(guild.id, member.id, 'vip');
  const rewards = await applyRewards(member, count);
  void journal(guild, 'boost', { title: 'Nouveau boost', tone: 'ok', lines: [`**Membre** : <@${member.id}>`, `**Boosts de ce membre** : ${count}`, `**Boosts du serveur** : ${guild.premiumSubscriptionCount ?? 0}`, rewards.length ? `**Récompenses** : ${rewards.join(', ')}` : null] });
  const channel = resolveTextChannel(guild, cfg.channelId);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild))
    .setTitle(`${emojiFor(guild.id, 'boost')} NOUVEAU BOOST !`)
    .setDescription(truncate(renderTemplate(cfg.message, { member, guild }), 4000) + (rewards.length ? `\n\n🎁 Récompenses : ${rewards.join(', ')}` : ''))
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  await channel.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } }).catch(() => undefined);
}

const boost: SlashCommand = {
  category: 'community',
  level: PermLevel.MEMBER,
  data: new SlashCommandBuilder()
    .setName('boost')
    .setDescription('Les boosts du serveur')
    .addSubcommand((s) => s.setName('top').setDescription('Les boosters du serveur'))
    .addSubcommand((s) =>
      s
        .setName('recompense')
        .setDescription('Ajouter une récompense de boosts')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Au bout de combien de boosts').setRequired(true).setMinValue(1).setMaxValue(100))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle donné'))
        .addStringOption((o) => o.setName('badge').setDescription('Badge donné (identifiant)').setMaxLength(32))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces données').setMinValue(0).setMaxValue(10_000_000)),
    )
    .addSubcommand((s) => s.setName('recompenses').setDescription('Les récompenses configurées'))
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer les récompenses d’un palier')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Le palier').setRequired(true).setMinValue(1).setMaxValue(100)),
    ),
  subLevels: { recompense: PermLevel.ADMIN, retirer: PermLevel.ADMIN, recompenses: PermLevel.STAFF },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'top') {
      const rows = all<{ user_id: string; count: number }>('SELECT user_id, count FROM boosts WHERE guild_id = ? ORDER BY count DESC, first_boost_at LIMIT 25', guild.id);
      return reply(interaction, {
        embeds: [brandEmbed(guild).setTitle('🚀 Boosters').setDescription(rows.map((r, i) => `${medal(i + 1)} <@${r.user_id}> — **${r.count}** boost(s)`).join('\n') || '*Aucun boost enregistré.*').setFooter({ text: `${guild.premiumSubscriptionCount ?? 0} boosts · niveau ${guild.premiumTier}` })],
      });
    }
    if (sub === 'recompenses') {
      const rewards = getConfig(guild.id).boosts.rewards;
      return reply(interaction, {
        embeds: [info(guild, rewards.map((r) => `**${r.count} boost(s)** → ${[r.roleId ? `<@&${r.roleId}>` : null, r.badgeId ? `badge \`${r.badgeId}\`` : null, r.coins ? `${r.coins} pièces` : null].filter(Boolean).join(', ')}`).join('\n') || 'Aucune récompense.', { titre: 'Récompenses de boost', sujet: '🚀' })],
        ephemeral: true,
      });
    }
    const count = interaction.options.getInteger('boosts', true);
    if (sub === 'retirer') {
      updateConfig(guild.id, (c) => void (c.boosts.rewards = c.boosts.rewards.filter((r) => r.count !== count)));
      return reply(interaction, { embeds: [ok(guild, `Récompenses du palier ${count} retirées.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    const badgeId = interaction.options.getString('badge');
    const coins = interaction.options.getInteger('pieces') ?? 0;
    if (!role && !badgeId && !coins) throw new UserError('Choisis au moins un rôle, un badge ou des pièces.');
    if (role && !canBotManageRole(guild, guild.roles.cache.get(role.id)!)) throw new UserError('Je ne peux pas donner ce rôle.');
    if (badgeId && !getBadge(guild.id, badgeId)) throw new UserError('Badge introuvable (voir `/badge liste`).');
    updateConfig(guild.id, (c) => c.boosts.rewards.push({ count, roleId: role?.id ?? null, badgeId, coins }));
    return reply(interaction, { embeds: [ok(guild, `Récompense ajoutée au palier **${count} boost(s)**.`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'boosts',
  section: 'community',
  title: 'Boosts',
  emoji: '🚀',
  moduleId: 'boosts',
  order: 13,
  description: 'Remercier les boosters, leur donner un rôle et des récompenses par palier (`/boost recompense`).\n-# Variables : `{mention}` `{user}` `{boosts}`',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des remerciements', get: (c) => c.boosts.channelId, set: (c, v) => void (c.boosts.channelId = v) },
    { kind: 'role', key: 'role', label: 'Rôle booster', assignable: true, get: (c) => c.boosts.boosterRoleId, set: (c, v) => void (c.boosts.boosterRoleId = v) },
    { kind: 'text', key: 'message', label: 'Message', long: true, maxLength: 1500, required: true, get: (c) => c.boosts.message, set: (c, v) => void (c.boosts.message = v) },
  ],
};

export const boostsModule: BotModule = {
  id: 'boosts',
  name: 'Boosts',
  emoji: '🚀',
  description: 'Remerciements, rôle booster et récompenses de boost',
  toggleable: true,
  defaultEnabled: true,
  commands: [boost],
  setupPages: [setupPage],
  events: [
    on('messageCreate', async (message: Message) => {
      if (!message.inGuild() || !BOOST_TYPES.has(message.type) || !message.member) return;
      await recordBoost(message.member);
    }, 20),
    on('guildMemberUpdate', async (before, after) => {
      const cfg = getConfig(after.guild.id).boosts;
      if (!before.premiumSince && after.premiumSince) {
        // Laisse le message système arriver en premier (il compte chaque boost) avant d'utiliser ce repli.
        setTimeout(() => void recordBoost(after), 5_000).unref();
      } else if (before.premiumSince && !after.premiumSince) {
        const role = cfg.boosterRoleId ? after.guild.roles.cache.get(cfg.boosterRoleId) : null;
        if (role && canBotManageRole(after.guild, role)) await after.roles.remove(role, 'Ne booste plus').catch(() => undefined);
        void journal(after.guild, 'boost', { title: 'Fin de boost', tone: 'alerte', lines: [`<@${after.id}> ne booste plus le serveur.`] });
      }
    }),
  ],
  tests: [
    {
      id: 'thanks',
      label: 'Remerciement de boost',
      emoji: '🚀',
      description: 'Voir le message de remerciement à ton nom (sans compter de boost)',
      async run(interaction) {
        const cfg = getConfig(interaction.guildId).boosts;
        const channel = resolveTextChannel(interaction.guild, cfg.channelId);
        if (!channel) return '⚠️ Aucun salon de remerciements utilisable.';
        await channel.send({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setTitle('🚀 NOUVEAU BOOST ! (test)').setDescription(renderTemplate(cfg.message, { member: interaction.member, guild: interaction.guild }))], allowedMentions: { parse: [] } });
        return `✅ Message de test posté dans <#${channel.id}>.`;
      },
    },
  ],
};
