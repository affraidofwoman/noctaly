import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type OverwriteResolvable,
  type TextChannel,
  type User,
} from 'discord.js';
import { all, get, run } from '../database/db';
import { brandName, colorFor } from '../core/embeds';
import { UserError } from '../core/errors';
import { getConfig, updateConfig, type TicketCategory } from '../core/guildConfig';
import { journal, recordLog } from '../core/logService';
import { createLogger } from '../core/logger';
import { canBotManageRole, hasLevel } from '../core/permissions';
import { slugify } from '../core/text';
import { PermLevel } from '../core/types';
import { listMembers } from '../core/whitelists';
import { buildTranscriptHtml, fetchAllMessages } from './transcript';

const log = createLogger('tickets');

export interface TicketRow {
  id: number;
  guild_id: string;
  number: number;
  channel_id: string;
  user_id: string;
  category: string;
  subject: string | null;
  status: 'open' | 'closed' | 'deleted';
  claimed_by: string | null;
  created_at: number;
  closed_at: number | null;
  closed_by: string | null;
}

/** Salons de tickets ouverts (pour enregistrer leurs messages sans requête par message). */
export const ticketChannels = new Set<string>();

export function loadTicketChannels(): void {
  ticketChannels.clear();
  for (const row of all<{ channel_id: string }>("SELECT channel_id FROM tickets WHERE status != 'deleted'")) ticketChannels.add(row.channel_id);
}

export function ticketByChannel(channelId: string): TicketRow | undefined {
  return get<TicketRow>("SELECT * FROM tickets WHERE channel_id = ? AND status != 'deleted'", channelId);
}

export function openTicketsOf(guildId: string, userId: string): TicketRow[] {
  return all<TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'", guildId, userId);
}

export function listTickets(guildId: string, status: 'open' | 'closed' | 'all' = 'open'): TicketRow[] {
  return status === 'all'
    ? all<TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 500", guildId)
    : all<TicketRow>('SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT 500', guildId, status);
}

export function ticketCount(guildId: string, userId: string): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ?', guildId, userId)?.n ?? 0;
}

export function categoryOf(guildId: string, id: string): TicketCategory {
  const cats = getConfig(guildId).tickets.categories;
  return cats.find((c) => c.id === id) ?? { id, label: id, emoji: '🎫', description: '', style: 'Secondary', roles: [] };
}

/** Rôles qui voient un ticket : ceux de la catégorie, sinon les rôles staff tickets, sinon les rôles d'accès du bot. */
export function accessRoles(guild: Guild, category: TicketCategory): string[] {
  const cfg = getConfig(guild.id);
  const pick = (ids: string[]) => ids.filter((id) => guild.roles.cache.has(id));
  const fromCategory = pick(category.roles);
  const staff = pick(cfg.tickets.staffRoles);
  if (fromCategory.length) return [...new Set([...fromCategory, ...staff])];
  if (staff.length) return staff;
  return pick([...cfg.permissions.support, ...cfg.permissions.staff, ...cfg.permissions.moderator, ...cfg.permissions.admin]);
}

/** Staff d'un ticket : niveau Support+, ou porteur d'un rôle qui voit ce ticket. */
export function isTicketStaff(member: GuildMember, ticket: TicketRow): boolean {
  if (hasLevel(member, PermLevel.SUPPORT)) return true;
  const roles = accessRoles(member.guild, categoryOf(member.guild.id, ticket.category));
  return roles.some((r) => member.roles.cache.has(r));
}

const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

async function ticketParent(guild: Guild): Promise<CategoryChannel> {
  const cfg = getConfig(guild.id).tickets;
  const configured = cfg.parentCategoryId ? guild.channels.cache.get(cfg.parentCategoryId) : null;
  const usable = (c: CategoryChannel | null | undefined) => c && c.type === ChannelType.GuildCategory && c.children.cache.size < 50;
  if (usable(configured as CategoryChannel)) return configured as CategoryChannel;
  const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('ticket') && c.children.cache.size < 50) as
    | CategoryChannel
    | undefined;
  if (found) return found;
  const created = await guild.channels.create({
    name: '🎫 Tickets',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
    reason: 'Catégorie des tickets',
  });
  if (!cfg.parentCategoryId) updateConfig(guild.id, (c) => void (c.tickets.parentCategoryId = created.id));
  return created;
}

