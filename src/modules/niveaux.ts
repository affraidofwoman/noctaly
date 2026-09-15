import { randomInt } from 'node:crypto';
import {
  ChannelType,
  type Client,
  type Guild,
  GuildMember,
  type Message,
  SlashCommandBuilder,
  type User,
  type VoiceState,
} from 'discord.js';
import { emojiPour, libelleNiveau, lireNiveau, rolesAttribuables } from '../coeur/acces';
import { embedEnseigne, info, lignesEnPages, ok, paginer, remplirModele, repondre } from '../coeur/affichage';
import type { ChampReglage, PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout } from '../coeur/base';
import { journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import {
  barreProgression,
  cleJour,
  creerRegistre,
  ErreurUtilisateur,
  formaterDuree,
  formaterNombre,
  identifiantDepuisTexte,
  joursDepuis,
  medaille,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import { nombreTickets } from './tickets';
import { victoiresDe } from './tirages';

const registre = creerRegistre('activite');

export type TypeActivite = 'messages' | 'voice_minutes' | 'giveaways' | 'daily';

export interface EvenementActivite {
  serveurId: string;
  utilisateurId: string;
  type: TypeActivite;
  montant: number;
}

type Ecouteur = (evenement: EvenementActivite, client: Client | null) => void;
const ecouteurs: Ecouteur[] = [];
let clientLie: Client | null = null;

export function lierClientActivite(client: Client): void {
  clientLie = client;
}

export function surActivite(ecouteur: Ecouteur): void {
  ecouteurs.push(ecouteur);
}

export function emettreActivite(evenement: EvenementActivite): void {
  for (const l of ecouteurs) {
    try {
      l(evenement, clientLie);
    } catch (echec) {
      registre.avertir(`Écouteur d’activité en échec : ${(echec as Error).message}`);
    }
  }
}

const registreVocal = creerRegistre('vocal');

export interface CreditVocal {
  serveurId: string;
  utilisateurId: string;
  salonId: string;
  secondes: number;
  inactif: boolean;
}

type EcouteurVocal = (credit: CreditVocal, client: Client) => void;

const ecouteursVocal: EcouteurVocal[] = [];
const CREDIT_MAX_S = 10 * 60;

export function surTempsVocal(ecouteur: EcouteurVocal): void {
  ecouteursVocal.push(ecouteur);
}

function emettre(client: Client, credit: CreditVocal): void {
  if (credit.secondes <= 0) return;
  for (const l of ecouteursVocal) {
    try {
      l(credit, client);
    } catch (echec) {
      registreVocal.avertir(`Écouteur vocal en échec : ${(echec as Error).message}`);
    }
  }
}

function estInactif(etat: VoiceState): boolean {
  const salon = etat.channel;
  if (!salon) return true;
  if (etat.selfDeaf || etat.serverDeaf) return true;
  if (etat.guild.afkChannelId === salon.id) return true;
  return salon.members.filter((m) => !m.user.bot).size < 2;
}

function credit(client: Client, serveurId: string, utilisateurId: string, jusqua: number, etat: VoiceState | null): void {
  const rangee = lireTout<{ salon_id: string; debut_le: number }>('SELECT salon_id, debut_le FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId)[0];
  if (!rangee) return;
  const secondes = Math.min(Math.floor((jusqua - rangee.debut_le) / 1000), CREDIT_MAX_S);
  emettre(client, { serveurId, utilisateurId, salonId: rangee.salon_id, secondes, inactif: etat ? estInactif(etat) : false });
}

export function traiterEtatVocal(avant: VoiceState, apres: VoiceState): void {
  const membre = apres.member ?? avant.member;
  if (!membre || membre.user.bot) return;
  const maintenant = Date.now();
  const serveurId = apres.guild.id;
  if (avant.channelId && avant.channelId !== apres.channelId) {
    credit(apres.client, serveurId, membre.id, maintenant, avant);
    executer('DELETE FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, membre.id);
  }
  if (apres.channelId && avant.channelId !== apres.channelId) {
    executer('INSERT OR REPLACE INTO sessions_vocales (serveur_id, utilisateur_id, salon_id, debut_le) VALUES (?, ?, ?, ?)', serveurId, membre.id, apres.channelId, maintenant);
  }
}

export function crediterVocal(client: Client): void {
  const maintenant = Date.now();
  for (const rangee of lireTout<{ serveur_id: string; utilisateur_id: string; salon_id: string; debut_le: number }>('SELECT * FROM sessions_vocales')) {
    const serveur = client.guilds.cache.get(rangee.serveur_id);
    const etat = serveur?.voiceStates.cache.get(rangee.utilisateur_id);
    if (!serveur || !etat?.channelId) {
      executer('DELETE FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', rangee.serveur_id, rangee.utilisateur_id);
      continue;
    }
    const secondes = Math.min(Math.floor((maintenant - rangee.debut_le) / 1000), CREDIT_MAX_S);
    emettre(client, { serveurId: rangee.serveur_id, utilisateurId: rangee.utilisateur_id, salonId: etat.channelId, secondes, inactif: estInactif(etat) });
    executer('UPDATE sessions_vocales SET debut_le = ?, salon_id = ? WHERE serveur_id = ? AND utilisateur_id = ?', maintenant, etat.channelId, rangee.serveur_id, rangee.utilisateur_id);
  }
}

export function resynchroniserVocal(client: Client): void {
  executer('DELETE FROM sessions_vocales');
  const maintenant = Date.now();
  for (const serveur of client.guilds.cache.values()) {
    for (const etat of serveur.voiceStates.cache.values()) {
      if (!etat.channelId || etat.member?.user.bot) continue;
      executer('INSERT OR REPLACE INTO sessions_vocales (serveur_id, utilisateur_id, salon_id, debut_le) VALUES (?, ?, ?, ?)', serveur.id, etat.id, etat.channelId, maintenant);
    }
  }
}

export const COLONNES_JOUR = ['messages', 'arrivees', 'departs', 'secondes_vocal', 'commandes'] as const;
type ColonneJour = (typeof COLONNES_JOUR)[number];

export function incrementerJour(serveurId: string, colonne: ColonneJour, montant = 1): void {
  const jour = cleJour(Date.now(), lireConfig(serveurId).general.fuseau);
  executer(
    `INSERT INTO statistiques_jour (serveur_id, jour, ${colonne}) VALUES (?, ?, ?)
     ON CONFLICT(serveur_id, jour) DO UPDATE SET ${colonne} = ${colonne} + excluded.${colonne}`,
    serveurId,
    jour,
    montant,
  );
}

export function noterMembre(serveurId: string, utilisateurId: string): void {
  executer('INSERT OR IGNORE INTO membres (serveur_id, utilisateur_id, vu_le) VALUES (?, ?, ?)', serveurId, utilisateurId, Date.now());
}

export function incrementerMembre(serveurId: string, utilisateurId: string, colonne: 'messages' | 'secondes_vocal', montant = 1): void {
  executer(
    `INSERT INTO membres (serveur_id, utilisateur_id, vu_le, ${colonne}) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET ${colonne} = ${colonne} + excluded.${colonne}`,
    serveurId,
    utilisateurId,
    Date.now(),
    montant,
  );
}

export function activiteMembre(serveurId: string, utilisateurId: string): { messages: number; secondes_vocal: number; vu_le: number } | undefined {
  return lire('SELECT messages, secondes_vocal, vu_le FROM membres WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId);
}

export function xpPourSuivant(niveau: number): number {
  return 5 * niveau * niveau + 50 * niveau + 100;
}

export function xpTotalePourNiveau(niveau: number): number {
  let total = 0;
  for (let l = 0; l < niveau; l++) total += xpPourSuivant(l);
  return total;
}

export function niveauDepuisXp(xp: number): { niveau: number; actuel: number; requis: number } {
  let niveau = 0;
  let reste = Math.max(0, Math.floor(xp));
  while (reste >= xpPourSuivant(niveau) && niveau < 1000) {
    reste -= xpPourSuivant(niveau);
    niveau++;
  }
  return { niveau, actuel: reste, requis: xpPourSuivant(niveau) };
}

export interface LigneXp {
  utilisateur_id: string;
  xp: number;
  niveau: number;
  dernier_message_le: number;
}

export function lireXp(serveurId: string, utilisateurId: string): LigneXp {
  return lire<LigneXp>('SELECT utilisateur_id, xp, niveau, dernier_message_le FROM xp WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId) ?? { utilisateur_id: utilisateurId, xp: 0, niveau: 0, dernier_message_le: 0 };
}

export function niveauDe(serveurId: string, utilisateurId: string): number {
  return lireXp(serveurId, utilisateurId).niveau;
}

export function ajouterXp(serveurId: string, utilisateurId: string, montant: number, noterMessage = false): { ancienNiveau: number; nouveauNiveau: number; xp: number } {
  const avant = lireXp(serveurId, utilisateurId);
  const xp = Math.max(0, avant.xp + Math.round(montant));
  const nouveauNiveau = niveauDepuisXp(xp).niveau;
  executer(
    `INSERT INTO xp (serveur_id, utilisateur_id, xp, niveau, dernier_message_le) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET xp = excluded.xp, niveau = excluded.niveau, dernier_message_le = CASE WHEN ? THEN excluded.dernier_message_le ELSE xp.dernier_message_le END`,
    serveurId,
    utilisateurId,
    xp,
    nouveauNiveau,
    noterMessage ? Date.now() : avant.dernier_message_le,
    noterMessage ? 1 : 0,
  );
  return { ancienNiveau: avant.niveau, nouveauNiveau, xp };
}

export function poserXp(serveurId: string, utilisateurId: string, xp: number): number {
  const niveau = niveauDepuisXp(xp).niveau;
  executer(
    `INSERT INTO xp (serveur_id, utilisateur_id, xp, niveau) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET xp = excluded.xp, niveau = excluded.niveau`,
    serveurId,
    utilisateurId,
    Math.max(0, Math.floor(xp)),
    niveau,
  );
  return niveau;
}

export function classement(serveurId: string, limite = 100, decalage = 0): LigneXp[] {
  return lireTout<LigneXp>('SELECT utilisateur_id, xp, niveau, dernier_message_le FROM xp WHERE serveur_id = ? AND xp > 0 ORDER BY xp DESC LIMIT ? OFFSET ?', serveurId, limite, decalage);
}

export function rangDe(serveurId: string, utilisateurId: string): number {
  const moi = lireXp(serveurId, utilisateurId);
  if (!moi.xp) return 0;
  return (lire<{ n: number }>('SELECT COUNT(*) AS n FROM xp WHERE serveur_id = ? AND xp > ?', serveurId, moi.xp)?.n ?? 0) + 1;
}

export function rolesNiveau(serveurId: string): { niveau: number; role_id: string }[] {
  return lireTout('SELECT niveau, role_id FROM roles_niveaux WHERE serveur_id = ? ORDER BY niveau ASC', serveurId);
}

export function poserRoleNiveau(serveurId: string, niveau: number, roleId: string): void {
  executer('INSERT OR IGNORE INTO roles_niveaux (serveur_id, niveau, role_id) VALUES (?, ?, ?)', serveurId, niveau, roleId);
}

export function retirerRoleNiveau(serveurId: string, roleId: string): number {
  return executer('DELETE FROM roles_niveaux WHERE serveur_id = ? AND role_id = ?', serveurId, roleId).changes;
}

export interface DefinitionBadge {
  badge_id: string;
  nom: string;
  emoji: string;
  description: string;
}

export const BADGES_DEFAUT: DefinitionBadge[] = [
  { badge_id: 'og', nom: 'OG', emoji: '🏆', description: 'Membre de très longue date' },
  { badge_id: 'actif', nom: 'Actif', emoji: '⭐', description: 'Niveau 10 atteint' },
  { badge_id: 'giveaway', nom: 'Giveaway Winner', emoji: '🎉', description: 'A gagné un giveaway' },
  { badge_id: 'birthday', nom: 'Birthday', emoji: '🎂', description: 'A fêté son anniversaire ici' },
  { badge_id: 'vip', nom: 'VIP', emoji: '💎', description: 'Booste le serveur' },
  { badge_id: 'early', nom: 'Early Supporter', emoji: '🔥', description: 'Parmi les premiers membres' },
  { badge_id: 'gamer', nom: 'Gamer', emoji: '🎮', description: 'Participe aux événements gaming' },
  { badge_id: 'staff', nom: 'Staff', emoji: '🛡️', description: 'Membre de l’équipe' },
];

function assurerDefauts(serveurId: string): void {
  const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM badges WHERE serveur_id = ?', serveurId)?.n ?? 0;
  if (nombre > 0) return;
  for (const b of BADGES_DEFAUT) {
    executer('INSERT OR IGNORE INTO badges (serveur_id, badge_id, nom, emoji, description) VALUES (?, ?, ?, ?, ?)', serveurId, b.badge_id, b.nom, b.emoji, b.description);
  }
}

export function listerBadges(serveurId: string): DefinitionBadge[] {
  assurerDefauts(serveurId);
  return lireTout<DefinitionBadge>('SELECT badge_id, nom, emoji, description FROM badges WHERE serveur_id = ? ORDER BY nom COLLATE NOCASE', serveurId);
}

export function lireBadge(serveurId: string, badgeId: string): DefinitionBadge | undefined {
  assurerDefauts(serveurId);
  return lire<DefinitionBadge>('SELECT badge_id, nom, emoji, description FROM badges WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId);
}

export function enregistrerBadge(serveurId: string, badge: DefinitionBadge): void {
  assurerDefauts(serveurId);
  executer(
    `INSERT INTO badges (serveur_id, badge_id, nom, emoji, description) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, badge_id) DO UPDATE SET nom = excluded.nom, emoji = excluded.emoji, description = excluded.description`,
    serveurId,
    badge.badge_id,
    badge.nom,
    badge.emoji,
    badge.description,
  );
}

export function supprimerBadge(serveurId: string, badgeId: string): boolean {
  executer('DELETE FROM badges_membres WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId);
  return executer('DELETE FROM badges WHERE serveur_id = ? AND badge_id = ?', serveurId, badgeId).changes > 0;
}

export function donnerBadge(serveurId: string, utilisateurId: string, badgeId: string, donnePar: string | null = null): boolean {
  if (!lireBadge(serveurId, badgeId)) return false;
  return executer('INSERT OR IGNORE INTO badges_membres (serveur_id, utilisateur_id, badge_id, donne_le, donne_par) VALUES (?, ?, ?, ?, ?)', serveurId, utilisateurId, badgeId, Date.now(), donnePar).changes > 0;
}

export function retirerBadge(serveurId: string, utilisateurId: string, badgeId: string): boolean {
  return executer('DELETE FROM badges_membres WHERE serveur_id = ? AND utilisateur_id = ? AND badge_id = ?', serveurId, utilisateurId, badgeId).changes > 0;
}

export function badgesMembre(serveurId: string, utilisateurId: string): (DefinitionBadge & { donne_le: number })[] {
  assurerDefauts(serveurId);
  return lireTout(
    `SELECT b.badge_id, b.nom, b.emoji, b.description, u.donne_le FROM badges_membres u
     JOIN badges b ON b.serveur_id = u.serveur_id AND b.badge_id = u.badge_id
     WHERE u.serveur_id = ? AND u.utilisateur_id = ? ORDER BY u.donne_le`,
    serveurId,
    utilisateurId,
  );
}

const delais = new Map<string, number>();

export async function synchroniserRolesNiveau(membre: GuildMember, niveau: number): Promise<void> {
  const recompenses = rolesNiveau(membre.guild.id);
  if (!recompenses.length) return;
  const cumuler = lireConfig(membre.guild.id).xp.cumulerRoles;
  const obtenus = recompenses.filter((r) => r.niveau <= niveau);
  const cible = cumuler ? obtenus : obtenus.filter((r) => r.niveau === Math.max(...obtenus.map((e) => e.niveau), -1));
  const ciblesIds = new Set(cible.map((r) => r.role_id));
  const aAjouter = rolesAttribuables(membre.guild, [...ciblesIds]).filter((r) => !membre.roles.cache.has(r.id));
  const aRetirer = rolesAttribuables(membre.guild, recompenses.map((r) => r.role_id)).filter((r) => !ciblesIds.has(r.id) && membre.roles.cache.has(r.id));
  if (aAjouter.length) await membre.roles.add(aAjouter, `Niveau ${niveau}`).catch(() => undefined);
  if (aRetirer.length) await membre.roles.remove(aRetirer, `Niveau ${niveau}`).catch(() => undefined);
  if (aAjouter.length) {
    void journal(membre.guild, 'autorole', { titre: 'Rôle de niveau', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Niveau** : ${niveau}`, `**Rôles** : ${aAjouter.map((r) => `<@&${r.id}>`).join(' ')}`] });
  }
}

async function annoncerNiveau(membre: GuildMember, niveau: number, source: Message | null): Promise<void> {
  const reglages = lireConfig(membre.guild.id).xp;
  if (niveau >= 10) donnerBadge(membre.guild.id, membre.id, 'actif');
  await synchroniserRolesNiveau(membre, niveau);
  if (reglages.annonce === 'off') return;
  const texte = remplirModele(reglages.messageNiveau, { membre, serveur: membre.guild, extra: { level: niveau } });
  const embed = embedEnseigne(membre.guild).setDescription(`${emojiPour(membre.guild.id, 'niveau')} ${texte}`).setThumbnail(membre.user.displayAvatarURL({ size: 128 }));
  if (reglages.annonce === 'dm') {
    await membre.send({ embeds: [embed] }).catch(() => undefined);
    return;
  }
  const salon = reglages.annonce === 'channel' ? resoudreSalonTexte(membre.guild, reglages.salonAnnonceId) : source?.channel;
  if (salon && 'send' in salon) await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const reglages = lireConfig(message.guildId).xp;
  if (reglages.salonsSansXp.includes(message.channelId) || (message.channel.isThread() && message.channel.parentId && reglages.salonsSansXp.includes(message.channel.parentId))) return;
  if (message.member.roles.cache.some((r) => reglages.rolesSansXp.includes(r.id))) return;
  const cle = `${message.guildId}:${message.author.id}`;
  const maintenant = Date.now();
  if ((delais.get(cle) ?? 0) > maintenant) return;
  delais.set(cle, maintenant + reglages.delaiSecondes * 1000);
  if (delais.size > 20_000) for (const [k, v] of delais) if (v < maintenant) delais.delete(k);
  const gain = randomInt(Math.min(reglages.min, reglages.max), Math.max(reglages.min, reglages.max) + 1);
  const { ancienNiveau, nouveauNiveau } = ajouterXp(message.guildId, message.author.id, gain, true);
  if (nouveauNiveau > ancienNiveau) await annoncerNiveau(message.member, nouveauNiveau, message);
}

surTempsVocal((credit, client) => {
  if (credit.inactif || !moduleActif(credit.serveurId, 'xp')) return;
  const parMinute = lireConfig(credit.serveurId).xp.xpVocalParMinute;
  if (parMinute <= 0) return;
  const gain = Math.floor((credit.secondes / 60) * parMinute);
  if (gain <= 0) return;
  const { ancienNiveau, nouveauNiveau } = ajouterXp(credit.serveurId, credit.utilisateurId, gain);
  if (nouveauNiveau > ancienNiveau) {
    const membre = client.guilds.cache.get(credit.serveurId)?.members.cache.get(credit.utilisateurId);
    if (membre) void annoncerNiveau(membre, nouveauNiveau, null);
  }
});

function embedRang(serveur: Guild, utilisateur: User) {
  const rangee = lireXp(serveur.id, utilisateur.id);
  const progression = niveauDepuisXp(rangee.xp);
  const rang = rangDe(serveur.id, utilisateur.id);
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`⭐ NIVEAU DE ${utilisateur.displayName.toUpperCase()}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `## Niveau ${progression.niveau}`,
        `**XP :** ${formaterNombre(progression.actuel)} / ${formaterNombre(progression.requis)}`,
        barreProgression(progression.actuel / progression.requis, 16),
        '',
        `• XP totale — **${formaterNombre(rangee.xp)}**`,
        `• Classement — **${rang ? `#${rang}` : '—'}**`,
      ].join('\n'),
    );
}

function pagesClassement(serveur: Guild) {
  const rangees = classement(serveur.id, 200);
  const lignes = rangees.map((r, i) => `${medaille(i + 1)} <@${r.utilisateur_id}> — Niveau **${r.niveau}** · ${formaterNombre(r.xp)} XP`);
  if (!lignes.length) lignes.push('*Personne n’a encore d’XP.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('🏆 CLASSEMENT').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

const optionMembre = (o: import('discord.js').SlashCommandUserOption) => o.setName('membre').setDescription('Qui (toi par défaut)');

const rang: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('rank').setDescription('Ton niveau').addUserOption(optionMembre),
  async executer(i) {
    await repondre(i, { embeds: [embedRang(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const niveau: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('level').setDescription('Le niveau d’un membre').addUserOption(optionMembre),
  async executer(i) {
    await repondre(i, { embeds: [embedRang(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const commandeClassement: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('leaderboard').setDescription('Le classement XP'),
  async executer(i) {
    await paginer(i, pagesClassement(i.guild));
  },
};

const commandeXp: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Gérer l’XP et les rôles de niveau')
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner ou retirer de l’XP')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('quantite').setDescription('XP (négatif pour retirer)').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000)),
    )
    .addSubcommand((s) =>
      s
        .setName('niveau')
        .setDescription('Fixer le niveau d’un membre')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((s) => s.setName('reset').setDescription('Remettre à zéro un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('role-ajouter')
        .setDescription('Récompenser un niveau par un rôle')
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('role-retirer').setDescription('Retirer une récompense de niveau').addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('roles').setDescription('Les rôles de niveau')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    const serveur = i.guild;
    if (sousCommande === 'roles') {
      const rangees = rolesNiveau(serveur.id);
      return repondre(i, { embeds: [info(serveur, rangees.map((r) => `Niveau **${r.niveau}** → <@&${r.role_id}>`).join('\n') || 'Aucun rôle de niveau.', { titre: 'Rôles de niveau', sujet: '🏆' })], ephemeral: true });
    }
    if (sousCommande === 'role-ajouter') {
      const role = i.options.getRole('role', true);
      if (!rolesAttribuables(serveur, [role.id]).length) throw new ErreurUtilisateur('Je ne peux pas attribuer ce rôle (il est au-dessus du mien ou géré par une intégration).');
      poserRoleNiveau(serveur.id, i.options.getInteger('niveau', true), role.id);
      return repondre(i, { embeds: [ok(serveur, `Niveau **${i.options.getInteger('niveau', true)}** → <@&${role.id}>`)], ephemeral: true });
    }
    if (sousCommande === 'role-retirer') {
      const n = retirerRoleNiveau(serveur.id, i.options.getRole('role', true).id);
      return repondre(i, { embeds: [n ? ok(serveur, 'Récompense retirée.') : info(serveur, 'Ce rôle n’était pas une récompense de niveau.')], ephemeral: true });
    }
    const utilisateur = i.options.getUser('membre', true);
    let nouveauNiveau: number;
    if (sousCommande === 'donner') nouveauNiveau = ajouterXp(serveur.id, utilisateur.id, i.options.getInteger('quantite', true)).nouveauNiveau;
    else if (sousCommande === 'niveau') nouveauNiveau = poserXp(serveur.id, utilisateur.id, xpTotalePourNiveau(i.options.getInteger('niveau', true)));
    else nouveauNiveau = poserXp(serveur.id, utilisateur.id, 0);
    const membre = await serveur.members.fetch(utilisateur.id).catch(() => null);
    if (membre) await synchroniserRolesNiveau(membre, nouveauNiveau);
    return repondre(i, { embeds: [ok(serveur, `<@${utilisateur.id}> est maintenant niveau **${nouveauNiveau}** (${formaterNombre(lireXp(serveur.id, utilisateur.id).xp)} XP).`)], ephemeral: true });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'rank',
    alias: ['level', 'niveau'],
    domaine: 'general',
    categorie: 'community',
    description: 'Ton niveau',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const utilisateur = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [embedRang(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'top',
    alias: ['leaderboard', 'lb'],
    domaine: 'general',
    categorie: 'community',
    description: 'Le classement XP',
    async executer(message) {
      await message.reply({ embeds: [pagesClassement(message.guild)[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'xp',
  section: 'community',
  titre: 'XP & niveaux',
  emoji: '⭐',
  moduleId: 'xp',
  ordre: 1,
  description: 'Gain d’XP par message (avec cooldown) et en vocal (à plusieurs, non sourd).\n-# Rôles de niveau : `/xp role-ajouter`. Variables du message : `{mention}` `{user}` `{level}`',
  champs: [
    {
      genre: 'choice',
      cle: 'announce',
      libelle: 'Annonce des niveaux',
      options: [
        { valeur: 'same', libelle: 'Dans le salon du message', emoji: '💬' },
        { valeur: 'channel', libelle: 'Dans un salon dédié', emoji: '📢' },
        { valeur: 'dm', libelle: 'En message privé', emoji: '✉️' },
        { valeur: 'off', libelle: 'Aucune annonce', emoji: '🔕' },
      ],
      lire: (c) => c.xp.annonce,
      ecrire: (c, v) => void (c.xp.annonce = v as 'off' | 'same' | 'channel' | 'dm'),
    },
    { genre: 'channel', cle: 'channel', libelle: 'Salon des annonces de niveau', lire: (c) => c.xp.salonAnnonceId, ecrire: (c, v) => void (c.xp.salonAnnonceId = v) },
    {
      genre: 'channels',
      cle: 'noxp',
      libelle: 'Salons sans XP',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
      lire: (c) => c.xp.salonsSansXp,
      ecrire: (c, v) => void (c.xp.salonsSansXp = v),
    },
    { genre: 'toggle', cle: 'stack', libelle: 'Cumuler les rôles de niveau', lire: (c) => c.xp.cumulerRoles, ecrire: (c, v) => void (c.xp.cumulerRoles = v) },
    { genre: 'text', cle: 'message', libelle: 'Message de niveau', long: true, longueurMax: 500, obligatoire: true, lire: (c) => c.xp.messageNiveau, ecrire: (c, v) => void (c.xp.messageNiveau = v) },
    { genre: 'number', cle: 'min', libelle: 'XP min par message', min: 1, max: 500, lire: (c) => c.xp.min, ecrire: (c, v) => void (c.xp.min = v) },
    { genre: 'number', cle: 'max', libelle: 'XP max par message', min: 1, max: 1000, lire: (c) => c.xp.max, ecrire: (c, v) => void (c.xp.max = v) },
    { genre: 'number', cle: 'cooldown', libelle: 'Cooldown entre deux gains', min: 0, max: 3600, unite: 's', lire: (c) => c.xp.delaiSecondes, ecrire: (c, v) => void (c.xp.delaiSecondes = v) },
    { genre: 'number', cle: 'voice', libelle: 'XP par minute de vocal', min: 0, max: 100, lire: (c) => c.xp.xpVocalParMinute, ecrire: (c, v) => void (c.xp.xpVocalParMinute = v) },
  ],
};

export const moduleNiveaux: ModuleBot = {
  id: 'xp',
  nom: 'XP & niveaux',
  emoji: '⭐',
  description: 'XP messages et vocal, niveaux, rôles de niveau, classement',
  desactivable: true,
  actifParDefaut: false,
  commandes: [rang, niveau, commandeClassement, commandeXp],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  evenements: [sur('messageCreate', (m) => surMessage(m), 150)],
};

const registreAnciennete = creerRegistre('anciennete');
const JOURS_DEFAUT = [30, 90, 180];

export async function synchroniserAnciennete(serveur: Guild): Promise<number> {
  const reglages = lireConfig(serveur.id).anciennete;
  const paliers = reglages.paliers.filter((t) => t.roleId && t.days > 0).sort((a, b) => a.days - b.days);
  if (!paliers.length) return 0;
  const membres = await serveur.members.fetch().catch(() => serveur.members.cache);
  let changements = 0;
  const meilleurs = paliers[paliers.length - 1]!;
  for (const membre of membres.values()) {
    if (membre.user.bot || !membre.joinedTimestamp) continue;
    const jours = joursDepuis(membre.joinedTimestamp);
    const obtenus = paliers.filter((t) => jours >= t.days);
    const cible = reglages.stack ? obtenus : obtenus.slice(-1);
    const ciblesIds = new Set(cible.map((t) => t.roleId));
    const ajouter = rolesAttribuables(serveur, [...ciblesIds]).filter((r) => !membre.roles.cache.has(r.id));
    const retirer = reglages.stack ? [] : rolesAttribuables(serveur, paliers.map((t) => t.roleId)).filter((r) => !ciblesIds.has(r.id) && membre.roles.cache.has(r.id));
    if (ajouter.length) await membre.roles.add(ajouter, 'Ancienneté').then(() => changements++).catch(() => undefined);
    if (retirer.length) await membre.roles.remove(retirer, 'Ancienneté').catch(() => undefined);
    if (jours >= meilleurs.days) donnerBadge(serveur.id, membre.id, 'og');
  }
  if (changements) void journal(serveur, 'autorole', { titre: 'Rôles d’ancienneté', ton: 'ok', lignes: [`**${changements}** membre(s) ont reçu un nouveau rôle d’ancienneté.`] });
  return changements;
}

function champsPalier(indice: number): ChampReglage[] {
  return [
    {
      genre: 'role',
      cle: `role${indice}`,
      libelle: `Palier ${indice + 1} : rôle`,
      attribuable: true,
      lire: (c) => c.anciennete.paliers[indice]?.roleId || null,
      ecrire: (c, v) => {
        const paliers = [...c.anciennete.paliers];
        while (paliers.length <= indice) paliers.push({ days: JOURS_DEFAUT[paliers.length] ?? 365, roleId: '' });
        paliers[indice] = { ...paliers[indice]!, roleId: v ?? '' };
        c.anciennete.paliers = paliers;
      },
    },
  ];
}

function champJours(indice: number): ChampReglage {
  return {
    genre: 'number',
    cle: `days${indice}`,
    libelle: `Palier ${indice + 1} : jours`,
    min: 1,
    max: 3650,
    unite: 'j',
    lire: (c) => c.anciennete.paliers[indice]?.days ?? JOURS_DEFAUT[indice] ?? 365,
    ecrire: (c, v) => {
      const paliers = [...c.anciennete.paliers];
      while (paliers.length <= indice) paliers.push({ days: JOURS_DEFAUT[paliers.length] ?? 365, roleId: '' });
      paliers[indice] = { ...paliers[indice]!, days: v };
      c.anciennete.paliers = paliers;
    },
  };
}

const pageReglageAnciennete: PageReglage = {
  id: 'seniority',
  section: 'roles',
  titre: 'Ancienneté',
  emoji: '🏆',
  moduleId: 'seniority',
  ordre: 3,
  description: 'Des rôles donnés automatiquement selon le temps passé sur le serveur (vérifié toutes les 6 heures).\n-# Par défaut : 30 j, 90 j, 180 j (OG).',
  champs: [
    ...champsPalier(0),
    ...champsPalier(1),
    ...champsPalier(2),
    { genre: 'toggle', cle: 'stack', libelle: 'Cumuler les paliers', lire: (c) => c.anciennete.stack, ecrire: (c, v) => void (c.anciennete.stack = v) },
    champJours(0),
    champJours(1),
    champJours(2),
  ],
  actions: [
    {
      id: 'sync',
      libelle: 'Appliquer maintenant',
      emoji: '🔄',
      async executer(interaction) {
        await interaction.deferReply({ flags: 64 });
        const n = await synchroniserAnciennete(interaction.guild);
        await interaction.editReply({ content: `✅ ${n} membre(s) mis à jour.` });
      },
    },
  ],
};

export const moduleAnciennete: ModuleBot = {
  id: 'seniority',
  nom: 'Ancienneté',
  emoji: '🏆',
  description: 'Rôles automatiques selon l’ancienneté (régulier, ancien, OG)',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglageAnciennete],
  taches: [
    {
      nom: 'seniority-sync',
      intervalleMs: 6 * 3_600_000,
      async executer(client: Client<true>) {
        for (const serveur of client.guilds.cache.values()) {
          if (!moduleActif(serveur.id, 'seniority') || !lireConfig(serveur.id).anciennete.paliers.some((t) => t.roleId)) continue;
          await synchroniserAnciennete(serveur).catch((echec: Error) => registreAnciennete.avertir(`Ancienneté ${serveur.id} : ${echec.message}`));
        }
      },
    },
  ],
};

function synchroniserBadgesAuto(membre: GuildMember): void {
  if (!lireConfig(membre.guild.id).profils.badgesAuto) return;
  const g = membre.guild.id;
  if (lireNiveau(membre) >= Niveau.SUPPORT) donnerBadge(g, membre.id, 'staff');
  if (membre.premiumSinceTimestamp) donnerBadge(g, membre.id, 'vip');
  if (membre.joinedTimestamp && joursDepuis(membre.joinedTimestamp) >= 180) donnerBadge(g, membre.id, 'og');
  if (lireXp(g, membre.id).niveau >= 10) donnerBadge(g, membre.id, 'actif');
}

export function embedProfil(serveur: Guild, utilisateur: User, membre: GuildMember | null) {
  if (membre) synchroniserBadgesAuto(membre);
  const g = serveur.id;
  const xp = lireXp(g, utilisateur.id);
  const progression = niveauDepuisXp(xp.xp);
  const activite = activiteMembre(g, utilisateur.id);
  const pieces = lire<{ solde: number }>('SELECT solde FROM economie WHERE serveur_id = ? AND utilisateur_id = ?', g, utilisateur.id)?.solde ?? 0;
  const serie = lire<{ actuelle: number; record: number }>('SELECT actuelle, record FROM series WHERE serveur_id = ? AND utilisateur_id = ?', g, utilisateur.id);
  const invitations = lire<{ n: number }>('SELECT COUNT(*) AS n FROM invitations WHERE serveur_id = ? AND parrain_id = ? AND faux = 0 AND parti_le IS NULL', g, utilisateur.id)?.n ?? 0;
  const badges = badgesMembre(g, utilisateur.id);
  const economie = lireConfig(g).economie;

  const embed = embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`👤 PROFIL DE ${(membre?.displayName ?? utilisateur.displayName).toUpperCase()}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '⭐ Niveau', value: `${progression.niveau}${rangDe(g, utilisateur.id) ? ` · #${rangDe(g, utilisateur.id)}` : ''}`, inline: true },
      { name: '🏆 XP', value: formaterNombre(xp.xp), inline: true },
      { name: '📅 Membre depuis', value: membre?.joinedTimestamp ? `${joursDepuis(membre.joinedTimestamp)} jours` : '—', inline: true },
      { name: '🎫 Tickets', value: String(nombreTickets(g, utilisateur.id)), inline: true },
      { name: '🎉 Giveaways gagnés', value: String(victoiresDe(g, utilisateur.id)), inline: true },
      { name: '💬 Messages', value: formaterNombre(activite?.messages ?? 0), inline: true },
    );
  if (activite?.secondes_vocal) embed.addFields({ name: '🎙️ Vocal', value: formaterDuree(activite.secondes_vocal * 1000), inline: true });
  if (moduleActif(g, 'economy')) embed.addFields({ name: `${economie.emojiMonnaie} ${economie.nomMonnaie}`, value: formaterNombre(pieces), inline: true });
  if (serie?.actuelle) embed.addFields({ name: '🔥 Série', value: `${serie.actuelle} jour${serie.actuelle > 1 ? 's' : ''} (record ${serie.record})`, inline: true });
  if (moduleActif(g, 'invites')) embed.addFields({ name: '📨 Invitations', value: String(invitations), inline: true });
  if (membre) embed.addFields({ name: '🛡️ Accès', value: libelleNiveau(lireNiveau(membre)), inline: true });
  embed.addFields({ name: `🏅 Badges (${badges.length})`, value: badges.length ? tronquer(badges.map((b) => `${b.emoji} ${b.nom}`).join('\n'), 1024) : '*Aucun badge pour l’instant.*', inline: false });
  if (membre?.displayColor) embed.setColor(membre.displayColor);
  return embed;
}

const profil: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Le profil communautaire')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async executer(interaction) {
    const utilisateur = interaction.options.getUser('membre') ?? interaction.user;
    const membre = interaction.options.getMember('membre') ?? (utilisateur.id === interaction.user.id ? interaction.member : null);
    await repondre(interaction, { embeds: [embedProfil(interaction.guild, utilisateur, membre instanceof GuildMember ? membre : null)] });
  },
};

const badge: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('badge')
    .setDescription('Les badges')
    .addSubcommand((s) => s.setName('liste').setDescription('Les badges du serveur'))
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Créer ou modifier un badge')
        .addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji').setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(120)),
    )
    .addSubcommand((s) =>
      s
        .setName('supprimer')
        .setDescription('Supprimer un badge')
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    ),
  niveauxSousCommandes: { donner: Niveau.STAFF, retirer: Niveau.STAFF, creer: Niveau.ADMIN, supprimer: Niveau.ADMIN },
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listerBadges(interaction.guildId)
        .filter((b) => b.nom.toLowerCase().includes(saisie) || b.badge_id.includes(saisie))
        .slice(0, 25)
        .map((b) => ({ name: `${b.emoji} ${b.nom}`.slice(0, 100), value: b.badge_id })),
    );
  },
  async executer(interaction) {
    const g = interaction.guildId;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'liste') {
      return repondre(interaction, { embeds: [info(interaction.guild, listerBadges(g).map((b) => `${b.emoji} **${b.nom}** — ${b.description || '—'} \`${b.badge_id}\``).join('\n') || 'Aucun badge.', { titre: 'Badges', sujet: '🏅' })], ephemeral: true });
    }
    if (sousCommande === 'creer') {
      const nom = interaction.options.getString('nom', true);
      const id = identifiantDepuisTexte(nom, 32);
      enregistrerBadge(g, { badge_id: id, nom, emoji: interaction.options.getString('emoji', true), description: interaction.options.getString('description') ?? '' });
      return repondre(interaction, { embeds: [ok(interaction.guild, `Badge **${nom}** enregistré (\`${id}\`).`)], ephemeral: true });
    }
    const badgeId = interaction.options.getString('badge', true);
    const definition = lireBadge(g, badgeId);
    if (!definition) throw new ErreurUtilisateur('Badge introuvable.');
    if (sousCommande === 'supprimer') {
      supprimerBadge(g, badgeId);
      return repondre(interaction, { embeds: [ok(interaction.guild, `Badge **${definition.nom}** supprimé.`)], ephemeral: true });
    }
    const utilisateur = interaction.options.getUser('membre', true);
    const change = sousCommande === 'donner' ? donnerBadge(g, utilisateur.id, badgeId, interaction.user.id) : retirerBadge(g, utilisateur.id, badgeId);
    return repondre(interaction, {
      embeds: [ok(interaction.guild, change ? `${definition.emoji} **${definition.nom}** ${sousCommande === 'donner' ? 'donné à' : 'retiré à'} <@${utilisateur.id}>.` : `Rien n’a changé pour <@${utilisateur.id}>.`)],
      ephemeral: true,
    });
  },
};

const commandesPrefixeProfils: CommandePrefixe[] = [
  {
    nom: 'profil',
    alias: ['profile', 'p'],
    domaine: 'general',
    categorie: 'community',
    description: 'Le profil communautaire',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const membre = id ? await message.guild.members.fetch(id).catch(() => null) : message.member;
      const utilisateur = membre?.user ?? (id ? await message.client.users.fetch(id).catch(() => null) : message.author);
      if (!utilisateur) throw new ErreurUtilisateur('Membre introuvable.');
      await message.reply({ embeds: [embedProfil(message.guild, utilisateur, membre)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleProfils: ModuleBot = {
  id: 'profiles',
  nom: 'Profils & badges',
  emoji: '👤',
  description: 'Profil communautaire et badges automatiques ou donnés',
  desactivable: true,
  actifParDefaut: true,
  commandes: [profil, badge],
  commandesPrefixe: commandesPrefixeProfils,
  pagesReglage: [
    {
      id: 'profiles',
      section: 'community',
      titre: 'Profils & badges',
      emoji: '🏅',
      moduleId: 'profiles',
      ordre: 6,
      description: 'Badges automatiques : 🛡️ Staff, 💎 VIP (booster), 🏆 OG (180 j), ⭐ Actif (niveau 10), 🎉 Giveaway Winner, 🎂 Birthday.',
      champs: [{ genre: 'toggle', cle: 'auto', libelle: 'Badges automatiques', lire: (c) => c.profils.badgesAuto, ecrire: (c, v) => void (c.profils.badgesAuto = v) }],
    },
  ],
};

surTempsVocal((credit) => {
  if (!moduleActif(credit.serveurId, 'stats') || !lireConfig(credit.serveurId).statistiques.suivreVocal) return;
  incrementerJour(credit.serveurId, 'secondes_vocal', credit.secondes);
  incrementerMembre(credit.serveurId, credit.utilisateurId, 'secondes_vocal', credit.secondes);
});

function sommeJours(serveurId: string, colonne: (typeof COLONNES_JOUR)[number], depuisJour: string | null): number {
  const rangee = depuisJour
    ? lire<{ n: number }>(`SELECT COALESCE(SUM(${colonne}), 0) AS n FROM statistiques_jour WHERE serveur_id = ? AND jour >= ?`, serveurId, depuisJour)
    : lire<{ n: number }>(`SELECT COALESCE(SUM(${colonne}), 0) AS n FROM statistiques_jour WHERE serveur_id = ?`, serveurId);
  return rangee?.n ?? 0;
}

const nombre = (requete: string, ...parametres: string[]) => lire<{ n: number }>(requete, ...parametres)?.n ?? 0;

const statistiques: CommandeSlash = {
  categorie: 'general',
  delaiSecondes: 10,
  donnees: new SlashCommandBuilder().setName('stats').setDescription('Les statistiques du serveur'),
  async executer(interaction) {
    const serveur = interaction.guild;
    const fuseau = lireConfig(serveur.id).general.fuseau;
    const aujourdhui = cleJour(Date.now(), fuseau);
    const semaine = cleJour(Date.now() - 6 * 86_400_000, fuseau);
    const bots = serveur.members.cache.filter((m) => m.user.bot).size;
    const enVocal = serveur.voiceStates.cache.filter((v) => !!v.channelId && !v.member?.user.bot).size;
    const embed = embedEnseigne(serveur)
      .setTitle(`📈 Statistiques — ${serveur.name}`)
      .setThumbnail(serveur.iconURL({ size: 256 }))
      .addFields(
        { name: '👥 Membres', value: `${formaterNombre(serveur.memberCount - bots)}\n-# +${sommeJours(serveur.id, 'arrivees', semaine)} / -${sommeJours(serveur.id, 'departs', semaine)} sur 7 j`, inline: true },
        { name: '🤖 Bots', value: formaterNombre(bots), inline: true },
        { name: '💬 Messages', value: `${formaterNombre(sommeJours(serveur.id, 'messages', aujourdhui))} aujourd’hui\n-# ${formaterNombre(sommeJours(serveur.id, 'messages', semaine))} sur 7 j · ${formaterNombre(sommeJours(serveur.id, 'messages', null))} au total`, inline: true },
        { name: '🎙️ Vocal', value: `${enVocal} en ce moment\n-# ${formaterDuree(sommeJours(serveur.id, 'secondes_vocal', semaine) * 1000) || '0 s'} sur 7 j`, inline: true },
        { name: '🎫 Tickets', value: `${nombre("SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ? AND statut = 'open'", serveur.id)} ouverts\n-# ${nombre('SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ?', serveur.id)} au total`, inline: true },
        { name: '🎉 Giveaways', value: `${nombre("SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ? AND statut = 'running'", serveur.id)} en cours\n-# ${nombre('SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ?', serveur.id)} au total`, inline: true },
        { name: '⭐ XP', value: `${formaterNombre(nombre('SELECT COALESCE(SUM(xp), 0) AS n FROM xp WHERE serveur_id = ?', serveur.id))} XP\n-# ${nombre('SELECT COUNT(*) AS n FROM xp WHERE serveur_id = ? AND xp > 0', serveur.id)} membres classés`, inline: true },
        { name: '🔴 Twitch', value: `${nombre('SELECT COUNT(*) AS n FROM chaines_twitch WHERE serveur_id = ? AND live_id IS NOT NULL', serveur.id)} en live\n-# ${nombre('SELECT COUNT(*) AS n FROM chaines_twitch WHERE serveur_id = ?', serveur.id)} chaîne(s) suivie(s)`, inline: true },
        { name: '⌨️ Commandes', value: `${formaterNombre(sommeJours(serveur.id, 'commandes', aujourdhui))} aujourd’hui\n-# ${formaterNombre(sommeJours(serveur.id, 'commandes', semaine))} sur 7 j`, inline: true },
      );
    await repondre(interaction, { embeds: [embed] });
  },
};

export const moduleStatistiques: ModuleBot = {
  id: 'stats',
  nom: 'Statistiques',
  emoji: '📈',
  description: 'Messages, vocal, arrivées et activité du serveur',
  desactivable: true,
  actifParDefaut: true,
  commandes: [statistiques],
  evenements: [
    sur('messageCreate', (message) => {
      if (!message.inGuild() || message.author.bot) return;
      incrementerJour(message.guildId, 'messages');
      incrementerMembre(message.guildId, message.author.id, 'messages');
    }, 250),
    sur('guildMemberAdd', (membre) => {
      if (!membre.user.bot) incrementerJour(membre.guild.id, 'arrivees');
    }, 250),
    sur('guildMemberRemove', (membre) => {
      if (!membre.user?.bot) incrementerJour(membre.guild.id, 'departs');
    }, 250),
  ],
};
