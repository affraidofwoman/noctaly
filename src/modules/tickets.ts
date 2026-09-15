import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type CategoryChannel,
  ChannelType,
  type Collection,
  ContainerBuilder,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  MessageFlags,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  PermissionFlagsBits,
  type RepliableInteraction,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type TextChannel,
  TextDisplayBuilder,
  type User,
  UserSelectMenuBuilder,
} from 'discord.js';
import { aNiveau, botPeutGererRole, emojiPour, enHexa, enseigneDe, membresListe } from '../coeur/acces';
import {
  bouton,
  construireFormulaire,
  couleurPour,
  demanderConfirmation,
  embedEnseigne,
  info,
  lignesEnPages,
  nomEnseigne,
  ok,
  paginer,
  rangee,
  remplirModele,
  repondre,
} from '../coeur/affichage';
import { afficherPage, lirePageReglage, type PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import { creerRegistre, ErreurUtilisateur, identifiantDepuisTexte, marqueTemps, tronquer, Niveau } from '../coeur/outils';
import { lireConfig, modifierConfig, type MotifTicket, type StyleBoutonTicket } from '../coeur/reglages';

export function echapperHtml(texte: string): string {
  return texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function recupererMessages(salon: GuildTextBasedChannel, max = 5000): Promise<Message[]> {
  const recuperes: Message[] = [];
  let avant: string | undefined;
  while (recuperes.length < max) {
    const lot: Collection<string, Message> | null = await salon.messages.fetch({ limit: 100, before: avant }).catch(() => null);
    if (!lot || lot.size === 0) break;
    recuperes.push(...lot.values());
    avant = lot.last()!.id;
    if (lot.size < 100) break;
  }
  return recuperes.reverse();
}

function rendreContenu(echappe: string, serveur: Guild): string {
  return echappe
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;a?:(\w{2,32}):(\d{15,25})&gt;/g, (_m, nom: string, id: string) => `<img class="emo" src="https://cdn.discordapp.com/emojis/${id}.webp?size=44&amp;animated=true" alt=":${nom}:" title=":${nom}:" loading="lazy"/>`)
    .replace(/&lt;@!?(\d{15,25})&gt;/g, (_m, id: string) => {
      const membre = serveur.members.cache.get(id);
      const nom = membre?.displayName ?? serveur.client.users.cache.get(id)?.username ?? id;
      return `<span class="mention">@${echapperHtml(nom)}</span>`;
    })
    .replace(/&lt;@&amp;(\d{15,25})&gt;/g, (_m, id: string) => {
      const role = serveur.roles.cache.get(id);
      if (!role) return '<span class="mention">@rôle</span>';
      const couleur = role.hexColor !== '#000000' ? role.hexColor : '#a68cff';
      return `<span class="mention role" style="color:${couleur};background:${couleur}22;border:1px solid ${couleur}55">@${echapperHtml(role.name)}</span>`;
    })
    .replace(/&lt;#(\d{15,25})&gt;/g, (_m, id: string) => `<span class="mention salon">#${echapperHtml(serveur.channels.cache.get(id)?.name ?? 'salon')}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function rendreMessage(m: Message, serveur: Guild): string {
  const heure = new Date(m.createdTimestamp).toLocaleString('fr-FR');
  const auteur = echapperHtml(m.member?.displayName ?? m.author.globalName ?? m.author.username);
  const avatar = echapperHtml(m.author.displayAvatarURL({ size: 64 }));
  const bot = m.author.bot ? '<span class="tag-bot">BOT</span>' : '';
  const textes: string[] = [];
  if (m.content) textes.push(rendreContenu(echapperHtml(m.content), serveur));
  for (const embed of m.embeds) {
    const parties = [embed.title ? `<b>${echapperHtml(embed.title)}</b>` : '', embed.description ? rendreContenu(echapperHtml(embed.description), serveur) : ''];
    for (const f of embed.fields) parties.push(`<b>${echapperHtml(f.name)}</b><br/>${rendreContenu(echapperHtml(f.value), serveur)}`);
    const couleur = embed.hexColor ?? '#7b5cff';
    textes.push(`<div class="embed" style="border-left-color:${couleur}">${parties.filter(Boolean).join('<br/>')}</div>`);
  }
  const attachments = [...m.attachments.values()]
    .map((a) => {
      const url = echapperHtml(a.url);
      const nom = echapperHtml(a.name || 'fichier');
      return /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
        ? `<a class="att-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${nom}" loading="lazy"/></a>`
        : `<a class="att-file" href="${url}" target="_blank" rel="noopener">📎 ${nom}</a>`;
    })
    .join('');
  return `<div class="msg"><img class="avatar" src="${avatar}" alt="" loading="lazy"/><div class="corps"><div class="tete"><span class="auteur">${auteur}</span>${bot}<span class="heure">${heure}</span></div>${textes.map((t) => `<div class="texte">${t}</div>`).join('')}${attachments ? `<div class="pjs">${attachments}</div>` : ''}</div></div>`;
}

function style(accent: string): string {
  return `
:root{--neon:${accent};--void:#07080d;--panneau:#0e1018;--bord:#241b4d;--texte:#e7e6f5;--doux:#9a97c0;--cyan:#46c8ff;}
*{box-sizing:border-box;}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#14122b 0%,var(--void) 60%) fixed;color:var(--texte);font-family:"gg sans","Segoe UI",system-ui,Arial,sans-serif;}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 64px;}
.entete{border:1px solid var(--bord);border-radius:16px;padding:20px 24px;background:linear-gradient(180deg,${accent}1a,${accent}00);box-shadow:0 0 40px ${accent}26;margin-bottom:20px;}
.marque{display:flex;align-items:center;gap:12px;}
.logo{width:36px;height:36px;border-radius:10px;object-fit:cover;}
.titre{font-size:19px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;}
.salon{margin-top:12px;font-size:15px;color:var(--neon);font-weight:700;}
.meta{margin-top:3px;font-size:12.5px;color:var(--doux);}
.msg{display:flex;gap:12px;padding:11px 10px;border-radius:12px;}
.msg:hover{background:${accent}0d;}
.avatar{width:40px;height:40px;border-radius:50%;flex:0 0 auto;border:1px solid var(--bord);object-fit:cover;}
.corps{min-width:0;flex:1;}
.tete{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.auteur{font-weight:700;color:#fff;}
.tag-bot{font-size:10px;font-weight:800;background:var(--neon);color:#fff;padding:1px 5px;border-radius:4px;}
.heure{font-size:11.5px;color:var(--doux);}
.texte{margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;}
.texte a{color:var(--cyan);text-decoration:none;}
.embed{border-left:4px solid var(--neon);background:var(--panneau);padding:8px 12px;border-radius:6px;margin-top:4px;}
.emo{width:1.35em;height:1.35em;vertical-align:-.28em;object-fit:contain;}
.mention{background:${accent}29;color:#fff;border-radius:4px;padding:0 3px;font-weight:600;}
.mention.salon{background:rgba(70,200,255,.13);color:var(--cyan);}
.pjs{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;}
.att-img img{max-width:260px;max-height:220px;border-radius:10px;border:1px solid var(--bord);display:block;}
.att-file{display:inline-block;padding:8px 12px;border:1px solid var(--bord);border-left:3px solid var(--neon);border-radius:8px;color:#fff;text-decoration:none;font-size:13px;background:var(--panneau);}
.vide{text-align:center;color:var(--doux);padding:48px 0;}
`;
}

export interface OptionsTranscript {
  titre?: string;
  sousTitre?: string;
}

export function construireTranscript(salon: GuildTextBasedChannel, messages: Message[], options: OptionsTranscript = {}): string {
  const serveur = salon.guild;
  const enseigne = enseigneDe(serveur.id);
  const accent = enHexa(enseigne.couleur);
  const nom = echapperHtml(enseigne.cle ? enseigne.nom : serveur.name);
  const logo = enseigne.logo ?? serveur.iconURL({ size: 64 });
  const corps = messages.length ? messages.map((m) => rendreMessage(m, serveur)).join('\n') : '<div class="vide">Aucun message.</div>';
  const titre = echapperHtml(options.titre ?? `Transcript — ${salon.name}`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${titre}</title><style>${style(accent)}</style></head><body>
<div class="wrap">
  <div class="entete">
    <div class="marque">${logo ? `<img class="logo" src="${echapperHtml(logo)}" alt=""/>` : ''}<div class="titre">${nom}</div></div>
    <div class="salon"># ${echapperHtml(salon.name)}</div>
    <div class="meta">${messages.length} message${messages.length > 1 ? 's' : ''} · transcript généré le ${new Date().toLocaleString('fr-FR')}</div>
    ${options.sousTitre ? `<div class="meta">${echapperHtml(options.sousTitre)}</div>` : ''}
  </div>
  ${corps}
</div>
</body></html>`;
}

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

export function rolesAcces(serveur: Guild, categorie: MotifTicket): string[] {
  const reglages = lireConfig(serveur.id);
  const choisir = (ids: string[]) => ids.filter((id) => serveur.roles.cache.has(id));
  const depuisMotif = choisir(categorie.roles);
  const staff = choisir(reglages.tickets.rolesStaff);
  if (depuisMotif.length) return [...new Set([...depuisMotif, ...staff])];
  if (staff.length) return staff;
  return choisir([...reglages.permissions.support, ...reglages.permissions.staff, ...reglages.permissions.moderateur, ...reglages.permissions.admin]);
}

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
  const membresWhitelists = [...new Set([...membresListe('support', serveur.id), ...membresListe('staff', serveur.id)])].filter((id) => serveur.members.cache.has(id) && id !== membre.id).slice(0, 30);
  for (const id of membresWhitelists) permissionsSalon.push({ id, allow: AUTORISATIONS_MEMBRE });

  const numero = modifierConfig(serveur.id, (c) => void (c.tickets.compteur += 1)).tickets.compteur;
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
      { nom: 'Ouvert par', valeur: `<@${ticket.utilisateur_id}>` },
      { nom: 'Fermé par', valeur: `<@${fermePar.id}>` },
      { nom: 'Motif', valeur: `${categorie.emoji} ${categorie.libelle}` },
      { nom: 'Pris en charge', valeur: ticket.pris_par ? `<@${ticket.pris_par}>` : '—' },
      { nom: 'Durée', valeur: `<t:${Math.floor(ticket.cree_le / 1000)}:R>` },
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

const STYLES: Record<StyleBoutonTicket, ButtonStyle> = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

// - Panneau -

function variables(serveur: Guild) {
  return { guild: serveur, extra: { enseigne: nomEnseigne(serveur) } };
}

export function construirePanneau(serveur: Guild): MessageCreateOptions {
  const reglages = lireConfig(serveur.id).tickets;
  const titre = remplirModele(reglages.titrePanneau, variables(serveur));
  const intro = remplirModele(reglages.introPanneau, variables(serveur));
  const pied = remplirModele(reglages.piedPanneau, variables(serveur));
  const categories = reglages.categories.slice(0, 20);

  if (reglages.stylePanneau === 'v2') {
    const conteneur = new ContainerBuilder().setAccentColor(couleurPour(serveur));
    conteneur.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${titre}`), new TextDisplayBuilder().setContent(intro));
    conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    categories.forEach((motif, i) => {
      if (i > 0) conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
      conteneur.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${motif.emoji} **${motif.libelle}**\n-# ${motif.description || '—'}`))
          .setButtonAccessory(new ButtonBuilder().setCustomId(`tk:open:${motif.id}`).setLabel('Ouvrir').setStyle(STYLES[motif.style] ?? ButtonStyle.Secondary)),
      );
    });
    conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    conteneur.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${pied}`));
    return { components: [conteneur], flags: MessageFlags.IsComponentsV2 };
  }

  const embed = embedEnseigne(serveur)
    .setTitle(titre.slice(0, 256))
    .setDescription(tronquer([intro, '', ...categories.map((c) => `${c.emoji} **${c.libelle}** — ${c.description}`)].join('\n'), 4096))
    .setFooter({ text: pied.slice(0, 2048) });

  if (reglages.stylePanneau === 'menu') {
    return { embeds: [embed], components: [rangee(bouton('tk:menu', 'Ouvrir un ticket', ButtonStyle.Primary, emojiPour(serveur.id, 'ticket')))] };
  }
  const boutons = categories.map((c) => bouton(`tk:open:${c.id}`, c.libelle, STYLES[c.style] ?? ButtonStyle.Secondary, c.emoji));
  const rangees: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < boutons.length && rangees.length < 5; i += 3) rangees.push(rangee(...boutons.slice(i, i + 3)));
  return { embeds: [embed], components: rangees };
}

async function publierPanneau(salon: GuildTextBasedChannel): Promise<string> {
  const envoye = await salon.send(construirePanneau(salon.guild));
  modifierConfig(salon.guild.id, (c) => void (c.tickets.salonPanneauId = salon.id));
  return envoye.url;
}

function menuMotifs(serveur: Guild) {
  const motifs = lireConfig(serveur.id).tickets.categories.slice(0, 25);
  return rangee(
    new StringSelectMenuBuilder()
      .setCustomId('tk:pick')
      .setPlaceholder('Quel est le sujet ?')
      .addOptions(motifs.map((c) => ({ label: c.libelle, value: c.id, emoji: c.emoji, description: tronquer(c.description || c.libelle, 100) }))),
  );
}

// - Contrôles dans le ticket -

function controlesOuvert(serveurId: string, pris: boolean) {
  return [
    rangee(
      bouton('tk:close', 'Fermer', ButtonStyle.Danger, '🔒'),
      bouton('tk:claim', pris ? 'Libérer' : 'Claim', ButtonStyle.Success, '📌'),
      bouton('tk:add', 'Ajouter', ButtonStyle.Secondary, '👤'),
      bouton('tk:remove', 'Retirer', ButtonStyle.Secondary, '❌'),
      bouton('tk:transcript', '', ButtonStyle.Secondary, emojiPour(serveurId, 'message')),
    ),
  ];
}

function controlesFerme() {
  return [
    rangee(
      bouton('tk:reopen', 'Rouvrir', ButtonStyle.Success, '🔓'),
      bouton('tk:transcript', 'Transcript', ButtonStyle.Secondary, '📄'),
      bouton('tk:delete', 'Supprimer', ButtonStyle.Danger, '🗑️'),
    ),
  ];
}

async function ouvrirTicket(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, categorieId: string) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { salon, categorie, rolesMentionnes, ticket } = await creerTicket(interaction.member, categorieId);
  const reglages = lireConfig(interaction.guild.id).tickets;
  const embed = embedEnseigne(interaction.guild)
    .setTitle(remplirModele(reglages.titreBienvenue, variables(interaction.guild)).slice(0, 256))
    .setDescription(tronquer(remplirModele(reglages.messageBienvenue, { membre: interaction.member, serveur: interaction.guild, extra: { brand: nomEnseigne(interaction.guild) } }), 4096))
    .addFields({ name: `${emojiPour(interaction.guild.id, 'ticket')} Motif`, value: `${categorie.emoji} ${categorie.libelle}`, inline: true }, { name: 'Numéro', value: `#${ticket.numero}`, inline: true })
    .setFooter({ text: reglages.piedBienvenue || nomEnseigne(interaction.guild) })
    .setTimestamp();
  await salon.send({
    content: [`<@${interaction.user.id}>`, ...rolesMentionnes.map((id) => `<@&${id}>`)].join(' '),
    embeds: [embed],
    components: controlesOuvert(interaction.guild.id, false),
    allowedMentions: { users: [interaction.user.id], roles: rolesMentionnes },
  });
  await interaction.editReply({ embeds: [ok(interaction.guild, `Ticket créé : <#${salon.id}>`, { titre: 'Ticket', sujet: emojiPour(interaction.guild.id, 'ticket') })] });
}

