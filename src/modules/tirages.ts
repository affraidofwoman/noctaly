import { randomInt } from 'node:crypto';
import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  MessageFlags,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { aAcces, emojiPour } from '../coeur/acces';
import {
  bouton,
  construireFormulaire,
  couleurPour,
  embedEnseigne,
  erreur,
  info,
  lignesEnPages,
  ok,
  paginer,
  rangee,
  repondre,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireJson, lireTout, transaction } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot } from '../coeur/noyau';
import {
  creerRegistre,
  ErreurUtilisateur,
  formaterDuree,
  joursDepuis,
  lireDuree,
  marqueTemps,
  resoudreRole,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig } from '../coeur/reglages';
import { donnerBadge, emettreActivite, niveauDe } from './niveaux';

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

const DUREE_MAX = 60 * 86_400_000;
const aRafraichir = new Set<number>();

function exigerTirage(serveurId: string, id: number | string | null | undefined): LigneTirage {
  const g = lireTirage(Number(id));
  if (!g || g.serveur_id !== serveurId) throw new ErreurUtilisateur('Giveaway introuvable.');
  return g;
}

function libelle(g: LigneTirage): string {
  const etat = g.statut === 'running' ? '🟢' : g.statut === 'paused' ? '⏸️' : '⚫';
  return tronquer(`${etat} #${g.id} · ${g.lot}`, 100);
}

// ─── Menu façon Airline ────────────────────────────────────────────────────

