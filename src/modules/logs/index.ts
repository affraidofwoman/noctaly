import {
  AttachmentBuilder,
  AuditLogEvent,
  SlashCommandBuilder,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type VoiceState,
} from 'discord.js';
import { all, parseJson } from '../../database/db';
import { brandEmbed, ok } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { ensureLogChannels, journal, LOG_TYPES, logDefinition, type LogType } from '../../core/logService';
import { linesToPages, paginate } from '../../core/pagination';
import { formatNumber, truncate } from '../../core/text';
import { daysSince, formatDuration, ts } from '../../core/time';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';

function ignored(guild: Guild, channelId: string | null | undefined): boolean {
  return !!channelId && getConfig(guild.id).logs.ignoredChannels.includes(channelId);
}

function quote(text: string | null | undefined, max = 1000): string {
  if (!text) return '*vide*';
  return truncate(text.replace(/```/g, 'ˋˋˋ'), max);
}

// ─── Membres ───────────────────────────────────────────────────────────────

async function onJoin(member: GuildMember) {
  const age = daysSince(member.user.createdTimestamp);
  await journal(member.guild, 'member', {
    title: member.user.bot ? 'Bot ajouté' : 'Arrivée',
    tone: 'ok',
    thumbnail: member.user.displayAvatarURL({ size: 128 }),
    lines: [
      `**Membre** : <@${member.id}> \`${member.user.tag}\``,
      `**Compte créé** : ${ts(member.user.createdTimestamp, 'D')} (${ts(member.user.createdTimestamp, 'R')})${age < 7 ? ' ⚠️ **compte récent**' : ''}`,
      `**Membres** : ${formatNumber(member.guild.memberCount)}`,
    ],
  });
}

async function onLeave(member: GuildMember | PartialGuildMember) {
  const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`) ?? [];
  await journal(member.guild, 'member', {
    title: 'Départ',
    tone: 'alerte',
    thumbnail: member.user?.displayAvatarURL({ size: 128 }),
    lines: [
      `**Membre** : <@${member.id}> \`${member.user?.tag ?? member.id}\``,
      member.joinedTimestamp ? `**Resté** : ${formatDuration(Date.now() - member.joinedTimestamp)}` : null,
      roles.length ? `**Rôles** : ${truncate(roles.join(' '), 900)}` : null,
      `**Membres** : ${formatNumber(member.guild.memberCount)}`,
    ],
  });
}

// ─── Messages ──────────────────────────────────────────────────────────────

async function onMessageDelete(message: Message | PartialMessage) {
  if (!message.guild || message.author?.bot || ignored(message.guild, message.channelId)) return;
  if (message.partial && !message.content) {
    await journal(message.guild, 'message', {
      title: 'Message supprimé',
      tone: 'alerte',
      lines: [`**Salon** : <#${message.channelId}>`, '*Contenu inconnu (message trop ancien pour être en mémoire).*'],
    });
    return;
  }
  const attachments = [...message.attachments.values()].map((a) => `[${a.name}](${a.url})`);
  await journal(message.guild, 'message', {
    title: 'Message supprimé',
    tone: 'alerte',
    lines: [
      `**Auteur** : <@${message.author?.id}> \`${message.author?.tag}\``,
      `**Salon** : <#${message.channelId}>`,
      `**Envoyé** : ${ts(message.createdTimestamp, 'R')}`,
      '',
      quote(message.content, 3000),
      attachments.length ? `\n**Pièces jointes** : ${attachments.join(' · ')}` : null,
    ],
  });
}

async function onMessageUpdate(before: Message | PartialMessage, after: Message | PartialMessage) {
  if (!after.guild || after.author?.bot || ignored(after.guild, after.channelId)) return;
  if (before.content === after.content || !after.content) return;
  await journal(after.guild, 'message', {
    title: 'Message modifié',
    tone: 'info',
    lines: [`**Auteur** : <@${after.author?.id}> \`${after.author?.tag}\``, `**Salon** : <#${after.channelId}> · [aller au message](${after.url})`],
    fields: [
      { name: 'Avant', value: before.partial ? '*inconnu*' : quote(before.content), inline: false },
      { name: 'Après', value: quote(after.content), inline: false },
    ],
  });
}