function exigerTicket(salonId: string | null): LigneTicket {
  const ticket = salonId ? ticketDuSalon(salonId) : undefined;
  if (!ticket) throw new ErreurUtilisateur('Cette action se fait dans un salon de ticket.');
  return ticket;
}

function exigerStaff(membre: GuildMember, ticket: LigneTicket): void {
  if (!estStaffTicket(membre, ticket)) throw new ErreurUtilisateur('Réservé au staff des tickets.');
}

async function fermerTicket(interaction: ButtonInteraction<'cached'> | import('discord.js').ChatInputCommandInteraction<'cached'>, ticket: LigneTicket) {
  const salon = interaction.channel as TextChannel;
  const serveur = interaction.guild;
  const mode = lireConfig(serveur.id).tickets.modeFermeture;
  if (ticket.utilisateur_id !== interaction.user.id && !estStaffTicket(interaction.member, ticket)) throw new ErreurUtilisateur('Seul le créateur ou le staff peut fermer ce ticket.');
  if (ticket.statut === 'closed') throw new ErreurUtilisateur('Ce ticket est déjà fermé.');

  const executer = async (i: RepliableInteraction) => {
    await repondre(i, { embeds: [info(serveur, 'Fermeture du ticket en cours…', { emoji: emojiPour(serveur.id, 'ticket') })] });
    marquerFerme(ticket, interaction.user.id);
    const { messages, mpEnvoye } = await archiverTranscript(serveur, salon, ticket, interaction.user);
    if (mode === 'delete') {
      await salon.send({ embeds: [info(serveur, `Transcript enregistré (${messages} messages)${mpEnvoye ? ', envoyé en MP' : ''}. Suppression du salon…`)] }).catch(() => undefined);
      setTimeout(() => {
        marquerSupprime(salon.id);
        void salon.delete(`Ticket fermé par ${interaction.user.tag}`).catch(() => undefined);
      }, 3_000).unref();
      return;
    }
    await verrouillerCreateur(salon, ticket, false);
    await salon.setName(`fermé-${salon.name}`.slice(0, 100)).catch(() => undefined);
    await salon.send({
      embeds: [
        embedEnseigne(serveur)
          .setTitle('🔒 Ticket fermé')
          .setDescription(`Fermé par <@${interaction.user.id}> · ${messages} messages archivés${mpEnvoye ? ' · transcript envoyé en MP' : ''}.`),
      ],
      components: controlesFerme(),
    });
  };

  await demanderConfirmation(interaction, {
    titre: 'Fermer le ticket ?',
    description: mode === 'delete' ? 'Le transcript est enregistré puis le salon est supprimé.' : 'Le transcript est enregistré et le salon est archivé.',
    libelleConfirmation: 'Fermer',
    surConfirmation: async (i) => {
      await i.update({ embeds: [info(serveur, 'C’est parti.')], components: [] });
      await executer(i);
    },
  });
}

