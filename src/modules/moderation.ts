import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  type CategoryChannel,
  ChannelType,

  type Collection,
  EmbedBuilder,
  type Client,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type User,
} from 'discord.js';
import { aNiveau, emojiPour, enseigneDe, verifierModerable } from '../coeur/acces';
import {
  bouton,
  construireFormulaire,
  couleurPour,
  creerSuivi,

  embedEnseigne,
  erreur,
  info,
  lignesEnPages,
  nomEnseigne,
  ok,
  paginer,
  rangee,
  repondre,
  suiviReponse,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireJson, lireTout } from '../coeur/base';
import { historiser, journal } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type GestionnaireComposant, type ModuleBot, sur } from '../coeur/noyau';
import {
  creerRegistre,
  ErreurUtilisateur,
  formaterDuree,
  lireDuree,
  marqueTemps,
  membreCible,
  resoudreUtilisateur,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig } from '../coeur/reglages';

const registre = creerRegistre('sanctions');

export type TypeSanction = 'warn' | 'unwarn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'blacklist' | 'unblacklist';

export const TIMEOUT_MAX_MS = 28 * 86_400_000;

const LIBELLES: Record<TypeSanction, { title: string; verbe: string; pose: boolean; emoji: string }> = {
  warn: { title: 'Avertissement', verbe: 'averti', pose: true, emoji: '⚠️' },
  unwarn: { title: 'Avertissement retiré', verbe: 'retiré un avertissement à', pose: false, emoji: '🧽' },
  timeout: { title: 'Timeout', verbe: 'mis en timeout', pose: true, emoji: '⏳' },
  untimeout: { title: 'Timeout levé', verbe: 'sorti du timeout', pose: false, emoji: '🔊' },
  kick: { title: 'Expulsion', verbe: 'expulsé', pose: true, emoji: '👢' },
  ban: { title: 'Bannissement', verbe: 'banni', pose: true, emoji: '🔨' },
  unban: { title: 'Débannissement', verbe: 'débanni', pose: false, emoji: '🕊️' },
  blacklist: { title: 'Blacklist', verbe: 'blacklisté', pose: true, emoji: '⛔' },
  unblacklist: { title: 'Blacklist levée', verbe: 'retiré de la blacklist', pose: false, emoji: '✅' },
};

const TEXTE_MP: Partial<Record<TypeSanction, (filtre: string) => string>> = {
  warn: (w) => `Tu as reçu un **avertissement** sur ${w}`,
  timeout: (w) => `Tu as été **mis en timeout** sur ${w}`,
  kick: (w) => `Tu as été **expulsé** de ${w}`,
  ban: (w) => `Tu as été **banni** de ${w}`,
  unban: (w) => `Ton bannissement de ${w} a été **levé**. Tu peux revenir.`,
  blacklist: (w) => `Tu as été **blacklist** de ${w} définitivement`,
  unblacklist: (w) => `Tu as été **retiré de la blacklist** de ${w}. Tu peux revenir.`,
};

export interface EntreeSanction {
  serveur: Guild;
  auteur: GuildMember;
  cible: User;
  type: TypeSanction;
  raison?: string | null;
  dureeMs?: number;
  avertissementId?: number;
  auto?: boolean;
}

export interface ResultatSanction {
  type: TypeSanction;
  cible: User;
  raison: string;
  mpEnvoye: boolean;
  avertissements?: number;
  avertissementId?: number;
  followUp?: ResultatSanction | null;
  jusqua?: number;
}

