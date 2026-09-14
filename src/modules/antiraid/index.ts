import { EmbedBuilder, GuildVerificationLevel, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Message } from 'discord.js';
import { colorFor, info, ok } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, recordLog, resolveTextChannel } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isBypassed } from '../../core/permissions';
import { SlidingWindowLimiter } from '../../core/rateLimit';
import type { SetupPage } from '../../core/setup';
import { daysSince, formatDuration, ts } from '../../core/time';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { listMembers } from '../../core/whitelists';
import { isServerLocked, lock } from '../../services/lockdown';

const log = createLogger('antiraid');

const joins = new Map<string, number[]>();
const recentMembers = new Map<string, GuildMember[]>();
const lastAlert = new Map<string, number>();
const mentionLimiter = new Map<string, SlidingWindowLimiter>();
const raidMode = new Map<string, { until: number; previousLevel: GuildVerificationLevel }>();
const RAID_MODE_MS = 30 * 60_000;

function recordJoin(member: GuildMember, windowMs: number): number {
  const now = Date.now();
  const list = (joins.get(member.guild.id) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  joins.set(member.guild.id, list);
  const members = (recentMembers.get(member.guild.id) ?? []).filter((m) => now - (m.joinedTimestamp ?? now) < windowMs).slice(-60);
  members.push(member);
  recentMembers.set(member.guild.id, members);
  return list.length;
}

/** Alerte : salon de sécurité + MP au propriétaire et aux streamers (sans spam : 10 min entre deux alertes). */
async function alert(guild: Guild, title: string, lines: string[]): Promise<void> {
  void journal(guild, 'security', { title, tone: 'alerte', lines });
  if ((lastAlert.get(guild.id) ?? 0) > Date.now()) return;
  lastAlert.set(guild.id, Date.now() + 10 * 60_000);
  const embed = new EmbedBuilder().setColor(colorFor(guild, 'error')).setTitle(`🚨 ${title}`).setDescription(lines.join('\n')).setFooter({ text: guild.name }).setTimestamp();
  const channel = resolveTextChannel(guild, getConfig(guild.id).antiraid.alertChannelId);
  if (channel) await channel.send({ embeds: [embed] }).catch(() => undefined);
  const recipients = new Set([guild.ownerId, ...listMembers('streamer', guild.id)]);
  for (const id of recipients) {
    const user = await guild.client.users.fetch(id).catch(() => null);
    await user?.send({ embeds: [embed] }).catch(() => undefined);
  }
}

/** Mode raid (comme sur Airline) : vérification Discord renforcée pendant 30 min, puis retour au niveau habituel. */
async function enableRaidMode(guild: Guild): Promise<boolean> {
  if (raidMode.has(guild.id)) return false;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return false;
  const previousLevel = guild.verificationLevel;
  if (previousLevel < GuildVerificationLevel.High) {
    await guild.setVerificationLevel(GuildVerificationLevel.High, 'Anti-raid : salve d’arrivées anormale').catch(() => undefined);
  }
  raidMode.set(guild.id, { until: Date.now() + RAID_MODE_MS, previousLevel });
  return true;
}

async function onJoin(member: GuildMember): Promise<'stop' | void> {
  if (member.user.bot) return;
  const guild = member.guild;
  const cfg = getConfig(guild.id).antiraid;
  const count = recordJoin(member, cfg.joinWindowSeconds * 1000);
  const age = daysSince(member.user.createdTimestamp);

  if (cfg.minAccountAgeDays && age < cfg.minAccountAgeDays && cfg.suspiciousAction !== 'none') {
    const reason = `Anti-raid : compte de ${age} jour(s)`;
    if (cfg.suspiciousAction === 'kick' && member.kickable) {
      await member.send({ embeds: [info(guild, `Ton compte est trop récent pour rejoindre **${guild.name}** pour le moment. Réessaie dans quelques jours.`)] }).catch(() => undefined);
      await member.kick(reason).catch(() => undefined);
      void journal(guild, 'security', { title: 'Compte suspect expulsé', tone: 'alerte', lines: [`<@${member.id}> \`${member.user.tag}\` — compte de ${age} j`] });
      return 'stop';
    }
    if (cfg.suspiciousAction === 'timeout' && member.moderatable) {
      await member.timeout(60 * 60_000, reason).catch(() => undefined);
      void journal(guild, 'security', { title: 'Compte suspect en timeout', tone: 'alerte', lines: [`<@${member.id}> \`${member.user.tag}\` — compte de ${age} j (1 h)`] });
    }
  }

  if (count < cfg.joinThreshold) return;
  const recent = recentMembers.get(guild.id) ?? [];
  const young = recent.filter((m) => daysSince(m.user.createdTimestamp) < 7).length;
  const raidEnabled = await enableRaidMode(guild);
  let lockdownText = '';
  if (cfg.autoLockdown && !isServerLocked(guild.id) && guild.members.me) {
    const r = await lock(guild, 'server', guild.id, guild.members.me.user, 'Anti-raid automatique').catch(() => null);
    if (r) lockdownText = `🔒 Lockdown automatique : **${r.locked}** salon(s) fermés (\`/lockdown end\` pour rouvrir).`;
  }
  recordLog(guild.id, 'security', 'raid', null, null, { joins: count, young });
  await alert(guild, 'Anti-raid — arrivées massives', [
    `**${count}** arrivées en **${cfg.joinWindowSeconds} s** (seuil : ${cfg.joinThreshold}).`,
    `Comptes de moins de 7 jours : **${young}**`,
    raidEnabled ? `🛡️ Niveau de vérification monté à « Élevé » pendant ${formatDuration(RAID_MODE_MS)}.` : '',
    lockdownText,
    '',
    `Derniers arrivés : ${recent.slice(-10).map((m) => `<@${m.id}>`).join(' ')}`,
  ].filter(Boolean));
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member || isBypassed(message.member)) return;
  const cfg = getConfig(message.guildId).antiraid;
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  if (!mentions || !cfg.mentionThreshold) return;
  const key = `${message.guildId}:${cfg.mentionThreshold}`;
  let limiter = mentionLimiter.get(key);
  if (!limiter) mentionLimiter.set(key, (limiter = new SlidingWindowLimiter(cfg.mentionThreshold, 30_000)));
  let blocked = false;
  for (let i = 0; i < mentions; i++) if (!limiter.hit(message.author.id)) blocked = true;
  if (!blocked) return;
  limiter.reset(message.author.id);
  await message.delete().catch(() => undefined);
  if (message.member.moderatable) await message.member.timeout(30 * 60_000, 'Anti-raid : mentions massives').catch(() => undefined);
  await alert(message.guild, 'Anti-raid — mentions massives', [`<@${message.author.id}> a mentionné plus de **${cfg.mentionThreshold}** personnes/rôles en 30 s.`, 'Message supprimé et membre mis en timeout 30 min.']);
}