async function envoyerTranscriptPrive(interaction: RepliableInteraction, salon: TextChannel) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = await recupererMessages(salon);
  const html = construireTranscript(salon, messages);
  await interaction.editReply({
    embeds: [ok(interaction.guild, `${messages.length} message(s).`, { titre: 'Transcript' })],
    files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${salon.name}.html` })],
  });
}

function ecranMotifs(serveur: Guild, note?: string) {
  const motifs = lireConfig(serveur.id).tickets.categories;
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'cle')} Qui voit les tickets`)
    .setDescription(note ?? 'Choisis une catégorie pour changer ses rôles, son texte ou la supprimer.\n-# Sans rôle, ce sont les rôles staff des tickets puis les rôles d’accès du bot qui prennent le relais.');
  for (const c of motifs.slice(0, 24)) {
    const bloques = rolesAuDessusDuBot(serveur, c.roles);
    embed.addFields({
      name: `${c.emoji} ${c.libelle}`,
      value: tronquer(`${c.roles.length ? c.roles.map((r) => `<@&${r}>`).join(' ') : '*rôles par défaut*'}${bloques.length ? '\n⚠️ rôle(s) introuvable(s) ou au-dessus du bot' : ''}\n-# \`${c.id}\` · ${c.style}`, 1024),
      inline: true,
    });
  }
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (motifs.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('tkc:open')
          .setPlaceholder('Catégorie de ticket à configurer')
          .addOptions(motifs.slice(0, 25).map((c) => ({ label: c.libelle, value: c.id, emoji: c.emoji, description: `${c.roles.length} rôle(s)` }))),
      ),
    );
  }
  composants.push(
    rangee(
      bouton('tkc:new', 'Ajouter une catégorie', ButtonStyle.Success, '➕').setDisabled(motifs.length >= 20),
      bouton('tkc:back', 'Retour aux réglages', ButtonStyle.Secondary, '⬅️'),
    ),
  );
  return { embeds: [embed], components: composants };
}