async function prevenir(serveur: Guild, utilisateur: User, type: TypeSanction, raison: string, dureeMs?: number): Promise<boolean> {
  const reglages = lireConfig(serveur.id).moderation;
  const texte = TEXTE_MP[type];
  if (!reglages.mpSanction || !texte || utilisateur.bot) return false;
  const pose = LIBELLES[type].pose;
  const lignes = [texte(`**${serveur.name}**`)];
  if (pose) {
    lignes[0] += raison ? ` pour la raison suivante : \`${tronquer(raison, 400)}\`` : '.';
    if (dureeMs) lignes.push(`Durée : **${formaterDuree(dureeMs)}**`);
    if (reglages.texteContact) lignes.push('', reglages.texteContact);
  }
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, pose ? 'erreur' : 'succes'))
    .setAuthor({ name: pose ? 'Sanction appliquée' : 'Sanction levée' })
    .setDescription(lignes.join('\n'))
    .setFooter({ text: nomEnseigne(serveur) })
    .setTimestamp();
  try {
    await utilisateur.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

export function avertissementsActifs(serveurId: string, utilisateurId: string): { id: number; moderateur_id: string; raison: string; cree_le: number }[] {
  return lireTout('SELECT id, moderateur_id, raison, cree_le FROM avertissements WHERE serveur_id = ? AND utilisateur_id = ? AND actif = 1 ORDER BY cree_le ASC', serveurId, utilisateurId);
}

export function compterAvertissements(serveurId: string, utilisateurId: string): number {
  return lire<{ n: number }>('SELECT COUNT(*) AS n FROM avertissements WHERE serveur_id = ? AND utilisateur_id = ? AND actif = 1', serveurId, utilisateurId)?.n ?? 0;
}

// - Blacklist d’enseigne -
// Partagée entre les serveurs d’une même enseigne, jamais au-delà.
export function porteeListeNoireEnseigne(serveurId: string): string | null {
  const cle = enseigneDe(serveurId).cle;
  return cle ? `enseigne:${cle}` : null;
}

export function estEnListeNoire(serveurId: string, utilisateurId: string): { portee: string; raison: string; ajoute_par: string; ajoute_le: number } | undefined {
  const partagee = porteeListeNoireEnseigne(serveurId) ?? serveurId;
  return lire('SELECT portee, raison, ajoute_par, ajoute_le FROM liste_noire WHERE utilisateur_id = ? AND portee IN (?, ?) ORDER BY portee = ? DESC LIMIT 1', utilisateurId, serveurId, partagee, partagee);
}

export function entreesListeNoire(portee: string): { utilisateur_id: string; raison: string; ajoute_par: string; ajoute_le: number }[] {
  return lireTout('SELECT utilisateur_id, raison, ajoute_par, ajoute_le FROM liste_noire WHERE portee = ? ORDER BY ajoute_le DESC', portee);
}

async function recupererMembre(serveur: Guild, id: string): Promise<GuildMember | null> {
  return serveur.members.cache.get(id) ?? (await serveur.members.fetch(id).catch(() => null));
}

export async function appliquerSanction(saisie: EntreeSanction): Promise<ResultatSanction> {
  const { serveur, auteur, cible, type } = saisie;
  const raison = (saisie.raison ?? '').trim() || 'Aucune raison';
  const raisonAudit = tronquer(`${raison} — par ${auteur.user.tag}`, 500);
  const membre = await recupererMembre(serveur, cible.id);
  const exigeMembre = ['warn', 'timeout', 'untimeout', 'kick'].includes(type);
  if (exigeMembre && !membre) throw new ErreurUtilisateur('Ce membre n’est pas sur le serveur.');
  if (membre && ['warn', 'timeout', 'kick', 'ban', 'blacklist'].includes(type) && !saisie.auto) {
    const verification = verifierModerable(auteur, membre);
    if (!verification.ok) throw new ErreurUtilisateur(verification.reason);
  }

  const resultat: ResultatSanction = { type, cible, raison, mpEnvoye: false };

  if (type === 'kick' || type === 'ban' || type === 'blacklist') {
    resultat.mpEnvoye = await prevenir(serveur, cible, type, raison, saisie.dureeMs);
  }

  switch (type) {
    case 'warn': {
      const r = executer('INSERT INTO avertissements (serveur_id, utilisateur_id, moderateur_id, raison, cree_le) VALUES (?, ?, ?, ?, ?)', serveur.id, cible.id, auteur.id, raison, Date.now());
      resultat.avertissementId = r.lastInsertRowid;
      resultat.avertissements = compterAvertissements(serveur.id, cible.id);
      break;
    }
    case 'unwarn': {
      const avertissement = saisie.avertissementId
        ? lire<{ id: number }>('SELECT id FROM avertissements WHERE id = ? AND serveur_id = ? AND utilisateur_id = ? AND actif = 1', saisie.avertissementId, serveur.id, cible.id)
        : lire<{ id: number }>('SELECT id FROM avertissements WHERE serveur_id = ? AND utilisateur_id = ? AND actif = 1 ORDER BY cree_le DESC LIMIT 1', serveur.id, cible.id);
      if (!avertissement) throw new ErreurUtilisateur('Aucun avertissement actif correspondant.');
      executer('UPDATE avertissements SET actif = 0 WHERE id = ?', avertissement.id);
      resultat.avertissementId = avertissement.id;
      resultat.avertissements = compterAvertissements(serveur.id, cible.id);
      break;
    }
    case 'timeout': {
      const duree = Math.min(Math.max(saisie.dureeMs ?? lireConfig(serveur.id).moderation.minutesTimeoutDefaut * 60_000, 5_000), TIMEOUT_MAX_MS);
      if (!membre!.moderatable) throw new ErreurUtilisateur('Je ne peux pas mettre ce membre en timeout (rôle trop haut ou administrateur).');
      await membre!.timeout(duree, raisonAudit);
      resultat.jusqua = Date.now() + duree;
      saisie.dureeMs = duree;
      break;
    }
    case 'untimeout':
      if (!membre!.isCommunicationDisabled()) throw new ErreurUtilisateur('Ce membre n’est pas en timeout.');
      await membre!.timeout(null, raisonAudit);
      break;
    case 'kick':
      if (!membre!.kickable) throw new ErreurUtilisateur('Je ne peux pas expulser ce membre.');
      await membre!.kick(raisonAudit);
      break;
    case 'ban':
    case 'blacklist': {
      if (membre && !membre.bannable) throw new ErreurUtilisateur('Je ne peux pas bannir ce membre.');
      if (type === 'blacklist') {
        executer(
          `INSERT INTO liste_noire (portee, utilisateur_id, raison, ajoute_par, ajoute_le) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(portee, utilisateur_id) DO UPDATE SET raison = excluded.raison, ajoute_par = excluded.ajoute_par, ajoute_le = excluded.ajoute_le`,
          serveur.id,
          cible.id,
          raison,
          auteur.id,
          Date.now(),
        );
      }
      const heures = lireConfig(serveur.id).moderation.heuresEffaceesBan;
      await serveur.members.ban(cible.id, { reason: raisonAudit, deleteMessageSeconds: Math.min(heures, 168) * 3600 }).catch((echec: { code?: number }) => {
        if (echec.code !== 10026 || type !== 'blacklist') throw echec;
      });
      break;
    }
    case 'unban':
      await serveur.bans.remove(cible.id, raisonAudit).catch((echec: { code?: number }) => {
        if (echec.code === 10026) throw new ErreurUtilisateur('Ce compte n’est pas banni.');
        throw echec;
      });
      break;
    case 'unblacklist': {
      const r = executer('DELETE FROM liste_noire WHERE portee = ? AND utilisateur_id = ?', serveur.id, cible.id);
      if (!r.changes) throw new ErreurUtilisateur('Ce compte n’est pas dans la blacklist du serveur.');
      await serveur.bans.remove(cible.id, raisonAudit).catch(() => undefined);
      break;
    }
  }

  if (type !== 'kick' && type !== 'ban' && type !== 'blacklist') {
    resultat.mpEnvoye = await prevenir(serveur, cible, type, raison, saisie.dureeMs);
  }

  const libelle = LIBELLES[type];
  historiser(serveur.id, type === 'blacklist' || type === 'unblacklist' ? 'blacklist' : 'sanction', type, cible.id, auteur.id, {
    reason: raison,
    durationMs: saisie.dureeMs ?? null,
    warningId: resultat.avertissementId ?? null,
  });
  void journal(serveur, type === 'blacklist' || type === 'unblacklist' ? 'blacklist' : 'sanction', {
    titre: libelle.pose ? `${libelle.title}${saisie.auto ? ' (automatique)' : ''}` : libelle.title,
    ton: libelle.pose ? 'alerte' : 'ok',
    miniature: cible.displayAvatarURL({ size: 128 }),
    lignes: [
      `**Cible** : <@${cible.id}> \`${cible.tag}\` \`${cible.id}\``,
      `**Raison** : ${tronquer(raison, 800)}`,
      saisie.dureeMs && type === 'timeout' ? `**Durée** : ${formaterDuree(saisie.dureeMs)} (fin ${marqueTemps(resultat.jusqua ?? Date.now(), 'R')})` : null,
      resultat.avertissements !== undefined ? `**Avertissements actifs** : ${resultat.avertissements}` : null,
      `**Message privé** : ${resultat.mpEnvoye ? 'remis' : 'non remis'}`,
    ],
    par: auteur.user,
  });

  if (type === 'warn' && !saisie.auto && resultat.avertissements) {
    resultat.followUp = await executerActionAuto(serveur, auteur, cible, resultat.avertissements).catch((echec: unknown) => {
      registre.avertir(`Action automatique impossible : ${(echec as Error).message}`);
      return null;
    });
  }
  return resultat;
}

async function executerActionAuto(serveur: Guild, auteur: GuildMember, cible: User, avertissements: number): Promise<ResultatSanction | null> {
  const regle = lireConfig(serveur.id).moderation.actionsAuto.find((a) => a.avertissements === avertissements);
  if (!regle) return null;
  const moi = serveur.members.me;
  if (!moi) return null;
  return appliquerSanction({
    serveur,
    auteur: moi,
    cible,
    type: regle.action,
    raison: `${avertissements} avertissements (action automatique, dernier par ${auteur.user.tag})`,
    dureeMs: regle.action === 'timeout' ? regle.dureeMinutes * 60_000 : undefined,
    auto: true,
  });
}

export function decrireResultat(resultat: ResultatSanction): string {
  const libelle = LIBELLES[resultat.type];
  const lignes = [`${libelle.emoji} <@${resultat.cible.id}> ${libelle.verbe}.`, `-# Raison : ${tronquer(resultat.raison, 300)}`];
  if (resultat.jusqua) lignes.push(`-# Fin ${marqueTemps(resultat.jusqua, 'R')}`);
  if (resultat.avertissements !== undefined) lignes.push(`-# Avertissements actifs : **${resultat.avertissements}**${resultat.avertissementId ? ` · n°${resultat.avertissementId}` : ''}`);
  if (!resultat.mpEnvoye && libelle.pose) lignes.push('-# Message privé non remis (MP fermés).');
  if (resultat.followUp) lignes.push('', `🤖 Action automatique : ${LIBELLES[resultat.followUp.type].title.toLowerCase()}.`);
  return lignes.join('\n');
}

export function lireActionsAuto(saisie: string): { avertissements: number; action: 'timeout' | 'kick' | 'ban'; dureeMinutes: number }[] | null {
  if (!saisie.trim()) return [];
  const sortie: { avertissements: number; action: 'timeout' | 'kick' | 'ban'; dureeMinutes: number }[] = [];
  for (const partie of saisie.split(',')) {
    const m = /^\s*(\d{1,2})\s*:\s*(timeout|kick|ban)\s*(?::\s*(\d{1,5}))?\s*$/i.exec(partie);
    if (!m) return null;
    const action = m[2]!.toLowerCase() as 'timeout' | 'kick' | 'ban';
    sortie.push({ avertissements: Number(m[1]), action, dureeMinutes: action === 'timeout' ? Math.min(Number(m[3] ?? 60), 40_320) : 0 });
  }
  return sortie.sort((a, b) => a.avertissements - b.avertissements);
}

export function formaterActionsAuto(liste: { avertissements: number; action: string; dureeMinutes: number }[]): string {
  return liste.map((a) => `${a.avertissements}:${a.action}${a.action === 'timeout' ? `:${a.dureeMinutes}` : ''}`).join(', ');
}

export type PorteeVerrou = 'channel' | 'category' | 'server';

interface InstantanePermissions {
  autorise: string;
  refuse: string;
  existait: boolean;
}

const PERMISSIONS_VERROU = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Speak,
];

