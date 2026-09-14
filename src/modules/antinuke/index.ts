import { AuditLogEvent, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildAuditLogsEntry } from 'discord.js';
import { colorFor, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig, updateConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, recordLog } from '../../core/logService';
import { createLogger } from '../../core/logger';
import type { SetupPage } from '../../core/setup';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { isBotOwner, listMembers } from '../../core/whitelists';

const log = createLogger('antinuke');

type Counter = 'channelDelete' | 'channelCreate' | 'roleDelete' | 'roleCreate' | 'ban' | 'kick' | 'webhookCreate';

const ACTIONS: Partial<Record<AuditLogEvent, { counter: Counter; label: string }>> = {
  [AuditLogEvent.ChannelDelete]: { counter: 'channelDelete', label: 'suppressions de salons' },
  [AuditLogEvent.ChannelCreate]: { counter: 'channelCreate', label: 'créations de salons' },
  [AuditLogEvent.RoleDelete]: { counter: 'roleDelete', label: 'suppressions de rôles' },
  [AuditLogEvent.RoleCreate]: { counter: 'roleCreate', label: 'créations de rôles' },
  [AuditLogEvent.MemberBanAdd]: { counter: 'ban', label: 'bannissements' },
  [AuditLogEvent.MemberKick]: { counter: 'kick', label: 'expulsions' },
  [AuditLogEvent.WebhookCreate]: { counter: 'webhookCreate', label: 'créations de webhooks' },
};

const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
];

const history = new Map<string, number[]>();
const punished = new Map<string, number>();

function isTrusted(guild: Guild, userId: string): boolean {
  if (userId === guild.ownerId || userId === guild.members.me?.id || isBotOwner(userId)) return true;
  const cfg = getConfig(guild.id).antinuke;
  return cfg.trustedUsers.includes(userId) || listMembers('streamer', guild.id).includes(userId);
}

/** Enregistre une action ; retourne le nombre d'actions du même type dans la fenêtre. */
export function countAction(key: string, windowMs: number, now = Date.now()): number {
  const list = (history.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  history.set(key, list);
  return list.length;
}

async function neutralize(guild: Guild, executorId: string, reason: string): Promise<string> {
  const cfg = getConfig(guild.id).antinuke;
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return 'compte introuvable';
  if (cfg.action === 'alert') return 'alerte seulement';
  const me = guild.members.me!;
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) return 'impossible : son rôle est au-dessus du mien';
  if (member.user.bot && cfg.action !== 'ban') {
    await member.kick(reason).catch(() => undefined);
    return 'bot expulsé';
  }
  if (cfg.action === 'ban') {
    await member.ban({ reason }).catch(() => undefined);
    return 'banni';
  }
  if (cfg.action === 'kick') {
    await member.kick(reason).catch(() => undefined);
    return 'expulsé';
  }
  const roles = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && DANGEROUS.some((p) => r.permissions.has(p)) && me.roles.highest.comparePositionTo(r) > 0);
  if (roles.size) await member.roles.remove([...roles.keys()], reason).catch(() => undefined);
  return `rôles dangereux retirés (${roles.size})`;
}

async function onAudit(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  const def = ACTIONS[entry.action];
  const executorId = entry.executorId;
  if (!def || !executorId || isTrusted(guild, executorId)) return;
  const cfg = getConfig(guild.id).antinuke;
  const threshold = cfg.thresholds[def.counter];
  if (!threshold) return;
  const count = countAction(`${guild.id}:${executorId}:${def.counter}`, cfg.windowSeconds * 1000);
  if (count < threshold) return;
  const key = `${guild.id}:${executorId}`;
  if ((punished.get(key) ?? 0) > Date.now()) return;
  punished.set(key, Date.now() + 5 * 60_000);

  const outcome = await neutralize(guild, executorId, `Anti-nuke : ${count} ${def.label} en ${cfg.windowSeconds} s`);
  recordLog(guild.id, 'security', 'nuke', executorId, null, { counter: def.counter, count, outcome });
  const lines = [`**Compte** : <@${executorId}> \`${executorId}\``, `**Détecté** : ${count} ${def.label} en ${cfg.windowSeconds} s (seuil ${threshold})`, `**Réaction** : ${outcome}`];
  void journal(guild, 'security', { title: 'Anti-nuke déclenché', tone: 'alerte', lines });
  log.warn(`Anti-nuke sur ${guild.id} : ${executorId} — ${def.counter} ×${count} → ${outcome}`);
  const embed = new EmbedBuilder().setColor(colorFor(guild, 'error')).setTitle('💥 Anti-nuke déclenché').setDescription(lines.join('\n')).setFooter({ text: guild.name }).setTimestamp();
  for (const id of new Set([guild.ownerId, ...listMembers('streamer', guild.id)])) {
    const user = await guild.client.users.fetch(id).catch(() => null);
    await user?.send({ embeds: [embed] }).catch(() => undefined);
  }
}

