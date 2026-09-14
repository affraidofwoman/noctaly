import {
  ChannelType,
  GuildMember,
  SlashCommandBuilder,
  version as djsVersion,
  type Guild,
  type User,
} from 'discord.js';
import { botState } from '../../core/bot';
import { brandEmbed, brandName, info } from '../../core/embeds';
import { reply } from '../../core/interactions';
import { getLevel, levelLabel } from '../../core/permissions';
import { resolveUser, targetMember } from '../../core/resolve';
import { formatNumber, truncate } from '../../core/text';
import { formatDuration, ts } from '../../core/time';
import { trashRow } from '../../core/trash';
import { on, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { flushVoice, handleVoiceState, resyncVoice } from '../../services/voice';
import { userWhitelists } from '../../core/whitelists';
import { helpHome, onHelpSelect } from './help';

function userInfoEmbed(guild: Guild, user: User, member: GuildMember | null) {
  const embed = brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle(`👤 ${member?.displayName ?? user.displayName}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Utilisateur', value: `${user}\n\`${user.id}\``, inline: true },
      { name: 'Compte créé', value: `${ts(user.createdTimestamp, 'D')}\n${ts(user.createdTimestamp, 'R')}`, inline: true },
    );
  if (member) {
    const roles = member.roles.cache
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.toString());
    const wls = userWhitelists(user.id, guild.id);
    embed.addFields(
      { name: 'Arrivée', value: member.joinedTimestamp ? `${ts(member.joinedTimestamp, 'D')}\n${ts(member.joinedTimestamp, 'R')}` : '—', inline: true },
      { name: 'Accès bot', value: levelLabel(getLevel(member)), inline: true },
      { name: 'Whitelists', value: wls.length ? wls.map((w) => `${w.emoji} ${w.label}`).join(' · ') : '—', inline: true },
      { name: 'Booster', value: member.premiumSinceTimestamp ? `depuis ${ts(member.premiumSinceTimestamp, 'R')}` : 'Non', inline: true },
      { name: `Rôles (${roles.length})`, value: roles.length ? truncate(roles.join(' '), 1024) : '—', inline: false },
    );
    if (member.displayColor) embed.setColor(member.displayColor);
  }
  if (user.bot) embed.setDescription('🤖 Ce compte est un bot.');
  const banner = user.bannerURL({ size: 1024 });
  if (banner) embed.setImage(banner);
  return embed;
}

function serverInfoEmbed(guild: Guild) {
  const channels = guild.channels.cache;
  const text = channels.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).size;
  const voice = channels.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).size;
  return brandEmbed(guild)
    .setTitle(`🏠 ${guild.name}`)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .setImage(guild.bannerURL({ size: 1024 }))
    .addFields(
      { name: 'Propriétaire', value: `<@${guild.ownerId}>`, inline: true },
      { name: 'Enseigne', value: brandName(guild), inline: true },
      { name: 'Création', value: ts(guild.createdTimestamp, 'D'), inline: true },
      { name: 'Membres', value: formatNumber(guild.memberCount), inline: true },
      { name: 'Salons', value: `${text} textuels · ${voice} vocaux`, inline: true },
      { name: 'Rôles', value: String(guild.roles.cache.size - 1), inline: true },
      { name: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0} (niveau ${guild.premiumTier})`, inline: true },
      { name: 'Émojis', value: String(guild.emojis.cache.size), inline: true },
      { name: 'ID', value: `\`${guild.id}\``, inline: true },
    );
}

async function imageEmbed(guild: Guild, user: User, member: GuildMember | null, kind: 'avatar' | 'banner') {
  if (kind === 'banner') {
    const full = await user.fetch(true).catch(() => user);
    const url = full.bannerURL({ size: 2048 });
    if (!url) return info(guild, `**${user.displayName}** n’a pas de bannière.`);
    return brandEmbed(guild).setTitle(`Bannière de ${user.displayName}`).setURL(url).setImage(url);
  }
  const globalUrl = user.displayAvatarURL({ size: 2048 });
  const serverUrl = member?.avatarURL({ size: 2048 }) ?? null;
  return brandEmbed(guild)
    .setTitle(`Photo de profil de ${user.displayName}`)
    .setURL(serverUrl ?? globalUrl)
    .setImage(serverUrl ?? globalUrl)
    .setDescription([`[Globale](${globalUrl})`, serverUrl ? `[Serveur](${serverUrl})` : null].filter(Boolean).join(' · '));
}

const help: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder().setName('help').setDescription('Tes commandes'),
  async execute(interaction) {
    await reply(interaction, helpHome(interaction.member));
  },
};

const ping: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder().setName('ping').setDescription('La latence du bot'),
  async execute(interaction) {
    const ws = interaction.client.ws.ping;
    const embed = brandEmbed(interaction.guild)
      .setTitle('🏓 Pong')
      .setDescription(
        [`• Latence — **${ws >= 0 ? `${ws} ms` : '—'}**`, `• En ligne depuis — **${formatDuration(Date.now() - botState.startedAt)}**`].join('\n'),
      );
    await reply(interaction, { embeds: [embed], ephemeral: true });
  },
};