const VERROUILLABLES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildStageVoice]);

function instantane(salon: GuildChannel): InstantanePermissions {
  const permissionExistante = salon.permissionOverwrites.cache.get(salon.guild.roles.everyone.id);
  return { autorise: String(permissionExistante?.allow.bitfield ?? 0n), refuse: String(permissionExistante?.deny.bitfield ?? 0n), existait: !!permissionExistante };
}

async function verrouillerSalon(salon: GuildChannel, raison: string): Promise<InstantanePermissions | null> {
  if (!VERROUILLABLES.has(salon.type)) return null;
  const tousMembres = salon.guild.roles.everyone;
  if (!salon.permissionsFor(tousMembres)?.has(PermissionFlagsBits.SendMessages) && salon.type !== ChannelType.GuildVoice) return null;
  const cliche = instantane(salon);
  await salon.permissionOverwrites.edit(tousMembres, Object.fromEntries(PERMISSIONS_VERROU.map((p) => [new PermissionsBitField(p).toArray()[0]!, false])), { reason: raison });
  return cliche;
}

async function restaurerSalon(salon: GuildChannel, cliche: InstantanePermissions, raison: string): Promise<void> {
  const tousMembres = salon.guild.roles.everyone.id;
  const options = cliche.existait ? versOptions(BigInt(cliche.autorise), BigInt(cliche.refuse)) : versOptions(0n, 0n);
  await salon.permissionOverwrites.edit(tousMembres, options, { reason: raison });
  if (!cliche.existait) {
    const actuel = salon.permissionOverwrites.cache.get(tousMembres);
    if (actuel && actuel.allow.bitfield === 0n && actuel.deny.bitfield === 0n) await actuel.delete(raison);
  }
}

function versOptions(autorise: bigint, refuse: bigint): Record<string, boolean | null> {
  const choix: Record<string, boolean | null> = {};
  for (const drapeau of PERMISSIONS_VERROU) {
    const nom = new PermissionsBitField(drapeau).toArray()[0]!;
    choix[nom] = (autorise & drapeau) === drapeau ? true : (refuse & drapeau) === drapeau ? false : null;
  }
  return choix;
}

export interface ResultatVerrou {
  id: number;
  verrouilles: number;
  ignores: number;
}

function verrouActif(serveurId: string, portee: PorteeVerrou, cibleId: string) {
  return lire<{ id: number; instantane: string }>('SELECT id, instantane FROM verrouillages WHERE serveur_id = ? AND portee = ? AND cible_id = ? AND actif = 1', serveurId, portee, cibleId);
}

export async function verrouiller(serveur: Guild, portee: PorteeVerrou, cibleId: string, auteur: User, raison: string, progression?: (fait: number, total: number) => void): Promise<ResultatVerrou> {
  if (verrouActif(serveur.id, portee, cibleId)) throw new ErreurUtilisateur(portee === 'channel' ? 'Ce salon est déjà verrouillé.' : 'Un verrouillage est déjà en cours sur cette cible.');
  let salons: GuildChannel[];
  if (portee === 'channel') {
    const salonVise = serveur.channels.cache.get(cibleId);
    if (!salonVise || !('permissionOverwrites' in salonVise)) throw new ErreurUtilisateur('Salon introuvable.');
    salons = [salonVise as GuildChannel];
  } else if (portee === 'category') {
    const motif = serveur.channels.cache.get(cibleId) as CategoryChannel | undefined;
    if (!motif || motif.type !== ChannelType.GuildCategory) throw new ErreurUtilisateur('Catégorie introuvable.');
    salons = [...motif.children.cache.values()];
  } else {
    salons = [...serveur.channels.cache.values()].filter((c) => 'permissionOverwrites' in c && c.type !== ChannelType.GuildCategory) as unknown as GuildChannel[];
  }

  const audit = `Verrouillage par ${auteur.tag} : ${raison}`.slice(0, 500);
  const instantanes: Record<string, InstantanePermissions> = {};
  let ignores = 0;
  let fait = 0;
  for (const salonVise of salons) {
    try {
      const cliche = await verrouillerSalon(salonVise, audit);
      if (cliche) instantanes[salonVise.id] = cliche;
      else ignores++;
    } catch {
      ignores++;
    }
    progression?.(++fait, salons.length);
  }
  if (!Object.keys(instantanes).length) throw new ErreurUtilisateur('Aucun salon à verrouiller (déjà fermés ou permissions insuffisantes).');
  const r = executer(
    'INSERT INTO verrouillages (serveur_id, portee, cible_id, instantane, raison, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
    serveur.id,
    portee,
    cibleId,
    JSON.stringify(instantanes),
    raison,
    auteur.id,
    Date.now(),
  );
  historiser(serveur.id, 'security', 'lock', null, auteur.id, { scope: portee, targetId: cibleId, reason: raison, channels: Object.keys(instantanes).length });
  void journal(serveur, 'security', {
    titre: portee === 'server' ? 'Lockdown du serveur' : portee === 'category' ? 'Catégorie verrouillée' : 'Salon verrouillé',
    ton: 'alerte',
    lignes: [portee === 'server' ? '**Cible** : tout le serveur' : `**Cible** : <#${cibleId}>`, `**Salons fermés** : ${Object.keys(instantanes).length}`, `**Raison** : ${raison}`],
    par: auteur,
  });
  return { id: r.lastInsertRowid, verrouilles: Object.keys(instantanes).length, ignores };
}

