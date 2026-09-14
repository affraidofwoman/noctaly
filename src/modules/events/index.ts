import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { all, get, run } from '../../database/db';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import type { SetupPage } from '../../core/setup';
import { mentionListShort, neutralizeMentions, truncate } from './helpers';
import { parseDateTime, ts } from '../../core/time';
import { button, isHttpUrl, row } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';

interface EventRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  creator_id: string;
  name: string;
  description: string;
  game: string | null;
  image: string | null;
  starts_at: number;
  status: 'scheduled' | 'started' | 'cancelled' | 'ended';
  reminded: number;
  created_at: number;
}

type Rsvp = 'yes' | 'maybe' | 'no';
const RSVP: Record<Rsvp, { label: string; emoji: string }> = {
  yes: { label: 'Présent', emoji: '✅' },
  maybe: { label: 'Peut-être', emoji: '❓' },
  no: { label: 'Absent', emoji: '❌' },
};

function rsvps(eventId: number): Record<Rsvp, string[]> {
  const out: Record<Rsvp, string[]> = { yes: [], maybe: [], no: [] };
  for (const r of all<{ user_id: string; status: Rsvp }>('SELECT user_id, status FROM event_rsvps WHERE event_id = ? ORDER BY updated_at', eventId)) {
    out[r.status]?.push(r.user_id);
  }
  return out;
}

