import { randomInt } from 'node:crypto';
import {
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { all, get, parseJson, run, transaction } from '../database/db';
import { emojiFor } from '../core/brand';
import { colorFor } from '../core/embeds';
import { getConfig } from '../core/guildConfig';
import { journal, recordLog } from '../core/logService';
import { createLogger } from '../core/logger';
import { truncate } from '../core/text';
import { daysSince, formatDuration } from '../core/time';
import { button, row } from '../core/ui';
import { emitActivity } from './activity';
import { grantBadge } from './badges';
import { levelOf } from './xp';

const log = createLogger('giveaways');

export interface GiveawayRequirements {
  roleId?: string | null;
  minLevel?: number | null;
  minAccountDays?: number | null;
  minMemberDays?: number | null;
  minParticipants?: number | null;
  note?: string | null;
}

export interface GiveawayRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  prize: string;
  winners_count: number;
  ends_at: number;
  status: 'running' | 'paused' | 'ended';
  paused_remaining: number | null;
  requirements: string;
  winners: string;
  created_at: number;
}

export function getGiveaway(id: number): GiveawayRow | undefined {
  return get<GiveawayRow>('SELECT * FROM giveaways WHERE id = ?', id);
}

export function guildGiveaways(guildId: string, status?: GiveawayRow['status']): GiveawayRow[] {
  return status
    ? all<GiveawayRow>('SELECT * FROM giveaways WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100', guildId, status)
    : all<GiveawayRow>('SELECT * FROM giveaways WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100', guildId);
}

export function participants(id: number): string[] {
  return all<{ user_id: string }>('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ? ORDER BY entered_at', id).map((r) => r.user_id);
}

export function participantCount(id: number): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?', id)?.n ?? 0;
}

export function winsOf(guildId: string, userId: string): number {
  return (
    get<{ n: number }>("SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ? AND status = 'ended' AND winners LIKE ?", guildId, `%"${userId}"%`)?.n ?? 0
  );
}

export function requirementsOf(g: GiveawayRow): GiveawayRequirements {
  return parseJson<GiveawayRequirements>(g.requirements, {});
}

export function describeRequirements(req: GiveawayRequirements): string[] {
  return [
    req.roleId ? `• Rôle — <@&${req.roleId}>` : null,
    req.minLevel ? `• Niveau XP — **${req.minLevel}** minimum` : null,
    req.minAccountDays ? `• Compte Discord — **${req.minAccountDays} j** minimum` : null,
    req.minMemberDays ? `• Sur le serveur depuis — **${req.minMemberDays} j** minimum` : null,
    req.minParticipants ? `• Tirage si au moins **${req.minParticipants}** participants` : null,
    req.note ? `• ${req.note}` : null,
  ].filter((l): l is string => !!l);
}

/** Vérifie les conditions de participation. Retourne la raison du refus ou null. */
export function checkEligibility(member: GuildMember, req: GiveawayRequirements): string | null {
  if (req.roleId && !member.roles.cache.has(req.roleId)) return `Il te faut le rôle <@&${req.roleId}> pour participer.`;
  if (req.minLevel && levelOf(member.guild.id, member.id) < req.minLevel) return `Il faut être au moins niveau **${req.minLevel}** (tu es niveau ${levelOf(member.guild.id, member.id)}).`;
  if (req.minAccountDays && daysSince(member.user.createdTimestamp) < req.minAccountDays) return `Ton compte Discord doit avoir au moins **${req.minAccountDays} jours**.`;
  if (req.minMemberDays && (!member.joinedTimestamp || daysSince(member.joinedTimestamp) < req.minMemberDays)) {
    return `Il faut être sur le serveur depuis au moins **${req.minMemberDays} jours**.`;
  }
  return null;
}

export function mentionList(ids: string[], max = 40): string {
  const shown = ids.slice(0, max).map((id) => `<@${id}>`).join(', ');
  const rest = ids.length - Math.min(ids.length, max);
  return rest > 0 ? `${shown} et ${rest} autre${rest > 1 ? 's' : ''}` : shown;
}