async function sortChannels(category: CategoryChannel): Promise<void> {
  try {
    const channels = [...category.children.cache.values()].filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (channels.length < 2) return;
    const base = Math.min(...channels.map((c) => c.rawPosition));
    await category.guild.channels.setPositions(channels.map((c, i) => ({ channel: c.id, position: base + i })));
  } catch (err) {
    log.debug(`Tri des tickets impossible : ${(err as Error).message}`);
  }
}

export interface CreatedTicket {
  channel: TextChannel;
  ticket: TicketRow;
  category: TicketCategory;
  pingRoles: string[];
}

export async function createTicket(member: GuildMember, categoryId: string, subject: string | null = null): Promise<CreatedTicket> {
  const guild = member.guild;
  const cfg = getConfig(guild.id).tickets;
  const category = cfg.categories.find((c) => c.id === categoryId);
  if (!category) throw new UserError('Ce motif de ticket n’existe plus.');
  const open = openTicketsOf(guild.id, member.id);
  if (open.length >= cfg.maxOpenPerUser) {
    throw new UserError(`Tu as déjà ${open.length} ticket(s) ouvert(s) : ${open.map((t) => `<#${t.channel_id}>`).join(', ')}`);
  }
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new UserError('Il me faut la permission « Gérer les salons » pour créer un ticket.');

  const parent = await ticketParent(guild);
  const base = `${slugify(category.id, 20)}-${slugify(member.user.username, 60)}`;
  const name = guild.channels.cache.some((c) => c.name === base) ? `${base}-${Math.random().toString(36).slice(2, 5)}` : base;
  const roles = accessRoles(guild, category);

  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: MEMBER_ALLOW },
    { id: me.id, allow: [...MEMBER_ALLOW, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ...roles.map((id) => ({ id, allow: MEMBER_ALLOW })),
  ];
  // Whitelists support/staff par ID : elles voient aussi les tickets (plafonné pour rester sous la limite Discord).
  const wlUsers = [...new Set([...listMembers('support', guild.id), ...listMembers('staff', guild.id)])].filter((id) => guild.members.cache.has(id) && id !== member.id).slice(0, 30);
  for (const id of wlUsers) overwrites.push({ id, allow: MEMBER_ALLOW });

  const number = updateConfig(guild.id, (c) => void (c.tickets.counter += 1)).tickets.counter;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    topic: `Ticket #${number} ouvert par ${member.id} | catégorie : ${category.id}`,
    permissionOverwrites: overwrites,
    reason: `Ticket de ${member.user.tag}`,
  });

  const r = run(
    'INSERT INTO tickets (guild_id, number, channel_id, user_id, category, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    guild.id,
    number,
    channel.id,
    member.id,
    category.id,
    subject,
    Date.now(),
  );
  ticketChannels.add(channel.id);
  void sortChannels(parent);

  const ticket = ticketByChannel(channel.id)!;
  recordLog(guild.id, 'ticket', 'open', member.id, member.id, { ticketId: r.lastInsertRowid, category: category.id });
  void journal(guild, 'ticket', {
    title: 'Ticket ouvert',
    tone: 'ok',
    lines: [`**Ticket** : <#${channel.id}> \`#${channel.name}\``, `**Catégorie** : ${category.emoji} ${category.label}`, `**Ouvert par** : <@${member.id}>`],
    by: member.user,
  });
  const pingRoles = category.roles.filter((id) => guild.roles.cache.has(id));
  return { channel, ticket, category, pingRoles };
}