function render(guild: Guild, e: EventRow) {
  const list = rsvps(e.id);
  const closed = e.status === 'cancelled' || e.status === 'ended';
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, e.status === 'cancelled' ? 'error' : 'primary'))
    .setTitle(`🎮 ${truncate(e.name.toUpperCase(), 240)}`)
    .setDescription(
      [
        e.game ? `**${e.game}**` : null,
        e.description || null,
        '',
        `📅 ${ts(e.starts_at, 'F')}`,
        `🕘 ${ts(e.starts_at, 'R')}`,
        e.status === 'cancelled' ? '\n**❌ Événement annulé**' : e.status === 'started' ? '\n**🔴 C’est parti !**' : null,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .addFields(
      (Object.keys(RSVP) as Rsvp[]).map((k) => ({
        name: `${RSVP[k].emoji} ${RSVP[k].label} (${list[k].length})`,
        value: list[k].length ? mentionListShort(list[k], 15) : '—',
        inline: true,
      })),
    )
    .setFooter({ text: `Événement #${e.id} · organisé par ${guild.members.cache.get(e.creator_id)?.displayName ?? 'le staff'}` });
  if (e.image) embed.setImage(e.image);
  return {
    embeds: [embed],
    components: closed
      ? []
      : [
          row(
            button(`ev:rsvp:${e.id}:yes`, 'Je participe', ButtonStyle.Success, '✅'),
            button(`ev:rsvp:${e.id}:maybe`, 'Peut-être', ButtonStyle.Secondary, '❓'),
            button(`ev:rsvp:${e.id}:no`, 'Absent', ButtonStyle.Secondary, '❌'),
          ),
        ],
  };
}

function requireEvent(guildId: string, id: number | string | undefined): EventRow {
  const e = get<EventRow>('SELECT * FROM events WHERE id = ? AND guild_id = ?', Number(id), guildId);
  if (!e) throw new UserError('Événement introuvable.');
  return e;
}

async function refresh(client: Client, e: EventRow): Promise<void> {
  const guild = client.guilds.cache.get(e.guild_id);
  const channel = guild ? resolveTextChannel(guild, e.channel_id) : null;
  if (!guild || !channel || !e.message_id) return;
  const message = await channel.messages.fetch(e.message_id).catch(() => null);
  await message?.edit(render(guild, e)).catch(() => undefined);
}

const eventCommand: SlashCommand = {
  category: 'community',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Les événements communautaires')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un événement')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Soirée communautaire').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('date').setDescription('JJ/MM ou JJ/MM/AAAA').setRequired(true))
        .addStringOption((o) => o.setName('heure').setDescription('Ex : 21h ou 21:30').setRequired(true))
        .addStringOption((o) => o.setName('jeu').setDescription('Ex : Minecraft').setMaxLength(100))
        .addStringOption((o) => o.setName('description').setDescription('Détails').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où l’annoncer').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('image').setDescription('Lien d’une image').setMaxLength(500)),
    )
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un événement')
        .addIntegerOption((o) => o.setName('evenement').setDescription('L’événement').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les événements à venir')),
  subLevels: { list: PermLevel.MEMBER },
  async autocomplete(interaction) {
    const rows = all<EventRow>("SELECT * FROM events WHERE guild_id = ? AND status IN ('scheduled','started') ORDER BY starts_at LIMIT 25", interaction.guildId);
    await interaction.respond(rows.map((e) => ({ name: truncate(`#${e.id} · ${e.name}`, 100), value: e.id })));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const rows = all<EventRow>("SELECT * FROM events WHERE guild_id = ? AND status IN ('scheduled','started') ORDER BY starts_at LIMIT 20", guild.id);
      const lines = rows.map((e) => `🎮 **${truncate(e.name, 80)}** — ${ts(e.starts_at, 'f')} (${ts(e.starts_at, 'R')}) · ✅ ${rsvps(e.id).yes.length}${e.message_id ? ` · [voir](https://discord.com/channels/${e.guild_id}/${e.channel_id}/${e.message_id})` : ''}`);
      return reply(interaction, { embeds: [new EmbedBuilder().setColor(colorFor(guild)).setTitle('📅 Événements à venir').setDescription(lines.join('\n') || '*Aucun événement prévu.*')], ephemeral: true });
    }
    if (sub === 'cancel') {
      const e = requireEvent(guild.id, interaction.options.getInteger('evenement', true));
      run("UPDATE events SET status = 'cancelled' WHERE id = ?", e.id);
      await refresh(interaction.client, { ...e, status: 'cancelled' });
      return reply(interaction, { embeds: [ok(guild, `Événement **${e.name}** annulé.`)], ephemeral: true });
    }
    const tz = getConfig(guild.id).general.timezone;
    const startsAt = parseDateTime(interaction.options.getString('date', true), interaction.options.getString('heure', true), tz);
    if (!startsAt) throw new UserError('Date ou heure invalide : exemples `25/12` et `21h`.');
    if (startsAt < Date.now()) throw new UserError('Cette date est déjà passée.');
    const image = interaction.options.getString('image');
    if (image && !isHttpUrl(image)) throw new UserError('Lien d’image invalide.');
    const channel = (interaction.options.getChannel('salon') ?? resolveTextChannel(guild, getConfig(guild.id).events.defaultChannelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!channel) throw new UserError('Salon introuvable.');
    const r = run(
      'INSERT INTO events (guild_id, channel_id, creator_id, name, description, game, image, starts_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      guild.id,
      channel.id,
      interaction.user.id,
      neutralizeMentions(interaction.options.getString('nom', true)),
      neutralizeMentions(interaction.options.getString('description') ?? ''),
      interaction.options.getString('jeu'),
      image,
      startsAt,
      Date.now(),
    );
    const e = requireEvent(guild.id, r.lastInsertRowid);
    const ping = getConfig(guild.id).events.pingRoleId;
    const message = await channel.send({ content: ping ? `<@&${ping}>` : undefined, ...render(guild, e), allowedMentions: { roles: ping ? [ping] : [] } });
    run('UPDATE events SET message_id = ? WHERE id = ?', message.id, e.id);
    void journal(guild, 'community', { title: 'Événement créé', tone: 'info', lines: [`**${e.name}** — ${ts(startsAt, 'F')}`, `[voir](${message.url})`], by: interaction.user });
    return reply(interaction, { embeds: [ok(guild, `Événement publié : ${message.url}`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'events',
  section: 'community',
  title: 'Événements',
  emoji: '📅',
  moduleId: 'events',
  order: 4,
  description: 'Les événements communautaires avec inscription ✅ / ❓ / ❌ et rappel aux participants avant le début.',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon des événements', get: (c) => c.events.defaultChannelId, set: (c, v) => void (c.events.defaultChannelId = v) },
    { kind: 'role', key: 'ping', label: 'Rôle mentionné', get: (c) => c.events.pingRoleId, set: (c, v) => void (c.events.pingRoleId = v) },
    { kind: 'number', key: 'reminder', label: 'Rappel avant le début', min: 0, max: 1440, unit: 'min', get: (c) => c.events.reminderMinutes, set: (c, v) => void (c.events.reminderMinutes = v) },
  ],
};

export const eventsModule: BotModule = {
  id: 'events',
  name: 'Événements',
  emoji: '📅',
  description: 'Événements communautaires avec RSVP et rappels',
  toggleable: true,
  defaultEnabled: true,
  commands: [eventCommand],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'ev',
      async button(interaction: ButtonInteraction<'cached'>, [action, id, status]) {
        if (action !== 'rsvp') return;
        const e = requireEvent(interaction.guildId, id);
        if (e.status === 'cancelled' || e.status === 'ended') throw new UserError('Cet événement est terminé.');
        if (!(status! in RSVP)) return;
        run('INSERT OR REPLACE INTO event_rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?)', e.id, interaction.user.id, status, Date.now());
        await interaction.update(render(interaction.guild, e));
        await interaction.followUp({ embeds: [ok(interaction.guild, `${RSVP[status as Rsvp].emoji} Réponse enregistrée : **${RSVP[status as Rsvp].label}** pour **${e.name}**.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  tasks: [
    {
      name: 'events',
      intervalMs: 30_000,
      runOnStart: true,
      async run(client) {
        const now = Date.now();
        for (const e of all<EventRow>("SELECT * FROM events WHERE status = 'scheduled' AND reminded = 0 LIMIT 50")) {
          const minutes = getConfig(e.guild_id).events.reminderMinutes;
          if (!minutes || e.starts_at - minutes * 60_000 > now) continue;
          run('UPDATE events SET reminded = 1 WHERE id = ?', e.id);
          for (const userId of [...rsvps(e.id).yes, ...rsvps(e.id).maybe].slice(0, 100)) {
            const user = await client.users.fetch(userId).catch(() => null);
            await user?.send({ embeds: [new EmbedBuilder().setColor(colorFor(e.guild_id)).setTitle('📅 Ça commence bientôt !').setDescription(`**${e.name}** commence ${ts(e.starts_at, 'R')}.`)] }).catch(() => undefined);
          }
        }
        for (const e of all<EventRow>("SELECT * FROM events WHERE status = 'scheduled' AND starts_at <= ? LIMIT 20", now)) {
          run("UPDATE events SET status = 'started' WHERE id = ?", e.id);
          await refresh(client, { ...e, status: 'started' });
        }
        for (const e of all<EventRow>("SELECT * FROM events WHERE status = 'started' AND starts_at <= ? LIMIT 20", now - 6 * 3_600_000)) {
          run("UPDATE events SET status = 'ended' WHERE id = ?", e.id);
          await refresh(client, { ...e, status: 'ended' });
        }
      },
    },
  ],
};
