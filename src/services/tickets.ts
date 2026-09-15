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
import { lireTout, lire, executer } from '../database/db';
import { nomEnseigne, couleurPour } from '../core/embeds';
import { ErreurUtilisateur } from '../core/errors';
import { lireConfig, modifierConfig, type MotifTicket } from '../core/guildConfig';
import { journal, historiser } from '../core/logService';
import { creerRegistre } from '../core/logger';
import { botPeutGererRole, aNiveau } from '../core/permissions';
import { identifiantDepuisTexte } from '../core/text';
import { Niveau } from '../core/types';
import { membresListe } from '../core/whitelists';
import { construireTranscript, recupererMessages } from './transcript';

const registre = creerRegistre('tickets');

export interface LigneTicket {
  id: number;
  serveur_id: string;
  numero: number;
  salon_id: string;
  utilisateur_id: string;
  categorie: string;
  sujet: string | null;
  statut: 'open' | 'closed' | 'deleted';
  pris_par: string | null;
  cree_le: number;
  ferme_le: number | null;
  ferme_par: string | null;
}

/** Salons de tickets ouverts (pour enregistrer leurs messages sans requête par message). */
export const salonsTickets = new Set<string>();

export function chargerSalonsTickets(): void {
  salonsTickets.clear();
  for (const rangee of lireTout<{ salon_id: string }>("SELECT salon_id FROM tickets WHERE statut != 'deleted'")) salonsTickets.add(rangee.salon_id);
}

export function ticketDuSalon(salonId: string): LigneTicket | undefined {
  return lire<LigneTicket>("SELECT * FROM tickets WHERE salon_id = ? AND statut != 'deleted'", salonId);
}

export function ticketsOuvertsDe(serveurId: string, utilisateurId: string): LigneTicket[] {
  return lireTout<LigneTicket>("SELECT * FROM tickets WHERE serveur_id = ? AND utilisateur_id = ? AND statut = 'open'", serveurId, utilisateurId);
}

export function listerTickets(serveurId: string, statut: 'open' | 'closed' | 'all' = 'open'): LigneTicket[] {
  return statut === 'all'
    ? lireTout<LigneTicket>("SELECT * FROM tickets WHERE serveur_id = ? AND statut != 'deleted' ORDER BY cree_le DESC LIMIT 500", serveurId)
    : lireTout<LigneTicket>('SELECT * FROM tickets WHERE serveur_id = ? AND statut = ? ORDER BY cree_le DESC LIMIT 500', serveurId, statut);
}

export function nombreTickets(serveurId: string, utilisateurId: string): number {
  return lire<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId)?.n ?? 0;
}

export function motifDe(serveurId: string, id: string): MotifTicket {
  const motifs = lireConfig(serveurId).tickets.categories;
  return motifs.find((c) => c.id === id) ?? { id, libelle: id, emoji: '🎫', description: '', style: 'Secondary', roles: [] };
}

/** Rôles qui voient un ticket : ceux de la catégorie, sinon les rôles staff tickets, sinon les rôles d'accès du bot. */
export function rolesAcces(serveur: Guild, categorie: MotifTicket): string[] {
  const reglages = lireConfig(serveur.id);
  const choisir = (ids: string[]) => ids.filter((id) => serveur.roles.cache.has(id));
  const depuisMotif = choisir(categorie.roles);
  const staff = choisir(reglages.tickets.rolesStaff);
  if (depuisMotif.length) return [...new Set([...depuisMotif, ...staff])];
  if (staff.length) return staff;
  return choisir([...reglages.permissions.support, ...reglages.permissions.staff, ...reglages.permissions.moderateur, ...reglages.permissions.admin]);
}

/** Staff d'un ticket : niveau Support+, ou porteur d'un rôle qui voit ce ticket. */
export function estStaffTicket(membre: GuildMember, ticket: LigneTicket): boolean {
  if (aNiveau(membre, Niveau.SUPPORT)) return true;
  const roles = rolesAcces(membre.guild, motifDe(membre.guild.id, ticket.categorie));
  return roles.some((r) => membre.roles.cache.has(r));
}

const AUTORISATIONS_MEMBRE = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

async function categorieTickets(serveur: Guild): Promise<CategoryChannel> {
  const reglages = lireConfig(serveur.id).tickets;
  const configure = reglages.categorieParenteId ? serveur.channels.cache.get(reglages.categorieParenteId) : null;
  const utilisable = (c: CategoryChannel | null | undefined) => c && c.type === ChannelType.GuildCategory && c.children.cache.size < 50;
  if (utilisable(configure as CategoryChannel)) return configure as CategoryChannel;
  const trouve = serveur.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('ticket') && c.children.cache.size < 50) as
    | CategoryChannel
    | undefined;
  if (trouve) return trouve;
  const cree = await serveur.channels.create({
    name: '🎫 Tickets',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: serveur.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
    reason: 'Catégorie des tickets',
  });
  if (!reglages.categorieParenteId) modifierConfig(serveur.id, (c) => void (c.tickets.categorieParenteId = cree.id));
  return cree;
}

