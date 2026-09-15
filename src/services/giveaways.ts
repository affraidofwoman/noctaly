import { randomInt } from 'node:crypto';
import {
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { lireTout, lire, lireJson, executer, transaction } from '../database/db';
import { emojiPour } from '../core/brand';
import { couleurPour } from '../core/embeds';
import { lireConfig } from '../core/guildConfig';
import { journal, historiser } from '../core/logService';
import { creerRegistre } from '../core/logger';
import { tronquer } from '../core/text';
import { joursDepuis, formaterDuree } from '../core/time';
import { bouton, rangee } from '../core/ui';
import { emettreActivite } from './activity';
import { donnerBadge } from './badges';
import { niveauDe } from './xp';

const registre = creerRegistre('giveaways');

export interface ConditionsTirage {
  roleId?: string | null;
  niveauMin?: number | null;
  joursCompteMin?: number | null;
  joursServeurMin?: number | null;
  participantsMin?: number | null;
  note?: string | null;
}

export interface LigneTirage {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  organisateur_id: string;
  lot: string;
  nombre_gagnants: number;
  fin_le: number;
  statut: 'running' | 'paused' | 'ended';
  restant_pause: number | null;
  conditions: string;
  gagnants: string;
  cree_le: number;
}

export function lireTirage(id: number): LigneTirage | undefined {
  return lire<LigneTirage>('SELECT * FROM tirages WHERE id = ?', id);
}

export function tiragesDuServeur(serveurId: string, statut?: LigneTirage['statut']): LigneTirage[] {
  return statut
    ? lireTout<LigneTirage>('SELECT * FROM tirages WHERE serveur_id = ? AND statut = ? ORDER BY cree_le DESC LIMIT 100', serveurId, statut)
    : lireTout<LigneTirage>('SELECT * FROM tirages WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 100', serveurId);
}

export function participants(id: number): string[] {
  return lireTout<{ utilisateur_id: string }>('SELECT utilisateur_id FROM participations_tirages WHERE tirage_id = ? ORDER BY inscrit_le', id).map((r) => r.utilisateur_id);
}

export function nombreParticipants(id: number): number {
  return lire<{ n: number }>('SELECT COUNT(*) AS n FROM participations_tirages WHERE tirage_id = ?', id)?.n ?? 0;
}

export function victoiresDe(serveurId: string, utilisateurId: string): number {
  return (
    lire<{ n: number }>("SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ? AND statut = 'ended' AND gagnants LIKE ?", serveurId, `%"${utilisateurId}"%`)?.n ?? 0
  );
}

export function conditionsDe(g: LigneTirage): ConditionsTirage {
  return lireJson<ConditionsTirage>(g.conditions, {});
}

export function decrireConditions(conditions: ConditionsTirage): string[] {
  return [
    conditions.roleId ? `• Rôle — <@&${conditions.roleId}>` : null,
    conditions.niveauMin ? `• Niveau XP — **${conditions.niveauMin}** minimum` : null,
    conditions.joursCompteMin ? `• Compte Discord — **${conditions.joursCompteMin} j** minimum` : null,
    conditions.joursServeurMin ? `• Sur le serveur depuis — **${conditions.joursServeurMin} j** minimum` : null,
    conditions.participantsMin ? `• Tirage si au moins **${conditions.participantsMin}** participants` : null,
    conditions.note ? `• ${conditions.note}` : null,
  ].filter((l): l is string => !!l);
}

/** Vérifie les conditions de participation. Retourne la raison du refus ou null. */
export function verifierEligibilite(membre: GuildMember, conditions: ConditionsTirage): string | null {
  if (conditions.roleId && !membre.roles.cache.has(conditions.roleId)) return `Il te faut le rôle <@&${conditions.roleId}> pour participer.`;
  if (conditions.niveauMin && niveauDe(membre.guild.id, membre.id) < conditions.niveauMin) return `Il faut être au moins niveau **${conditions.niveauMin}** (tu es niveau ${niveauDe(membre.guild.id, membre.id)}).`;
  if (conditions.joursCompteMin && joursDepuis(membre.user.createdTimestamp) < conditions.joursCompteMin) return `Ton compte Discord doit avoir au moins **${conditions.joursCompteMin} jours**.`;
  if (conditions.joursServeurMin && (!membre.joinedTimestamp || joursDepuis(membre.joinedTimestamp) < conditions.joursServeurMin)) {
    return `Il faut être sur le serveur depuis au moins **${conditions.joursServeurMin} jours**.`;
  }
  return null;
}

export function listeMentions(ids: string[], max = 40): string {
  const affiches = ids.slice(0, max).map((id) => `<@${id}>`).join(', ');
  const reste = ids.length - Math.min(ids.length, max);
  return reste > 0 ? `${affiches} et ${reste} autre${reste > 1 ? 's' : ''}` : affiches;
}

export function construireMessageTirage(serveur: Guild, g: LigneTirage) {
  const nombre = nombreParticipants(g.id);
  const gagnants = lireJson<string[]>(g.gagnants, []);
  const conditions = conditionsDe(g);
  const cadeauEmoji = emojiPour(serveur.id, 'cadeau');
  const termine = g.statut === 'ended';
  const enPause = g.statut === 'paused';
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, termine ? 'info' : 'primary'))
    .setAuthor({ name: termine ? 'Giveaway terminé' : enPause ? 'Giveaway en pause' : 'Giveaway en cours' })
    .setTitle(`${cadeauEmoji} ${termine ? `~~${tronquer(g.lot, 200)}~~` : tronquer(g.lot, 240)}`)
    .setFooter({ text: `${g.nombre_gagnants} gagnant${g.nombre_gagnants > 1 ? 's' : ''} · lancé par ${serveur.members.cache.get(g.organisateur_id)?.user.tag ?? 'le staff'}` });

  if (termine) {
    embed.setDescription(gagnants.length ? `${cadeauEmoji} ${gagnants.length > 1 ? 'Gagnants' : 'Gagnant'} : ${listeMentions(gagnants)}` : '*Personne n’a gagné.*');
    embed.addFields({ name: 'Participants', value: String(nombre), inline: true });
  } else {
    embed.setDescription(enPause ? '⏸️ Les participations sont suspendues pour le moment.' : 'Clique sur **Participer** pour tenter ta chance.');
    const fin = Math.floor(g.fin_le / 1000);
    embed.addFields(
      enPause
        ? { name: 'Temps restant', value: formaterDuree(g.restant_pause ?? 0), inline: true }
        : { name: 'Tirage', value: `<t:${fin}:R>\n-# <t:${fin}:f>`, inline: true },
      { name: 'Participants', value: String(nombre), inline: true },
    );
  }
  const lignesConditions = decrireConditions(conditions);
  if (lignesConditions.length) embed.addFields({ name: 'Conditions', value: tronquer(lignesConditions.join('\n'), 1024), inline: false });

  const composants = [
    rangee(
      bouton(`gw:join:${g.id}`, `Participer (${nombre})`, ButtonStyle.Primary, emojiPour(serveur.id, 'giveaway')).setDisabled(termine || enPause),
      bouton(`gw:info:${g.id}`, '', ButtonStyle.Secondary, emojiPour(serveur.id, 'info')),
    ),
  ];
  return { embeds: [embed], components: composants };
}

