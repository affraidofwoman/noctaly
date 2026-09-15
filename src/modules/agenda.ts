import {
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { botPeutGererRole, emojiPour, lireNiveau } from '../coeur/acces';
import {
  bouton,
  couleurPour,
  embedEnseigne,
  estLienHttp,
  lignesEnPages,
  ok,
  paginer,
  rangee,
  remplirModele,
  repondre,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout } from '../coeur/base';
import { journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot } from '../coeur/noyau';
import {
  ErreurUtilisateur,
  formaterDuree,
  lireDateHeure,
  lireDuree,
  marqueTemps,
  MOIS,
  neutraliserMentions,
  partiesFuseau,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import { donnerBadge } from './niveaux';

interface LigneAnniversaire {
  utilisateur_id: string;
  jour: number;
  mois: number;
  annee_annoncee: number | null;
  role_donne_le: number | null;
}

const JOURS_PAR_MOIS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function anniversaireValide(jour: number, mois: number): boolean {
  return Number.isInteger(jour) && Number.isInteger(mois) && mois >= 1 && mois <= 12 && jour >= 1 && jour <= JOURS_PAR_MOIS[mois - 1]!;
}

export function estAnniversaire(rangee: { jour: number; mois: number }, aujourdhui: { jour: number; mois: number; annee: number }): boolean {
  const bissextile = (aujourdhui.annee % 4 === 0 && aujourdhui.annee % 100 !== 0) || aujourdhui.annee % 400 === 0;
  if (rangee.mois === 2 && rangee.jour === 29 && !bissextile) return aujourdhui.mois === 2 && aujourdhui.jour === 28;
  return rangee.jour === aujourdhui.jour && rangee.mois === aujourdhui.mois;
}

async function traiterServeur(serveur: Guild): Promise<void> {
  const reglages = lireConfig(serveur.id).anniversaires;
  const maintenant = partiesFuseau(Date.now(), lireConfig(serveur.id).general.fuseau);
  const role = reglages.roleId ? serveur.roles.cache.get(reglages.roleId) : null;

  if (role) {
    for (const r of lireTout<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ? AND role_donne_le IS NOT NULL AND role_donne_le < ?', serveur.id, Date.now() - 86_400_000)) {
      const membre = await serveur.members.fetch(r.utilisateur_id).catch(() => null);
      if (membre && botPeutGererRole(serveur, role)) await membre.roles.remove(role, 'Fin de l’anniversaire').catch(() => undefined);
      executer('UPDATE anniversaires SET role_donne_le = NULL WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, r.utilisateur_id);
    }
  }

  if (maintenant.heure < reglages.heure) return;
  const echus = lireTout<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ? AND (annee_annoncee IS NULL OR annee_annoncee < ?)', serveur.id, maintenant.annee).filter((r) => estAnniversaire(r, maintenant));
  if (!echus.length) return;
  const salon = resoudreSalonTexte(serveur, reglages.salonId);
  for (const r of echus) {
    executer('UPDATE anniversaires SET annee_annoncee = ? WHERE serveur_id = ? AND utilisateur_id = ?', maintenant.annee, serveur.id, r.utilisateur_id);
    const membre = await serveur.members.fetch(r.utilisateur_id).catch(() => null);
    if (!membre) continue;
    donnerBadge(serveur.id, membre.id, 'birthday');
    if (role && botPeutGererRole(serveur, role)) {
      await membre.roles.add(role, 'Anniversaire').catch(() => undefined);
      executer('UPDATE anniversaires SET role_donne_le = ? WHERE serveur_id = ? AND utilisateur_id = ?', Date.now(), serveur.id, r.utilisateur_id);
    }
    if (salon) {
      const embed = new EmbedBuilder()
        .setColor(couleurPour(serveur))
        .setTitle(`${emojiPour(serveur.id, 'anniversaire')} ANNIVERSAIRE !`)
        .setDescription(tronquer(remplirModele(reglages.message, { membre, serveur }), 4096))
        .setThumbnail(membre.user.displayAvatarURL({ size: 256 }));
      await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
    }
  }
}

const commandeAnniversaire: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Les anniversaires')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Ton anniversaire')
        .addIntegerOption((o) => o.setName('jour').setDescription('Jour').setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((o) => o.setName('mois').setDescription('Mois').setRequired(true).addChoices(...MOIS.map((m, i) => ({ name: m, value: i + 1 }))))
        .addUserOption((o) => o.setName('membre').setDescription('Autre membre')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer ton anniversaire')
        .addUserOption((o) => o.setName('membre').setDescription('Autre membre')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Prochains anniversaires')),
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    const autre = interaction.options.getUser('membre');
    if (autre && autre.id !== interaction.user.id && lireNiveau(interaction.member) < Niveau.STAFF) {
      throw new ErreurUtilisateur('Seul le staff peut modifier l’anniversaire de quelqu’un d’autre.');
    }
    const utilisateurId = autre?.id ?? interaction.user.id;
    if (sousCommande === 'set') {
      const jour = interaction.options.getInteger('jour', true);
      const mois = interaction.options.getInteger('mois', true);
      if (!anniversaireValide(jour, mois)) throw new ErreurUtilisateur('Cette date n’existe pas.');
      const annee = partiesFuseau(Date.now(), lireConfig(serveur.id).general.fuseau).annee;
      const aujourdhui = partiesFuseau(Date.now(), lireConfig(serveur.id).general.fuseau);
      const ignorerCetteAnnee = estAnniversaire({ jour, mois }, aujourdhui) && aujourdhui.heure >= lireConfig(serveur.id).anniversaires.heure;
      executer(
        `INSERT INTO anniversaires (serveur_id, utilisateur_id, jour, mois, annee_annoncee) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET jour = excluded.jour, mois = excluded.mois, annee_annoncee = excluded.annee_annoncee`,
        serveur.id,
        utilisateurId,
        jour,
        mois,
        ignorerCetteAnnee ? annee : null,
      );
      return repondre(interaction, { embeds: [ok(serveur, `🎂 Anniversaire de <@${utilisateurId}> enregistré : **${jour} ${MOIS[mois - 1]}**.`)], ephemeral: true });
    }
    if (sousCommande === 'remove') {
      const r = executer('DELETE FROM anniversaires WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, utilisateurId);
      return repondre(interaction, { embeds: [ok(serveur, r.changes ? 'Anniversaire retiré.' : 'Aucun anniversaire enregistré.')], ephemeral: true });
    }
    const aujourdhui = partiesFuseau(Date.now(), lireConfig(serveur.id).general.fuseau);
    const rangees = lireTout<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ?', serveur.id);
    const score = (r: LigneAnniversaire) => {
      const v = (r.mois - aujourdhui.mois) * 31 + (r.jour - aujourdhui.jour);
      return v < 0 ? v + 12 * 31 : v;
    };
    const lignes = rangees.sort((a, b) => score(a) - score(b)).map((r) => `${score(r) === 0 ? '🎉' : '🎂'} **${r.jour} ${MOIS[r.mois - 1]}** — <@${r.utilisateur_id}>`);
    if (!lignes.length) lignes.push('*Aucun anniversaire enregistré. Ajoute le tien avec `/birthday set` !*');
    return paginer(interaction, lignesEnPages(lignes, 15, (contenu, page, total) => embedEnseigne(serveur).setTitle('🎂 Anniversaires à venir').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` })));
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'anniv',
    alias: ['birthday', 'bday'],
    domaine: 'general',
    categorie: 'community',
    description: 'Ton anniversaire (JJ/MM)',
    usage: '<JJ/MM>',
    async executer(message, parametres) {
      const m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(parametres[0] ?? '');
      if (!m) {
        const rangee = lire<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, message.author.id);
        await message.reply({ embeds: [ok(message.guild, rangee ? `Ton anniversaire : **${rangee.jour} ${MOIS[rangee.mois - 1]}**.` : 'Aucun anniversaire enregistré. Écris par exemple `=anniv 14/09`.')], allowedMentions: { repliedUser: false } });
        return;
      }
      const jour = Number(m[1]);
      const mois = Number(m[2]);
      if (!anniversaireValide(jour, mois)) throw new ErreurUtilisateur('Cette date n’existe pas.');
      executer('INSERT INTO anniversaires (serveur_id, utilisateur_id, jour, mois) VALUES (?, ?, ?, ?) ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET jour = excluded.jour, mois = excluded.mois', message.guildId, message.author.id, jour, mois);
      await message.reply({ embeds: [ok(message.guild, `🎂 Anniversaire enregistré : **${jour} ${MOIS[mois - 1]}**.`)], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'birthdays',
  section: 'community',
  titre: 'Anniversaires',
  emoji: '🎂',
  moduleId: 'birthdays',
  ordre: 3,
  description: 'Le bot souhaite les anniversaires à l’heure choisie (fuseau du serveur) et peut donner un rôle pour la journée.\n-# Variables : `{mention}` `{user}` `{server}`',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des anniversaires', lire: (c) => c.anniversaires.salonId, ecrire: (c, v) => void (c.anniversaires.salonId = v) },
    { genre: 'role', cle: 'role', libelle: 'Rôle du jour', attribuable: true, lire: (c) => c.anniversaires.roleId, ecrire: (c, v) => void (c.anniversaires.roleId = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.anniversaires.message, ecrire: (c, v) => void (c.anniversaires.message = v) },
    { genre: 'number', cle: 'hour', libelle: 'Heure d’annonce', min: 0, max: 23, unite: 'h', lire: (c) => c.anniversaires.heure, ecrire: (c, v) => void (c.anniversaires.heure = v) },
  ],
};

export const moduleAnniversaires: ModuleBot = {
  id: 'birthdays',
  nom: 'Anniversaires',
  emoji: '🎂',
  description: 'Annonces d’anniversaire, rôle du jour et badge',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeAnniversaire],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  taches: [
    {
      nom: 'birthdays',
      intervalleMs: 10 * 60_000,
      auDemarrage: true,
      async executer(client: Client<true>) {
        for (const serveur of client.guilds.cache.values()) {
          if (moduleActif(serveur.id, 'birthdays')) await traiterServeur(serveur);
        }
      },
    },
  ],
  tests: [
    {
      id: 'announce',
      libelle: 'Annonce d’anniversaire',
      emoji: '🎂',
      description: 'Voir le message avec ton nom',
      async executer(interaction) {
        const reglages = lireConfig(interaction.guildId).anniversaires;
        const salon = resoudreSalonTexte(interaction.guild, reglages.salonId);
        if (!salon) return '⚠️ Aucun salon d’anniversaires utilisable.';
        await salon.send({
          embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🎂 ANNIVERSAIRE ! (test)').setDescription(remplirModele(reglages.message, { membre: interaction.member, serveur: interaction.guild }))],
          allowedMentions: { parse: [] },
        });
        return `✅ Annonce de test postée dans <#${salon.id}>.`;
      },
    },
  ],
};

interface LigneRappel {
  id: number;
  serveur_id: string | null;
  salon_id: string | null;
  utilisateur_id: string;
  contenu: string;
  rappel_le: number;
  cree_le: number;
}

const DELAI_MAX = 365 * 86_400_000;

function creer(serveurId: string, salonId: string, utilisateurId: string, delai: number, contenu: string): LigneRappel {
  if (delai < 10_000 || delai > DELAI_MAX) throw new ErreurUtilisateur('Durée entre 10 secondes et 1 an (ex : `2h30`, `1j`, `45m`).');
  const max = lireConfig(serveurId).rappels.maxParMembre;
  const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM rappels WHERE utilisateur_id = ? AND envoye = 0', utilisateurId)?.n ?? 0;
  if (nombre >= max) throw new ErreurUtilisateur(`Tu as déjà ${nombre} rappels en attente (maximum ${max}).`);
  const r = executer(
    'INSERT INTO rappels (serveur_id, salon_id, utilisateur_id, contenu, rappel_le, cree_le) VALUES (?, ?, ?, ?, ?, ?)',
    serveurId,
    salonId,
    utilisateurId,
    tronquer(neutraliserMentions(contenu.trim() || 'Rappel'), 1000),
    Date.now() + delai,
    Date.now(),
  );
  return lire<LigneRappel>('SELECT * FROM rappels WHERE id = ?', r.lastInsertRowid)!;
}

export function decouperRappel(saisie: string): { delay: number; text: string } | null {
  const mots = saisie.trim().split(/\s+/);
  for (let n = Math.min(3, mots.length); n >= 1; n--) {
    const delai = lireDuree(mots.slice(0, n).join(' '));
    if (delai && !/^\d+$/.test(mots[0]!)) return { delay: delai, text: mots.slice(n).join(' ') };
  }
  return null;
}

async function livrer(client: Client, r: LigneRappel): Promise<void> {
  executer('UPDATE rappels SET envoye = 1 WHERE id = ?', r.id);
  const serveur = r.serveur_id ? client.guilds.cache.get(r.serveur_id) : null;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur ?? null))
    .setTitle(`${emojiPour(r.serveur_id, 'rappel')} RAPPEL`)
    .setDescription(`Tu avais demandé un rappel :\n\n**${r.contenu}**`)
    .setFooter({ text: `Programmé ${serveur ? `sur ${serveur.name} ` : ''}` })
    .setTimestamp(r.cree_le);
  const utilisateur = await client.users.fetch(r.utilisateur_id).catch(() => null);
  const mp = await utilisateur?.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (mp) return;
  const salon = serveur && r.salon_id ? serveur.channels.cache.get(r.salon_id) : null;
  if (salon?.isTextBased()) await salon.send({ content: `<@${r.utilisateur_id}>`, embeds: [embed], allowedMentions: { users: [r.utilisateur_id] } }).catch(() => undefined);
}

const rappel: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Les rappels')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Programmer un rappel')
        .addStringOption((o) => o.setName('duree').setDescription('Dans combien de temps').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('De quoi te rappeler').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Tes rappels en attente'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un rappel')
        .addIntegerOption((o) => o.setName('rappel').setDescription('Le rappel').setRequired(true).setAutocomplete(true)),
    ),
  async autocompletion(interaction) {
    const rangees = lireTout<LigneRappel>('SELECT * FROM rappels WHERE utilisateur_id = ? AND envoye = 0 ORDER BY rappel_le LIMIT 25', interaction.user.id);
    await interaction.respond(rangees.map((r) => ({ name: tronquer(`#${r.id} · ${r.contenu}`, 100), value: r.id })));
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    if (sousCommande === 'set') {
      const delai = lireDuree(interaction.options.getString('duree', true));
      if (!delai) throw new ErreurUtilisateur('Durée incomprise : exemples `2h30`, `45m`, `1j 2h`.');
      const r = creer(serveur.id, interaction.channelId, interaction.user.id, delai, interaction.options.getString('texte', true));
      return repondre(interaction, { embeds: [ok(serveur, `⏰ Rappel **#${r.id}** programmé ${marqueTemps(r.rappel_le, 'R')} (${formaterDuree(delai)}).\n> ${r.contenu}`)], ephemeral: true });
    }
    if (sousCommande === 'cancel') {
      const reponse = executer('DELETE FROM rappels WHERE id = ? AND utilisateur_id = ? AND envoye = 0', interaction.options.getInteger('rappel', true), interaction.user.id);
      return repondre(interaction, { embeds: [ok(serveur, reponse.changes ? 'Rappel annulé.' : 'Rappel introuvable.')], ephemeral: true });
    }
    const rangees = lireTout<LigneRappel>('SELECT * FROM rappels WHERE utilisateur_id = ? AND envoye = 0 ORDER BY rappel_le', interaction.user.id);
    const lignes = rangees.map((r) => `**#${r.id}** ${marqueTemps(r.rappel_le, 'R')} — ${tronquer(r.contenu, 100)}`);
    if (!lignes.length) lignes.push('*Aucun rappel en attente.*');
    return paginer(interaction, lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('⏰ Tes rappels').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` })), true);
  },
};

const commandesPrefixeRappels: CommandePrefixe[] = [
  {
    nom: 'remind',
    alias: ['rappel', 'rm'],
    domaine: 'general',
    categorie: 'community',
    description: 'Programmer un rappel',
    usage: '<durée> <texte>',
    async executer(message, parametres) {
      const lu = decouperRappel(parametres.join(' '));
      if (!lu) throw new ErreurUtilisateur('Usage : `=remind 2h30 live Twitch`.');
      const r = creer(message.guildId, message.channelId, message.author.id, lu.delay, lu.text);
      await message.reply({ embeds: [ok(message.guild, `⏰ Rappel **#${r.id}** ${marqueTemps(r.rappel_le, 'R')}.`)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleRappels: ModuleBot = {
  id: 'reminders',
  nom: 'Rappels',
  emoji: '⏰',
  description: 'Rappels persistants en MP (ou dans le salon)',
  desactivable: true,
  actifParDefaut: true,
  commandes: [rappel],
  commandesPrefixe: commandesPrefixeRappels,
  taches: [
    {
      nom: 'reminders',
      intervalleMs: 10_000,
      auDemarrage: true,
      async executer(client) {
        for (const r of lireTout<LigneRappel>('SELECT * FROM rappels WHERE envoye = 0 AND rappel_le <= ? ORDER BY rappel_le LIMIT 50', Date.now())) {
          await livrer(client, r);
        }
        executer('DELETE FROM rappels WHERE envoye = 1 AND rappel_le < ?', Date.now() - 7 * 86_400_000);
      },
    },
  ],
};

function listeMentionsCourte(ids: string[], max: number): string {
  const affiches = ids.slice(0, max).map((id) => `<@${id}>`).join(' ');
  return ids.length > max ? `${affiches} +${ids.length - max}` : affiches;
}

interface LigneEvenement {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  createur_id: string;
  nom: string;
  description: string;
  jeu: string | null;
  image: string | null;
  debut_le: number;
  statut: 'scheduled' | 'started' | 'cancelled' | 'ended';
  rappele: number;
  cree_le: number;
}

type ReponseRsvp = 'yes' | 'maybe' | 'no';
const RSVP: Record<ReponseRsvp, { label: string; emoji: string }> = {
  yes: { label: 'Présent', emoji: '✅' },
  maybe: { label: 'Peut-être', emoji: '❓' },
  no: { label: 'Absent', emoji: '❌' },
};

function reponsesRsvp(evenementId: number): Record<ReponseRsvp, string[]> {
  const sortie: Record<ReponseRsvp, string[]> = { yes: [], maybe: [], no: [] };
  for (const r of lireTout<{ utilisateur_id: string; statut: ReponseRsvp }>('SELECT utilisateur_id, statut FROM reponses_evenements WHERE evenement_id = ? ORDER BY modifie_le', evenementId)) {
    sortie[r.statut]?.push(r.utilisateur_id);
  }
  return sortie;
}

function afficher(serveur: Guild, e: LigneEvenement) {
  const liste = reponsesRsvp(e.id);
  const ferme = e.statut === 'cancelled' || e.statut === 'ended';
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, e.statut === 'cancelled' ? 'error' : 'primary'))
    .setTitle(`🎮 ${tronquer(e.nom.toUpperCase(), 240)}`)
    .setDescription(
      [
        e.jeu ? `**${e.jeu}**` : null,
        e.description || null,
        '',
        `📅 ${marqueTemps(e.debut_le, 'F')}`,
        `🕘 ${marqueTemps(e.debut_le, 'R')}`,
        e.statut === 'cancelled' ? '\n**❌ Événement annulé**' : e.statut === 'started' ? '\n**🔴 C’est parti !**' : null,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .addFields(
      (Object.keys(RSVP) as ReponseRsvp[]).map((k) => ({
        name: `${RSVP[k].emoji} ${RSVP[k].label} (${liste[k].length})`,
        value: liste[k].length ? listeMentionsCourte(liste[k], 15) : '—',
        inline: true,
      })),
    )
    .setFooter({ text: `Événement #${e.id} · organisé par ${serveur.members.cache.get(e.createur_id)?.displayName ?? 'le staff'}` });
  if (e.image) embed.setImage(e.image);
  return {
    embeds: [embed],
    components: ferme
      ? []
      : [
          rangee(
            bouton(`ev:rsvp:${e.id}:yes`, 'Je participe', ButtonStyle.Success, '✅'),
            bouton(`ev:rsvp:${e.id}:maybe`, 'Peut-être', ButtonStyle.Secondary, '❓'),
            bouton(`ev:rsvp:${e.id}:no`, 'Absent', ButtonStyle.Secondary, '❌'),
          ),
        ],
  };
}

function exigerEvenement(serveurId: string, id: number | string | undefined): LigneEvenement {
  const e = lire<LigneEvenement>('SELECT * FROM evenements WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!e) throw new ErreurUtilisateur('Événement introuvable.');
  return e;
}

async function rafraichir(client: Client, e: LigneEvenement): Promise<void> {
  const serveur = client.guilds.cache.get(e.serveur_id);
  const salon = serveur ? resoudreSalonTexte(serveur, e.salon_id) : null;
  if (!serveur || !salon || !e.message_id) return;
  const message = await salon.messages.fetch(e.message_id).catch(() => null);
  await message?.edit(afficher(serveur, e)).catch(() => undefined);
}

const commandeEvenement: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Les événements')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un événement')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Soirée communautaire').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('date').setDescription('JJ/MM ou JJ/MM/AAAA').setRequired(true))
        .addStringOption((o) => o.setName('heure').setDescription('Heure (21h30)').setRequired(true))
        .addStringOption((o) => o.setName('jeu').setDescription('Ex : Minecraft').setMaxLength(100))
        .addStringOption((o) => o.setName('description').setDescription('Détails').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où l’annoncer').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('image').setDescription('Lien d’une image').setMaxLength(500)),
    )
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un événement')
        .addIntegerOption((o) => o.setName('evenement').setDescription('L’événement').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les événements à venir')),
  niveauxSousCommandes: { list: Niveau.MEMBRE },
  async autocompletion(interaction) {
    const rangees = lireTout<LigneEvenement>("SELECT * FROM evenements WHERE serveur_id = ? AND statut IN ('scheduled','started') ORDER BY debut_le LIMIT 25", interaction.guildId);
    await interaction.respond(rangees.map((e) => ({ name: tronquer(`#${e.id} · ${e.nom}`, 100), value: e.id })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'list') {
      const rangees = lireTout<LigneEvenement>("SELECT * FROM evenements WHERE serveur_id = ? AND statut IN ('scheduled','started') ORDER BY debut_le LIMIT 20", serveur.id);
      const lignes = rangees.map((e) => `🎮 **${tronquer(e.nom, 80)}** — ${marqueTemps(e.debut_le, 'f')} (${marqueTemps(e.debut_le, 'R')}) · ✅ ${reponsesRsvp(e.id).yes.length}${e.message_id ? ` · [voir](https://discord.com/channels/${e.serveur_id}/${e.salon_id}/${e.message_id})` : ''}`);
      return repondre(interaction, { embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setTitle('📅 Événements à venir').setDescription(lignes.join('\n') || '*Aucun événement prévu.*')], ephemeral: true });
    }
    if (sousCommande === 'cancel') {
      const e = exigerEvenement(serveur.id, interaction.options.getInteger('evenement', true));
      executer("UPDATE evenements SET statut = 'cancelled' WHERE id = ?", e.id);
      await rafraichir(interaction.client, { ...e, statut: 'cancelled' });
      return repondre(interaction, { embeds: [ok(serveur, `Événement **${e.nom}** annulé.`)], ephemeral: true });
    }
    const fuseau = lireConfig(serveur.id).general.fuseau;
    const debutLe = lireDateHeure(interaction.options.getString('date', true), interaction.options.getString('heure', true), fuseau);
    if (!debutLe) throw new ErreurUtilisateur('Date ou heure invalide : exemples `25/12` et `21h`.');
    if (debutLe < Date.now()) throw new ErreurUtilisateur('Cette date est déjà passée.');
    const image = interaction.options.getString('image');
    if (image && !estLienHttp(image)) throw new ErreurUtilisateur('Lien d’image invalide.');
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(serveur, lireConfig(serveur.id).evenements.salonDefautId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const r = executer(
      'INSERT INTO evenements (serveur_id, salon_id, createur_id, nom, description, jeu, image, debut_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serveur.id,
      salon.id,
      interaction.user.id,
      neutraliserMentions(interaction.options.getString('nom', true)),
      neutraliserMentions(interaction.options.getString('description') ?? ''),
      interaction.options.getString('jeu'),
      image,
      debutLe,
      Date.now(),
    );
    const e = exigerEvenement(serveur.id, r.lastInsertRowid);
    const ping = lireConfig(serveur.id).evenements.roleMentionId;
    const message = await salon.send({ content: ping ? `<@&${ping}>` : undefined, ...afficher(serveur, e), allowedMentions: { roles: ping ? [ping] : [] } });
    executer('UPDATE evenements SET message_id = ? WHERE id = ?', message.id, e.id);
    void journal(serveur, 'community', { titre: 'Événement créé', ton: 'info', lignes: [`**${e.nom}** — ${marqueTemps(debutLe, 'F')}`, `[voir](${message.url})`], par: interaction.user });
    return repondre(interaction, { embeds: [ok(serveur, `Événement publié : ${message.url}`)], ephemeral: true });
  },
};

const pageReglageEvenements: PageReglage = {
  id: 'events',
  section: 'community',
  titre: 'Événements',
  emoji: '📅',
  moduleId: 'events',
  ordre: 4,
  description: 'Les événements communautaires avec inscription ✅ / ❓ / ❌ et rappel aux participants avant le début.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des événements', lire: (c) => c.evenements.salonDefautId, ecrire: (c, v) => void (c.evenements.salonDefautId = v) },
    { genre: 'role', cle: 'ping', libelle: 'Rôle mentionné', lire: (c) => c.evenements.roleMentionId, ecrire: (c, v) => void (c.evenements.roleMentionId = v) },
    { genre: 'number', cle: 'reminder', libelle: 'Rappel avant le début', min: 0, max: 1440, unite: 'min', lire: (c) => c.evenements.rappelMinutes, ecrire: (c, v) => void (c.evenements.rappelMinutes = v) },
  ],
};

export const moduleEvenements: ModuleBot = {
  id: 'events',
  nom: 'Événements',
  emoji: '📅',
  description: 'Événements communautaires avec RSVP et rappels',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeEvenement],
  pagesReglage: [pageReglageEvenements],
  composants: [
    {
      prefixe: 'ev',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, statut]) {
        if (action !== 'rsvp') return;
        const e = exigerEvenement(interaction.guildId, id);
        if (e.statut === 'cancelled' || e.statut === 'ended') throw new ErreurUtilisateur('Cet événement est terminé.');
        if (!(statut! in RSVP)) return;
        executer('INSERT OR REPLACE INTO reponses_evenements (evenement_id, utilisateur_id, statut, modifie_le) VALUES (?, ?, ?, ?)', e.id, interaction.user.id, statut, Date.now());
        await interaction.update(afficher(interaction.guild, e));
        await interaction.followUp({ embeds: [ok(interaction.guild, `${RSVP[statut as ReponseRsvp].emoji} Réponse enregistrée : **${RSVP[statut as ReponseRsvp].label}** pour **${e.nom}**.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  taches: [
    {
      nom: 'events',
      intervalleMs: 30_000,
      auDemarrage: true,
      async executer(client) {
        const maintenant = Date.now();
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'scheduled' AND rappele = 0 LIMIT 50")) {
          const minutes = lireConfig(e.serveur_id).evenements.rappelMinutes;
          if (!minutes || e.debut_le - minutes * 60_000 > maintenant) continue;
          executer('UPDATE evenements SET rappele = 1 WHERE id = ?', e.id);
          for (const utilisateurId of [...reponsesRsvp(e.id).yes, ...reponsesRsvp(e.id).maybe].slice(0, 100)) {
            const utilisateur = await client.users.fetch(utilisateurId).catch(() => null);
            await utilisateur?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(e.serveur_id)).setTitle('📅 Ça commence bientôt !').setDescription(`**${e.nom}** commence ${marqueTemps(e.debut_le, 'R')}.`)] }).catch(() => undefined);
          }
        }
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'scheduled' AND debut_le <= ? LIMIT 20", maintenant)) {
          executer("UPDATE evenements SET statut = 'started' WHERE id = ?", e.id);
          await rafraichir(client, { ...e, statut: 'started' });
        }
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'started' AND debut_le <= ? LIMIT 20", maintenant - 6 * 3_600_000)) {
          executer("UPDATE evenements SET statut = 'ended' WHERE id = ?", e.id);
          await rafraichir(client, { ...e, statut: 'ended' });
        }
      },
    },
  ],
};