export async function deverrouiller(serveur: Guild, portee: PorteeVerrou, cibleId: string, auteur: User): Promise<number> {
  const rangee = verrouActif(serveur.id, portee, cibleId);
  if (!rangee) throw new ErreurUtilisateur(portee === 'channel' ? 'Ce salon n’est pas verrouillé par le bot.' : 'Aucun verrouillage en cours sur cette cible.');
  const instantanes = lireJson<Record<string, InstantanePermissions>>(rangee.instantane, {});
  const audit = `Déverrouillage par ${auteur.tag}`;
  let restaures = 0;
  for (const [salonId, cliche] of Object.entries(instantanes)) {
    const salonVise = serveur.channels.cache.get(salonId);
    if (!salonVise || !('permissionOverwrites' in salonVise)) continue;
    try {
      await restaurerSalon(salonVise as GuildChannel, cliche, audit);
      restaures++;
    } catch {}
  }
  executer('UPDATE verrouillages SET actif = 0 WHERE id = ?', rangee.id);
  historiser(serveur.id, 'security', 'unlock', null, auteur.id, { scope: portee, targetId: cibleId, restored: restaures });
  void journal(serveur, 'security', {
    titre: portee === 'server' ? 'Fin du lockdown' : 'Déverrouillage',
    ton: 'ok',
    lignes: [portee === 'server' ? '**Cible** : tout le serveur' : `**Cible** : <#${cibleId}>`, `**Salons rouverts** : ${restaures}`],
    par: auteur,
  });
  return restaures;
}

export function verrousActifs(serveurId: string): { portee: PorteeVerrou; cible_id: string; cree_le: number; raison: string | null }[] {
  return lireTout('SELECT portee, cible_id, cree_le, raison FROM verrouillages WHERE serveur_id = ? AND actif = 1 ORDER BY cree_le DESC', serveurId);
}

export function serveurVerrouille(serveurId: string): boolean {
  return !!verrouActif(serveurId, 'server', serveurId);
}

const registreModeration = creerRegistre('moderation');


