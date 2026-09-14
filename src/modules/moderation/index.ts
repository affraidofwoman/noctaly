import {
  ButtonStyle,
  ChannelType,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Collection,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type User,
} from 'discord.js';
import { get, run } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { askConfirmation } from '../../core/confirm';
import { brandEmbed, erreur, info, ok, refus } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { reply } from '../../core/interactions';
import { journal, recordLog } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { linesToPages, paginate } from '../../core/pagination';
import { hasLevel } from '../../core/permissions';
import { resolveUser, targetMember } from '../../core/resolve';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { formatDuration, parseDuration, ts } from '../../core/time';
import { button, row } from '../../core/ui';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { activeLocks, lock, unlock, type LockScope } from '../../services/lockdown';
import {
  activeWarnings,
  applySanction,
  blacklistEntries,
  describeResult,
  formatAutoActions,
  isBlacklisted,
  MAX_TIMEOUT_MS,
  parseAutoActions,
  type SanctionType,
} from '../../services/moderation';

const log = createLogger('moderation');

async function sanctionReply(interaction: ChatInputCommandInteraction<'cached'>, type: SanctionType, target: User, reason: string | null, durationMs?: number, warningId?: number) {
  await interaction.deferReply();
  const result = await applySanction({ guild: interaction.guild, actor: interaction.member, target, type, reason, durationMs, warningId });
  await interaction.editReply({ embeds: [ok(interaction.guild, describeResult(result), { titre: 'Sanction', sujet: emojiFor(interaction.guildId, 'sanction') })] });
}

async function sanctionMessage(message: Message<true>, type: SanctionType, target: User, reason: string | null, durationMs?: number, warningId?: number) {
  if (!message.member) return;
  const result = await applySanction({ guild: message.guild, actor: message.member, target, type, reason, durationMs, warningId });
  await message.reply({ embeds: [ok(message.guild, describeResult(result), { titre: 'Sanction', sujet: emojiFor(message.guildId, 'sanction') })], allowedMentions: { repliedUser: false } });
}

function warningsPages(guild: Guild, user: User) {
  const list = activeWarnings(guild.id, user.id);
  const lines = list.map((w, i) => `**${i + 1}.** \`n°${w.id}\` ${ts(w.created_at, 'd')} — ${truncate(w.reason, 120)}\n-# par <@${w.moderator_id}>`);
  if (!lines.length) lines.push('*Aucun avertissement actif.*');
  return linesToPages(lines, 8, (content, page, total) =>
    brandEmbed(guild)
      .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
      .setTitle(`⚠️ Avertissements — ${list.length}`)
      .setDescription(content)
      .setFooter({ text: `Page ${page}/${total} · /unwarn pour en retirer un` }),
  );
}

// ─── Nettoyage ─────────────────────────────────────────────────────────────

async function clearMessages(channel: GuildTextBasedChannel, amount: number, filterUserId: string | null, actor: User): Promise<number> {
  const max = Math.min(Math.max(amount, 1), 1000);
  let deleted = 0;
  let before: string | undefined;
  const cutoff = Date.now() - 14 * 86_400_000 + 60_000;
  while (deleted < max) {
    const batch: Collection<string, Message> = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    before = batch.last()?.id;
    const candidates = batch.filter((m) => m.createdTimestamp > cutoff && !m.pinned && (!filterUserId || m.author.id === filterUserId));
    const toDelete = [...candidates.values()].slice(0, max - deleted);
    if (toDelete.length) {
      const removed = await channel.bulkDelete(toDelete, true);
      deleted += removed.size;
    }
    if (batch.size < 100 || batch.last()!.createdTimestamp < cutoff) break;
  }
  recordLog(channel.guild.id, 'clear', 'clear', filterUserId, actor.id, { channelId: channel.id, deleted });
  void journal(channel.guild, 'clear', {
    title: 'Salon nettoyé',
    tone: 'alerte',
    lines: [`**Salon** : <#${channel.id}>`, `**Messages supprimés** : ${deleted}`, filterUserId ? `**Filtre** : <@${filterUserId}>` : null],
    by: actor,
  });
  return deleted;
}

// ─── Commandes slash ───────────────────────────────────────────────────────

const reasonOpt = (o: import('discord.js').SlashCommandStringOption) => o.setName('raison').setDescription('Pourquoi').setMaxLength(400);

