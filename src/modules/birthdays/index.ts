import { EmbedBuilder, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { all, get, run } from '../../database/db';
import { emojiFor } from '../../core/brand';
import { brandEmbed, colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { resolveTextChannel } from '../../core/logService';
import { isModuleEnabled } from '../../core/moduleManager';
import { linesToPages, paginate } from '../../core/pagination';
import { canBotManageRole, getLevel } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { MONTHS_FR, zonedParts } from '../../core/time';
import { renderTemplate } from '../../core/variables';
import { PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { grantBadge } from '../../services/badges';

interface BirthdayRow {
  user_id: string;
  day: number;
  month: number;
  last_announced_year: number | null;
  role_given_at: number | null;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidBirthday(day: number, month: number): boolean {
  return Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

/** Le 29 février est fêté le 28 les années non bissextiles. */
export function isBirthdayToday(row: { day: number; month: number }, today: { day: number; month: number; year: number }): boolean {
  const leap = (today.year % 4 === 0 && today.year % 100 !== 0) || today.year % 400 === 0;
  if (row.month === 2 && row.day === 29 && !leap) return today.month === 2 && today.day === 28;
  return row.day === today.day && row.month === today.month;
}

async function processGuild(guild: Guild): Promise<void> {
  const cfg = getConfig(guild.id).birthdays;
  const now = zonedParts(Date.now(), getConfig(guild.id).general.timezone);
  const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;

  // Retire le rôle d'anniversaire après 24 h.
  if (role) {
    for (const r of all<BirthdayRow>('SELECT * FROM birthdays WHERE guild_id = ? AND role_given_at IS NOT NULL AND role_given_at < ?', guild.id, Date.now() - 86_400_000)) {
      const member = await guild.members.fetch(r.user_id).catch(() => null);
      if (member && canBotManageRole(guild, role)) await member.roles.remove(role, 'Fin de l’anniversaire').catch(() => undefined);
      run('UPDATE birthdays SET role_given_at = NULL WHERE guild_id = ? AND user_id = ?', guild.id, r.user_id);
    }
  }

  if (now.hour < cfg.hour) return;
  const due = all<BirthdayRow>('SELECT * FROM birthdays WHERE guild_id = ? AND (last_announced_year IS NULL OR last_announced_year < ?)', guild.id, now.year).filter((r) => isBirthdayToday(r, now));
  if (!due.length) return;
  const channel = resolveTextChannel(guild, cfg.channelId);
  for (const r of due) {
    run('UPDATE birthdays SET last_announced_year = ? WHERE guild_id = ? AND user_id = ?', now.year, guild.id, r.user_id);
    const member = await guild.members.fetch(r.user_id).catch(() => null);
    if (!member) continue;
    grantBadge(guild.id, member.id, 'birthday');
    if (role && canBotManageRole(guild, role)) {
      await member.roles.add(role, 'Anniversaire').catch(() => undefined);
      run('UPDATE birthdays SET role_given_at = ? WHERE guild_id = ? AND user_id = ?', Date.now(), guild.id, r.user_id);
    }
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(colorFor(guild))
        .setTitle(`${emojiFor(guild.id, 'anniversaire')} ANNIVERSAIRE !`)
        .setDescription(truncate(renderTemplate(cfg.message, { member, guild }), 4096))
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
      await channel.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } }).catch(() => undefined);
    }
  }
}

const birthday: SlashCommand = {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Les anniversaires')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Enregistrer ton anniversaire')
        .addIntegerOption((o) => o.setName('jour').setDescription('Jour').setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((o) => o.setName('mois').setDescription('Mois').setRequired(true).addChoices(...MONTHS_FR.map((m, i) => ({ name: m, value: i + 1 }))))
        .addUserOption((o) => o.setName('membre').setDescription('Pour quelqu’un d’autre (staff)')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer ton anniversaire')
        .addUserOption((o) => o.setName('membre').setDescription('Pour quelqu’un d’autre (staff)')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les prochains anniversaires')),
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    const other = interaction.options.getUser('membre');
    if (other && other.id !== interaction.user.id && getLevel(interaction.member) < PermLevel.STAFF) {
      throw new UserError('Seul le staff peut modifier l’anniversaire de quelqu’un d’autre.');
    }
    const userId = other?.id ?? interaction.user.id;
    if (sub === 'set') {
      const day = interaction.options.getInteger('jour', true);
      const month = interaction.options.getInteger('mois', true);
      if (!isValidBirthday(day, month)) throw new UserError('Cette date n’existe pas.');
      const year = zonedParts(Date.now(), getConfig(guild.id).general.timezone).year;
      const today = zonedParts(Date.now(), getConfig(guild.id).general.timezone);
      // Enregistré aujourd'hui même : on ne le souhaite pas une seconde fois s'il est déjà passé l'heure.
      const skipThisYear = isBirthdayToday({ day, month }, today) && today.hour >= getConfig(guild.id).birthdays.hour;
      run(
        `INSERT INTO birthdays (guild_id, user_id, day, month, last_announced_year) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET day = excluded.day, month = excluded.month, last_announced_year = excluded.last_announced_year`,
        guild.id,
        userId,
        day,
        month,
        skipThisYear ? year : null,
      );
      return reply(interaction, { embeds: [ok(guild, `🎂 Anniversaire de <@${userId}> enregistré : **${day} ${MONTHS_FR[month - 1]}**.`)], ephemeral: true });
    }
    if (sub === 'remove') {
      const r = run('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?', guild.id, userId);
      return reply(interaction, { embeds: [ok(guild, r.changes ? 'Anniversaire retiré.' : 'Aucun anniversaire enregistré.')], ephemeral: true });
    }
    const today = zonedParts(Date.now(), getConfig(guild.id).general.timezone);
    const rows = all<BirthdayRow>('SELECT * FROM birthdays WHERE guild_id = ?', guild.id);
    const score = (r: BirthdayRow) => {
      const v = (r.month - today.month) * 31 + (r.day - today.day);
      return v < 0 ? v + 12 * 31 : v;
    };
    const lines = rows.sort((a, b) => score(a) - score(b)).map((r) => `${score(r) === 0 ? '🎉' : '🎂'} **${r.day} ${MONTHS_FR[r.month - 1]}** — <@${r.user_id}>`);
    if (!lines.length) lines.push('*Aucun anniversaire enregistré. Ajoute le tien avec `/birthday set` !*');
    return paginate(interaction, linesToPages(lines, 15, (content, page, total) => brandEmbed(guild).setTitle('🎂 Anniversaires à venir').setDescription(content).setFooter({ text: `Page ${page}/${total}` })));
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'anniv',
    aliases: ['birthday', 'bday'],
    domain: 'general',
    category: 'community',
    description: 'Ton anniversaire (JJ/MM)',
    usage: '<JJ/MM>',
    async execute(message, args) {
      const m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(args[0] ?? '');
      if (!m) {
        const row = get<BirthdayRow>('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?', message.guildId, message.author.id);
        await message.reply({ embeds: [ok(message.guild, row ? `Ton anniversaire : **${row.day} ${MONTHS_FR[row.month - 1]}**.` : 'Aucun anniversaire enregistré. Écris par exemple `=anniv 14/09`.')], allowedMentions: { repliedUser: false } });
        return;
      }
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (!isValidBirthday(day, month)) throw new UserError('Cette date n’existe pas.');
      run('INSERT INTO birthdays (guild_id, user_id, day, month) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET day = excluded.day, month = excluded.month', message.guildId, message.author.id, day, month);
      await message.reply({ embeds: [ok(message.guild, `🎂 Anniversaire enregistré : **${day} ${MONTHS_FR[month - 1]}**.`)], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'birthdays',
  section: 'community',
  title: 'Anniversaires',
  emoji: '🎂',
  moduleId: 'birthdays',
  order: 3,
  description: 'Le bot souhaite les anniversaires à l’heure choisie (fuseau du serveur) et peut donner un rôle pour la journée.\n-# Variables : `{mention}` `{user}` `{server}`',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des anniversaires', get: (c) => c.birthdays.channelId, set: (c, v) => void (c.birthdays.channelId = v) },
    { kind: 'role', key: 'role', label: 'Rôle du jour', assignable: true, get: (c) => c.birthdays.roleId, set: (c, v) => void (c.birthdays.roleId = v) },
    { kind: 'text', key: 'message', label: 'Message', long: true, maxLength: 1500, required: true, get: (c) => c.birthdays.message, set: (c, v) => void (c.birthdays.message = v) },
    { kind: 'number', key: 'hour', label: 'Heure d’annonce', min: 0, max: 23, unit: 'h', get: (c) => c.birthdays.hour, set: (c, v) => void (c.birthdays.hour = v) },
  ],
};

export const birthdaysModule: BotModule = {
  id: 'birthdays',
  name: 'Anniversaires',
  emoji: '🎂',
  description: 'Annonces d’anniversaire, rôle du jour et badge',
  toggleable: true,
  defaultEnabled: true,
  commands: [birthday],
  prefixCommands,
  setupPages: [setupPage],
  tasks: [
    {
      name: 'birthdays',
      intervalMs: 10 * 60_000,
      runOnStart: true,
      async run(client: Client<true>) {
        for (const guild of client.guilds.cache.values()) {
          if (isModuleEnabled(guild.id, 'birthdays')) await processGuild(guild);
        }
      },
    },
  ],
  tests: [
    {
      id: 'announce',
      label: 'Annonce d’anniversaire',
      emoji: '🎂',
      description: 'Voir le message avec ton nom',
      async run(interaction) {
        const cfg = getConfig(interaction.guildId).birthdays;
        const channel = resolveTextChannel(interaction.guild, cfg.channelId);
        if (!channel) return '⚠️ Aucun salon d’anniversaires utilisable.';
        await channel.send({
          embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setTitle('🎂 ANNIVERSAIRE ! (test)').setDescription(renderTemplate(cfg.message, { member: interaction.member, guild: interaction.guild }))],
          allowedMentions: { parse: [] },
        });
        return `✅ Annonce de test postée dans <#${channel.id}>.`;
      },
    },
  ],
};