async function recupererSalon(client: Client, g: LigneTirage): Promise<GuildTextBasedChannel | null> {
  const salon = await client.channels.fetch(g.salon_id).catch(() => null);
  return salon && salon.isTextBased() && !salon.isDMBased() ? salon : null;
}

export async function rafraichirMessage(client: Client, g: LigneTirage): Promise<void> {
  if (!g.message_id) return;
  const salon = await recupererSalon(client, g);
  if (!salon) return;
  const message = await salon.messages.fetch(g.message_id).catch(() => null);
  if (!message) return;
  await message.edit(construireMessageTirage(salon.guild, g)).catch((echec: Error) => registre.debogage(`Message giveaway non mis à jour : ${echec.message}`));
}

/** Tirage équitable (crypto) de `count` gagnants distincts. */
export function tirerGagnants(reserveTirage: string[], nombre: number): string[] {
  const copie = [...reserveTirage];
  const gagnants: string[] = [];
  while (copie.length && gagnants.length < nombre) gagnants.push(copie.splice(randomInt(copie.length), 1)[0]!);
  return gagnants;
}

export interface NouveauTirage {
  salon: GuildTextBasedChannel;
  organisateur: GuildMember;
  lot: string;
  gagnants: number;
  dureeMs: number;
  conditions: ConditionsTirage;
}