const warn: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => reasonOpt(o).setRequired(true)),
  async execute(i) {
    await sanctionReply(i, 'warn', i.options.getUser('membre', true), i.options.getString('raison', true));
  },
};

const unwarn: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Retirer un avertissement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addIntegerOption((o) => o.setName('numero').setDescription('Numéro du warn (le dernier par défaut)').setMinValue(1))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    await sanctionReply(i, 'unwarn', i.options.getUser('membre', true), i.options.getString('raison'), undefined, i.options.getInteger('numero') ?? undefined);
  },
};

const warnings: SlashCommand = {
  category: 'moderation',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Les avertissements d’un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
  async execute(i) {
    await paginate(i, warningsPages(i.guild, i.options.getUser('membre', true)), true);
  },
};

const timeout: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Rendre muet temporairement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 10m, 2h, 1j (28 j max)').setRequired(true))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    const duration = parseDuration(i.options.getString('duree', true));
    if (!duration || duration > MAX_TIMEOUT_MS) throw new UserError('Durée invalide : exemples `10m`, `2h`, `1j` (28 jours maximum).');
    await sanctionReply(i, 'timeout', i.options.getUser('membre', true), i.options.getString('raison'), duration);
  },
};

const untimeout: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Lever un timeout')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    await sanctionReply(i, 'untimeout', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const kick: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulser un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    await sanctionReply(i, 'kick', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const ban: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un compte')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (même hors du serveur)').setRequired(true))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    await sanctionReply(i, 'ban', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const unban: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un compte')
    .addStringOption((o) => o.setName('id').setDescription('Identifiant Discord').setRequired(true))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    const user = await resolveUser(i.client, i.options.getString('id', true));
    if (!user) throw new UserError('Identifiant Discord attendu.');
    await sanctionReply(i, 'unban', user, i.options.getString('raison'));
  },
};

const blacklist: SlashCommand = {
  category: 'moderation',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Blacklist du serveur (re-ban automatique)')
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Blacklister un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant ou mention').setRequired(true))
        .addStringOption((o) => reasonOpt(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer de la blacklist')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Détail d’un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('La blacklist')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'liste') return paginate(i, blacklistPages(i.guild), true);
    const user = await resolveUser(i.client, i.options.getString('id', true));
    if (!user) throw new UserError('Identifiant Discord attendu.');
    if (sub === 'info') return reply(i, { embeds: [blacklistInfo(i.guild, user)], ephemeral: true });
    return sanctionReply(i, sub === 'ajouter' ? 'blacklist' : 'unblacklist', user, i.options.getString('raison'));
  },
};

function blacklistPages(guild: Guild) {
  const local = blacklistEntries(guild.id);
  const lines = local.map((b) => `• <@${b.user_id}> \`${b.user_id}\` — ${truncate(b.reason, 80)}\n-# ${ts(b.added_at, 'd')} par <@${b.added_by}>`);
  if (!lines.length) lines.push('*La blacklist est vide.*');
  return linesToPages(lines, 10, (content, page, total) =>
    brandEmbed(guild).setTitle(`⛔ Blacklist (${local.length})`).setDescription(content).setFooter({ text: `Page ${page}/${total}` }),
  );
}

function blacklistInfo(guild: Guild, user: User) {
  const entry = isBlacklisted(guild.id, user.id);
  if (!entry) return info(guild, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiFor(guild.id, 'sanction') });
  return info(
    guild,
    [
      `**Compte** — ${user.tag} (\`${user.id}\`)`,
      `**Raison** — ${entry.reason}`,
      `**Par** — <@${entry.added_by}>`,
      `**Le** — ${ts(entry.added_at, 'f')}`,
      `-# ${entry.scope === 'global' ? 'Blacklist globale : tous les serveurs du bot' : 'Blacklist de ce serveur'}`,
    ].join('\n'),
    { titre: 'Sanction', sujet: emojiFor(guild.id, 'sanction') },
  );
}