async function onBulkDelete(messages: Map<string, Message | PartialMessage>, channelId: string, guild: Guild) {
  if (ignored(guild, channelId)) return;
  const list = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const dump = list
    .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.tag ?? 'inconnu'} : ${m.content ?? ''}${m.attachments.size ? ` [${m.attachments.size} pièce(s) jointe(s)]` : ''}`)
    .join('\n');
  await journal(guild, 'clear', {
    title: 'Suppression en masse',
    tone: 'alerte',
    lines: [`**Salon** : <#${channelId}>`, `**Messages** : ${list.length}`],
    files: dump ? [new AttachmentBuilder(Buffer.from(dump, 'utf8'), { name: `suppression-${channelId}.txt` })] : [],
  });
}

// ─── Vocal ─────────────────────────────────────────────────────────────────

async function onVoice(before: VoiceState, after: VoiceState) {
  const member = after.member ?? before.member;
  if (!member || member.user.bot) return;
  const guild = after.guild;
  if (before.channelId === after.channelId) return;
  if (!before.channelId && after.channelId) {
    await journal(guild, 'voice', { title: 'Connexion vocale', tone: 'ok', lines: [`<@${member.id}> a rejoint <#${after.channelId}>`] });
  } else if (before.channelId && !after.channelId) {
    await journal(guild, 'voice', { title: 'Déconnexion vocale', tone: 'alerte', lines: [`<@${member.id}> a quitté <#${before.channelId}>`] });
  } else {
    await journal(guild, 'voice', { title: 'Déplacement vocal', tone: 'info', lines: [`<@${member.id}> : <#${before.channelId}> → <#${after.channelId}>`] });
  }
}

// ─── Journal d'audit (avec l'auteur de l'action) ───────────────────────────

type Change = { key: string; old?: unknown; new?: unknown };

function describeChanges(changes: Change[]): string[] {
  const labels: Record<string, string> = {
    name: 'Nom',
    topic: 'Sujet',
    nsfw: 'NSFW',
    rate_limit_per_user: 'Mode lent',
    color: 'Couleur',
    hoist: 'Affiché séparément',
    mentionable: 'Mentionnable',
    permissions: 'Permissions',
    bitrate: 'Débit',
    user_limit: 'Limite',
    parent_id: 'Catégorie',
    nick: 'Pseudo',
  };
  return changes
    .filter((c) => labels[c.key])
    .map((c) => `• ${labels[c.key]} — \`${truncate(String(c.old ?? '—'), 80)}\` → \`${truncate(String(c.new ?? '—'), 80)}\``);
}