export async function lancerTirage(saisie: NouveauTirage): Promise<LigneTirage> {
  const serveur = saisie.salon.guild;
  const r = executer(
    'INSERT INTO tirages (serveur_id, salon_id, organisateur_id, lot, nombre_gagnants, fin_le, conditions, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    serveur.id,
    saisie.salon.id,
    saisie.organisateur.id,
    saisie.lot,
    saisie.gagnants,
    Date.now() + saisie.dureeMs,
    JSON.stringify(saisie.conditions),
    Date.now(),
  );
  const g = lireTirage(r.lastInsertRowid)!;
  const ping = lireConfig(serveur.id).tirages.roleMentionId;
  const message = await saisie.salon.send({
    content: ping ? `<@&${ping}>` : undefined,
    ...construireMessageTirage(serveur, g),
    allowedMentions: { roles: ping ? [ping] : [] },
  });
  executer('UPDATE tirages SET message_id = ? WHERE id = ?', message.id, g.id);
  historiser(serveur.id, 'giveaway', 'start', null, saisie.organisateur.id, { id: g.id, prize: saisie.lot });
  void journal(serveur, 'giveaway', {
    titre: 'Giveaway lancé',
    ton: 'info',
    lignes: [
      `**Lot** : ${tronquer(saisie.lot, 300)}`,
      `**Gagnants** : ${saisie.gagnants}`,
      `**Fin** : <t:${Math.floor(g.fin_le / 1000)}:R>`,
      `**Salon** : <#${saisie.salon.id}> · [message](${message.url})`,
      ...decrireConditions(saisie.conditions),
    ],
    par: saisie.organisateur.user,
  });
  return lireTirage(g.id)!;
}

export type ResultatParticipation = { inscrit: true } | { inscrit: false; raison: string } | { dejaInscrit: true };

export function participerTirage(membre: GuildMember, g: LigneTirage): ResultatParticipation {
  if (g.statut !== 'running') return { inscrit: false, raison: g.statut === 'paused' ? 'Ce giveaway est en pause.' : 'Ce giveaway est terminé.' };
  if (g.fin_le <= Date.now()) return { inscrit: false, raison: 'Le tirage est en cours.' };
  const refusMotif = verifierEligibilite(membre, conditionsDe(g));
  if (refusMotif) return { inscrit: false, raison: refusMotif };
  const r = executer('INSERT OR IGNORE INTO participations_tirages (tirage_id, utilisateur_id, inscrit_le) VALUES (?, ?, ?)', g.id, membre.id, Date.now());
  if (!r.changes) return { dejaInscrit: true };
  emettreActivite({ serveurId: membre.guild.id, utilisateurId: membre.id, type: 'giveaways', montant: 1 });
  if (lireConfig(membre.guild.id).tirages.journaliserParticipations) {
    void journal(membre.guild, 'giveaway', { titre: 'Participation', ton: 'neutre', lignes: [`<@${membre.id}> participe à **${tronquer(g.lot, 100)}**`] });
  }
  return { inscrit: true };
}

export function quitterTirage(utilisateurId: string, g: LigneTirage): boolean {
  return executer('DELETE FROM participations_tirages WHERE tirage_id = ? AND utilisateur_id = ?', g.id, utilisateurId).changes > 0;
}

