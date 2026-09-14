import { GuildMember, SlashCommandBuilder, type Guild, type User } from 'discord.js';
import { get } from '../../database/db';
import { brandEmbed, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { isModuleEnabled } from '../../core/moduleManager';
import { getLevel, levelLabel } from '../../core/permissions';
import { formatNumber, slugify, truncate } from '../../core/text';
import { daysSince, formatDuration } from '../../core/time';
import { PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { deleteBadge, getBadge, grantBadge, listBadges, revokeBadge, upsertBadge, userBadges } from '../../services/badges';
import { userActivity } from '../../services/stats';
import { ticketCount } from '../../services/tickets';
import { winsOf } from '../../services/giveaways';
import { getXp, levelFromXp, rankOf } from '../../services/xp';

/** Badges automatiques calculés à l'affichage (staff, booster, ancienneté). */
function syncAutoBadges(member: GuildMember): void {
  if (!getConfig(member.guild.id).profiles.autoBadges) return;
  const g = member.guild.id;
  if (getLevel(member) >= PermLevel.SUPPORT) grantBadge(g, member.id, 'staff');
  if (member.premiumSinceTimestamp) grantBadge(g, member.id, 'vip');
  if (member.joinedTimestamp && daysSince(member.joinedTimestamp) >= 180) grantBadge(g, member.id, 'og');
  if (getXp(g, member.id).level >= 10) grantBadge(g, member.id, 'actif');
}

export function profileEmbed(guild: Guild, user: User, member: GuildMember | null) {
  if (member) syncAutoBadges(member);
  const g = guild.id;
  const xp = getXp(g, user.id);
  const progress = levelFromXp(xp.xp);
  const activity = userActivity(g, user.id);
  const coins = get<{ balance: number }>('SELECT balance FROM economy WHERE guild_id = ? AND user_id = ?', g, user.id)?.balance ?? 0;
  const streak = get<{ current: number; best: number }>('SELECT current, best FROM streaks WHERE guild_id = ? AND user_id = ?', g, user.id);
  const invites = get<{ n: number }>('SELECT COUNT(*) AS n FROM invites WHERE guild_id = ? AND inviter_id = ? AND fake = 0 AND left_at IS NULL', g, user.id)?.n ?? 0;
  const badges = userBadges(g, user.id);
  const eco = getConfig(g).economy;

  const embed = brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle(`👤 PROFIL DE ${(member?.displayName ?? user.displayName).toUpperCase()}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '⭐ Niveau', value: `${progress.level}${rankOf(g, user.id) ? ` · #${rankOf(g, user.id)}` : ''}`, inline: true },
      { name: '🏆 XP', value: formatNumber(xp.xp), inline: true },
      { name: '📅 Membre depuis', value: member?.joinedTimestamp ? `${daysSince(member.joinedTimestamp)} jours` : '—', inline: true },
      { name: '🎫 Tickets', value: String(ticketCount(g, user.id)), inline: true },
      { name: '🎉 Giveaways gagnés', value: String(winsOf(g, user.id)), inline: true },
      { name: '💬 Messages', value: formatNumber(activity?.messages ?? 0), inline: true },
    );
  if (activity?.voice_seconds) embed.addFields({ name: '🎙️ Vocal', value: formatDuration(activity.voice_seconds * 1000), inline: true });
  if (isModuleEnabled(g, 'economy')) embed.addFields({ name: `${eco.currencyEmoji} ${eco.currencyName}`, value: formatNumber(coins), inline: true });
  if (streak?.current) embed.addFields({ name: '🔥 Série', value: `${streak.current} jour${streak.current > 1 ? 's' : ''} (record ${streak.best})`, inline: true });
  if (isModuleEnabled(g, 'invites')) embed.addFields({ name: '📨 Invitations', value: String(invites), inline: true });
  if (member) embed.addFields({ name: '🛡️ Accès', value: levelLabel(getLevel(member)), inline: true });
  embed.addFields({ name: `🏅 Badges (${badges.length})`, value: badges.length ? truncate(badges.map((b) => `${b.emoji} ${b.name}`).join('\n'), 1024) : '*Aucun badge pour l’instant.*', inline: false });
  if (member?.displayColor) embed.setColor(member.displayColor);
  return embed;
}

const profile: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Le profil communautaire')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async execute(interaction) {
    const user = interaction.options.getUser('membre') ?? interaction.user;
    const member = interaction.options.getMember('membre') ?? (user.id === interaction.user.id ? interaction.member : null);
    await reply(interaction, { embeds: [profileEmbed(interaction.guild, user, member instanceof GuildMember ? member : null)] });
  },
};

const badge: SlashCommand = {
  category: 'community',
  level: PermLevel.MEMBER,
  data: new SlashCommandBuilder()
    .setName('badge')
    .setDescription('Les badges')
    .addSubcommand((s) => s.setName('liste').setDescription('Les badges du serveur'))
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Créer ou modifier un badge')
        .addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji').setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(120)),
    )
    .addSubcommand((s) =>
      s
        .setName('supprimer')
        .setDescription('Supprimer un badge')
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    ),
  subLevels: { donner: PermLevel.STAFF, retirer: PermLevel.STAFF, creer: PermLevel.ADMIN, supprimer: PermLevel.ADMIN },
  async autocomplete(interaction) {
    const focused = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listBadges(interaction.guildId)
        .filter((b) => b.name.toLowerCase().includes(focused) || b.badge_id.includes(focused))
        .slice(0, 25)
        .map((b) => ({ name: `${b.emoji} ${b.name}`.slice(0, 100), value: b.badge_id })),
    );
  },
  async execute(interaction) {
    const g = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    if (sub === 'liste') {
      return reply(interaction, { embeds: [info(interaction.guild, listBadges(g).map((b) => `${b.emoji} **${b.name}** — ${b.description || '—'} \`${b.badge_id}\``).join('\n') || 'Aucun badge.', { titre: 'Badges', sujet: '🏅' })], ephemeral: true });
    }
    if (sub === 'creer') {
      const name = interaction.options.getString('nom', true);
      const id = slugify(name, 32);
      upsertBadge(g, { badge_id: id, name, emoji: interaction.options.getString('emoji', true), description: interaction.options.getString('description') ?? '' });
      return reply(interaction, { embeds: [ok(interaction.guild, `Badge **${name}** enregistré (\`${id}\`).`)], ephemeral: true });
    }
    const badgeId = interaction.options.getString('badge', true);
    const def = getBadge(g, badgeId);
    if (!def) throw new UserError('Badge introuvable.');
    if (sub === 'supprimer') {
      deleteBadge(g, badgeId);
      return reply(interaction, { embeds: [ok(interaction.guild, `Badge **${def.name}** supprimé.`)], ephemeral: true });
    }
    const user = interaction.options.getUser('membre', true);
    const changed = sub === 'donner' ? grantBadge(g, user.id, badgeId, interaction.user.id) : revokeBadge(g, user.id, badgeId);
    return reply(interaction, {
      embeds: [ok(interaction.guild, changed ? `${def.emoji} **${def.name}** ${sub === 'donner' ? 'donné à' : 'retiré à'} <@${user.id}>.` : `Rien n’a changé pour <@${user.id}>.`)],
      ephemeral: true,
    });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'profil',
    aliases: ['profile', 'p'],
    domain: 'general',
    category: 'community',
    description: 'Le profil communautaire',
    usage: '[membre]',
    async execute(message, args) {
      const id = args[0]?.replace(/\D/g, '');
      const member = id ? await message.guild.members.fetch(id).catch(() => null) : message.member;
      const user = member?.user ?? (id ? await message.client.users.fetch(id).catch(() => null) : message.author);
      if (!user) throw new UserError('Membre introuvable.');
      await message.reply({ embeds: [profileEmbed(message.guild, user, member)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const profilesModule: BotModule = {
  id: 'profiles',
  name: 'Profils & badges',
  emoji: '👤',
  description: 'Profil communautaire et badges automatiques ou donnés',
  toggleable: true,
  defaultEnabled: true,
  commands: [profile, badge],
  prefixCommands,
  setupPages: [
    {
      id: 'profiles',
      section: 'community',
      title: 'Profils & badges',
      emoji: '🏅',
      moduleId: 'profiles',
      order: 6,
      description: 'Badges automatiques : 🛡️ Staff, 💎 VIP (booster), 🏆 OG (180 j), ⭐ Actif (niveau 10), 🎉 Giveaway Winner, 🎂 Birthday.',
      fields: [{ kind: 'toggle', key: 'auto', label: 'Badges automatiques', get: (c) => c.profiles.autoBadges, set: (c, v) => void (c.profiles.autoBadges = v) }],
    },
  ],
};