const antiraid: SlashCommand = {
  category: 'moderation',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Protection contre les raids')
    .addSubcommand((s) => s.setName('status').setDescription('État de la protection'))
    .addSubcommand((s) => s.setName('panique').setDescription('Mode raid immédiat : vérification élevée et lockdown'))
    .addSubcommand((s) => s.setName('fin').setDescription('Terminer le mode raid')),
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'panique') {
      await interaction.deferReply({ flags: 64 });
      await enableRaidMode(guild);
      const r = isServerLocked(guild.id) ? null : await lock(guild, 'server', guild.id, interaction.user, 'Mode panique anti-raid').catch(() => null);
      return interaction.editReply({ embeds: [ok(guild, `🚨 Mode raid activé : vérification élevée${r ? `, **${r.locked}** salon(s) verrouillés` : ''}.\n-# \`/antiraid fin\` puis \`/lockdown end portee:Serveur\` pour revenir à la normale.`)] });
    }
    if (sub === 'fin') {
      const state = raidMode.get(guild.id);
      if (state) {
        await guild.setVerificationLevel(state.previousLevel, 'Fin du mode raid').catch(() => undefined);
        raidMode.delete(guild.id);
      }
      return reply(interaction, { embeds: [ok(guild, state ? 'Mode raid terminé, vérification remise à son niveau habituel.' : 'Aucun mode raid en cours.')], ephemeral: true });
    }
    const cfg = getConfig(guild.id).antiraid;
    const state = raidMode.get(guild.id);
    return reply(interaction, {
      embeds: [
        info(
          guild,
          [
            `• Seuil — **${cfg.joinThreshold}** arrivées en **${cfg.joinWindowSeconds} s**`,
            `• Comptes suspects — moins de **${cfg.minAccountAgeDays} j** → ${cfg.suspiciousAction === 'none' ? 'rien' : cfg.suspiciousAction}`,
            `• Lockdown automatique — **${cfg.autoLockdown ? 'oui' : 'non'}**`,
            `• Mentions massives — **${cfg.mentionThreshold}** en 30 s`,
            `• Mode raid — ${state ? `actif jusqu’à ${ts(state.until, 'R')}` : 'inactif'}`,
            `• Lockdown serveur — ${isServerLocked(guild.id) ? '🔒 en cours' : 'non'}`,
          ].join('\n'),
          { titre: 'Anti-raid', sujet: '🚨' },
        ),
      ],
      ephemeral: true,
    });
  },
};