async function sanctionParMessage(message: Message<true>, type: TypeSanction, cible: User, raison: string | null, dureeMs?: number, avertissementId?: number) {
  if (!message.member) return;
  const resultat = await appliquerSanction({ serveur: message.guild, auteur: message.member, cible, type, raison, dureeMs, avertissementId });
  await message.reply({ embeds: [ok(message.guild, decrireResultat(resultat), { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') })], allowedMentions: { repliedUser: false } });
}

function pagesAvertissements(serveur: Guild, utilisateur: User) {
  const liste = avertissementsActifs(serveur.id, utilisateur.id);
  const lignes = liste.map((w, i) => `**${i + 1}.** \`n°${w.id}\` ${marqueTemps(w.cree_le, 'd')} — ${tronquer(w.raison, 120)}\n-# par <@${w.moderateur_id}>`);
  if (!lignes.length) lignes.push('*Aucun avertissement actif.*');
  return lignesEnPages(lignes, 8, (contenu, page, total) =>
    embedEnseigne(serveur)
      .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
      .setTitle(`⚠️ Avertissements — ${liste.length}`)
      .setDescription(contenu)
      .setFooter({ text: `Page ${page}/${total} · /sanction pour en retirer un` }),
  );
}

// - Nettoyage -

async function effacerMessages(salon: GuildTextBasedChannel, montant: number, filtreMembreId: string | null, auteur: User, progression?: (fait: number, total: number) => void): Promise<number> {
  const max = Math.min(Math.max(montant, 1), 1000);
  let supprimes = 0;
  let avant: string | undefined;
  const limite = Date.now() - 14 * 86_400_000 + 60_000;
  while (supprimes < max) {
    const lot: Collection<string, Message> = await salon.messages.fetch({ limit: 100, before: avant });
    if (!lot.size) break;
    avant = lot.last()?.id;
    const candidats = lot.filter((m) => m.createdTimestamp > limite && !m.pinned && (!filtreMembreId || m.author.id === filtreMembreId));
    const aSupprimer = [...candidats.values()].slice(0, max - supprimes);
    if (aSupprimer.length) {
      const retiree = await salon.bulkDelete(aSupprimer, true);
      supprimes += retiree.size;
      progression?.(supprimes, max);
    }
    if (lot.size < 100 || lot.last()!.createdTimestamp < limite) break;
  }
  historiser(salon.guild.id, 'clear', 'clear', filtreMembreId, auteur.id, { channelId: salon.id, deleted: supprimes });
  void journal(salon.guild, 'clear', {
    titre: 'Salon nettoyé',
    ton: 'alerte',
    lignes: [`**Salon** : <#${salon.id}>`, `**Messages supprimés** : ${supprimes}`, filtreMembreId ? `**Filtre** : <@${filtreMembreId}>` : null],
    par: auteur,
  });
  return supprimes;
}

// - /sanction : la fiche d’un compte, les sanctions au clic -
export interface EtatSanction {
  present: boolean;
  muet: boolean;
  banni: boolean;
  blacklist: boolean;
  avertissements: number;
}

export function actionsSanction(e: EtatSanction): TypeSanction[] {
  const actions: TypeSanction[] = [];
  if (e.present) actions.push('warn', e.muet ? 'untimeout' : 'timeout', 'kick');
  actions.push(e.banni ? 'unban' : 'ban');
  if (e.avertissements) actions.push('unwarn');
  actions.push(e.blacklist ? 'unblacklist' : 'blacklist');
  return actions;
}

const BOUTONS_SANCTION: Record<TypeSanction, { libelle: string; style: ButtonStyle }> = {
  warn: { libelle: 'Avertir', style: ButtonStyle.Primary },
  unwarn: { libelle: 'Retirer un warn', style: ButtonStyle.Secondary },
  timeout: { libelle: 'Rendre muet', style: ButtonStyle.Secondary },
  untimeout: { libelle: 'Lever le mute', style: ButtonStyle.Success },
  kick: { libelle: 'Expulser', style: ButtonStyle.Danger },
  ban: { libelle: 'Bannir', style: ButtonStyle.Danger },
  unban: { libelle: 'Débannir', style: ButtonStyle.Success },
  blacklist: { libelle: 'Blacklist', style: ButtonStyle.Danger },
  unblacklist: { libelle: 'Retirer de la blacklist', style: ButtonStyle.Success },
};

async function ficheSanction(serveur: Guild, utilisateur: User, note?: string) {
  const membre = await serveur.members.fetch(utilisateur.id).catch(() => null);
  const banni = await serveur.bans.fetch(utilisateur.id).then(() => true).catch(() => false);
  const liste = avertissementsActifs(serveur.id, utilisateur.id);
  const bl = estEnListeNoire(serveur.id, utilisateur.id);
  const muetJusqua = membre?.communicationDisabledUntilTimestamp && membre.communicationDisabledUntilTimestamp > Date.now() ? membre.communicationDisabledUntilTimestamp : null;
  const etat = { present: Boolean(membre), muet: Boolean(muetJusqua), banni, blacklist: Boolean(bl), avertissements: liste.length };
  const situation = [
    bl ? `⛔ Blacklist — ${tronquer(bl.raison, 80)}` : null,
    banni ? '🔨 Banni' : null,
    muetJusqua ? `🔇 Muet, fin ${marqueTemps(muetJusqua, 'R')}` : null,
    !membre && !banni ? '🚪 Pas sur le serveur' : null,
  ].filter(Boolean);
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiPour(serveur.id, 'sanction')} ${membre?.displayName ?? utilisateur.username}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .setDescription(note ?? null)
    .addFields(
      { name: 'Situation', value: situation.join('\n') || '🟢 Rien à signaler', inline: true },
      { name: 'Compte', value: `Créé ${marqueTemps(utilisateur.createdTimestamp, 'R')}${membre?.joinedTimestamp ? `\nArrivé ${marqueTemps(membre.joinedTimestamp, 'R')}` : ''}`, inline: true },
      { name: `Avertissements (${liste.length})`, value: liste.slice(0, 3).map((w) => `\`n°${w.id}\` ${tronquer(w.raison, 60)} · ${marqueTemps(w.cree_le, 'R')}`).join('\n') || '—', inline: false },
    )
    .setFooter({ text: 'Chaque sanction demande une raison ; le membre est prévenu en MP.' });
  const boutons = actionsSanction(etat).map((type) => bouton(`sct:${type}:${utilisateur.id}`, BOUTONS_SANCTION[type].libelle, BOUTONS_SANCTION[type].style, LIBELLES[type].emoji));
  if (liste.length > 3) boutons.push(bouton(`sct:casier:${utilisateur.id}`, 'Tout le casier', ButtonStyle.Secondary, '📋'));
  const rangees = [];
  for (let i = 0; i < boutons.length; i += 4) rangees.push(rangee(...boutons.slice(i, i + 4)));
  return { embeds: [embed], components: rangees };
}

function fenetreSanction(type: TypeSanction, utilisateurId: string) {
  const champs: import('../coeur/affichage').ChampFenetre[] = [];
  if (type === 'timeout') champs.push({ id: 'duree', libelle: 'Durée', valeur: '1h', indication: '10m, 2h, 1j (28 jours maximum)', longueurMax: 10 });
  if (type === 'unwarn') champs.push({ id: 'numero', libelle: 'Numéro du warn (vide = le dernier)', obligatoire: false, longueurMax: 8 });
  champs.push({ id: 'raison', libelle: 'Raison', long: true, obligatoire: type === 'warn' || type === 'blacklist', longueurMax: 400 });
  return construireFormulaire(`sct:m:${type}:${utilisateurId}`, LIBELLES[type].title, champs);
}

const commandeSanction: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('sanction')
    .setDescription('Sanctionner un compte')
    .addUserOption((o) => o.setName('membre').setDescription('Qui, même absent').setRequired(true)),
  async executer(i) {
    await i.deferReply({ flags: 64 });
    await i.editReply(await ficheSanction(i.guild, i.options.getUser('membre', true)));
  },
};

const composantSanction: GestionnaireComposant = {
  prefixe: 'sct',
  niveau: Niveau.MODERATEUR,
  async bouton(interaction: ButtonInteraction<'cached'>, [action, utilisateurId]) {
    const utilisateur = await resoudreUtilisateur(interaction.client, utilisateurId);
    if (!utilisateur) throw new ErreurUtilisateur('Compte introuvable.');
    if (action === 'casier') return paginer(interaction, pagesAvertissements(interaction.guild, utilisateur), true);
    if (!(action! in LIBELLES)) return;
    await interaction.showModal(fenetreSanction(action as TypeSanction, utilisateur.id));
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>, [, action, utilisateurId]) {
    const type = action as TypeSanction;
    if (!(type in LIBELLES)) return;
    const utilisateur = await resoudreUtilisateur(interaction.client, utilisateurId);
    if (!utilisateur) throw new ErreurUtilisateur('Compte introuvable.');
    const champ = (id: string) => {
      try {
        return interaction.fields.getTextInputValue(id).trim();
      } catch {
        return '';
      }
    };
    let dureeMs: number | undefined;
    if (type === 'timeout') {
      dureeMs = lireDuree(champ('duree')) ?? undefined;
      if (!dureeMs || dureeMs > TIMEOUT_MAX_MS) throw new ErreurUtilisateur('Durée invalide : exemples `10m`, `2h`, `1j` (28 jours maximum).');
    }
    const numero = Number(champ('numero')) || undefined;
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: 64 });
    const resultat = await appliquerSanction({ serveur: interaction.guild, auteur: interaction.member, cible: utilisateur, type, raison: champ('raison') || null, dureeMs, avertissementId: numero });
    await interaction.editReply(await ficheSanction(interaction.guild, utilisateur, `✅ ${decrireResultat(resultat)}`));
  },
};

// - /salon : tenir le salon où l’on est -
const LENTEURS = [0, 5, 10, 30, 60, 300, 600, 3600];

function ecranSalon(serveur: Guild, salon: GuildTextBasedChannel, note?: string) {
  const ferme = Boolean(verrouActif(serveur.id, 'channel', salon.id));
  const lockdown = serveurVerrouille(serveur.id);
  const lent = 'rateLimitPerUser' in salon ? (salon.rateLimitPerUser ?? 0) : 0;
  const embed = embedEnseigne(serveur)
    .setTitle(`🔑 #${'name' in salon ? salon.name : 'salon'}`)
    .setDescription(note ?? 'Tout se règle ici, pour ce salon.')
    .addFields(
      { name: 'Écriture', value: ferme ? '🔒 Fermé' : '🔓 Ouvert', inline: true },
      { name: 'Mode lent', value: lent ? formaterDuree(lent * 1000) : 'Coupé', inline: true },
      { name: 'Serveur', value: lockdown ? '🚨 Lockdown en cours' : '🟢 Normal', inline: true },
    );
  const lenteur = new StringSelectMenuBuilder()
    .setCustomId(`sal:slow:${salon.id}`)
    .setPlaceholder('Mode lent')
    .addOptions(LENTEURS.map((s) => ({ label: s ? `Mode lent : ${formaterDuree(s * 1000)}` : 'Mode lent coupé', value: String(s), default: s === lent, emoji: s ? '🐢' : '⚡' })));
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton(`sal:clear:${salon.id}`, 'Effacer', ButtonStyle.Secondary, '🧹'),
        ferme ? bouton(`sal:unlock:${salon.id}`, 'Rouvrir', ButtonStyle.Success, '🔓') : bouton(`sal:lock:${salon.id}`, 'Fermer', ButtonStyle.Danger, '🔒'),
        lockdown ? bouton(`sal:unld:${salon.id}`, 'Fin du lockdown', ButtonStyle.Success, '🟢') : bouton(`sal:ld:${salon.id}`, 'Lockdown serveur', ButtonStyle.Danger, '🚨'),
      ),
      rangee(lenteur),
    ],
  };
}

const commandeSalon: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder().setName('salon').setDescription('Tenir ce salon'),
  async executer(i) {
    if (!i.channel) return;
    await repondre(i, { ...ecranSalon(i.guild, i.channel), ephemeral: true });
  },
};