function ecranMotif(serveur: Guild, id: string, note?: string) {
  const motif = lireConfig(serveur.id).tickets.categories.find((c) => c.id === id);
  if (!motif) return ecranMotifs(serveur, '⚠️ Cette catégorie n’existe plus.');
  const embed = embedEnseigne(serveur)
    .setTitle(`${motif.emoji} ${motif.libelle}`)
    .setDescription(
      [
        note,
        motif.description,
        '',
        `**Rôles** : ${motif.roles.length ? motif.roles.map((r) => `<@&${r}>`).join(' ') : '*par défaut*'}`,
        '-# Eux et le membre, personne d’autre. Ils sont mentionnés à l’ouverture.',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const menu = new RoleSelectMenuBuilder().setCustomId(`tkc:roles:${motif.id}`).setPlaceholder('Rôles ayant accès (aucun = par défaut)').setMinValues(0).setMaxValues(10);
  const valides = motif.roles.filter((r) => serveur.roles.cache.has(r));
  if (valides.length) menu.setDefaultRoles(...valides);
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`tkc:edit:${motif.id}`, 'Modifier', ButtonStyle.Primary, '✏️'),
        bouton(`tkc:del:${motif.id}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
        bouton('tkc:home', 'Toutes les catégories', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function lireStyle(brut: string): StyleBoutonTicket {
  const v = brut.trim().toLowerCase();
  if (['rouge', 'danger', 'red'].includes(v)) return 'Danger';
  if (['vert', 'success', 'green'].includes(v)) return 'Success';
  if (['bleu', 'primary', 'blue', 'violet', 'blurple'].includes(v)) return 'Primary';
  return 'Secondary';
}

const LIBELLE_STYLE: Record<StyleBoutonTicket, string> = { Primary: 'bleu', Secondary: 'gris', Success: 'vert', Danger: 'rouge' };

// - Setup -

const pages: PageReglage[] = [
  {
    id: 'tickets',
    section: 'tickets',
    titre: 'Tickets',
    emoji: '🎫',
    moduleId: 'tickets',
    ordre: 1,
    description: 'Le panneau, la catégorie Discord des tickets et le staff qui les voit.\n-# Les transcripts partent dans `#ticket-logs`.',
    champs: [
      { genre: 'channel', cle: 'panel', libelle: 'Salon du panneau', lire: (c) => c.tickets.salonPanneauId, ecrire: (c, v) => void (c.tickets.salonPanneauId = v) },
      {
        genre: 'channel',
        cle: 'parent',
        libelle: 'Catégorie des tickets',
        channelTypes: [ChannelType.GuildCategory],
        lire: (c) => c.tickets.categorieParenteId,
        ecrire: (c, v) => void (c.tickets.categorieParenteId = v),
      },
      { genre: 'roles', cle: 'staff', libelle: 'Rôles staff (tous les tickets)', max: 10, lire: (c) => c.tickets.rolesStaff, ecrire: (c, v) => void (c.tickets.rolesStaff = v) },
      { genre: 'toggle', cle: 'dm', libelle: 'Transcript en MP', lire: (c) => c.tickets.transcriptAuMembre, ecrire: (c, v) => void (c.tickets.transcriptAuMembre = v) },
      {
        genre: 'toggle',
        cle: 'delete',
        libelle: 'Supprimer à la fermeture',
        lire: (c) => c.tickets.modeFermeture === 'delete',
        ecrire: (c, v) => void (c.tickets.modeFermeture = v ? 'delete' : 'archive'),
      },
      { genre: 'number', cle: 'max', libelle: 'Tickets ouverts max par membre', min: 1, max: 10, lire: (c) => c.tickets.ouvertsMaxParMembre, ecrire: (c, v) => void (c.tickets.ouvertsMaxParMembre = v) },
      { genre: 'text', cle: 'wfooter', libelle: 'Pied du message d’ouverture', longueurMax: 200, lire: (c) => c.tickets.piedBienvenue, ecrire: (c, v) => void (c.tickets.piedBienvenue = v) },
    ],
    actions: [
      {
        id: 'publish',
        libelle: 'Publier le panneau',
        emoji: '📤',
        async executer(interaction) {
          const salon = resoudreSalonTexte(interaction.guild, lireConfig(interaction.guildId).tickets.salonPanneauId);
          if (!salon) throw new ErreurUtilisateur('Choisis d’abord le salon du panneau (et vérifie que je peux y écrire).');
          const url = await publierPanneau(salon);
          await interaction.reply({ embeds: [ok(interaction.guild, `Panneau posté : ${url}`)], flags: MessageFlags.Ephemeral });
        },
      },
      {
        id: 'cats',
        libelle: 'Catégories & rôles',
        emoji: '🔑',
        async executer(interaction) {
          await interaction.update(ecranMotifs(interaction.guild));
        },
      },
    ],
  },
  {
    id: 'tickets-look',
    section: 'tickets',
    titre: 'Tickets — textes',
    emoji: '📝',
    ordre: 2,
    description: 'L’apparence du panneau et du message d’ouverture.\n-# Variables : `{brand}` `{server}` `{mention}` `{user}`',
    champs: [
      {
        genre: 'choice',
        cle: 'style',
        libelle: 'Style du panneau',
        options: [
          { valeur: 'buttons', libelle: 'Un bouton par motif', emoji: '🔘' },
          { valeur: 'v2', libelle: 'Sections avec bouton « Ouvrir »', emoji: '🧩' },
          { valeur: 'menu', libelle: 'Un bouton puis « Quel est le sujet ? »', emoji: '📋' },
        ],
        lire: (c) => c.tickets.stylePanneau,
        ecrire: (c, v) => void (c.tickets.stylePanneau = v as 'buttons' | 'v2' | 'menu'),
      },
      { genre: 'text', cle: 'ptitle', libelle: 'Titre du panneau', longueurMax: 200, obligatoire: true, lire: (c) => c.tickets.titrePanneau, ecrire: (c, v) => void (c.tickets.titrePanneau = v) },
      { genre: 'text', cle: 'pintro', libelle: 'Phrase du panneau', long: true, longueurMax: 1000, lire: (c) => c.tickets.introPanneau, ecrire: (c, v) => void (c.tickets.introPanneau = v) },
      { genre: 'text', cle: 'pfooter', libelle: 'Pied du panneau', longueurMax: 200, lire: (c) => c.tickets.piedPanneau, ecrire: (c, v) => void (c.tickets.piedPanneau = v) },
      { genre: 'text', cle: 'wtitle', libelle: 'Titre à l’ouverture', longueurMax: 200, obligatoire: true, lire: (c) => c.tickets.titreBienvenue, ecrire: (c, v) => void (c.tickets.titreBienvenue = v) },
      { genre: 'text', cle: 'wmessage', libelle: 'Message à l’ouverture', long: true, longueurMax: 2000, obligatoire: true, lire: (c) => c.tickets.messageBienvenue, ecrire: (c, v) => void (c.tickets.messageBienvenue = v) },
    ],
  },
];

// - Commandes -

function pagesTickets(serveur: Guild, statut: 'open' | 'closed' | 'all') {
  const rangees = listerTickets(serveur.id, statut);
  const lignes = rangees.map((t) => {
    const motif = motifDe(serveur.id, t.categorie);
    const etat = t.statut === 'open' ? '🟢' : '🔒';
    return `${etat} **#${t.numero}** <#${t.salon_id}> — ${motif.emoji} ${motif.libelle} · <@${t.utilisateur_id}> · ${marqueTemps(t.cree_le, 'R')}${t.pris_par ? ` · 📌 <@${t.pris_par}>` : ''}`;
  });
  if (!lignes.length) lignes.push('*Aucun ticket.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) =>
    embedEnseigne(serveur).setTitle(`🎫 Tickets (${rangees.length})`).setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }),
  );
}