export function buildGiveawayMessage(guild: Guild, g: GiveawayRow) {
  const count = participantCount(g.id);
  const winners = parseJson<string[]>(g.winners, []);
  const req = requirementsOf(g);
  const gift = emojiFor(guild.id, 'cadeau');
  const ended = g.status === 'ended';
  const paused = g.status === 'paused';
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, ended ? 'info' : 'primary'))
    .setAuthor({ name: ended ? 'Giveaway terminé' : paused ? 'Giveaway en pause' : 'Giveaway en cours' })
    .setTitle(`${gift} ${ended ? `~~${truncate(g.prize, 200)}~~` : truncate(g.prize, 240)}`)
    .setFooter({ text: `${g.winners_count} gagnant${g.winners_count > 1 ? 's' : ''} · lancé par ${guild.members.cache.get(g.host_id)?.user.tag ?? 'le staff'}` });

  if (ended) {
    embed.setDescription(winners.length ? `${gift} ${winners.length > 1 ? 'Gagnants' : 'Gagnant'} : ${mentionList(winners)}` : '*Personne n’a gagné.*');
    embed.addFields({ name: 'Participants', value: String(count), inline: true });
  } else {
    embed.setDescription(paused ? '⏸️ Les participations sont suspendues pour le moment.' : 'Clique sur **Participer** pour tenter ta chance.');
    const end = Math.floor(g.ends_at / 1000);
    embed.addFields(
      paused
        ? { name: 'Temps restant', value: formatDuration(g.paused_remaining ?? 0), inline: true }
        : { name: 'Tirage', value: `<t:${end}:R>\n-# <t:${end}:f>`, inline: true },
      { name: 'Participants', value: String(count), inline: true },
    );
  }
  const reqLines = describeRequirements(req);
  if (reqLines.length) embed.addFields({ name: 'Conditions', value: truncate(reqLines.join('\n'), 1024), inline: false });

  const components = [
    row(
      button(`gw:join:${g.id}`, `Participer (${count})`, ButtonStyle.Primary, emojiFor(guild.id, 'giveaway')).setDisabled(ended || paused),
      button(`gw:info:${g.id}`, '', ButtonStyle.Secondary, emojiFor(guild.id, 'info')),
    ),
  ];
  return { embeds: [embed], components };
}

async function fetchChannel(client: Client, g: GiveawayRow): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(g.channel_id).catch(() => null);
  return channel && channel.isTextBased() && !channel.isDMBased() ? channel : null;
}

export async function refreshMessage(client: Client, g: GiveawayRow): Promise<void> {
  if (!g.message_id) return;
  const channel = await fetchChannel(client, g);
  if (!channel) return;
  const message = await channel.messages.fetch(g.message_id).catch(() => null);
  if (!message) return;
  await message.edit(buildGiveawayMessage(channel.guild, g)).catch((err: Error) => log.debug(`Message giveaway non mis à jour : ${err.message}`));
}

/** Tirage équitable (crypto) de `count` gagnants distincts. */
export function pickWinners(pool: string[], count: number): string[] {
  const copy = [...pool];
  const winners: string[] = [];
  while (copy.length && winners.length < count) winners.push(copy.splice(randomInt(copy.length), 1)[0]!);
  return winners;
}

export interface CreateGiveawayInput {
  channel: GuildTextBasedChannel;
  host: GuildMember;
  prize: string;
  winners: number;
  durationMs: number;
  requirements: GiveawayRequirements;
}

