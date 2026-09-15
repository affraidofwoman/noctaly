import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type GuildChannel,
  type User,
} from 'discord.js';
import { lireTout, lire, lireJson, executer } from '../database/db';
import { ErreurUtilisateur } from '../core/errors';
import { journal, historiser } from '../core/logService';

export type PorteeVerrou = 'channel' | 'category' | 'server';

/** État de l'overwrite @everyone avant verrouillage, pour le restaurer exactement. */
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
  // Déjà fermé à @everyone : on ne touche à rien.
  if (!salon.permissionsFor(tousMembres)?.has(PermissionFlagsBits.SendMessages) && salon.type !== ChannelType.GuildVoice) return null;
  const cliche = instantane(salon);
  await salon.permissionOverwrites.edit(tousMembres, Object.fromEntries(PERMISSIONS_VERROU.map((p) => [new PermissionsBitField(p).toArray()[0]!, false])), { reason: raison });
  return cliche;
}

async function restaurerSalon(salon: GuildChannel, cliche: InstantanePermissions, raison: string): Promise<void> {
  const tousMembres = salon.guild.roles.everyone.id;
  // Remet exactement l'état d'avant pour les permissions touchées par le verrouillage.
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

/** Verrouille un salon, une catégorie ou tout le serveur, en gardant de quoi tout restaurer. */
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

/** Lève un verrouillage et restaure les permissions d'origine. */
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
    } catch {
      /* salon devenu inaccessible : on continue */
    }
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