const clear: SlashCommand = {
  category: 'salons',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Effacer des messages')
    .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (1 à 1000)').setMinValue(1).setMaxValue(1000).setRequired(true))
    .addUserOption((o) => o.setName('membre').setDescription('Seulement ses messages')),
  async execute(i) {
    if (!i.channel) return;
    await i.deferReply({ flags: 64 });
    const deleted = await clearMessages(i.channel, i.options.getInteger('nombre', true), i.options.getUser('membre')?.id ?? null, i.user);
    await i.editReply({ embeds: [ok(i.guild, `**${deleted}** message(s) supprimé(s).\n-# Les messages de plus de 14 jours et épinglés sont conservés.`)] });
  },
};

const slowmode: SlashCommand = {
  category: 'salons',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Mode lent du salon')
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 5s, 1m, 0 pour couper (6 h max)').setRequired(true))
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)),
  async execute(i) {
    const raw = i.options.getString('duree', true).trim();
    const seconds = raw === '0' ? 0 : Math.round((parseDuration(/^\d+$/.test(raw) ? `${raw}s` : raw) ?? -1000) / 1000);
    if (seconds < 0 || seconds > 21_600) throw new UserError('Durée invalide : de `0` à `6h`.');
    const channel = (i.options.getChannel('salon') ?? i.channel) as GuildTextBasedChannel | null;
    if (!channel || !('setRateLimitPerUser' in channel)) throw new UserError('Ce salon ne gère pas le mode lent.');
    await channel.setRateLimitPerUser(seconds, `Mode lent par ${i.user.tag}`);
    void journal(i.guild, 'channel', { title: 'Mode lent', tone: 'info', lines: [`**Salon** : <#${channel.id}>`, `**Délai** : ${seconds ? formatDuration(seconds * 1000) : 'coupé'}`], by: i.user });
    await reply(i, { embeds: [ok(i.guild, seconds ? `Mode lent de **${formatDuration(seconds * 1000)}** sur <#${channel.id}>.` : `Mode lent coupé sur <#${channel.id}>.`)], ephemeral: true });
  },
};

const lockCommand: SlashCommand = {
  category: 'salons',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Fermer un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)'))
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    const channel = i.options.getChannel('salon') ?? i.channel;
    if (!channel) return;
    const r = await lock(i.guild, 'channel', channel.id, i.user, i.options.getString('raison') ?? 'Aucune raison');
    await reply(i, { embeds: [ok(i.guild, `🔒 <#${channel.id}> fermé (${r.locked} salon).`)] });
  },
};

const unlockCommand: SlashCommand = {
  category: 'salons',
  level: PermLevel.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Rouvrir un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)')),
  async execute(i) {
    const channel = i.options.getChannel('salon') ?? i.channel;
    if (!channel) return;
    await unlock(i.guild, 'channel', channel.id, i.user);
    await reply(i, { embeds: [ok(i.guild, `🔓 <#${channel.id}> rouvert.`)] });
  },
};