const avatar: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Photo de profil ou bannière')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addStringOption((o) =>
      o.setName('type').setDescription('Quoi').addChoices({ name: 'Photo de profil', value: 'avatar' }, { name: 'Bannière', value: 'banner' }),
    ),
  async execute(interaction) {
    const user = interaction.options.getUser('membre') ?? interaction.user;
    const member = interaction.options.getMember('membre') ?? (user.id === interaction.user.id ? interaction.member : null);
    const kind = (interaction.options.getString('type') ?? 'avatar') as 'avatar' | 'banner';
    const embed = await imageEmbed(interaction.guild, user, member instanceof GuildMember ? member : null, kind);
    await reply(interaction, { embeds: [embed], components: [trashRow(interaction.guildId, interaction.user.id)] });
  },
};

const userinfo: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Fiche d’un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async execute(interaction) {
    const user = await (interaction.options.getUser('membre') ?? interaction.user).fetch();
    const member = interaction.options.getMember('membre') ?? (user.id === interaction.user.id ? interaction.member : null);
    await reply(interaction, {
      embeds: [userInfoEmbed(interaction.guild, user, member instanceof GuildMember ? member : null)],
      components: [trashRow(interaction.guildId, interaction.user.id)],
    });
  },
};

const serverinfo: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Fiche du serveur'),
  async execute(interaction) {
    await reply(interaction, { embeds: [serverInfoEmbed(interaction.guild)], components: [trashRow(interaction.guildId, interaction.user.id)] });
  },
};

const botinfo: SlashCommand = {
  category: 'general',
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Le bot en chiffres'),
  async execute(interaction) {
    const client = interaction.client;
    const mem = process.memoryUsage();
    const embed = brandEmbed(interaction.guild)
      .setTitle('🤖 Le bot')
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription(
        [
          `• Serveurs — **${formatNumber(client.guilds.cache.size)}**`,
          `• En ligne depuis — **${formatDuration(Date.now() - botState.startedAt)}**`,
          `• Latence — **${client.ws.ping} ms**`,
          `• Mémoire — **${Math.round(mem.rss / 1024 / 1024)} Mo**`,
          `• Node.js — **${process.version}** · discord.js **v${djsVersion}**`,
        ].join('\n'),
      );
    await reply(interaction, { embeds: [embed], ephemeral: true });
  },
};

async function prefixUser(message: import('discord.js').Message<true>, arg: string | undefined) {
  const member = await targetMember(message, arg);
  if (member) return { user: member.user, member };
  const user = (await resolveUser(message.client, arg)) ?? message.author;
  const fallbackMember = user.id === message.author.id ? message.member : null;
  return { user, member: fallbackMember };
}

const prefixCommands: PrefixCommand[] = [
  {
    name: 'help',
    domain: 'general',
    category: 'general',
    description: 'Tes commandes',
    async execute(message) {
      if (!message.member) return;
      await message.reply({ ...helpHome(message.member), allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'ui',
    aliases: ['userinfo'],
    domain: 'general',
    category: 'general',
    description: 'Fiche d’un membre',
    usage: '[membre]',
    async execute(message, args) {
      const { user, member } = await prefixUser(message, args[0]);
      await message.reply({ embeds: [userInfoEmbed(message.guild, user, member)], components: [trashRow(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'si',
    aliases: ['serverinfo'],
    domain: 'general',
    category: 'general',
    description: 'Fiche du serveur',
    async execute(message) {
      await message.reply({ embeds: [serverInfoEmbed(message.guild)], components: [trashRow(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'pic',
    aliases: ['avatar', 'pp'],
    domain: 'sanction',
    category: 'general',
    description: 'Photo de profil',
    usage: '[membre]',
    async execute(message, args) {
      const { user, member } = await prefixUser(message, args[0]);
      await message.reply({ embeds: [await imageEmbed(message.guild, user, member, 'avatar')], components: [trashRow(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'banner',
    domain: 'sanction',
    category: 'general',
    description: 'Bannière',
    usage: '[membre]',
    async execute(message, args) {
      const { user, member } = await prefixUser(message, args[0]);
      await message.reply({ embeds: [await imageEmbed(message.guild, user, member, 'banner')], components: [trashRow(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'ping',
    domain: 'general',
    category: 'general',
    description: 'La latence du bot',
    async execute(message) {
      await message.reply({ embeds: [info(message.guild, `Pong — **${message.client.ws.ping} ms**`)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const generalModule: BotModule = {
  id: 'general',
  name: 'Général',
  emoji: '📌',
  description: 'Aide, fiches et informations',
  toggleable: false,
  defaultEnabled: true,
  commands: [help, ping, avatar, userinfo, serverinfo, botinfo],
  prefixCommands,
  components: [
    {
      prefix: 'help',
      async select(interaction, [, ownerId]) {
        await onHelpSelect(interaction, ownerId);
      },
    },
  ],
  // Suivi vocal commun : XP, statistiques et quêtes s'y abonnent chacun de leur côté.
  events: [on('voiceStateUpdate', (before, after) => handleVoiceState(before, after), 5)],
  tasks: [
    {
      name: 'voice-flush',
      intervalMs: 5 * 60_000,
      async run(client) {
        flushVoice(client);
      },
    },
  ],
  async onReady(client) {
    resyncVoice(client);
  },
};