export async function startGiveaway(input: CreateGiveawayInput): Promise<GiveawayRow> {
  const guild = input.channel.guild;
  const r = run(
    'INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winners_count, ends_at, requirements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    guild.id,
    input.channel.id,
    input.host.id,
    input.prize,
    input.winners,
    Date.now() + input.durationMs,
    JSON.stringify(input.requirements),
    Date.now(),
  );
  const g = getGiveaway(r.lastInsertRowid)!;
  const ping = getConfig(guild.id).giveaways.pingRoleId;
  const message = await input.channel.send({
    content: ping ? `<@&${ping}>` : undefined,
    ...buildGiveawayMessage(guild, g),
    allowedMentions: { roles: ping ? [ping] : [] },
  });
  run('UPDATE giveaways SET message_id = ? WHERE id = ?', message.id, g.id);
  recordLog(guild.id, 'giveaway', 'start', null, input.host.id, { id: g.id, prize: input.prize });
  void journal(guild, 'giveaway', {
    title: 'Giveaway lancé',
    tone: 'info',
    lines: [
      `**Lot** : ${truncate(input.prize, 300)}`,
      `**Gagnants** : ${input.winners}`,
      `**Fin** : <t:${Math.floor(g.ends_at / 1000)}:R>`,
      `**Salon** : <#${input.channel.id}> · [message](${message.url})`,
      ...describeRequirements(input.requirements),
    ],
    by: input.host.user,
  });
  return getGiveaway(g.id)!;
}

export type JoinResult = { joined: true } | { joined: false; reason: string } | { alreadyIn: true };

export function joinGiveaway(member: GuildMember, g: GiveawayRow): JoinResult {
  if (g.status !== 'running') return { joined: false, reason: g.status === 'paused' ? 'Ce giveaway est en pause.' : 'Ce giveaway est terminé.' };
  if (g.ends_at <= Date.now()) return { joined: false, reason: 'Le tirage est en cours.' };
  const refusal = checkEligibility(member, requirementsOf(g));
  if (refusal) return { joined: false, reason: refusal };
  const r = run('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)', g.id, member.id, Date.now());
  if (!r.changes) return { alreadyIn: true };
  emitActivity({ guildId: member.guild.id, userId: member.id, type: 'giveaways', amount: 1 });
  if (getConfig(member.guild.id).giveaways.logParticipations) {
    void journal(member.guild, 'giveaway', { title: 'Participation', tone: 'neutre', lines: [`<@${member.id}> participe à **${truncate(g.prize, 100)}**`] });
  }
  return { joined: true };
}

export function leaveGiveaway(userId: string, g: GiveawayRow): boolean {
  return run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', g.id, userId).changes > 0;
}

/** Termine un giveaway : tirage parmi les participants encore éligibles, annonce, MP, badges, logs. */
export async function endGiveaway(client: Client, id: number, endedBy: string | null = null): Promise<string[]> {
  const claimed = transaction(() => {
    const g = getGiveaway(id);
    if (!g || g.status === 'ended') return null;
    run("UPDATE giveaways SET status = 'ended', ends_at = ? WHERE id = ?", Math.min(g.ends_at, Date.now()), id);
    return g;
  });
  if (!claimed) return [];
  const channel = await fetchChannel(client, claimed);
  const guild = channel?.guild ?? client.guilds.cache.get(claimed.guild_id);
  const req = requirementsOf(claimed);
  const pool = participants(id);

  let eligible = pool;
  if (guild) {
    // Les membres partis ou qui ne remplissent plus les conditions ne peuvent pas gagner.
    const members = await guild.members.fetch({ user: pool.slice(0, 1000) }).catch(() => null);
    if (members) eligible = pool.filter((uid) => {
      const m = members.get(uid);
      return m && !checkEligibility(m, req);
    });
  }
  const enough = !req.minParticipants || pool.length >= req.minParticipants;
  const winners = enough ? pickWinners(eligible, claimed.winners_count) : [];
  run('UPDATE giveaways SET winners = ? WHERE id = ?', JSON.stringify(winners), id);
  const g = getGiveaway(id)!;

  if (guild) {
    for (const w of winners) grantBadge(guild.id, w, 'giveaway');
    recordLog(guild.id, 'giveaway', 'end', null, endedBy, { id, winners, participants: pool.length });
    void journal(guild, 'giveaway', {
      title: 'Giveaway terminé',
      tone: winners.length ? 'ok' : 'alerte',
      lines: [
        `**Lot** : ${truncate(g.prize, 300)}`,
        winners.length ? `**Gagnant(s)** : ${mentionList(winners)}` : enough ? '**Aucun participant éligible**' : `**Pas assez de participants** (${pool.length}/${req.minParticipants})`,
        `**Participants** : ${pool.length}`,
        endedBy ? `**Arrêté par** : <@${endedBy}>` : null,
      ],
    });
  }

  if (channel) {
    await refreshMessage(client, g);
    const gift = emojiFor(channel.guild.id, 'cadeau');
    if (winners.length) {
      await channel
        .send({
          content: winners.slice(0, 50).map((w) => `<@${w}>`).join(' '),
          embeds: [new EmbedBuilder().setColor(colorFor(channel.guild, 'success')).setDescription(`${gift} Bravo ${mentionList(winners)} — tu remportes **${truncate(g.prize, 300)}** !\n-# Ouvre un ticket pour récupérer ton lot.`)],
          allowedMentions: { users: winners.slice(0, 100) },
        })
        .catch(() => undefined);
    } else {
      const why = enough ? 'Personne d’éligible n’a participé' : `Pas assez de participants (${pool.length}/${req.minParticipants})`;
      await channel.send({ embeds: [new EmbedBuilder().setColor(colorFor(channel.guild, 'warning')).setDescription(`⏹️ ${why} : **${truncate(g.prize, 300)}** n’a pas trouvé preneur.`)] }).catch(() => undefined);
    }
    if (winners.length && getConfig(channel.guild.id).giveaways.dmWinners) {
      for (const w of winners.slice(0, 20)) {
        const user = await client.users.fetch(w).catch(() => null);
        await user
          ?.send({ embeds: [new EmbedBuilder().setColor(colorFor(channel.guild, 'success')).setTitle(`${gift} Tu as gagné !`).setDescription(`Tu remportes **${truncate(g.prize, 300)}** sur **${channel.guild.name}**.\nOuvre un ticket sur le serveur pour récupérer ton lot.`)] })
          .catch(() => undefined);
      }
    }
  }
  return winners;
}

