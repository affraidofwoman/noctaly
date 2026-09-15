import {
  type ButtonInteraction,
  ButtonStyle,
  type CategoryChannel,
  ChannelType,
  type ChatInputCommandInteraction,
  type Collection,
  EmbedBuilder,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  type User,
} from 'discord.js';
import { aNiveau, emojiPour, verifierModerable } from '../coeur/acces';
import {
  bouton,
  couleurPour,
  demanderConfirmation,
  embedEnseigne,
  erreur,
  info,
  lignesEnPages,
  nomEnseigne,
  ok,
  paginer,
  rangee,
  refus,
  repondre,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireJson, lireTout } from '../coeur/base';
import { historiser, journal } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
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
    .setColor(couleurPour(serveur, pose ? 'error' : 'success'))
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

export function estEnListeNoire(serveurId: string, utilisateurId: string): { portee: string; raison: string; ajoute_par: string; ajoute_le: number } | undefined {
  return lire('SELECT portee, raison, ajoute_par, ajoute_le FROM liste_noire WHERE utilisateur_id = ? AND portee IN (?, ?) ORDER BY portee = ? DESC LIMIT 1', utilisateurId, serveurId, 'global', 'global');
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
  const opts: Record<string, boolean | null> = {};
  for (const drapeau of PERMISSIONS_VERROU) {
    const nom = new PermissionsBitField(drapeau).toArray()[0]!;
    opts[nom] = (autorise & drapeau) === drapeau ? true : (refuse & drapeau) === drapeau ? false : null;
  }
  return opts;
}

export interface ResultatVerrou {
  id: number;
  verrouilles: number;
  ignores: number;
}

function verrouActif(serveurId: string, portee: PorteeVerrou, cibleId: string) {
  return lire<{ id: number; instantane: string }>('SELECT id, instantane FROM verrouillages WHERE serveur_id = ? AND portee = ? AND cible_id = ? AND actif = 1', serveurId, portee, cibleId);
}

export async function verrouiller(serveur: Guild, portee: PorteeVerrou, cibleId: string, auteur: User, raison: string): Promise<ResultatVerrou> {
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
  for (const salonVise of salons) {
    try {
      const cliche = await verrouillerSalon(salonVise, audit);
      if (cliche) instantanes[salonVise.id] = cliche;
      else ignores++;
    } catch {
      ignores++;
    }
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

async function sanctionParCommande(interaction: ChatInputCommandInteraction<'cached'>, type: TypeSanction, cible: User, raison: string | null, dureeMs?: number, avertissementId?: number) {
  await interaction.deferReply();
  const resultat = await appliquerSanction({ serveur: interaction.guild, auteur: interaction.member, cible, type, raison, dureeMs, avertissementId });
  await interaction.editReply({ embeds: [ok(interaction.guild, decrireResultat(resultat), { titre: 'Sanction', sujet: emojiPour(interaction.guildId, 'sanction') })] });
}

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
      .setFooter({ text: `Page ${page}/${total} · /unwarn pour en retirer un` }),
  );
}

// - Nettoyage -

async function effacerMessages(salon: GuildTextBasedChannel, montant: number, filtreMembreId: string | null, auteur: User): Promise<number> {
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

// - Commandes slash -

const optionRaison = (o: import('discord.js').SlashCommandStringOption) => o.setName('raison').setDescription('Pourquoi').setMaxLength(400);

const avertir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o).setRequired(true)),
  async executer(i) {
    await sanctionParCommande(i, 'warn', i.options.getUser('membre', true), i.options.getString('raison', true));
  },
};

const retirerAvertissement: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Retirer un avertissement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addIntegerOption((o) => o.setName('numero').setDescription('Numéro du warn').setMinValue(1))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'unwarn', i.options.getUser('membre', true), i.options.getString('raison'), undefined, i.options.getInteger('numero') ?? undefined);
  },
};

const avertissements: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Ses avertissements')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
  async executer(i) {
    await paginer(i, pagesAvertissements(i.guild, i.options.getUser('membre', true)), true);
  },
};