const commandeTicket: CommandeSlash = {
  categorie: 'tickets',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Les tickets')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les tickets'))
    .addSubcommand((s) => s.setName('config').setDescription('Réglages tickets'))
    .addSubcommand((s) =>
      s
        .setName('panneau')
        .setDescription('Poster le panneau')
        .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('close').setDescription('Fermer ce ticket'))
    .addSubcommand((s) => s.setName('reopen').setDescription('Rouvrir ce ticket'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Ajouter au ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer du ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('claim').setDescription('Prendre le ticket'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Transcript du ticket'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Les tickets du serveur')
        .addStringOption((o) => o.setName('etat').setDescription('Lesquels').addChoices({ name: 'Ouverts', value: 'open' }, { name: 'Fermés', value: 'closed' }, { name: 'Tous', value: 'all' })),
    ),
  niveauxSousCommandes: {
    setup: Niveau.ADMIN,
    config: Niveau.ADMIN,
    panneau: Niveau.ADMIN,
    reopen: Niveau.SUPPORT,
    add: Niveau.SUPPORT,
    remove: Niveau.SUPPORT,
    claim: Niveau.SUPPORT,
    transcript: Niveau.SUPPORT,
    list: Niveau.SUPPORT,
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    switch (sousCommande) {
      case 'setup':
        return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('tickets')!), ephemeral: true });
      case 'config':
        return repondre(interaction, { ...ecranMotifs(serveur), ephemeral: true });
      case 'panneau': {
        const salon = (interaction.options.getChannel('salon') ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!salon) return;
        const url = await publierPanneau(salon);
        return repondre(interaction, { embeds: [ok(serveur, `Panneau posté : ${url}`)], ephemeral: true });
      }
      case 'list':
        return paginer(interaction, pagesTickets(serveur, (interaction.options.getString('etat') ?? 'open') as 'open' | 'closed' | 'all'), true);
    }
    const ticket = exigerTicket(interaction.channelId);
    const salon = interaction.channel as TextChannel;
    switch (sousCommande) {
      case 'close':
        return fermerTicket(interaction, ticket);
      case 'reopen':
        return rouvrir(interaction, ticket, salon);
      case 'claim':
        return prendreEnCharge(interaction, ticket);
      case 'transcript':
        return envoyerTranscriptPrive(interaction, salon);
      case 'add':
      case 'remove': {
        const utilisateur = interaction.options.getUser('membre', true);
        await reglerAccesMembre(serveur, salon, ticket, utilisateur.id, sousCommande === 'add', interaction.member);
        return repondre(interaction, { embeds: [ok(serveur, `<@${utilisateur.id}> ${sousCommande === 'add' ? 'ajouté au' : 'retiré du'} ticket.`)] });
      }
    }
  },
};