function menu(serveur: Guild, note?: string) {
  const lireTout = tiragesDuServeur(serveur.id);
  const enCours = lireTout.filter((g) => g.statut === 'running').length;
  const termine = lireTout.filter((g) => g.statut === 'ended').length;
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'cadeau')} Giveaways`)
    .setDescription(
      [
        note,
        '**Lancer** — tu écris le lot, le nombre de gagnants et la durée.',
        '**Arrêter** — tire les gagnants tout de suite, sans attendre la fin.',
        '**Retirer au sort** — refait le tirage d’un giveaway déjà fini.',
        '',
        `${enCours} en cours · ${termine} terminé${termine > 1 ? 's' : ''} sur ce serveur.`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton('gwm:create', 'Lancer', ButtonStyle.Success, emojiPour(serveur.id, 'cadeau')),
        bouton('gwm:end', 'Arrêter', ButtonStyle.Danger, '⏹️'),
        bouton('gwm:reroll', 'Retirer au sort', ButtonStyle.Secondary, '🔁'),
        bouton('gwm:list', 'Liste', ButtonStyle.Secondary, '📋'),
      ),
    ],
  };
}

function menuChoix(serveur: Guild, action: 'end' | 'reroll') {
  const liste = tiragesDuServeur(serveur.id).filter((g) => (action === 'end' ? g.statut !== 'ended' : g.statut === 'ended' && nombreParticipants(g.id) > 0));
  if (!liste.length) return null;
  return rangee(
    new StringSelectMenuBuilder()
      .setCustomId(`gwm:pick:${action}`)
      .setPlaceholder(action === 'end' ? 'Lequel arrêter maintenant ?' : 'Lequel retirer au sort ?')
      .addOptions(liste.slice(0, 25).map((g) => ({ label: libelle(g), value: String(g.id), description: `${nombreParticipants(g.id)} participant(s) · ${g.nombre_gagnants} gagnant(s)` }))),
  );
}

function pagesListe(serveur: Guild) {
  const lignes = tiragesDuServeur(serveur.id).map((g) => {
    const gagnants = lireJson<string[]>(g.gagnants, []);
    const etat = g.statut === 'running' ? `fin ${marqueTemps(g.fin_le, 'R')}` : g.statut === 'paused' ? 'en pause' : gagnants.length ? `gagné par ${gagnants.map((w) => `<@${w}>`).join(', ')}` : 'sans gagnant';
    return `${libelle(g)}\n-# ${nombreParticipants(g.id)} participant(s) · ${etat}${g.message_id ? ` · [message](https://discord.com/channels/${g.serveur_id}/${g.salon_id}/${g.message_id})` : ''}`;
  });
  if (!lignes.length) lignes.push('*Aucun giveaway.*');
  return lignesEnPages(lignes, 8, (contenu, page, total) => embedEnseigne(serveur).setTitle('🎉 Giveaways').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

// ─── Commande ──────────────────────────────────────────────────────────────

const optionId = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('id').setDescription('Le giveaway').setRequired(true).setAutocomplete(true);

const tirage: CommandeSlash = {
  categorie: 'giveaways',
  niveau: Niveau.STAFF,
  whitelist: 'giveaway',
  donnees: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Les giveaways')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un giveaway')
        .addStringOption((o) => o.setName('recompense').setDescription('Ce qu’on gagne').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duree').setDescription('Ex : 30m, 1h, 2j, 1h30m').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Combien de gagnants (1 par défaut)').setMinValue(1).setMaxValue(50))
        .addChannelOption((o) => o.setName('salon').setDescription('Où (salon giveaways par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle obligatoire'))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau XP minimum').setMinValue(1).setMaxValue(500))
        .addIntegerOption((o) => o.setName('compte').setDescription('Âge minimum du compte Discord (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('anciennete').setDescription('Présence minimum sur le serveur (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('participants').setDescription('Participants minimum pour tirer au sort').setMinValue(2).setMaxValue(100000))
        .addStringOption((o) => o.setName('condition').setDescription('Condition personnalisée affichée (ex : suivre la chaîne)').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('end').setDescription('Arrêter et tirer au sort').addIntegerOption(optionId))
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Refaire le tirage')
        .addIntegerOption(optionId)
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de nouveaux gagnants').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Mettre en pause').addIntegerOption(optionId))
    .addSubcommand((s) => s.setName('resume').setDescription('Reprendre').addIntegerOption(optionId))
    .addSubcommand((s) => s.setName('list').setDescription('Les giveaways du serveur'))
    .addSubcommand((s) => s.setName('menu').setDescription('Le menu Lancer / Arrêter / Retirer au sort')),
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    const sousCommande = interaction.options.getSubcommand();
    const liste = tiragesDuServeur(interaction.guildId).filter((g) =>
      sousCommande === 'reroll' ? g.statut === 'ended' : sousCommande === 'resume' ? g.statut === 'paused' : sousCommande === 'pause' ? g.statut === 'running' : g.statut !== 'ended',
    );
    await interaction.respond(liste.filter((g) => libelle(g).toLowerCase().includes(saisie)).slice(0, 25).map((g) => ({ name: libelle(g), value: g.id })));
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    const client = interaction.client;
    switch (sousCommande) {
      case 'start': {
        const duree = lireDuree(interaction.options.getString('duree', true));
        if (!duree || duree < 10_000 || duree > DUREE_MAX) throw new ErreurUtilisateur('Durée incomprise : écris par exemple `30m`, `1h`, `2j`, `1h30m` (60 jours max).');
        const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(serveur, lireConfig(serveur.id).tirages.salonDefautId) ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
        const conditions: ConditionsTirage = {
          roleId: interaction.options.getRole('role')?.id ?? null,
          niveauMin: interaction.options.getInteger('niveau'),
          joursCompteMin: interaction.options.getInteger('compte'),
          joursServeurMin: interaction.options.getInteger('anciennete'),
          participantsMin: interaction.options.getInteger('participants'),
          note: interaction.options.getString('condition'),
        };
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const g = await lancerTirage({
          salon,
          organisateur: interaction.member,
          lot: interaction.options.getString('recompense', true),
          gagnants: interaction.options.getInteger('gagnants') ?? 1,
          dureeMs: duree,
          conditions,
        });
        return interaction.editReply({ embeds: [ok(serveur, `Giveaway **#${g.id}** lancé dans <#${salon.id}>, tirage ${marqueTemps(g.fin_le, 'R')}.`)] });
      }
      case 'list':
        return paginer(interaction, pagesListe(serveur), true);
      case 'menu':
        return repondre(interaction, { ...menu(serveur), ephemeral: true });
    }
    const g = exigerTirage(serveur.id, interaction.options.getInteger('id', true));
    switch (sousCommande) {
      case 'end': {
        if (g.statut === 'ended') throw new ErreurUtilisateur('Ce giveaway est déjà terminé.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gagnants = await terminerTirage(client, g.id, interaction.user.id);
        return interaction.editReply({ embeds: [ok(serveur, gagnants.length ? `Tirage fait : ${gagnants.map((w) => `<@${w}>`).join(', ')}.` : 'Tirage fait, sans gagnant.')] });
      }
      case 'reroll': {
        if (g.statut !== 'ended') throw new ErreurUtilisateur('Le giveaway doit être terminé pour refaire le tirage.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gagnants = await relancerTirage(client, g, interaction.user.id, interaction.options.getInteger('gagnants') ?? undefined);
        return interaction.editReply({ embeds: [gagnants.length ? ok(serveur, 'C’est retiré au sort.') : erreur(serveur, 'Personne n’a participé à ce giveaway.')] });
      }
      case 'pause':
        if (g.statut !== 'running') throw new ErreurUtilisateur('Ce giveaway n’est pas en cours.');
        mettreTirageEnPause(g);
        await rafraichirMessage(client, lireTirage(g.id)!);
        return repondre(interaction, { embeds: [ok(serveur, `⏸️ Giveaway **#${g.id}** en pause.`)], ephemeral: true });
      case 'resume':
        if (g.statut !== 'paused') throw new ErreurUtilisateur('Ce giveaway n’est pas en pause.');
        reprendreTirage(g);
        await rafraichirMessage(client, lireTirage(g.id)!);
        return repondre(interaction, { embeds: [ok(serveur, `▶️ Giveaway **#${g.id}** repris, tirage ${marqueTemps(lireTirage(g.id)!.fin_le, 'R')}.`)], ephemeral: true });
    }
  },
};