async function trierSalons(categorie: CategoryChannel): Promise<void> {
  try {
    const salons = [...categorie.children.cache.values()].filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (salons.length < 2) return;
    const base = Math.min(...salons.map((c) => c.rawPosition));
    await categorie.guild.channels.setPositions(salons.map((c, i) => ({ channel: c.id, position: base + i })));
  } catch (echec) {
    registre.debogage(`Tri des tickets impossible : ${(echec as Error).message}`);
  }
}

export interface TicketCree {
  salon: TextChannel;
  ticket: LigneTicket;
  categorie: MotifTicket;
  rolesMentionnes: string[];
}

export async function creerTicket(membre: GuildMember, categorieId: string, sujet: string | null = null): Promise<TicketCree> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).tickets;
  const categorie = reglages.categories.find((c) => c.id === categorieId);
  if (!categorie) throw new ErreurUtilisateur('Ce motif de ticket n’existe plus.');
  const ouvrir = ticketsOuvertsDe(serveur.id, membre.id);
  if (ouvrir.length >= reglages.ouvertsMaxParMembre) {
    throw new ErreurUtilisateur(`Tu as déjà ${ouvrir.length} ticket(s) ouvert(s) : ${ouvrir.map((t) => `<#${t.salon_id}>`).join(', ')}`);
  }
  const moi = serveur.members.me;
  if (!moi?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new ErreurUtilisateur('Il me faut la permission « Gérer les salons » pour créer un ticket.');

  const parent = await categorieTickets(serveur);
  const base = `${identifiantDepuisTexte(categorie.id, 20)}-${identifiantDepuisTexte(membre.user.username, 60)}`;
  const nom = serveur.channels.cache.some((c) => c.name === base) ? `${base}-${Math.random().toString(36).slice(2, 5)}` : base;
  const roles = rolesAcces(serveur, categorie);

  const permissionsSalon: OverwriteResolvable[] = [
    { id: serveur.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: membre.id, allow: AUTORISATIONS_MEMBRE },
    { id: moi.id, allow: [...AUTORISATIONS_MEMBRE, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ...roles.map((id) => ({ id, allow: AUTORISATIONS_MEMBRE })),
  ];
  // Whitelists support/staff par ID : elles voient aussi les tickets (plafonné pour rester sous la limite Discord).
  const membresWhitelists = [...new Set([...membresListe('support', serveur.id), ...membresListe('staff', serveur.id)])].filter((id) => serveur.members.cache.has(id) && id !== membre.id).slice(0, 30);
  for (const id of membresWhitelists) permissionsSalon.push({ id, allow: AUTORISATIONS_MEMBRE });

  const numero = modifierConfig(serveur.id, (c) => void (c.tickets.counter += 1)).tickets.counter;
  const salon = await serveur.channels.create({
    name: nom,
    type: ChannelType.GuildText,
    parent: parent.id,
    topic: `Ticket #${numero} ouvert par ${membre.id} | catégorie : ${categorie.id}`,
    permissionOverwrites: permissionsSalon,
    reason: `Ticket de ${membre.user.tag}`,
  });

  const r = executer(
    'INSERT INTO tickets (serveur_id, numero, salon_id, utilisateur_id, categorie, sujet, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
    serveur.id,
    numero,
    salon.id,
    membre.id,
    categorie.id,
    sujet,
    Date.now(),
  );
  salonsTickets.add(salon.id);
  void trierSalons(parent);

  const ticket = ticketDuSalon(salon.id)!;
  historiser(serveur.id, 'ticket', 'open', membre.id, membre.id, { ticketId: r.lastInsertRowid, category: categorie.id });
  void journal(serveur, 'ticket', {
    titre: 'Ticket ouvert',
    ton: 'ok',
    lignes: [`**Ticket** : <#${salon.id}> \`#${salon.name}\``, `**Catégorie** : ${categorie.emoji} ${categorie.libelle}`, `**Ouvert par** : <@${membre.id}>`],
    par: membre.user,
  });
  const rolesMentionnes = categorie.roles.filter((id) => serveur.roles.cache.has(id));
  return { salon, ticket, categorie, rolesMentionnes };
}

/** Génère le transcript, l'envoie dans ticket-logs et en MP au créateur. */
export async function archiverTranscript(serveur: Guild, salon: TextChannel, ticket: LigneTicket, fermePar: User): Promise<{ messages: number; mpEnvoye: boolean }> {
  const messages = await recupererMessages(salon);
  const categorie = motifDe(serveur.id, ticket.categorie);
  const html = construireTranscript(salon, messages, { sousTitre: `${categorie.libelle} · ouvert par ${ticket.utilisateur_id}` });
  const nomFichier = `transcript-${salon.name}.html`;

  await journal(serveur, 'ticket', {
    titre: 'Ticket fermé',
    ton: 'neutre',
    lignes: [`**#${salon.name}** · ${messages.length} message${messages.length > 1 ? 's' : ''} · transcript en pièce jointe`],
    champs: [
      { name: 'Ouvert par', value: `<@${ticket.utilisateur_id}>` },
      { name: 'Fermé par', value: `<@${fermePar.id}>` },
      { name: 'Motif', value: `${categorie.emoji} ${categorie.libelle}` },
      { name: 'Pris en charge', value: ticket.pris_par ? `<@${ticket.pris_par}>` : '—' },
      { name: 'Durée', value: `<t:${Math.floor(ticket.cree_le / 1000)}:R>` },
    ],
    fichiers: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: nomFichier })],
    par: fermePar,
  });

  let mpEnvoye = false;
  if (lireConfig(serveur.id).tickets.transcriptAuMembre) {
    const createur = await serveur.client.users.fetch(ticket.utilisateur_id).catch(() => null);
    if (createur && !createur.bot) {
      const embed = new EmbedBuilder()
        .setColor(couleurPour(serveur))
        .setTitle('🎫 Ton ticket est fermé')
        .setDescription('Toute la conversation est dans le fichier joint — garde-le si tu en as besoin.')
        .addFields({ name: 'Motif', value: categorie.libelle, inline: true }, { name: 'Salon', value: `\`${salon.name}\``, inline: true })
        .setFooter({ text: `${nomEnseigne(serveur)} · transcript du ticket` })
        .setTimestamp();
      mpEnvoye = await createur
        .send({ embeds: [embed], files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: nomFichier })] })
        .then(() => true)
        .catch(() => false);
    }
  }
  return { messages: messages.length, mpEnvoye };
}