/** Génère le transcript, l'envoie dans ticket-logs et en MP au créateur. */
export async function archiveTranscript(guild: Guild, channel: TextChannel, ticket: TicketRow, closedBy: User): Promise<{ messages: number; dmSent: boolean }> {
  const messages = await fetchAllMessages(channel);
  const category = categoryOf(guild.id, ticket.category);
  const html = buildTranscriptHtml(channel, messages, { subtitle: `${category.label} · ouvert par ${ticket.user_id}` });
  const fileName = `transcript-${channel.name}.html`;

  await journal(guild, 'ticket', {
    title: 'Ticket fermé',
    tone: 'neutre',
    lines: [`**#${channel.name}** · ${messages.length} message${messages.length > 1 ? 's' : ''} · transcript en pièce jointe`],
    fields: [
      { name: 'Ouvert par', value: `<@${ticket.user_id}>` },
      { name: 'Fermé par', value: `<@${closedBy.id}>` },
      { name: 'Motif', value: `${category.emoji} ${category.label}` },
      { name: 'Pris en charge', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : '—' },
      { name: 'Durée', value: `<t:${Math.floor(ticket.created_at / 1000)}:R>` },
    ],
    files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName })],
    by: closedBy,
  });

  let dmSent = false;
  if (getConfig(guild.id).tickets.transcriptToUser) {
    const creator = await guild.client.users.fetch(ticket.user_id).catch(() => null);
    if (creator && !creator.bot) {
      const embed = new EmbedBuilder()
        .setColor(colorFor(guild))
        .setTitle('🎫 Ton ticket est fermé')
        .setDescription('Toute la conversation est dans le fichier joint — garde-le si tu en as besoin.')
        .addFields({ name: 'Motif', value: category.label, inline: true }, { name: 'Salon', value: `\`${channel.name}\``, inline: true })
        .setFooter({ text: `${brandName(guild)} · transcript du ticket` })
        .setTimestamp();
      dmSent = await creator
        .send({ embeds: [embed], files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName })] })
        .then(() => true)
        .catch(() => false);
    }
  }
  return { messages: messages.length, dmSent };
}

export function markClosed(ticket: TicketRow, closedBy: string): void {
  run("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?", Date.now(), closedBy, ticket.id);
  recordLog(ticket.guild_id, 'ticket', 'close', ticket.user_id, closedBy, { ticketId: ticket.id });
}

export function markDeleted(channelId: string): void {
  run("UPDATE tickets SET status = 'deleted', closed_at = COALESCE(closed_at, ?) WHERE channel_id = ?", Date.now(), channelId);
  ticketChannels.delete(channelId);
}

export function markReopened(ticket: TicketRow): void {
  run("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?", ticket.id);
  recordLog(ticket.guild_id, 'ticket', 'reopen', ticket.user_id, null, { ticketId: ticket.id });
}

export function markClaimed(ticket: TicketRow, staffId: string | null): void {
  run('UPDATE tickets SET claimed_by = ? WHERE id = ?', staffId, ticket.id);
  recordLog(ticket.guild_id, 'ticket', staffId ? 'claim' : 'unclaim', ticket.user_id, staffId, { ticketId: ticket.id });
}

/** Ferme l'accès en écriture du créateur (mode archive). */
export async function lockCreator(channel: TextChannel, ticket: TicketRow, open: boolean): Promise<void> {
  await channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: open, ViewChannel: true }, { reason: open ? 'Ticket rouvert' : 'Ticket fermé' }).catch(() => undefined);
}

export function storeTicketMessage(ticketId: number, messageId: string, authorId: string, authorTag: string, content: string, attachments: string[]): void {
  run(
    'INSERT INTO ticket_messages (ticket_id, message_id, author_id, author_tag, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ticketId,
    messageId,
    authorId,
    authorTag,
    content.slice(0, 4000),
    JSON.stringify(attachments.slice(0, 10)),
    Date.now(),
  );
}

export function rolesAboveBot(guild: Guild, ids: string[]): string[] {
  return ids.filter((id) => {
    const role = guild.roles.cache.get(id);
    return role && !canBotManageRole(guild, role);
  });
}