async function onAudit(entry: GuildAuditLogsEntry, guild: Guild) {
  const executorId = entry.executorId;
  // Les actions du bot sont déjà journalisées par les modules concernés, avec plus de détails.
  if (executorId && executorId === guild.members.me?.id) return;
  const by = executorId ? `<@${executorId}>` : '*inconnu*';
  const executor = executorId ? (guild.client.users.cache.get(executorId) ?? null) : null;
  const target = entry.targetId;
  const reason = entry.reason ? `**Raison** : ${truncate(entry.reason, 500)}` : null;
  const changes = (entry.changes ?? []) as Change[];
  const send = (type: LogType, title: string, tone: 'ok' | 'alerte' | 'info' | 'neutre', lines: (string | null)[]) =>
    journal(guild, type, { title, tone, lines: [...lines, `**Par** : ${by}`, reason], by: executor });

  switch (entry.action) {
    case AuditLogEvent.ChannelCreate:
      return send('channel', 'Salon créé', 'ok', [`**Salon** : <#${target}> \`${changes.find((c) => c.key === 'name')?.new ?? ''}\``]);
    case AuditLogEvent.ChannelDelete:
      return send('channel', 'Salon supprimé', 'alerte', [`**Salon** : \`#${changes.find((c) => c.key === 'name')?.old ?? target}\``]);
    case AuditLogEvent.ChannelUpdate: {
      const lines = describeChanges(changes);
      if (!lines.length) return;
      return send('channel', 'Salon modifié', 'info', [`**Salon** : <#${target}>`, ...lines]);
    }
    case AuditLogEvent.ChannelOverwriteCreate:
    case AuditLogEvent.ChannelOverwriteUpdate:
    case AuditLogEvent.ChannelOverwriteDelete:
      return send('channel', 'Permissions de salon modifiées', 'info', [`**Salon** : <#${target}>`]);
    case AuditLogEvent.RoleCreate:
      return send('role', 'Rôle créé', 'ok', [`**Rôle** : <@&${target}> \`${changes.find((c) => c.key === 'name')?.new ?? ''}\``]);
    case AuditLogEvent.RoleDelete:
      return send('role', 'Rôle supprimé', 'alerte', [`**Rôle** : \`@${changes.find((c) => c.key === 'name')?.old ?? target}\``]);
    case AuditLogEvent.RoleUpdate: {
      const lines = describeChanges(changes);
      if (!lines.length) return;
      return send('role', 'Rôle modifié', 'info', [`**Rôle** : <@&${target}>`, ...lines]);
    }
    case AuditLogEvent.MemberRoleUpdate: {
      const added = (changes.find((c) => c.key === '$add')?.new as { id: string }[] | undefined) ?? [];
      const removed = (changes.find((c) => c.key === '$remove')?.new as { id: string }[] | undefined) ?? [];
      return send('role', 'Rôles modifiés', added.length && !removed.length ? 'ok' : 'info', [
        `**Membre** : <@${target}>`,
        added.length ? `**Donnés** : ${added.map((r) => `<@&${r.id}>`).join(' ')}` : null,
        removed.length ? `**Retirés** : ${removed.map((r) => `<@&${r.id}>`).join(' ')}` : null,
      ]);
    }
    case AuditLogEvent.MemberUpdate: {
      const timeout = changes.find((c) => c.key === 'communication_disabled_until');
      if (timeout) {
        const until = timeout.new ? Date.parse(String(timeout.new)) : null;
        return send('sanction', until ? 'Timeout (manuel)' : 'Timeout retiré (manuel)', until ? 'alerte' : 'ok', [
          `**Membre** : <@${target}>`,
          until ? `**Jusqu’à** : ${ts(until, 'f')}` : null,
        ]);
      }
      const nick = changes.find((c) => c.key === 'nick');
      if (nick) return send('member', 'Pseudo modifié', 'info', [`**Membre** : <@${target}>`, ...describeChanges([nick])]);
      return;
    }
    case AuditLogEvent.MemberBanAdd:
      return send('sanction', 'Bannissement (manuel)', 'alerte', [`**Membre** : <@${target}> \`${target}\``]);
    case AuditLogEvent.MemberBanRemove:
      return send('sanction', 'Débannissement (manuel)', 'ok', [`**Membre** : <@${target}> \`${target}\``]);
    case AuditLogEvent.MemberKick:
      return send('sanction', 'Expulsion (manuelle)', 'alerte', [`**Membre** : <@${target}> \`${target}\``]);
    case AuditLogEvent.GuildUpdate: {
      const lines = describeChanges(changes);
      if (!lines.length) return;
      return send('channel', 'Serveur modifié', 'info', lines);
    }
    default:
      return;
  }
}

// ─── Commandes ─────────────────────────────────────────────────────────────

interface LogRow {
  category: string;
  type: string;
  user_id: string | null;
  actor_id: string | null;
  data: string;
  created_at: number;
}