export function marquerFerme(ticket: LigneTicket, fermePar: string): void {
  executer("UPDATE tickets SET statut = 'closed', ferme_le = ?, ferme_par = ? WHERE id = ?", Date.now(), fermePar, ticket.id);
  historiser(ticket.serveur_id, 'ticket', 'close', ticket.utilisateur_id, fermePar, { ticketId: ticket.id });
}

export function marquerSupprime(salonId: string): void {
  executer("UPDATE tickets SET statut = 'deleted', ferme_le = COALESCE(ferme_le, ?) WHERE salon_id = ?", Date.now(), salonId);
  salonsTickets.delete(salonId);
}

export function marquerRouvert(ticket: LigneTicket): void {
  executer("UPDATE tickets SET statut = 'open', ferme_le = NULL, ferme_par = NULL WHERE id = ?", ticket.id);
  historiser(ticket.serveur_id, 'ticket', 'reopen', ticket.utilisateur_id, null, { ticketId: ticket.id });
}

export function marquerPris(ticket: LigneTicket, staffId: string | null): void {
  executer('UPDATE tickets SET pris_par = ? WHERE id = ?', staffId, ticket.id);
  historiser(ticket.serveur_id, 'ticket', staffId ? 'claim' : 'unclaim', ticket.utilisateur_id, staffId, { ticketId: ticket.id });
}

/** Ferme l'accès en écriture du créateur (mode archive). */
export async function verrouillerCreateur(salon: TextChannel, ticket: LigneTicket, ouvrir: boolean): Promise<void> {
  await salon.permissionOverwrites.edit(ticket.utilisateur_id, { SendMessages: ouvrir, ViewChannel: true }, { reason: ouvrir ? 'Ticket rouvert' : 'Ticket fermé' }).catch(() => undefined);
}

export function stockerMessageTicket(ticketId: number, messageId: string, auteurId: string, pseudoAuteur: string, contenu: string, attachments: string[]): void {
  executer(
    'INSERT INTO messages_tickets (ticket_id, message_id, auteur_id, auteur_pseudo, contenu, pieces_jointes, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ticketId,
    messageId,
    auteurId,
    pseudoAuteur,
    contenu.slice(0, 4000),
    JSON.stringify(attachments.slice(0, 10)),
    Date.now(),
  );
}

export function rolesAuDessusDuBot(serveur: Guild, ids: string[]): string[] {
  return ids.filter((id) => {
    const role = serveur.roles.cache.get(id);
    return role && !botPeutGererRole(serveur, role);
  });
}