async function rouvrir(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: LigneTicket, salon: TextChannel) {
  exigerStaff(interaction.member, ticket);
  if (ticket.statut !== 'closed') throw new ErreurUtilisateur('Ce ticket est déjà ouvert.');
  marquerRouvert(ticket);
  salonsTickets.add(salon.id);
  await verrouillerCreateur(salon, ticket, true);
  if (salon.name.startsWith('fermé-')) await salon.setName(salon.name.slice('fermé-'.length)).catch(() => undefined);
  void journal(interaction.guild, 'ticket', { titre: 'Ticket rouvert', ton: 'ok', lignes: [`**Ticket** : <#${salon.id}>`], par: interaction.user });
  await repondre(interaction, { embeds: [ok(interaction.guild, `🔓 Ticket rouvert par <@${interaction.user.id}>.`)], components: controlesOuvert(interaction.guild.id, !!ticket.pris_par) });
}

async function prendreEnCharge(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: LigneTicket) {
  exigerStaff(interaction.member, ticket);
  if (ticket.pris_par && ticket.pris_par !== interaction.user.id && !aNiveau(interaction.member, Niveau.ADMIN)) {
    throw new ErreurUtilisateur(`Ce ticket est déjà pris en charge par <@${ticket.pris_par}>.`);
  }
  const liberer = ticket.pris_par === interaction.user.id;
  marquerPris(ticket, liberer ? null : interaction.user.id);
  void journal(interaction.guild, 'ticket', {
    titre: liberer ? 'Ticket libéré' : 'Ticket pris en charge',
    ton: 'info',
    lignes: [`**Ticket** : <#${ticket.salon_id}>`, `**Staff** : <@${interaction.user.id}>`],
    par: interaction.user,
  });
  await repondre(interaction, {
    embeds: [info(interaction.guild, liberer ? `📌 <@${interaction.user.id}> a libéré ce ticket.` : `📌 Ticket pris en charge par <@${interaction.user.id}>.`)],
    allowedMentions: { parse: [] },
  });
}