const composantSalon: GestionnaireComposant = {
  prefixe: 'sal',
  niveau: Niveau.MODERATEUR,
  async bouton(interaction: ButtonInteraction<'cached'>, [action, salonId]) {
    const serveur = interaction.guild;
    const salon = serveur.channels.cache.get(salonId ?? '') as GuildTextBasedChannel | undefined;
    if (!salon?.isTextBased()) throw new ErreurUtilisateur('Salon introuvable.');
    if (action === 'clear') {
      await interaction.showModal(
        construireFormulaire(`sal:m:${salon.id}`, 'Effacer des messages', [
          { id: 'nombre', libelle: 'Combien (1 à 1000)', valeur: '50', longueurMax: 4 },
          { id: 'membre', libelle: 'Seulement ceux de (identifiant)', obligatoire: false, longueurMax: 25 },
        ]),
      );
      return;
    }
    if ((action === 'ld' || action === 'unld') && !aNiveau(interaction.member, Niveau.ADMIN)) throw new ErreurUtilisateur('Le lockdown du serveur est réservé aux admins.');
    await interaction.deferUpdate();
    let note = '';
    if (action === 'lock') note = `🔒 Fermé : seuls le staff et le bot écrivent (${(await verrouiller(serveur, 'channel', salon.id, interaction.user, 'Fermé depuis /salon')).verrouilles} salon).`;
    if (action === 'unlock') note = `🔓 Rouvert (${await deverrouiller(serveur, 'channel', salon.id, interaction.user)} salon).`;
    if (action === 'ld') {
      const suivi = suiviReponse(interaction, serveur, 'Lockdown');
      const r = await verrouiller(serveur, 'server', serveur.id, interaction.user, 'Lockdown depuis /salon', (f, t) => suivi.regler(f, t)).finally(() => suivi.terminer());
      note = `🚨 Lockdown : **${r.verrouilles}** salon(s) fermés.`;
    }
    if (action === 'unld') note = `🟢 Lockdown terminé : **${await deverrouiller(serveur, 'server', serveur.id, interaction.user)}** salon(s) rouverts.`;
    await interaction.editReply(ecranSalon(serveur, salon, note));
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [, salonId]) {
    const salon = interaction.guild.channels.cache.get(salonId ?? '') as GuildTextBasedChannel | undefined;
    if (!salon || !('setRateLimitPerUser' in salon)) throw new ErreurUtilisateur('Ce salon ne gère pas le mode lent.');
    const secondes = Number(interaction.values[0]) || 0;
    await salon.setRateLimitPerUser(secondes, `Mode lent par ${interaction.user.tag}`);
    void journal(interaction.guild, 'channel', { titre: 'Mode lent', ton: 'info', lignes: [`**Salon** : <#${salon.id}>`, `**Délai** : ${secondes ? formaterDuree(secondes * 1000) : 'coupé'}`], par: interaction.user });
    await interaction.update(ecranSalon(interaction.guild, salon, secondes ? `🐢 Mode lent : **${formaterDuree(secondes * 1000)}**.` : '⚡ Mode lent coupé.'));
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>, [, salonId]) {
    const salon = interaction.guild.channels.cache.get(salonId ?? '') as GuildTextBasedChannel | undefined;
    if (!salon?.isTextBased()) throw new ErreurUtilisateur('Salon introuvable.');
    const nombre = Number(interaction.fields.getTextInputValue('nombre'));
    if (!Number.isInteger(nombre) || nombre < 1 || nombre > 1000) throw new ErreurUtilisateur('Un nombre entre 1 et 1000.');
    const filtre = interaction.fields.getTextInputValue('membre').replace(/\D/g, '') || null;
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: 64 });
    const suivi = suiviReponse(interaction, interaction.guild, 'Nettoyage');
    const supprimes = await effacerMessages(salon, nombre, filtre, interaction.user, (f, t) => suivi.regler(f, t));
    await suivi.terminer();
    await interaction.editReply(ecranSalon(interaction.guild, salon, `🧹 **${supprimes}** message(s) effacé(s).\n-# Les messages de plus de 14 jours et les épinglés restent.`));
  },
};

function pagesListeNoire(serveur: Guild) {
  const local = entreesListeNoire(serveur.id);
  const lignes = local.map((b) => `• <@${b.utilisateur_id}> \`${b.utilisateur_id}\` — ${tronquer(b.raison, 80)}\n-# ${marqueTemps(b.ajoute_le, 'd')} par <@${b.ajoute_par}>`);
  if (!lignes.length) lignes.push('*La blacklist est vide.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) =>
    embedEnseigne(serveur).setTitle(`⛔ Blacklist (${local.length})`).setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }),
  );
}

function exigerPorteeEnseigne(serveurId: string): string {
  const portee = porteeListeNoireEnseigne(serveurId);
  if (!portee) throw new ErreurUtilisateur('Ce serveur n’a pas d’enseigne : utilise la blacklist du serveur.');
  return portee;
}

function serveursEnseigne(client: Client, portee: string): Guild[] {
  return [...client.guilds.cache.values()].filter((g) => porteeListeNoireEnseigne(g.id) === portee);
}

function ficheListeNoire(serveur: Guild, utilisateur: User) {
  const entree = estEnListeNoire(serveur.id, utilisateur.id);
  if (!entree) return info(serveur, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiPour(serveur.id, 'sanction') });
  return info(
    serveur,
    [
      `**Compte** — ${utilisateur.tag} (\`${utilisateur.id}\`)`,
      `**Raison** — ${entree.raison}`,
      `**Par** — <@${entree.ajoute_par}>`,
      `**Le** — ${marqueTemps(entree.ajoute_le, 'f')}`,
      `-# ${entree.portee.startsWith('enseigne:') ? 'Blacklist de l’enseigne : tous ses serveurs' : 'Blacklist de ce serveur'}`,
    ].join('\n'),
    { titre: 'Sanction', sujet: emojiPour(serveur.id, 'sanction') },
  );
}