function historyPages(guild: Guild, userId: string | null, type: string | null) {
  const rows = all<LogRow>(
    `SELECT category, type, user_id, actor_id, data, created_at FROM logs
     WHERE guild_id = ? AND (? IS NULL OR user_id = ? OR actor_id = ?) AND (? IS NULL OR category = ?)
     ORDER BY created_at DESC LIMIT 500`,
    guild.id,
    userId,
    userId,
    userId,
    type,
    type,
  );
  const lines = rows.map((r) => {
    const data = parseJson<Record<string, unknown>>(r.data, {});
    const detail = typeof data.reason === 'string' ? ` — ${truncate(data.reason, 60)}` : typeof data.list === 'string' ? ` — ${data.list}` : '';
    return `${ts(r.created_at, 'd')} \`${r.category}·${r.type}\`${r.user_id ? ` <@${r.user_id}>` : ''}${r.actor_id ? ` par <@${r.actor_id}>` : ''}${detail}`;
  });
  if (!lines.length) lines.push('*Rien d’enregistré.*');
  return linesToPages(lines, 15, (content, page, total) =>
    brandEmbed(guild)
      .setTitle(`🔎 Historique${userId ? '' : ' du serveur'}`)
      .setDescription(`${userId ? `<@${userId}>\n` : ''}${content}`)
      .setFooter({ text: `Page ${page}/${total} · ${rows.length} entrée(s)` }),
  );
}

const logsCommand: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  whitelist: 'logs',
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('L’historique du serveur')
    .addSubcommand((s) =>
      s
        .setName('voir')
        .setDescription('L’historique (sanctions, whitelists, tickets…)')
        .addUserOption((o) => o.setName('membre').setDescription('Une personne'))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Un type')
            .addChoices(...LOG_TYPES.slice(0, 25).map((t) => ({ name: `${t.name} — ${truncate(t.description, 60)}`, value: t.type }))),
        ),
    )
    .addSubcommand((s) => s.setName('salons').setDescription('Créer les salons de logs manquants')),
  subLevels: { salons: PermLevel.ADMIN },
  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'salons') {
      await interaction.deferReply({ flags: 64 });
      const { created, linked } = await ensureLogChannels(interaction.guild);
      await interaction.editReply({ embeds: [ok(interaction.guild, `**${created}** créé(s), **${linked}** déjà présent(s).`, { titre: 'Salons de logs' })] });
      return;
    }
    const user = interaction.options.getUser('membre');
    const type = interaction.options.getString('type');
    await paginate(interaction, historyPages(interaction.guild, user?.id ?? null, type), true);
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'logs',
    domain: 'general',
    category: 'admin',
    description: 'L’historique (seul : tout le serveur)',
    usage: '[membre]',
    level: PermLevel.ADMIN,
    whitelist: 'logs',
    async execute(message, args) {
      const id = args[0]?.replace(/\D/g, '') || null;
      const pages = historyPages(message.guild, id, null);
      await message.reply({ embeds: [pages[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

export const logsModule: BotModule = {
  id: 'logs',
  name: 'Logs',
  emoji: '📜',
  description: 'Un salon par type de log, avec l’auteur de chaque action',
  toggleable: true,
  defaultEnabled: true,
  commands: [logsCommand],
  prefixCommands,
  events: [
    on('guildMemberAdd', (m) => onJoin(m), 200),
    on('guildMemberRemove', (m) => onLeave(m), 200),
    on('messageDelete', (m) => onMessageDelete(m), 200),
    on('messageUpdate', (a, b) => onMessageUpdate(a, b), 200),
    on('messageDeleteBulk', (messages, channel) => {
      return onBulkDelete(messages as unknown as Map<string, Message | PartialMessage>, channel.id, channel.guild);
    }, 200),
    on('voiceStateUpdate', (a, b) => onVoice(a, b), 200),
    on('guildAuditLogEntryCreate', (entry, guild) => onAudit(entry, guild), 200),
  ],
  tests: [
    {
      id: 'all',
      label: 'Écrire dans chaque salon',
      emoji: '📜',
      description: 'Un message de test par type de log',
      async run(interaction) {
        const results: string[] = [];
        for (const t of LOG_TYPES) {
          const sent = await journal(interaction.guild, t.type, { title: 'Test des logs', tone: 'info', lines: [logDefinition(t.type).description], by: interaction.user });
          results.push(`${sent ? '✅' : '❌'} \`${t.name}\``);
        }
        return results.join(' · ');
      },
    },
  ],
};