const setupPage: SetupPage = {
  id: 'antiraid',
  section: 'security',
  title: 'Anti-raid',
  emoji: '🚨',
  moduleId: 'antiraid',
  order: 3,
  description: 'Arrivées massives → alerte (salon + MP au propriétaire et aux streamers), vérification Discord renforcée 30 min, lockdown en option.',
  fields: [
    { kind: 'channel', key: 'alert', label: 'Salon d’alerte (en plus de securite-log)', get: (c) => c.antiraid.alertChannelId, set: (c, v) => void (c.antiraid.alertChannelId = v) },
    {
      kind: 'choice',
      key: 'suspicious',
      label: 'Comptes trop récents',
      options: [
        { value: 'none', label: 'Ne rien faire (alerte seulement)', emoji: '👀' },
        { value: 'timeout', label: 'Timeout 1 h', emoji: '⏳' },
        { value: 'kick', label: 'Expulser', emoji: '👢' },
      ],
      get: (c) => c.antiraid.suspiciousAction,
      set: (c, v) => void (c.antiraid.suspiciousAction = v as 'none' | 'timeout' | 'kick'),
    },
    { kind: 'toggle', key: 'lock', label: 'Lockdown automatique', get: (c) => c.antiraid.autoLockdown, set: (c, v) => void (c.antiraid.autoLockdown = v) },
    { kind: 'number', key: 'threshold', label: 'Arrivées déclenchant l’alerte', min: 3, max: 500, get: (c) => c.antiraid.joinThreshold, set: (c, v) => void (c.antiraid.joinThreshold = v) },
    { kind: 'number', key: 'window', label: 'Fenêtre', min: 5, max: 3600, unit: 's', get: (c) => c.antiraid.joinWindowSeconds, set: (c, v) => void (c.antiraid.joinWindowSeconds = v) },
    { kind: 'number', key: 'age', label: 'Compte suspect si moins de', min: 0, max: 365, unit: 'j', get: (c) => c.antiraid.minAccountAgeDays, set: (c, v) => void (c.antiraid.minAccountAgeDays = v) },
    { kind: 'number', key: 'mentions', label: 'Mentions max en 30 s', min: 5, max: 500, get: (c) => c.antiraid.mentionThreshold, set: (c, v) => void (c.antiraid.mentionThreshold = v) },
  ],
};

export const antiraidModule: BotModule = {
  id: 'antiraid',
  name: 'Anti-raid',
  emoji: '🚨',
  description: 'Arrivées massives, comptes suspects, mentions massives',
  toggleable: true,
  defaultEnabled: true,
  commands: [antiraid],
  setupPages: [setupPage],
  events: [on('guildMemberAdd', (m) => onJoin(m), 2), on('messageCreate', (m) => onMessage(m), 11)],
  tasks: [
    {
      name: 'antiraid-restore',
      intervalMs: 60_000,
      async run(client) {
        for (const [guildId, state] of raidMode) {
          if (state.until > Date.now()) continue;
          raidMode.delete(guildId);
          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;
          await guild.setVerificationLevel(state.previousLevel, 'Anti-raid : retour au niveau habituel').catch(() => undefined);
          void journal(guild, 'security', { title: 'Anti-raid — retour à la normale', tone: 'ok', lines: ['Le niveau de vérification est revenu à son réglage habituel.'] });
          log.info(`Mode raid terminé sur ${guildId}`);
        }
      },
    },
  ],
};