export async function rerollGiveaway(client: Client, g: GiveawayRow, actorId: string, count?: number): Promise<string[]> {
  const previous = parseJson<string[]>(g.winners, []);
  const pool = participants(g.id).filter((p) => !previous.includes(p));
  const winners = pickWinners(pool.length ? pool : participants(g.id), count ?? g.winners_count);
  if (!winners.length) return [];
  run('UPDATE giveaways SET winners = ? WHERE id = ?', JSON.stringify(winners), g.id);
  const channel = await fetchChannel(client, g);
  if (channel) {
    for (const w of winners) grantBadge(channel.guild.id, w, 'giveaway');
    await refreshMessage(client, getGiveaway(g.id)!);
    await channel.send({
      content: winners.map((w) => `<@${w}>`).join(' '),
      embeds: [new EmbedBuilder().setColor(colorFor(channel.guild, 'success')).setDescription(`${emojiFor(channel.guild.id, 'cadeau')} Nouveau tirage pour **${truncate(g.prize, 300)}** — bravo ${mentionList(winners)}.`)],
      allowedMentions: { users: winners },
    });
    recordLog(channel.guild.id, 'giveaway', 'reroll', null, actorId, { id: g.id, winners });
    void journal(channel.guild, 'giveaway', { title: 'Giveaway relancé', tone: 'info', lines: [`**Lot** : ${truncate(g.prize, 300)}`, `**Nouveau(x) gagnant(s)** : ${mentionList(winners)}`], by: client.users.cache.get(actorId) ?? null });
  }
  return winners;
}

export function pauseGiveaway(g: GiveawayRow): void {
  run("UPDATE giveaways SET status = 'paused', paused_remaining = ? WHERE id = ? AND status = 'running'", Math.max(0, g.ends_at - Date.now()), g.id);
}

export function resumeGiveaway(g: GiveawayRow): void {
  run("UPDATE giveaways SET status = 'running', ends_at = ?, paused_remaining = NULL WHERE id = ? AND status = 'paused'", Date.now() + (g.paused_remaining ?? 60_000), g.id);
}

export function dueGiveaways(): GiveawayRow[] {
  return all<GiveawayRow>("SELECT * FROM giveaways WHERE status = 'running' AND ends_at <= ? LIMIT 20", Date.now());
}