async function reglerAccesMembre(serveur: Guild, salon: TextChannel, ticket: LigneTicket, utilisateurId: string, ajouter: boolean, auteur: GuildMember) {
  exigerStaff(auteur, ticket);
  if (!ajouter && utilisateurId === ticket.utilisateur_id) throw new ErreurUtilisateur('Impossible de retirer le créateur du ticket.');
  if (ajouter) await salon.permissionOverwrites.edit(utilisateurId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  else await salon.permissionOverwrites.delete(utilisateurId);
  void journal(serveur, 'ticket', {
    titre: ajouter ? 'Membre ajouté au ticket' : 'Membre retiré du ticket',
    ton: 'info',
    lignes: [`**Ticket** : <#${salon.id}>`, `**Membre** : <@${utilisateurId}>`],
    par: auteur.user,
  });
}

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'ticket',
    domaine: 'general',
    categorie: 'tickets',
    description: 'Poster le panneau ici',
    niveau: Niveau.ADMIN,
    async executer(message) {
      await publierPanneau(message.channel);
      await message.delete().catch(() => undefined);
    },
  },
  {
    nom: 'tickets',
    domaine: 'general',
    categorie: 'tickets',
    description: 'Les tickets ouverts',
    niveau: Niveau.SUPPORT,
    async executer(message) {
      await message.reply({ embeds: [pagesTickets(message.guild, 'open')[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

// - Composants -

export const moduleTickets: ModuleBot = {
  id: 'tickets',
  nom: 'Tickets',
  emoji: '🎫',
  description: 'Panneau, salons privés, claim, transcripts HTML',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeTicket],
  commandesPrefixe,
  pagesReglage: pages,
  composants: [
    {
      prefixe: 'tk',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, argument]) {
        const serveur = interaction.guild;
        if (action === 'open' && argument) return ouvrirTicket(interaction, argument);
        if (action === 'menu') return interaction.reply({ components: [menuMotifs(serveur)], flags: MessageFlags.Ephemeral });
        const ticket = exigerTicket(interaction.channelId);
        const salon = interaction.channel as TextChannel;
        switch (action) {
          case 'close':
            return fermerTicket(interaction, ticket);
          case 'claim':
            return prendreEnCharge(interaction, ticket);
          case 'reopen':
            return rouvrir(interaction, ticket, salon);
          case 'transcript':
            exigerStaff(interaction.member, ticket);
            return envoyerTranscriptPrive(interaction, salon);
          case 'add':
          case 'remove':
            exigerStaff(interaction.member, ticket);
            return interaction.reply({
              components: [
                rangee(
                  new UserSelectMenuBuilder()
                    .setCustomId(`tk:${action}sel`)
                    .setPlaceholder(action === 'add' ? 'Qui ajouter ?' : 'Qui retirer ?')
                    .setMinValues(1)
                    .setMaxValues(5),
                ),
              ],
              flags: MessageFlags.Ephemeral,
            });
          case 'delete':
            exigerStaff(interaction.member, ticket);
            return demanderConfirmation(interaction, {
              titre: 'Supprimer le ticket ?',
              description: 'Le salon est supprimé définitivement (le transcript a déjà été enregistré à la fermeture).',
              libelleConfirmation: 'Supprimer',
              surConfirmation: async (i) => {
                await i.update({ embeds: [info(serveur, 'Suppression…')], components: [] });
                marquerSupprime(salon.id);
                void journal(serveur, 'ticket', { titre: 'Ticket supprimé', ton: 'alerte', lignes: [`**Ticket** : \`#${salon.name}\``], par: i.user });
                setTimeout(() => void salon.delete(`Ticket supprimé par ${i.user.tag}`).catch(() => undefined), 2_000).unref();
              },
            });
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action]) {
        if (action === 'pick' && interaction.isStringSelectMenu()) return ouvrirTicket(interaction, interaction.values[0]!);
        if ((action === 'addsel' || action === 'removesel') && interaction.isUserSelectMenu()) {
          const ticket = exigerTicket(interaction.channelId);
          const salon = interaction.channel as TextChannel;
          const ajouter = action === 'addsel';
          const fait: string[] = [];
          for (const utilisateur of interaction.users.values()) {
            if (utilisateur.bot) continue;
            await reglerAccesMembre(interaction.guild, salon, ticket, utilisateur.id, ajouter, interaction.member).then(() => fait.push(`<@${utilisateur.id}>`)).catch(() => undefined);
          }
          await interaction.update({ embeds: [ok(interaction.guild, fait.length ? `${fait.join(', ')} ${ajouter ? 'ajouté(s)' : 'retiré(s)'}.` : 'Personne n’a été modifié.')], components: [] });
          if (fait.length) await salon.send({ embeds: [info(interaction.guild, `${fait.join(', ')} ${ajouter ? 'ajouté(s) au' : 'retiré(s) du'} ticket par <@${interaction.user.id}>.`)], allowedMentions: { parse: [] } });
        }
      },
    },
    {
      prefixe: 'tkc',
      niveau: Niveau.ADMIN,
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        switch (action) {
          case 'home':
            return interaction.update(ecranMotifs(serveur));
          case 'back':
            return interaction.update(afficherPage(serveur, lirePageReglage('tickets')!));
          case 'new':
            return interaction.showModal(
              construireFormulaire('tkc:newm', 'Nouvelle catégorie', [
                { id: 'label', libelle: 'Nom', indication: 'ex : Support', longueurMax: 40 },
                { id: 'emoji', libelle: 'Émoji', indication: '🎫', longueurMax: 64, obligatoire: false },
                { id: 'description', libelle: 'Description', indication: 'Une question ou un souci ? On t’aide.', longueurMax: 100, obligatoire: false },
                { id: 'style', libelle: 'Couleur du bouton (bleu, vert, rouge, gris)', valeur: 'gris', longueurMax: 10, obligatoire: false },
              ]),
            );
          case 'edit': {
            const motif = lireConfig(serveur.id).tickets.categories.find((c) => c.id === id);
            if (!motif) return interaction.update(ecranMotifs(serveur));
            return interaction.showModal(
              construireFormulaire(`tkc:editm:${motif.id}`, `Catégorie ${motif.libelle}`.slice(0, 45), [
                { id: 'label', libelle: 'Nom', valeur: motif.libelle, longueurMax: 40 },
                { id: 'emoji', libelle: 'Émoji', valeur: motif.emoji, longueurMax: 64, obligatoire: false },
                { id: 'description', libelle: 'Description', valeur: motif.description, longueurMax: 100, obligatoire: false },
                { id: 'style', libelle: 'Couleur du bouton (bleu, vert, rouge, gris)', valeur: LIBELLE_STYLE[motif.style], longueurMax: 10, obligatoire: false },
              ]),
            );
          }
          case 'del': {
            if (lireConfig(serveur.id).tickets.categories.length <= 1) throw new ErreurUtilisateur('Il faut garder au moins une catégorie.');
            modifierConfig(serveur.id, (c) => void (c.tickets.categories = c.tickets.categories.filter((x) => x.id !== id)));
            return interaction.update(ecranMotifs(serveur, '✅ Catégorie supprimée. Pense à republier le panneau.'));
          }
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(ecranMotif(serveur, interaction.values[0]!));
        if (action === 'roles' && interaction.isRoleSelectMenu() && id) {
          modifierConfig(serveur.id, (c) => {
            const motif = c.tickets.categories.find((x) => x.id === id);
            if (motif) motif.roles = [...interaction.values];
          });
          return interaction.update(ecranMotif(serveur, id, `✅ C’est enregistré.`));
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        const libelle = interaction.fields.getTextInputValue('label').trim();
        const emoji = interaction.fields.getTextInputValue('emoji').trim() || '🎫';
        const description = interaction.fields.getTextInputValue('description').trim();
        const style = lireStyle(interaction.fields.getTextInputValue('style'));
        if (!libelle) throw new ErreurUtilisateur('Le nom est obligatoire.');
        let cible = id;
        modifierConfig(serveur.id, (c) => {
          if (action === 'newm') {
            let identifiantTexte = identifiantDepuisTexte(libelle, 20);
            while (c.tickets.categories.some((x) => x.id === identifiantTexte)) identifiantTexte = `${identifiantDepuisTexte(libelle, 16)}-${Math.random().toString(36).slice(2, 4)}`;
            c.tickets.categories.push({ id: identifiantTexte, libelle, emoji, description, style, roles: [] } satisfies MotifTicket);
            cible = identifiantTexte;
          } else {
            const motif = c.tickets.categories.find((x) => x.id === id);
            if (motif) Object.assign(motif, { label: libelle, emoji, description, style });
          }
        });
        const charge = ecranMotif(serveur, cible!, '✅ C’est enregistré. Pense à republier le panneau.');
        if (interaction.isFromMessage()) await interaction.update(charge);
        else await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('messageCreate', (message) => {
      if (!message.inGuild() || !salonsTickets.has(message.channelId) || message.author.bot) return;
      const ticket = ticketDuSalon(message.channelId);
      if (!ticket) return;
      stockerMessageTicket(ticket.id, message.id, message.author.id, message.author.tag, message.content, [...message.attachments.values()].map((a) => a.url));
    }, 300),
    sur('channelDelete', (salon) => {
      if (salonsTickets.has(salon.id)) marquerSupprime(salon.id);
    }),
  ],
  async auDemarrage() {
    chargerSalonsTickets();
  },
  tests: [
    {
      id: 'panel',
      libelle: 'Aperçu du panneau',
      emoji: '🎫',
      description: 'Poster le panneau ici, en privé',
      async executer(interaction) {
        const panneauBoutons = construirePanneau(interaction.guild);
        const v2 = panneauBoutons.flags !== undefined;
        await interaction.followUp({
          embeds: panneauBoutons.embeds,
          components: panneauBoutons.components,
          flags: v2 ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : MessageFlags.Ephemeral,
        } as Parameters<typeof interaction.followUp>[0]);
        return '✅ Aperçu envoyé juste en dessous (les boutons fonctionnent vraiment).';
      },
    },
  ],
};