/** Termine un giveaway : tirage parmi les participants encore éligibles, annonce, MP, badges, logs. */
export async function terminerTirage(client: Client, id: number, terminePar: string | null = null): Promise<string[]> {
  const pris = transaction(() => {
    const g = lireTirage(id);
    if (!g || g.statut === 'ended') return null;
    executer("UPDATE tirages SET statut = 'ended', fin_le = ? WHERE id = ?", Math.min(g.fin_le, Date.now()), id);
    return g;
  });
  if (!pris) return [];
  const salon = await recupererSalon(client, pris);
  const serveur = salon?.guild ?? client.guilds.cache.get(pris.serveur_id);
  const conditions = conditionsDe(pris);
  const reserveTirage = participants(id);

  let eligibles = reserveTirage;
  if (serveur) {
    // Les membres partis ou qui ne remplissent plus les conditions ne peuvent pas gagner.
    const membres = await serveur.members.fetch({ user: reserveTirage.slice(0, 1000) }).catch(() => null);
    if (membres) eligibles = reserveTirage.filter((uid) => {
      const m = membres.get(uid);
      return m && !verifierEligibilite(m, conditions);
    });
  }
  const suffisant = !conditions.participantsMin || reserveTirage.length >= conditions.participantsMin;
  const gagnants = suffisant ? tirerGagnants(eligibles, pris.nombre_gagnants) : [];
  executer('UPDATE tirages SET gagnants = ? WHERE id = ?', JSON.stringify(gagnants), id);
  const g = lireTirage(id)!;

  if (serveur) {
    for (const w of gagnants) donnerBadge(serveur.id, w, 'giveaway');
    historiser(serveur.id, 'giveaway', 'end', null, terminePar, { id, winners: gagnants, participants: reserveTirage.length });
    void journal(serveur, 'giveaway', {
      titre: 'Giveaway terminé',
      ton: gagnants.length ? 'ok' : 'alerte',
      lignes: [
        `**Lot** : ${tronquer(g.lot, 300)}`,
        gagnants.length ? `**Gagnant(s)** : ${listeMentions(gagnants)}` : suffisant ? '**Aucun participant éligible**' : `**Pas assez de participants** (${reserveTirage.length}/${conditions.participantsMin})`,
        `**Participants** : ${reserveTirage.length}`,
        terminePar ? `**Arrêté par** : <@${terminePar}>` : null,
      ],
    });
  }

  if (salon) {
    await rafraichirMessage(client, g);
    const cadeauEmoji = emojiPour(salon.guild.id, 'cadeau');
    if (gagnants.length) {
      await salon
        .send({
          content: gagnants.slice(0, 50).map((w) => `<@${w}>`).join(' '),
          embeds: [new EmbedBuilder().setColor(couleurPour(salon.guild, 'success')).setDescription(`${cadeauEmoji} Bravo ${listeMentions(gagnants)} — tu remportes **${tronquer(g.lot, 300)}** !\n-# Ouvre un ticket pour récupérer ton lot.`)],
          allowedMentions: { users: gagnants.slice(0, 100) },
        })
        .catch(() => undefined);
    } else {
      const raisonRefus = suffisant ? 'Personne d’éligible n’a participé' : `Pas assez de participants (${reserveTirage.length}/${conditions.participantsMin})`;
      await salon.send({ embeds: [new EmbedBuilder().setColor(couleurPour(salon.guild, 'warning')).setDescription(`⏹️ ${raisonRefus} : **${tronquer(g.lot, 300)}** n’a pas trouvé preneur.`)] }).catch(() => undefined);
    }
    if (gagnants.length && lireConfig(salon.guild.id).tirages.mpGagnants) {
      for (const w of gagnants.slice(0, 20)) {
        const utilisateur = await client.users.fetch(w).catch(() => null);
        await utilisateur
          ?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(salon.guild, 'success')).setTitle(`${cadeauEmoji} Tu as gagné !`).setDescription(`Tu remportes **${tronquer(g.lot, 300)}** sur **${salon.guild.name}**.\nOuvre un ticket sur le serveur pour récupérer ton lot.`)] })
          .catch(() => undefined);
      }
    }
  }
  return gagnants;
}

export async function relancerTirage(client: Client, g: LigneTirage, auteurId: string, nombre?: number): Promise<string[]> {
  const precedent = lireJson<string[]>(g.gagnants, []);
  const reserveTirage = participants(g.id).filter((p) => !precedent.includes(p));
  const gagnants = tirerGagnants(reserveTirage.length ? reserveTirage : participants(g.id), nombre ?? g.nombre_gagnants);
  if (!gagnants.length) return [];
  executer('UPDATE tirages SET gagnants = ? WHERE id = ?', JSON.stringify(gagnants), g.id);
  const salon = await recupererSalon(client, g);
  if (salon) {
    for (const w of gagnants) donnerBadge(salon.guild.id, w, 'giveaway');
    await rafraichirMessage(client, lireTirage(g.id)!);
    await salon.send({
      content: gagnants.map((w) => `<@${w}>`).join(' '),
      embeds: [new EmbedBuilder().setColor(couleurPour(salon.guild, 'success')).setDescription(`${emojiPour(salon.guild.id, 'cadeau')} Nouveau tirage pour **${tronquer(g.lot, 300)}** — bravo ${listeMentions(gagnants)}.`)],
      allowedMentions: { users: gagnants },
    });
    historiser(salon.guild.id, 'giveaway', 'reroll', null, auteurId, { id: g.id, winners: gagnants });
    void journal(salon.guild, 'giveaway', { titre: 'Giveaway relancé', ton: 'info', lignes: [`**Lot** : ${tronquer(g.lot, 300)}`, `**Nouveau(x) gagnant(s)** : ${listeMentions(gagnants)}`], par: client.users.cache.get(auteurId) ?? null });
  }
  return gagnants;
}

export function mettreTirageEnPause(g: LigneTirage): void {
  executer("UPDATE tirages SET statut = 'paused', restant_pause = ? WHERE id = ? AND statut = 'running'", Math.max(0, g.fin_le - Date.now()), g.id);
}

export function reprendreTirage(g: LigneTirage): void {
  executer("UPDATE tirages SET statut = 'running', fin_le = ?, restant_pause = NULL WHERE id = ? AND statut = 'paused'", Date.now() + (g.restant_pause ?? 60_000), g.id);
}

export function tiragesEchus(): LigneTirage[] {
  return lireTout<LigneTirage>("SELECT * FROM tirages WHERE statut = 'running' AND fin_le <= ? LIMIT 20", Date.now());
}