const lockdown: SlashCommand = {
  category: 'salons',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Bloquer les messages des membres')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé').addChannelTypes(ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice))
        .addStringOption((o) => reasonOpt(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Terminer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé')),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Les verrouillages en cours')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'status') {
      const locks = activeLocks(i.guildId);
      const lines = locks.map((l) => `• ${l.scope === 'server' ? '**Serveur entier**' : `<#${l.target_id}>`} — ${ts(l.created_at, 'R')}${l.reason ? ` · ${truncate(l.reason, 60)}` : ''}`);
      return reply(i, { embeds: [info(i.guild, lines.join('\n') || 'Aucun verrouillage en cours.', { titre: 'Lockdown', sujet: '🔒' })], ephemeral: true });
    }
    const scope = i.options.getString('portee', true) as LockScope;
    const target = scope === 'server' ? i.guildId : (i.options.getChannel('cible')?.id ?? i.channelId);
    const reason = i.options.getString('raison') ?? 'Aucune raison';
    const where = scope === 'server' ? 'tout le serveur' : `<#${target}>`;
    if (sub === 'end') {
      const restored = await unlock(i.guild, scope, target, i.user);
      return reply(i, { embeds: [ok(i.guild, `🔓 Lockdown terminé sur ${where} — **${restored}** salon(s) rouvert(s).`)] });
    }
    return askConfirmation(i, {
      title: '🔒 LOCKDOWN',
      description: `Les membres ne pourront plus écrire sur ${where}.\nLes permissions d’origine seront restaurées avec \`/lockdown end\`.`,
      confirmLabel: 'Verrouiller',
      onConfirm: async (b) => {
        await b.update({ embeds: [info(b.guild, 'Verrouillage en cours…')], components: [] });
        const r = await lock(b.guild, scope, target, b.user, reason);
        await b.editReply({ embeds: [ok(b.guild, `🔒 **${r.locked}** salon(s) verrouillé(s) sur ${where}.${r.skipped ? `\n-# ${r.skipped} ignoré(s) (déjà fermés ou inaccessibles).` : ''}`)] });
        if (b.channel && 'send' in b.channel) {
          await b.channel.send({ embeds: [refus(b.guild, `**LOCKDOWN** — ${reason}\nLes messages sont temporairement bloqués.`)] }).catch(() => undefined);
        }
      },
    });
  },
};

// ─── Commandes à préfixe (façon Airline) ───────────────────────────────────

async function needTarget(message: Message<true>, arg: string | undefined): Promise<User> {
  const member = await targetMember(message, arg);
  if (member) return member.user;
  const user = await resolveUser(message.client, arg);
  if (!user) throw new UserError('Mention ou identifiant Discord attendu.');
  return user;
}

const prefixCommands: PrefixCommand[] = [
  {
    name: 'ban',
    domain: 'sanction',
    category: 'moderation',
    description: 'Bannit / débannit',
    usage: '<membre|id> [raison]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      const banned = await message.guild.bans.fetch(user.id).catch(() => null);
      await sanctionMessage(message, banned ? 'unban' : 'ban', user, args.slice(1).join(' ') || null);
    },
  },
  {
    name: 'kick',
    domain: 'sanction',
    category: 'moderation',
    description: 'Expulse',
    usage: '<membre> [raison]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      await sanctionMessage(message, 'kick', await needTarget(message, args[0]), args.slice(1).join(' ') || null);
    },
  },
  {
    name: 'mute',
    aliases: ['timeout', 'to'],
    domain: 'sanction',
    category: 'moderation',
    description: 'Timeout',
    usage: '<membre> <durée> [raison]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      const duration = parseDuration(args[1] ?? '');
      if (!duration || duration > MAX_TIMEOUT_MS) throw new UserError('Durée attendue : `10m`, `2h`, `1j`…');
      await sanctionMessage(message, 'timeout', user, args.slice(2).join(' ') || null, duration);
    },
  },
  {
    name: 'unmute',
    aliases: ['untimeout'],
    domain: 'sanction',
    category: 'moderation',
    description: 'Lève un timeout',
    usage: '<membre>',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      await sanctionMessage(message, 'untimeout', await needTarget(message, args[0]), args.slice(1).join(' ') || null);
    },
  },
  {
    name: 'warn',
    domain: 'sanction',
    category: 'moderation',
    description: 'Avertit',
    usage: '<membre> <raison>',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      const reason = args.slice(1).join(' ');
      if (!reason) throw new UserError('Une raison est attendue.');
      await sanctionMessage(message, 'warn', user, reason);
    },
  },
  {
    name: 'unwarn',
    domain: 'sanction',
    category: 'moderation',
    description: 'Retire un warn',
    usage: '<membre> [numéro]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      await sanctionMessage(message, 'unwarn', user, null, undefined, args[1] ? Number(args[1]) || undefined : undefined);
    },
  },
  {
    name: 'warns',
    aliases: ['warnings'],
    domain: 'sanction',
    category: 'moderation',
    description: 'Les warns d’un membre',
    usage: '<membre>',
    level: PermLevel.STAFF,
    async execute(message, args) {
      const pages = warningsPages(message.guild, await needTarget(message, args[0]));
      await message.reply({ embeds: [pages[0]!], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'baninfo',
    domain: 'sanction',
    category: 'moderation',
    description: 'Détail d’un ban',
    usage: '<id>',
    level: PermLevel.STAFF,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      const ban = await message.guild.bans.fetch(user.id).catch(() => null);
      const last = get<{ actor_id: string; data: string; created_at: number }>(
        "SELECT actor_id, data, created_at FROM logs WHERE guild_id = ? AND user_id = ? AND type IN ('ban','blacklist') ORDER BY created_at DESC LIMIT 1",
        message.guildId,
        user.id,
      );
      const embed = ban
        ? info(
            message.guild,
            [
              `**Compte** — ${user.tag} (\`${user.id}\`)`,
              `**Raison** — ${ban.reason ?? '*aucune raison enregistrée*'}`,
              last ? `**Par** — <@${last.actor_id}>` : null,
              last ? `**Le** — ${ts(last.created_at, 'f')}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            { titre: 'Sanction', sujet: emojiFor(message.guildId, 'sanction') },
          )
        : info(message.guild, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiFor(message.guildId, 'sanction') });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'unbanall',
    domain: 'sanction',
    category: 'moderation',
    description: 'Débannit tout',
    level: PermLevel.STREAMER,
    async execute(message) {
      const bans = await message.guild.bans.fetch();
      const blacklisted = new Set(blacklistEntries(message.guildId).map((b) => b.user_id));
      const count = bans.filter((b) => !blacklisted.has(b.user.id)).size;
      await message.reply({
        embeds: [info(message.guild, `Débannir **${count}** compte(s) ?\n-# Les comptes blacklistés restent bannis.`, { titre: 'Confirmation', sujet: '⚠️' })],
        components: [row(button(`modconf:unbanall:${message.author.id}`, 'Tout débannir', ButtonStyle.Danger, '🕊️'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    name: 'clear',
    domain: 'salon',
    category: 'salons',
    description: 'Efface',
    usage: '[n] [membre]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const n = Number(args[0] ?? 50);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UserError('Nombre entre 1 et 1000.');
      const target = args[1] ? await needTarget(message, args[1]) : null;
      await message.delete().catch(() => undefined);
      const deleted = await clearMessages(message.channel, n, target?.id ?? null, message.author);
      const note = await message.channel.send({ embeds: [ok(message.guild, `**${deleted}** message(s) supprimé(s).`)] });
      setTimeout(() => void note.delete().catch(() => undefined), 5_000).unref();
    },
  },
  {
    name: 'lock',
    domain: 'salon',
    category: 'salons',
    description: 'Ce salon',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      await lock(message.guild, 'channel', message.channelId, message.author, args.join(' ') || 'Aucune raison');
      await message.reply({ embeds: [ok(message.guild, '🔒 Salon fermé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'unlock',
    domain: 'salon',
    category: 'salons',
    description: 'Ce salon',
    level: PermLevel.MODERATOR,
    async execute(message) {
      await unlock(message.guild, 'channel', message.channelId, message.author);
      await message.reply({ embeds: [ok(message.guild, '🔓 Salon rouvert.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'l0all',
    aliases: ['lockall'],
    domain: 'salon',
    category: 'salons',
    description: 'Tout le serveur',
    level: PermLevel.ADMIN,
    async execute(message, args) {
      await message.reply({
        embeds: [info(message.guild, 'Verrouiller **tout le serveur** ?\n-# `&unl0all` pour tout rouvrir.', { titre: 'LOCKDOWN', sujet: '🔒' })],
        components: [row(button(`modconf:lockall:${message.author.id}:${encodeURIComponent(args.join(' ').slice(0, 60))}`, 'Verrouiller', ButtonStyle.Danger, '🔒'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    name: 'unl0all',
    aliases: ['unlockall'],
    domain: 'salon',
    category: 'salons',
    description: 'Rouvre tout le serveur',
    level: PermLevel.ADMIN,
    async execute(message) {
      const restored = await unlock(message.guild, 'server', message.guildId, message.author);
      await message.reply({ embeds: [ok(message.guild, `🔓 **${restored}** salon(s) rouvert(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'slowmode',
    aliases: ['slow'],
    domain: 'salon',
    category: 'salons',
    description: 'Mode lent',
    usage: '<durée|0>',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const raw = args[0] ?? '0';
      const seconds = raw === '0' ? 0 : Math.round((parseDuration(/^\d+$/.test(raw) ? `${raw}s` : raw) ?? -1000) / 1000);
      if (seconds < 0 || seconds > 21_600 || !('setRateLimitPerUser' in message.channel)) throw new UserError('Durée de `0` à `6h`.');
      await message.channel.setRateLimitPerUser(seconds, `Mode lent par ${message.author.tag}`);
      await message.reply({ embeds: [ok(message.guild, seconds ? `Mode lent : **${formatDuration(seconds * 1000)}**.` : 'Mode lent coupé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'bl',
    domain: 'salon',
    category: 'moderation',
    description: 'Blacklist (seul : liste)',
    usage: '[id] [raison]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      if (!args[0]) {
        await message.reply({ embeds: [blacklistPages(message.guild)[0]!], allowedMentions: { repliedUser: false } });
        return;
      }
      await sanctionMessage(message, 'blacklist', await needTarget(message, args[0]), args.slice(1).join(' ') || null);
    },
  },
  {
    name: 'unbl',
    domain: 'salon',
    category: 'moderation',
    description: 'Retire de la blacklist',
    usage: '<id>',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      await sanctionMessage(message, 'unblacklist', await needTarget(message, args[0]), null);
    },
  },
  {
    name: 'blinfo',
    domain: 'salon',
    category: 'moderation',
    description: 'Détail blacklist',
    usage: '<id>',
    level: PermLevel.STAFF,
    async execute(message, args) {
      await message.reply({ embeds: [blacklistInfo(message.guild, await needTarget(message, args[0]))], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'gbl',
    domain: 'owner',
    category: 'owner',
    description: 'Blacklist globale (seul : liste)',
    usage: '[id] [raison]',
    level: PermLevel.BOT_OWNER,
    async execute(message, args) {
      if (!args[0]) {
        const lines = blacklistEntries('global').map((b) => `• <@${b.user_id}> \`${b.user_id}\` — ${truncate(b.reason, 80)}`);
        await message.reply({ embeds: [info(message.guild, truncate(lines.join('\n') || 'Vide.', 4000), { titre: 'Blacklist globale', sujet: '⛔' })], allowedMentions: { repliedUser: false } });
        return;
      }
      const user = await needTarget(message, args[0]);
      const reason = args.slice(1).join(' ') || 'Aucune raison';
      run(
        `INSERT INTO blacklist (scope, user_id, reason, added_by, added_at) VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(scope, user_id) DO UPDATE SET reason = excluded.reason`,
        user.id,
        reason,
        message.author.id,
        Date.now(),
      );
      let banned = 0;
      for (const guild of message.client.guilds.cache.values()) {
        const ok2 = await guild.members.ban(user.id, { reason: `Blacklist globale : ${reason}`.slice(0, 500) }).then(() => true).catch(() => false);
        if (ok2) {
          banned++;
          recordLog(guild.id, 'blacklist', 'global', user.id, message.author.id, { reason });
          void journal(guild, 'blacklist', { title: 'Blacklist globale', tone: 'alerte', lines: [`**Cible** : <@${user.id}> \`${user.id}\``, `**Raison** : ${reason}`], by: message.author });
        }
      }
      await message.reply({ embeds: [ok(message.guild, `<@${user.id}> blacklisté partout — banni de **${banned}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'ungbl',
    domain: 'owner',
    category: 'owner',
    description: 'Retire de la blacklist globale',
    usage: '<id>',
    level: PermLevel.BOT_OWNER,
    async execute(message, args) {
      const user = await needTarget(message, args[0]);
      const r = run("DELETE FROM blacklist WHERE scope = 'global' AND user_id = ?", user.id);
      if (!r.changes) throw new UserError('Ce compte n’est pas dans la blacklist globale.');
      let unbanned = 0;
      for (const guild of message.client.guilds.cache.values()) {
        if (isBlacklisted(guild.id, user.id)) continue;
        if (await guild.bans.remove(user.id, 'Retrait de la blacklist globale').then(() => true).catch(() => false)) unbanned++;
      }
      await message.reply({ embeds: [ok(message.guild, `<@${user.id}> retiré de la blacklist globale — débanni de **${unbanned}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
];

async function onModConfirm(interaction: ButtonInteraction<'cached'>, [action, ownerId, extra]: string[]) {
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ embeds: [erreur(interaction.guild, 'Seul l’auteur de la commande peut confirmer.')], flags: 64 });
    return;
  }
  if (action === 'lockall') {
    await interaction.update({ embeds: [info(interaction.guild, 'Verrouillage en cours…')], components: [] });
    const r = await lock(interaction.guild, 'server', interaction.guildId, interaction.user, decodeURIComponent(extra ?? '') || 'Aucune raison');
    await interaction.editReply({ embeds: [ok(interaction.guild, `🔒 **${r.locked}** salon(s) verrouillé(s).`)] });
    return;
  }
  if (action === 'unbanall') {
    if (!hasLevel(interaction.member, PermLevel.STREAMER)) throw new UserError('Accès Streamer requis.');
    await interaction.update({ embeds: [info(interaction.guild, 'Débannissement en cours…')], components: [] });
    const bans = await interaction.guild.bans.fetch();
    const blacklisted = new Set(blacklistEntries(interaction.guildId).map((b) => b.user_id));
    let done = 0;
    for (const b of bans.values()) {
      if (blacklisted.has(b.user.id) || isBlacklisted(interaction.guildId, b.user.id)) continue;
      if (await interaction.guild.bans.remove(b.user.id, `+unbanall par ${interaction.user.tag}`).then(() => true).catch(() => false)) done++;
    }
    recordLog(interaction.guildId, 'sanction', 'unbanall', null, interaction.user.id, { count: done });
    void journal(interaction.guild, 'sanction', { title: 'Débannissement général', tone: 'ok', lines: [`**Comptes débannis** : ${done}`], by: interaction.user });
    await interaction.editReply({ embeds: [ok(interaction.guild, `🕊️ **${done}** compte(s) débanni(s).`)] });
  }
}

const setupPage: SetupPage = {
  id: 'moderation',
  section: 'moderation',
  title: 'Sanctions',
  emoji: '🛡️',
  moduleId: 'moderation',
  order: 1,
  description: 'Avertissements, actions automatiques et messages privés de sanction.\n-# Actions automatiques : `3:timeout:60, 5:kick, 7:ban` (nombre de warns : action : minutes).',
  fields: [
    { kind: 'toggle', key: 'dm', label: 'Prévenir en MP', get: (c) => c.moderation.dmOnAction, set: (c, v) => void (c.moderation.dmOnAction = v) },
    {
      kind: 'text',
      key: 'auto',
      label: 'Actions automatiques',
      maxLength: 200,
      get: (c) => formatAutoActions(c.moderation.autoActions),
      set: (c, v) => void (c.moderation.autoActions = parseAutoActions(v) ?? c.moderation.autoActions),
      validate: (v) => (parseAutoActions(v) ? null : 'Format attendu : `3:timeout:60, 5:kick, 7:ban`.'),
    },
    { kind: 'text', key: 'contact', label: 'Phrase de contact (MP)', long: true, maxLength: 300, get: (c) => c.moderation.contactText, set: (c, v) => void (c.moderation.contactText = v) },
    { kind: 'number', key: 'timeout', label: 'Timeout par défaut', min: 1, max: 40_320, unit: 'min', get: (c) => c.moderation.defaultTimeoutMinutes, set: (c, v) => void (c.moderation.defaultTimeoutMinutes = v) },
    { kind: 'number', key: 'bandelete', label: 'Messages effacés au ban', min: 0, max: 168, unit: 'h', get: (c) => c.moderation.banDeleteHours, set: (c, v) => void (c.moderation.banDeleteHours = v) },
  ],
};

export const moderationModule: BotModule = {
  id: 'moderation',
  name: 'Modération',
  emoji: '🛡️',
  description: 'Warns, timeouts, bans, blacklist, lock et lockdown',
  toggleable: true,
  defaultEnabled: true,
  commands: [warn, unwarn, warnings, timeout, untimeout, kick, ban, unban, blacklist, clear, slowmode, lockCommand, unlockCommand, lockdown],
  prefixCommands,
  setupPages: [setupPage],
  components: [{ prefix: 'modconf', level: PermLevel.MODERATOR, button: (i, args) => onModConfirm(i, args) }],
  events: [
    // Blacklist : re-ban immédiat, avant tout accueil.
    on('guildMemberAdd', async (member: GuildMember) => {
      const entry = isBlacklisted(member.guild.id, member.id);
      if (!entry) return;
      try {
        await member.ban({ reason: `Blacklist${entry.scope === 'global' ? ' globale' : ''} : tentative de retour (${entry.reason})`.slice(0, 500) });
        void journal(member.guild, 'blacklist', {
          title: 'Retour bloqué',
          tone: 'alerte',
          lines: [`**Compte** : <@${member.id}> \`${member.id}\``, `**Blacklist** : ${entry.scope === 'global' ? 'globale' : 'serveur'}`, `**Raison** : ${entry.reason}`],
        });
        return 'stop';
      } catch (err) {
        log.warn(`Re-ban impossible de ${member.id} : ${(err as Error).message}`);
      }
    }, 1),
  ],
};