const exclure: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Rendre muet temporairement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (28 j max)').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const duree = lireDuree(i.options.getString('duree', true));
    if (!duree || duree > TIMEOUT_MAX_MS) throw new ErreurUtilisateur('Durée invalide : exemples `10m`, `2h`, `1j` (28 jours maximum).');
    await sanctionParCommande(i, 'timeout', i.options.getUser('membre', true), i.options.getString('raison'), duree);
  },
};

const leverTimeout: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Lever un timeout')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'untimeout', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const expulser: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulser un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'kick', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const bannir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un compte')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (même hors du serveur)').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'ban', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const debannir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un compte')
    .addStringOption((o) => o.setName('id').setDescription('Identifiant Discord').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const utilisateur = await resoudreUtilisateur(i.client, i.options.getString('id', true));
    if (!utilisateur) throw new ErreurUtilisateur('Identifiant Discord attendu.');
    await sanctionParCommande(i, 'unban', utilisateur, i.options.getString('raison'));
  },
};

const listeNoire: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Blacklist du serveur')
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Blacklister un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant ou mention').setRequired(true))
        .addStringOption((o) => optionRaison(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer de la blacklist')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Détail d’un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('La blacklist')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    if (sousCommande === 'liste') return paginer(i, pagesListeNoire(i.guild), true);
    const utilisateur = await resoudreUtilisateur(i.client, i.options.getString('id', true));
    if (!utilisateur) throw new ErreurUtilisateur('Identifiant Discord attendu.');
    if (sousCommande === 'info') return repondre(i, { embeds: [ficheListeNoire(i.guild, utilisateur)], ephemeral: true });
    return sanctionParCommande(i, sousCommande === 'ajouter' ? 'blacklist' : 'unblacklist', utilisateur, i.options.getString('raison'));
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
      `-# ${entree.portee === 'global' ? 'Blacklist globale : tous les serveurs du bot' : 'Blacklist de ce serveur'}`,
    ].join('\n'),
    { titre: 'Sanction', sujet: emojiPour(serveur.id, 'sanction') },
  );
}

const effacer: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Effacer des messages')
    .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (1 à 1000)').setMinValue(1).setMaxValue(1000).setRequired(true))
    .addUserOption((o) => o.setName('membre').setDescription('Seulement ses messages')),
  async executer(i) {
    if (!i.channel) return;
    await i.deferReply({ flags: 64 });
    const supprimes = await effacerMessages(i.channel, i.options.getInteger('nombre', true), i.options.getUser('membre')?.id ?? null, i.user);
    await i.editReply({ embeds: [ok(i.guild, `**${supprimes}** message(s) supprimé(s).\n-# Les messages de plus de 14 jours et épinglés sont conservés.`)] });
  },
};

const modeLent: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Mode lent du salon')
    .addStringOption((o) => o.setName('duree').setDescription('Délai (0 = coupé)').setRequired(true))
    .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)),
  async executer(i) {
    const brut = i.options.getString('duree', true).trim();
    const secondes = brut === '0' ? 0 : Math.round((lireDuree(/^\d+$/.test(brut) ? `${brut}s` : brut) ?? -1000) / 1000);
    if (secondes < 0 || secondes > 21_600) throw new ErreurUtilisateur('Durée invalide : de `0` à `6h`.');
    const salon = (i.options.getChannel('salon') ?? i.channel) as GuildTextBasedChannel | null;
    if (!salon || !('setRateLimitPerUser' in salon)) throw new ErreurUtilisateur('Ce salon ne gère pas le mode lent.');
    await salon.setRateLimitPerUser(secondes, `Mode lent par ${i.user.tag}`);
    void journal(i.guild, 'channel', { titre: 'Mode lent', ton: 'info', lignes: [`**Salon** : <#${salon.id}>`, `**Délai** : ${secondes ? formaterDuree(secondes * 1000) : 'coupé'}`], par: i.user });
    await repondre(i, { embeds: [ok(i.guild, secondes ? `Mode lent de **${formaterDuree(secondes * 1000)}** sur <#${salon.id}>.` : `Mode lent coupé sur <#${salon.id}>.`)], ephemeral: true });
  },
};