// ─── Composants ────────────────────────────────────────────────────────────

async function surArrivee(interaction: ButtonInteraction<'cached'>, id: string | undefined) {
  const g = exigerTirage(interaction.guildId, id);
  const resultat = participerTirage(interaction.member, g);
  const cadeauEmoji = emojiPour(interaction.guildId, 'cadeau');
  if ('dejaInscrit' in resultat) {
    await interaction.reply({
      embeds: [info(interaction.guild, `Tu participes déjà pour **${tronquer(g.lot, 200)}**.`, { emoji: cadeauEmoji })],
      components: [rangee(bouton(`gw:leave:${g.id}`, 'Me retirer', ButtonStyle.Secondary, '🚪'))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!resultat.inscrit) {
    await interaction.reply({ embeds: [erreur(interaction.guild, resultat.raison)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  aRafraichir.add(g.id);
  await interaction.reply({ embeds: [ok(interaction.guild, `C’est noté, tu participes pour **${tronquer(g.lot, 200)}**.`)], flags: MessageFlags.Ephemeral });
}

async function surFenetreCreation(interaction: ModalSubmitInteraction<'cached'>) {
  const serveur = interaction.guild;
  const lot = interaction.fields.getTextInputValue('prize').trim();
  const gagnants = Number(interaction.fields.getTextInputValue('winners').trim());
  const duree = lireDuree(interaction.fields.getTextInputValue('duration'));
  const roleBrut = interaction.fields.getTextInputValue('role').trim();
  const niveauBrut = interaction.fields.getTextInputValue('level').trim();
  if (!Number.isInteger(gagnants) || gagnants < 1 || gagnants > 50) throw new ErreurUtilisateur('Le nombre de gagnants doit être un entier entre 1 et 50.');
  if (!duree || duree < 10_000 || duree > DUREE_MAX) throw new ErreurUtilisateur('Durée incomprise. Écris un nombre suivi de l’unité : `30m`, `1h`, `2j`, `1h30m`.');
  let roleId: string | null = null;
  if (roleBrut) {
    const role = resoudreRole(serveur, roleBrut.replace(/^@/, ''));
    if (!role) throw new ErreurUtilisateur(`Rôle « ${roleBrut} » introuvable. Laisse vide pour ouvrir à tout le monde.`);
    roleId = role.id;
  }
  const niveauMin = niveauBrut ? Number(niveauBrut) : null;
  if (niveauMin !== null && (!Number.isInteger(niveauMin) || niveauMin < 1)) throw new ErreurUtilisateur('Le niveau minimum doit être un entier positif.');
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).tirages.salonDefautId) ?? (interaction.channel as GuildTextBasedChannel | null);
  if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = await lancerTirage({ salon, organisateur: interaction.member, lot, gagnants, dureeMs: duree, conditions: { roleId, niveauMin } });
  await interaction.editReply({ embeds: [ok(serveur, `Giveaway **#${g.id}** lancé dans <#${salon.id}>, tirage ${marqueTemps(g.fin_le, 'R')}.`)] });
}

const composants = [
  {
    prefixe: 'gw',
    async bouton(interaction: ButtonInteraction<'cached'>, [action, id]: string[]) {
      if (action === 'join') return surArrivee(interaction, id);
      const g = exigerTirage(interaction.guildId, id);
      if (action === 'leave') {
        const partis = quitterTirage(interaction.user.id, g);
        if (partis) aRafraichir.add(g.id);
        return interaction.update({ embeds: [partis ? ok(interaction.guild, 'Tu ne participes plus.') : info(interaction.guild, 'Tu ne participais pas.')], components: [] });
      }
      if (action === 'info') {
        const conditions = decrireConditions(conditionsDe(g));
        return interaction.reply({
          embeds: [
            embedEnseigne(interaction.guild)
              .setTitle(`${emojiPour(interaction.guildId, 'cadeau')} ${tronquer(g.lot, 240)}`)
              .setDescription(
                [
                  `• Gagnants — **${g.nombre_gagnants}**`,
                  `• Participants — **${nombreParticipants(g.id)}**`,
                  g.statut === 'running' ? `• Tirage — ${marqueTemps(g.fin_le, 'R')}` : `• État — **${g.statut === 'paused' ? 'en pause' : 'terminé'}**`,
                  conditions.length ? `\n**Conditions**\n${conditions.join('\n')}` : '\n*Ouvert à tout le monde.*',
                  `\n-# Giveaway #${g.id} · lancé par <@${g.organisateur_id}>`,
                ].join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    },
  },
  {
    prefixe: 'gwm',
    level: Niveau.STAFF,
    whitelist: 'giveaway',
    async bouton(interaction: ButtonInteraction<'cached'>, [action]: string[]) {
      const serveur = interaction.guild;
      if (action === 'create') {
        return interaction.showModal(
          construireFormulaire('gwm:createm', 'Nouveau giveaway', [
            { id: 'prize', libelle: 'Ce qu’on gagne', indication: '1 mois de Nitro', longueurMax: 200 },
            { id: 'winners', libelle: 'Combien de gagnants', valeur: '1', longueurMax: 2 },
            { id: 'duration', libelle: 'Ça dure combien de temps', indication: '1h — ou 30m, 2j, 1h30m', longueurMax: 20 },
            { id: 'role', libelle: 'Rôle requis (vide = tout le monde)', indication: 'Présent — ou @Présent, ou son ID', obligatoire: false, longueurMax: 100 },
            { id: 'level', libelle: 'Niveau XP minimum (vide = aucun)', obligatoire: false, longueurMax: 3 },
          ]),
        );
      }
      if (action === 'end' || action === 'reroll') {
        const choisir = menuChoix(serveur, action);
        if (!choisir) return interaction.update(menu(serveur, action === 'end' ? '⚠️ Aucun giveaway en cours sur ce serveur.\n' : '⚠️ Aucun giveaway terminé avec des participants.\n'));
        return interaction.update({ ...menu(serveur), components: [choisir, rangee(bouton('gwm:home', 'Retour', ButtonStyle.Secondary, '⬅️'))] });
      }
      if (action === 'list') return paginer(interaction, pagesListe(serveur), true);
      if (action === 'home') return interaction.update(menu(serveur));
    },
    async select(interaction: AnySelectMenuInteraction<'cached'>, [action, laquelle]: string[]) {
      if (action !== 'pick' || !interaction.isStringSelectMenu()) return;
      const g = exigerTirage(interaction.guildId, interaction.values[0]);
      await interaction.update({ embeds: [info(interaction.guild, 'Tirage en cours…')], components: [] });
      const gagnants = laquelle === 'end' ? (g.statut === 'ended' ? [] : await terminerTirage(interaction.client, g.id, interaction.user.id)) : await relancerTirage(interaction.client, g, interaction.user.id);
      await interaction.editReply(menu(interaction.guild, gagnants.length ? `✅ Gagnant(s) : ${gagnants.map((w) => `<@${w}>`).join(', ')}\n` : '⚠️ Aucun gagnant.\n'));
    },
    async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action]: string[]) {
      if (action === 'createm') return surFenetreCreation(interaction);
    },
  },
];

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'giveaway',
    alias: ['gw'],
    domaine: 'general',
    categorie: 'giveaways',
    description: 'Lancer, arrêter, retirer au sort',
    niveau: Niveau.STAFF,
    whitelist: 'giveaway',
    async executer(message) {
      await message.reply({ ...menu(message.guild), allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'giveaways',
  section: 'giveaways',
  titre: 'Giveaways',
  emoji: '🎉',
  moduleId: 'giveaways',
  description: 'Où partent les giveaways et qui est prévenu.\n-# Pour les lancer : `/giveaway start` ou le menu `=giveaway` (staff ou whitelist Giveaway).',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon par défaut', lire: (c) => c.tirages.salonDefautId, ecrire: (c, v) => void (c.tirages.salonDefautId = v) },
    { genre: 'role', cle: 'ping', libelle: 'Rôle mentionné au lancement', lire: (c) => c.tirages.roleMentionId, ecrire: (c, v) => void (c.tirages.roleMentionId = v) },
    { genre: 'toggle', cle: 'dm', libelle: 'MP aux gagnants', lire: (c) => c.tirages.mpGagnants, ecrire: (c, v) => void (c.tirages.mpGagnants = v) },
    { genre: 'toggle', cle: 'logjoin', libelle: 'Journaliser les participations', lire: (c) => c.tirages.journaliserParticipations, ecrire: (c, v) => void (c.tirages.journaliserParticipations = v) },
  ],
};

export const moduleTirages: ModuleBot = {
  id: 'giveaways',
  nom: 'Giveaways',
  emoji: '🎉',
  description: 'Giveaways avec conditions, pause et tirages persistants',
  desactivable: true,
  actifParDefaut: true,
  commandes: [tirage],
  commandesPrefixe,
  composants,
  pagesReglage: [pageReglage],
  taches: [
    {
      nom: 'giveaways-end',
      intervalleMs: 10_000,
      auDemarrage: true,
      async executer(client) {
        for (const g of tiragesEchus()) await terminerTirage(client, g.id);
      },
    },
    {
      nom: 'giveaways-refresh',
      intervalleMs: 5_000,
      async executer(client) {
        // Les compteurs « Participer (n) » sont regroupés pour ne pas éditer le message à chaque clic.
        const ids = [...aRafraichir].slice(0, 10);
        for (const id of ids) {
          aRafraichir.delete(id);
          const g = lireTirage(id);
          if (g) await rafraichirMessage(client, g);
        }
      },
    },
  ],
  tests: [
    {
      id: 'preview',
      libelle: 'Aperçu d’un giveaway',
      emoji: '🎉',
      description: 'Voir le rendu sans rien lancer',
      async executer(interaction) {
        const faux: LigneTirage = {
          id: 0,
          serveur_id: interaction.guildId,
          salon_id: interaction.channelId,
          message_id: null,
          organisateur_id: interaction.user.id,
          lot: '20€ Steam',
          nombre_gagnants: 1,
          fin_le: Date.now() + 86_400_000,
          statut: 'running',
          restant_pause: null,
          conditions: JSON.stringify({ roleId: null, niveauMin: 5 }),
          gagnants: '[]',
          cree_le: Date.now(),
        };
        const apercu = construireMessageTirage(interaction.guild, faux);
        await interaction.followUp({ embeds: apercu.embeds, flags: MessageFlags.Ephemeral });
        return '✅ Aperçu envoyé juste en dessous.';
      },
    },
  ],
};

export function peutGererTirages(membre: import('discord.js').GuildMember): boolean {
  return aAcces(membre, Niveau.STAFF, 'giveaway');
}
