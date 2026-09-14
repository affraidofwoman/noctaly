import { PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type User } from 'discord.js';
import { all, get, run } from '../../database/db';
import { brandEmbed } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import { linesToPages, paginate } from '../../core/pagination';
import type { SetupPage } from '../../core/setup';
import { medal } from '../../core/text';
import { daysSince } from '../../core/time';
import { on, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';

const log = createLogger('invitations');

/** Nombre d'utilisations connu par code, par serveur. */
const snapshots = new Map<string, Map<string, { uses: number; inviterId: string | null }>>();

async function snapshot(guild: Guild): Promise<Map<string, { uses: number; inviterId: string | null }> | null> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  const map = new Map<string, { uses: number; inviterId: string | null }>();
  for (const inv of invites.values()) map.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviterId });
  if (guild.vanityURLCode) {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity) map.set(`vanity:${vanity.code}`, { uses: vanity.uses, inviterId: null });
  }
  return map;
}

function counts(guildId: string, userId: string): { total: number; valid: number; fake: number; left: number } {
  const r = get<{ total: number; fake: number; left: number }>(
    'SELECT COUNT(*) AS total, SUM(fake) AS fake, SUM(CASE WHEN left_at IS NOT NULL AND fake = 0 THEN 1 ELSE 0 END) AS left FROM invites WHERE guild_id = ? AND inviter_id = ?',
    guildId,
    userId,
  );
  const total = r?.total ?? 0;
  const fake = r?.fake ?? 0;
  const left = r?.left ?? 0;
  return { total, valid: total - fake - left, fake, left };
}

async function onJoin(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const guild = member.guild;
  const before = snapshots.get(guild.id);
  const after = await snapshot(guild);
  if (!after) return;
  snapshots.set(guild.id, after);
  let code: string | null = null;
  let inviterId: string | null = null;
  if (before) {
    for (const [c, data] of after) {
      if (data.uses > (before.get(c)?.uses ?? 0)) {
        code = c;
        inviterId = data.inviterId;
        break;
      }
    }
    // Invitation à usage unique supprimée après utilisation.
    if (!code) {
      const vanished = [...before.entries()].filter(([c]) => !after.has(c));
      if (vanished.length === 1) {
        code = vanished[0]![0];
        inviterId = vanished[0]![1].inviterId;
      }
    }
  }
  const fake = daysSince(member.user.createdTimestamp) < getConfig(guild.id).invites.fakeAccountDays || inviterId === member.id ? 1 : 0;
  run(
    `INSERT INTO invites (guild_id, invited_id, inviter_id, code, joined_at, fake) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, invited_id) DO UPDATE SET inviter_id = excluded.inviter_id, code = excluded.code, joined_at = excluded.joined_at, left_at = NULL, fake = excluded.fake`,
    guild.id,
    member.id,
    inviterId,
    code,
    Date.now(),
    fake,
  );
  const text = code?.startsWith('vanity:')
    ? `<@${member.id}> a rejoint via le lien personnalisé **${code.slice(7)}**.`
    : inviterId
      ? `<@${member.id}> a été invité par <@${inviterId}> (\`${code}\`) — **${counts(guild.id, inviterId).valid}** invitation(s) valides.`
      : `<@${member.id}> a rejoint, invitation inconnue.`;
  void journal(guild, 'invite', { title: 'Invitation utilisée', tone: fake ? 'alerte' : 'ok', lines: [text, fake ? '⚠️ Compte récent : compté comme **fake**.' : null] });
  const channel = resolveTextChannel(guild, getConfig(guild.id).invites.channelId);
  if (channel) await channel.send({ content: `📨 ${text}`, allowedMentions: { parse: [] } }).catch(() => undefined);
}

function invitesEmbed(guild: Guild, user: User) {
  const c = counts(guild.id, user.id);
  return brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle('📨 INVITATIONS')
    .setDescription([`• Invitations — **${c.total}**`, `• Validées — **${c.valid}**`, `• Fake / parties — **${c.fake + c.left}**`, `-# ${c.fake} fake · ${c.left} parti(s)`].join('\n'));
}

function leaderboardPages(guild: Guild) {
  const rows = all<{ inviter_id: string; valid: number }>(
    'SELECT inviter_id, SUM(CASE WHEN fake = 0 AND left_at IS NULL THEN 1 ELSE 0 END) AS valid FROM invites WHERE guild_id = ? AND inviter_id IS NOT NULL GROUP BY inviter_id HAVING valid > 0 ORDER BY valid DESC LIMIT 100',
    guild.id,
  );
  const lines = rows.map((r, i) => `${medal(i + 1)} <@${r.inviter_id}> — **${r.valid}** invitation(s)`);
  if (!lines.length) lines.push('*Aucune invitation suivie pour l’instant.*');
  return linesToPages(lines, 10, (content, page, total) => brandEmbed(guild).setTitle('🏆 Classement des invitations').setDescription(content).setFooter({ text: `Page ${page}/${total}` }));
}

const invites: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Tes invitations')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addBooleanOption((o) => o.setName('classement').setDescription('Voir le classement')),
  async execute(interaction) {
    if (interaction.options.getBoolean('classement')) return paginate(interaction, leaderboardPages(interaction.guild));
    return reply(interaction, { embeds: [invitesEmbed(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'invites',
    aliases: ['invs'],
    domain: 'general',
    category: 'community',
    description: 'Tes invitations',
    usage: '[membre]',
    async execute(message, args) {
      const id = args[0]?.replace(/\D/g, '');
      const user = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [invitesEmbed(message.guild, user)], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'invites',
  section: 'community',
  title: 'Invitations',
  emoji: '📨',
  moduleId: 'invites',
  order: 12,
  description: 'Qui a invité qui. Nécessite la permission « Gérer le serveur ». Les comptes trop récents comptent comme fake.',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des arrivées (facultatif)', get: (c) => c.invites.channelId, set: (c, v) => void (c.invites.channelId = v) },
    { kind: 'number', key: 'fake', label: 'Compte « fake » si plus jeune que', min: 0, max: 365, unit: 'j', get: (c) => c.invites.fakeAccountDays, set: (c, v) => void (c.invites.fakeAccountDays = v) },
  ],
};

export const invitesModule: BotModule = {
  id: 'invites',
  name: 'Invitations',
  emoji: '📨',
  description: 'Suivi des invitations, fakes et classement',
  toggleable: true,
  defaultEnabled: true,
  commands: [invites],
  prefixCommands,
  setupPages: [setupPage],
  events: [
    on('guildMemberAdd', (m) => onJoin(m), 30),
    on('guildMemberRemove', (m) => {
      run('UPDATE invites SET left_at = ? WHERE guild_id = ? AND invited_id = ?', Date.now(), m.guild.id, m.id);
    }),
    on('inviteCreate', (invite) => {
      if (!invite.guild) return;
      snapshots.get(invite.guild.id)?.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId });
    }),
    on('inviteDelete', (invite) => {
      if (!invite.guild) return;
      // On garde le code un moment pour détecter les invitations à usage unique.
      setTimeout(() => snapshots.get(invite.guild!.id)?.delete(invite.code), 10_000).unref();
    }),
  ],
  async onReady(client) {
    for (const guild of client.guilds.cache.values()) {
      if (!isModuleEnabled(guild.id, 'invites')) continue;
      const snap = await snapshot(guild).catch(() => null);
      if (snap) snapshots.set(guild.id, snap);
    }
    log.info(`Invitations suivies sur ${snapshots.size} serveur(s).`);
  },
};