const commandeVerrouiller: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Fermer un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon'))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const salon = i.options.getChannel('salon') ?? i.channel;
    if (!salon) return;
    const r = await verrouiller(i.guild, 'channel', salon.id, i.user, i.options.getString('raison') ?? 'Aucune raison');
    await repondre(i, { embeds: [ok(i.guild, `🔒 <#${salon.id}> fermé (${r.verrouilles} salon).`)] });
  },
};

const commandeDeverrouiller: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Rouvrir un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon')),
  async executer(i) {
    const salon = i.options.getChannel('salon') ?? i.channel;
    if (!salon) return;
    await deverrouiller(i.guild, 'channel', salon.id, i.user);
    await repondre(i, { embeds: [ok(i.guild, `🔓 <#${salon.id}> rouvert.`)] });
  },
};

const verrouillage: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Tout fermer')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé').addChannelTypes(ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice))
        .addStringOption((o) => optionRaison(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Terminer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé')),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Les verrouillages en cours')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    if (sousCommande === 'status') {
      const verrous = verrousActifs(i.guildId);
      const lignes = verrous.map((l) => `• ${l.portee === 'server' ? '**Serveur entier**' : `<#${l.cible_id}>`} — ${marqueTemps(l.cree_le, 'R')}${l.raison ? ` · ${tronquer(l.raison, 60)}` : ''}`);
      return repondre(i, { embeds: [info(i.guild, lignes.join('\n') || 'Aucun verrouillage en cours.', { titre: 'Lockdown', sujet: '🔒' })], ephemeral: true });
    }
    const portee = i.options.getString('portee', true) as PorteeVerrou;
    const cible = portee === 'server' ? i.guildId : (i.options.getChannel('cible')?.id ?? i.channelId);
    const raison = i.options.getString('raison') ?? 'Aucune raison';
    const filtre = portee === 'server' ? 'tout le serveur' : `<#${cible}>`;
    if (sousCommande === 'end') {
      const restaures = await deverrouiller(i.guild, portee, cible, i.user);
      return repondre(i, { embeds: [ok(i.guild, `🔓 Lockdown terminé sur ${filtre} — **${restaures}** salon(s) rouvert(s).`)] });
    }
    return demanderConfirmation(i, {
      titre: '🔒 LOCKDOWN',
      description: `Les membres ne pourront plus écrire sur ${filtre}.\nLes permissions d’origine seront restaurées avec \`/lockdown end\`.`,
      libelleConfirmation: 'Verrouiller',
      surConfirmation: async (b) => {
        await b.update({ embeds: [info(b.guild, 'Verrouillage en cours…')], components: [] });
        const r = await verrouiller(b.guild, portee, cible, b.user, raison);
        await b.editReply({ embeds: [ok(b.guild, `🔒 **${r.verrouilles}** salon(s) verrouillé(s) sur ${filtre}.${r.ignores ? `\n-# ${r.ignores} ignoré(s) (déjà fermés ou inaccessibles).` : ''}`)] });
        if (b.channel && 'send' in b.channel) {
          await b.channel.send({ embeds: [refus(b.guild, `**LOCKDOWN** — ${raison}\nLes messages sont temporairement bloqués.`)] }).catch(() => undefined);
        }
      },
    });
  },
};


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
    domaine: 'owner',
    categorie: 'owner',
    description: 'Blacklist partout',
    usage: '[id] [raison]',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message, parametres) {
      if (!parametres[0]) {
        const lignes = entreesListeNoire('global').map((b) => `• <@${b.utilisateur_id}> \`${b.utilisateur_id}\` — ${tronquer(b.raison, 80)}`);
        await message.reply({ embeds: [info(message.guild, tronquer(lignes.join('\n') || 'Vide.', 4000), { titre: 'Blacklist globale', sujet: '⛔' })], allowedMentions: { repliedUser: false } });
        return;
      }
      const utilisateur = await exigerCible(message, parametres[0]);
      const raison = parametres.slice(1).join(' ') || 'Aucune raison';
      executer(
        `INSERT INTO liste_noire (portee, utilisateur_id, raison, ajoute_par, ajoute_le) VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(portee, utilisateur_id) DO UPDATE SET raison = excluded.raison`,
        utilisateur.id,
        raison,
        message.author.id,
        Date.now(),
      );
      let banni = 0;
      for (const serveur of message.client.guilds.cache.values()) {
        const reussi = await serveur.members.ban(utilisateur.id, { reason: `Blacklist globale : ${raison}`.slice(0, 500) }).then(() => true).catch(() => false);
        if (reussi) {
          banni++;
          historiser(serveur.id, 'blacklist', 'global', utilisateur.id, message.author.id, { reason: raison });
          void journal(serveur, 'blacklist', { titre: 'Blacklist globale', ton: 'alerte', lignes: [`**Cible** : <@${utilisateur.id}> \`${utilisateur.id}\``, `**Raison** : ${raison}`], par: message.author });
        }
      }
      await message.reply({ embeds: [ok(message.guild, `<@${utilisateur.id}> blacklisté partout — banni de **${banni}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'ungbl',
    domaine: 'owner',
    categorie: 'owner',
    description: 'Retirer partout',
    usage: '<id>',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const r = executer("DELETE FROM liste_noire WHERE portee = 'global' AND utilisateur_id = ?", utilisateur.id);
      if (!r.changes) throw new ErreurUtilisateur('Ce compte n’est pas dans la blacklist globale.');
      let debannis = 0;
      for (const serveur of message.client.guilds.cache.values()) {
        if (estEnListeNoire(serveur.id, utilisateur.id)) continue;
        if (await serveur.bans.remove(utilisateur.id, 'Retrait de la blacklist globale').then(() => true).catch(() => false)) debannis++;
      }
      await message.reply({ embeds: [ok(message.guild, `<@${utilisateur.id}> retiré de la blacklist globale — débanni de **${debannis}** serveur(s).`)], allowedMentions: { repliedUser: false } });
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
    const r = await verrouiller(interaction.guild, 'server', interaction.guildId, interaction.user, decodeURIComponent(extra ?? '') || 'Aucune raison');
    await interaction.editReply({ embeds: [ok(interaction.guild, `🔒 **${r.verrouilles}** salon(s) verrouillé(s).`)] });
    return;
  }
  if (action === 'unbanall') {
    if (!aNiveau(interaction.member, Niveau.STREAMER)) throw new ErreurUtilisateur('Accès Streamer requis.');
    await interaction.update({ embeds: [info(interaction.guild, 'Débannissement en cours…')], components: [] });
    const bannissements = await interaction.guild.bans.fetch();
    const enListeNoire = new Set(entreesListeNoire(interaction.guildId).map((b) => b.utilisateur_id));
    let fait = 0;
    for (const b of bannissements.values()) {
      if (enListeNoire.has(b.user.id) || estEnListeNoire(interaction.guildId, b.user.id)) continue;
      if (await interaction.guild.bans.remove(b.user.id, `+unbanall par ${interaction.user.tag}`).then(() => true).catch(() => false)) fait++;
    }
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
  commandes: [avertir, retirerAvertissement, avertissements, exclure, leverTimeout, expulser, bannir, debannir, listeNoire, effacer, modeLent, commandeVerrouiller, commandeDeverrouiller, verrouillage],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [{ prefixe: 'modconf', niveau: Niveau.MODERATEUR, bouton: (i, parametres) => surConfirmationModeration(i, parametres) }],
  evenements: [
    sur('guildMemberAdd', async (membre: GuildMember) => {
      const entree = estEnListeNoire(membre.guild.id, membre.id);
      if (!entree) return;
      try {
        await membre.ban({ reason: `Blacklist${entree.portee === 'global' ? ' globale' : ''} : tentative de retour (${entree.raison})`.slice(0, 500) });
        void journal(membre.guild, 'blacklist', {
          titre: 'Retour bloqué',
          ton: 'alerte',
          lignes: [`**Compte** : <@${membre.id}> \`${membre.id}\``, `**Blacklist** : ${entree.portee === 'global' ? 'globale' : 'serveur'}`, `**Raison** : ${entree.raison}`],
        });
        return 'stop';
      } catch (echec) {
        registreModeration.avertir(`Re-ban impossible de ${membre.id} : ${(echec as Error).message}`);
      }
    }, 1),
  ],
};