async function exigerCible(message: Message<true>, argument: string | undefined): Promise<User> {
  const membre = await membreCible(message, argument);
  if (membre) return membre.user;
  const utilisateur = await resoudreUtilisateur(message.client, argument);
  if (!utilisateur) throw new ErreurUtilisateur('Mention ou identifiant Discord attendu.');
  return utilisateur;
}

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'ban',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Bannit / débannit',
    usage: '<membre|id> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const banni = await message.guild.bans.fetch(utilisateur.id).catch(() => null);
      await sanctionParMessage(message, banni ? 'unban' : 'ban', utilisateur, parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'kick',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Expulse',
    usage: '<membre> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'kick', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'mute',
    alias: ['timeout', 'to'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Timeout',
    usage: '<membre> <durée> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const duree = lireDuree(parametres[1] ?? '');
      if (!duree || duree > TIMEOUT_MAX_MS) throw new ErreurUtilisateur('Durée attendue : `10m`, `2h`, `1j`…');
      await sanctionParMessage(message, 'timeout', utilisateur, parametres.slice(2).join(' ') || null, duree);
    },
  },
  {
    nom: 'unmute',
    alias: ['untimeout'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Lève un timeout',
    usage: '<membre>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'untimeout', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'warn',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Avertit',
    usage: '<membre> <raison>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const raison = parametres.slice(1).join(' ');
      if (!raison) throw new ErreurUtilisateur('Une raison est attendue.');
      await sanctionParMessage(message, 'warn', utilisateur, raison);
    },
  },
  {
    nom: 'unwarn',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Retire un warn',
    usage: '<membre> [numéro]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      await sanctionParMessage(message, 'unwarn', utilisateur, null, undefined, parametres[1] ? Number(parametres[1]) || undefined : undefined);
    },
  },
  {
    nom: 'warns',
    alias: ['warnings'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Les warns d’un membre',
    usage: '<membre>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      const pages = pagesAvertissements(message.guild, await exigerCible(message, parametres[0]));
      await message.reply({ embeds: [pages[0]!], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'baninfo',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Détail d’un ban',
    usage: '<id>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const bannir = await message.guild.bans.fetch(utilisateur.id).catch(() => null);
      const dernier = lire<{ acteur_id: string; donnees: string; cree_le: number }>(
        "SELECT acteur_id, donnees, cree_le FROM journaux WHERE serveur_id = ? AND utilisateur_id = ? AND type IN ('ban','blacklist') ORDER BY cree_le DESC LIMIT 1",
        message.guildId,
        utilisateur.id,
      );
      const embed = bannir
        ? info(
            message.guild,
            [
              `**Compte** — ${utilisateur.tag} (\`${utilisateur.id}\`)`,
              `**Raison** — ${bannir.reason ?? '*aucune raison enregistrée*'}`,
              dernier ? `**Par** — <@${dernier.acteur_id}>` : null,
              dernier ? `**Le** — ${marqueTemps(dernier.cree_le, 'f')}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') },
          )
        : info(message.guild, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'unbanall',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Débannit tout',
    niveau: Niveau.STREAMER,
    async executer(message) {
      const bannissements = await message.guild.bans.fetch();
      const enListeNoire = new Set(entreesListeNoire(message.guildId).map((b) => b.utilisateur_id));
      const nombre = bannissements.filter((b) => !enListeNoire.has(b.user.id)).size;
      await message.reply({
        embeds: [info(message.guild, `Débannir **${nombre}** compte(s) ?\n-# Les comptes blacklistés restent bannis.`, { titre: 'Confirmation', sujet: '⚠️' })],
        components: [rangee(bouton(`modconf:unbanall:${message.author.id}`, 'Tout débannir', ButtonStyle.Danger, '🕊️'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    nom: 'clear',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Efface',
    usage: '[n] [membre]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const n = Number(parametres[0] ?? 50);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ErreurUtilisateur('Nombre entre 1 et 1000.');
      const cible = parametres[1] ? await exigerCible(message, parametres[1]) : null;
      await message.delete().catch(() => undefined);
      const supprimes = await effacerMessages(message.channel, n, cible?.id ?? null, message.author);
      const note = await message.channel.send({ embeds: [ok(message.guild, `**${supprimes}** message(s) supprimé(s).`)] });
      setTimeout(() => void note.delete().catch(() => undefined), 5_000).unref();
    },
  },
  {
    nom: 'lock',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Ce salon',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await verrouiller(message.guild, 'channel', message.channelId, message.author, parametres.join(' ') || 'Aucune raison');
      await message.reply({ embeds: [ok(message.guild, '🔒 Salon fermé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'unlock',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Ce salon',
    niveau: Niveau.MODERATEUR,
    async executer(message) {
      await deverrouiller(message.guild, 'channel', message.channelId, message.author);
      await message.reply({ embeds: [ok(message.guild, '🔓 Salon rouvert.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'l0all',
    alias: ['lockall'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Tout le serveur',
    niveau: Niveau.ADMIN,
    async executer(message, parametres) {
      await message.reply({
        embeds: [info(message.guild, 'Verrouiller **tout le serveur** ?\n-# `&unl0all` pour tout rouvrir.', { titre: 'LOCKDOWN', sujet: '🔒' })],
        components: [rangee(bouton(`modconf:lockall:${message.author.id}:${encodeURIComponent(parametres.join(' ').slice(0, 60))}`, 'Verrouiller', ButtonStyle.Danger, '🔒'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    nom: 'unl0all',
    alias: ['unlockall'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Rouvre tout le serveur',
    niveau: Niveau.ADMIN,
    async executer(message) {
      const restaures = await deverrouiller(message.guild, 'server', message.guildId, message.author);
      await message.reply({ embeds: [ok(message.guild, `🔓 **${restaures}** salon(s) rouvert(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'slowmode',
    alias: ['slow'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Mode lent',
    usage: '<durée|0>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const brut = parametres[0] ?? '0';
      const secondes = brut === '0' ? 0 : Math.round((lireDuree(/^\d+$/.test(brut) ? `${brut}s` : brut) ?? -1000) / 1000);
      if (secondes < 0 || secondes > 21_600 || !('setRateLimitPerUser' in message.channel)) throw new ErreurUtilisateur('Durée de `0` à `6h`.');
      await message.channel.setRateLimitPerUser(secondes, `Mode lent par ${message.author.tag}`);
      await message.reply({ embeds: [ok(message.guild, secondes ? `Mode lent : **${formaterDuree(secondes * 1000)}**.` : 'Mode lent coupé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'bl',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Blacklist',
    usage: '[id] [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      if (!parametres[0]) {
        await message.reply({ embeds: [pagesListeNoire(message.guild)[0]!], allowedMentions: { repliedUser: false } });
        return;
      }
      await sanctionParMessage(message, 'blacklist', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'unbl',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Retire de la blacklist',
    usage: '<id>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'unblacklist', await exigerCible(message, parametres[0]), null);
    },
  },
  {
    nom: 'blinfo',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Détail blacklist',
    usage: '<id>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      await message.reply({ embeds: [ficheListeNoire(message.guild, await exigerCible(message, parametres[0]))], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'gbl',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Blacklist d’enseigne',
    usage: '[id] [raison]',
    niveau: Niveau.STREAMER,
    async executer(message, parametres) {
      const portee = exigerPorteeEnseigne(message.guildId);
      if (!parametres[0]) {
        const lignes = entreesListeNoire(portee).map((b) => `• <@${b.utilisateur_id}> \`${b.utilisateur_id}\` — ${tronquer(b.raison, 80)}`);
        await message.reply({ embeds: [info(message.guild, tronquer(lignes.join('\n') || 'Vide.', 4000), { titre: 'Blacklist d’enseigne', sujet: '⛔' })], allowedMentions: { repliedUser: false } });
        return;
      }
      const utilisateur = await exigerCible(message, parametres[0]);
      const raison = parametres.slice(1).join(' ') || 'Aucune raison';
      executer(
        `INSERT INTO liste_noire (portee, utilisateur_id, raison, ajoute_par, ajoute_le) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(portee, utilisateur_id) DO UPDATE SET raison = excluded.raison`,
        portee,
        utilisateur.id,
        raison,
        message.author.id,
        Date.now(),
      );
      let banni = 0;
      const serveurs = serveursEnseigne(message.client, portee);
      const attente = await message.reply({ embeds: [info(message.guild, 'Blacklist en cours…')], allowedMentions: { repliedUser: false } });
      const suivi = creerSuivi((texte) => attente.edit({ embeds: [info(message.guild, texte)] }), 'Blacklist d’enseigne', serveurs.length);
      for (const serveur of serveurs) {
        suivi.avancer();
        const reussi = await serveur.members.ban(utilisateur.id, { reason: `Blacklist d’enseigne : ${raison}`.slice(0, 500) }).then(() => true).catch(() => false);
        if (reussi) {
          banni++;
          historiser(serveur.id, 'blacklist', 'enseigne', utilisateur.id, message.author.id, { reason: raison });
          void journal(serveur, 'blacklist', { titre: 'Blacklist d’enseigne', ton: 'alerte', lignes: [`**Cible** : <@${utilisateur.id}> \`${utilisateur.id}\``, `**Raison** : ${raison}`], par: message.author });
        }
      }
      await suivi.terminer();
      await attente.edit({ embeds: [ok(message.guild, `<@${utilisateur.id}> blacklisté sur l’enseigne — banni de **${banni}** serveur(s).`)] });
    },
  },
  {
    nom: 'ungbl',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Retirer de l’enseigne',
    usage: '<id>',
    niveau: Niveau.STREAMER,
    async executer(message, parametres) {
      const portee = exigerPorteeEnseigne(message.guildId);
      const utilisateur = await exigerCible(message, parametres[0]);
      const r = executer('DELETE FROM liste_noire WHERE portee = ? AND utilisateur_id = ?', portee, utilisateur.id);
      if (!r.changes) throw new ErreurUtilisateur('Ce compte n’est pas dans la blacklist de l’enseigne.');
      let debannis = 0;
      for (const serveur of serveursEnseigne(message.client, portee)) {
        if (estEnListeNoire(serveur.id, utilisateur.id)) continue;
        if (await serveur.bans.remove(utilisateur.id, 'Retrait de la blacklist d’enseigne').then(() => true).catch(() => false)) debannis++;
      }
      await message.reply({ embeds: [ok(message.guild, `<@${utilisateur.id}> retiré de la blacklist d’enseigne — débanni de **${debannis}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
];

async function surConfirmationModeration(interaction: ButtonInteraction<'cached'>, [action, proprietaireId, extra]: string[]) {
  if (interaction.user.id !== proprietaireId) {
    await interaction.reply({ embeds: [erreur(interaction.guild, 'Seul l’auteur de la commande peut confirmer.')], flags: 64 });
    return;
  }
  if (action === 'lockall') {
    await interaction.update({ embeds: [info(interaction.guild, 'Verrouillage en cours…')], components: [] });
    const suivi = suiviReponse(interaction, interaction.guild, 'Verrouillage');
    const r = await verrouiller(interaction.guild, 'server', interaction.guildId, interaction.user, decodeURIComponent(extra ?? '') || 'Aucune raison', (f, t) => suivi.regler(f, t)).finally(() => suivi.terminer());
    await interaction.editReply({ embeds: [ok(interaction.guild, `🔒 **${r.verrouilles}** salon(s) verrouillé(s).`)] });
    return;
  }
  if (action === 'unbanall') {
    if (!aNiveau(interaction.member, Niveau.STREAMER)) throw new ErreurUtilisateur('Accès Streamer requis.');
    await interaction.update({ embeds: [info(interaction.guild, 'Débannissement en cours…')], components: [] });
    const bannissements = await interaction.guild.bans.fetch();
    const enListeNoire = new Set(entreesListeNoire(interaction.guildId).map((b) => b.utilisateur_id));
    const suivi = suiviReponse(interaction, interaction.guild, 'Débannissement', bannissements.size);
    let fait = 0;
    for (const b of bannissements.values()) {
      suivi.avancer();
      if (enListeNoire.has(b.user.id) || estEnListeNoire(interaction.guildId, b.user.id)) continue;
      if (await interaction.guild.bans.remove(b.user.id, `+unbanall par ${interaction.user.tag}`).then(() => true).catch(() => false)) fait++;
    }
    await suivi.terminer();
    historiser(interaction.guildId, 'sanction', 'unbanall', null, interaction.user.id, { count: fait });
    void journal(interaction.guild, 'sanction', { titre: 'Débannissement général', ton: 'ok', lignes: [`**Comptes débannis** : ${fait}`], par: interaction.user });
    await interaction.editReply({ embeds: [ok(interaction.guild, `🕊️ **${fait}** compte(s) débanni(s).`)] });
  }
}

const pageReglage: PageReglage = {
  id: 'moderation',
  section: 'moderation',
  titre: 'Sanctions',
  emoji: '🛡️',
  moduleId: 'moderation',
  ordre: 1,
  description: 'Avertissements, actions automatiques et messages privés de sanction.\n-# Actions automatiques : `3:timeout:60, 5:kick, 7:ban` (nombre de warns : action : minutes).',
  champs: [
    { genre: 'toggle', cle: 'dm', libelle: 'Prévenir en MP', lire: (c) => c.moderation.mpSanction, ecrire: (c, v) => void (c.moderation.mpSanction = v) },
    {
      genre: 'text',
      cle: 'auto',
      libelle: 'Actions automatiques',
      longueurMax: 200,
      lire: (c) => formaterActionsAuto(c.moderation.actionsAuto),
      ecrire: (c, v) => void (c.moderation.actionsAuto = lireActionsAuto(v) ?? c.moderation.actionsAuto),
      validate: (v) => (lireActionsAuto(v) ? null : 'Format attendu : `3:timeout:60, 5:kick, 7:ban`.'),
    },
    { genre: 'text', cle: 'contact', libelle: 'Phrase de contact (MP)', long: true, longueurMax: 300, lire: (c) => c.moderation.texteContact, ecrire: (c, v) => void (c.moderation.texteContact = v) },
    { genre: 'number', cle: 'timeout', libelle: 'Timeout par défaut', min: 1, max: 40_320, unite: 'min', lire: (c) => c.moderation.minutesTimeoutDefaut, ecrire: (c, v) => void (c.moderation.minutesTimeoutDefaut = v) },
    { genre: 'number', cle: 'bandelete', libelle: 'Messages effacés au ban', min: 0, max: 168, unite: 'h', lire: (c) => c.moderation.heuresEffaceesBan, ecrire: (c, v) => void (c.moderation.heuresEffaceesBan = v) },
  ],
};

export const moduleModeration: ModuleBot = {
  id: 'moderation',
  nom: 'Modération',
  emoji: '🛡️',
  description: 'Warns, timeouts, bans, blacklist, lock et lockdown',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeSanction, commandeSalon],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [{ prefixe: 'modconf', niveau: Niveau.MODERATEUR, bouton: (i, parametres) => surConfirmationModeration(i, parametres) }, composantSanction, composantSalon],
  evenements: [
    sur('guildMemberAdd', async (membre: GuildMember) => {
      const entree = estEnListeNoire(membre.guild.id, membre.id);
      if (!entree) return;
      try {
        await membre.ban({ reason: `Blacklist${entree.portee.startsWith('enseigne:') ? ' d’enseigne' : ''} : tentative de retour (${entree.raison})`.slice(0, 500) });
        void journal(membre.guild, 'blacklist', {
          titre: 'Retour bloqué',
          ton: 'alerte',
          lignes: [`**Compte** : <@${membre.id}> \`${membre.id}\``, `**Blacklist** : ${entree.portee.startsWith('enseigne:') ? 'enseigne' : 'serveur'}`, `**Raison** : ${entree.raison}`],
        });
        return 'stop';
      } catch (echec) {
        registreModeration.avertir(`Re-ban impossible de ${membre.id} : ${(echec as Error).message}`);
      }
    }, 1),
  ],
};
