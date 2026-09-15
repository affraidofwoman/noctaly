import { EmbedBuilder, type Guild, type GuildMember, type User } from 'discord.js';
import { lireTout, lire, executer } from '../database/db';
import { nomEnseigne, couleurPour } from '../core/embeds';
import { ErreurUtilisateur } from '../core/errors';
import { lireConfig } from '../core/guildConfig';
import { journal, historiser } from '../core/logService';
import { creerRegistre } from '../core/logger';
import { verifierModerable } from '../core/permissions';
import { tronquer } from '../core/text';
import { formaterDuree, marqueTemps } from '../core/time';

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
  /** Pour unwarn : numéro de l'avertissement (sinon le plus récent). */
  avertissementId?: number;
  /** Ne pas déclencher les actions automatiques (utilisé par elles-mêmes). */
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

/** Message privé façon Airline : « Sanction appliquée » / « Sanction levée ». */
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

/**
 * Applique une sanction complète : vérifications, action Discord, base de données,
 * message privé, journal sanction-log et actions automatiques des warns.
 */
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

  // Le message privé part avant l'expulsion : après, le bot ne partage plus de serveur avec la personne.
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
        // Déjà banni : la blacklist reste valable.
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

/** Actions automatiques configurées : ex. 3 warns → timeout, 5 → kick, 7 → ban. */
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

/** Parse « 3:timeout:60, 5:kick, 7:ban » pour les actions automatiques. */
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