const antinuke: SlashCommand = {
  category: 'moderation',
  level: PermLevel.STREAMER,
  data: new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Protection contre les comptes compromis')
    .addSubcommand((s) => s.setName('status').setDescription('Seuils et réaction'))
    .addSubcommand((s) =>
      s
        .setName('confiance')
        .setDescription('Ajouter ou retirer un compte de confiance')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    ),
  async execute(interaction) {
    const guild = interaction.guild;
    if (interaction.options.getSubcommand() === 'confiance') {
      const user = interaction.options.getUser('membre', true);
      if (user.bot && user.id === interaction.client.user.id) throw new UserError('Le bot est toujours de confiance.');
      let added = false;
      updateConfig(guild.id, (c) => {
        const list = c.antinuke.trustedUsers;
        if (list.includes(user.id)) c.antinuke.trustedUsers = list.filter((id) => id !== user.id);
        else {
          list.push(user.id);
          added = true;
        }
      });
      return reply(interaction, { embeds: [ok(guild, `<@${user.id}> ${added ? 'ajouté aux' : 'retiré des'} comptes de confiance.`)], ephemeral: true });
    }
    const cfg = getConfig(guild.id).antinuke;
    return reply(interaction, {
      embeds: [
        info(
          guild,
          [
            `Fenêtre : **${cfg.windowSeconds} s** · réaction : **${cfg.action}**`,
            '',
            ...Object.values(ACTIONS).map((a) => `• ${a!.label} — seuil **${cfg.thresholds[a!.counter]}**`),
            '',
            `Comptes de confiance : ${cfg.trustedUsers.map((id) => `<@${id}>`).join(' ') || '*aucun*'} (+ propriétaire, streamers, owners bot)`,
          ].join('\n'),
          { titre: 'Anti-nuke', sujet: '💥' },
        ),
      ],
      ephemeral: true,
    });
  },
};

const counterField = (counter: Counter, label: string) => ({
  kind: 'number' as const,
  key: counter,
  label,
  min: 1,
  max: 100,
  get: (c: import('../../core/guildConfig').GuildConfig) => c.antinuke.thresholds[counter],
  set: (c: import('../../core/guildConfig').GuildConfig, v: number) => void (c.antinuke.thresholds[counter] = v),
});

const setupPage: SetupPage = {
  id: 'antinuke',
  section: 'security',
  title: 'Anti-nuke',
  emoji: '💥',
  moduleId: 'antinuke',
  order: 4,
  description: 'Surveille le journal d’audit : un compte qui supprime ou crée en masse est neutralisé.\n-# Il me faut « Voir les logs du serveur » et un rôle au-dessus des rôles du staff.',
  fields: [
    {
      kind: 'choice',
      key: 'action',
      label: 'Réaction',
      options: [
        { value: 'alert', label: 'Alerter seulement', emoji: '📣' },
        { value: 'strip', label: 'Retirer ses rôles dangereux', emoji: '🧯' },
        { value: 'kick', label: 'Expulser', emoji: '👢' },
        { value: 'ban', label: 'Bannir', emoji: '🔨' },
      ],
      get: (c) => c.antinuke.action,
      set: (c, v) => void (c.antinuke.action = v as 'alert' | 'strip' | 'kick' | 'ban'),
    },
    counterField('channelDelete', 'Suppressions de salons'),
    counterField('roleDelete', 'Suppressions de rôles'),
    counterField('ban', 'Bannissements'),
    counterField('channelCreate', 'Créations de salons'),
    { kind: 'number', key: 'window', label: 'Fenêtre', min: 5, max: 600, unit: 's', get: (c) => c.antinuke.windowSeconds, set: (c, v) => void (c.antinuke.windowSeconds = v) },
  ],
};

export const antinukeModule: BotModule = {
  id: 'antinuke',
  name: 'Anti-nuke',
  emoji: '💥',
  description: 'Suppressions, créations et bans en masse d’un compte compromis',
  toggleable: true,
  defaultEnabled: true,
  commands: [antinuke],
  setupPages: [setupPage],
  events: [on('guildAuditLogEntryCreate', (entry, guild) => onAudit(entry, guild), 1)],
};
