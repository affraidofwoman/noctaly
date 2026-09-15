import { EmbedBuilder, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { resoudreSalonTexte } from '../../core/logService';
import { moduleActif } from '../../core/moduleManager';
import { lignesEnPages, paginer } from '../../core/pagination';
import { botPeutGererRole, lireNiveau } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { MOIS, partiesFuseau } from '../../core/time';
import { remplirModele } from '../../core/variables';
import { Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { donnerBadge } from '../../services/badges';

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

/** Le 29 février est fêté le 28 les années non bissextiles. */
export function estAnniversaire(rangee: { jour: number; mois: number }, aujourdhui: { jour: number; mois: number; annee: number }): boolean {
  const bissextile = (aujourdhui.annee % 4 === 0 && aujourdhui.annee % 100 !== 0) || aujourdhui.annee % 400 === 0;
  if (rangee.mois === 2 && rangee.jour === 29 && !bissextile) return aujourdhui.mois === 2 && aujourdhui.jour === 28;
  return rangee.jour === aujourdhui.jour && rangee.mois === aujourdhui.mois;
}

async function traiterServeur(serveur: Guild): Promise<void> {
  const reglages = lireConfig(serveur.id).anniversaires;
  const maintenant = partiesFuseau(Date.now(), lireConfig(serveur.id).general.fuseau);
  const role = reglages.roleId ? serveur.roles.cache.get(reglages.roleId) : null;

  // Retire le rôle d'anniversaire après 24 h.
  if (role) {
    for (const r of lireTout<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ? AND role_donne_le IS NOT NULL AND role_donne_le < ?', serveur.id, Date.now() - 86_400_000)) {
      const membre = await serveur.members.fetch(r.utilisateur_id).catch(() => null);
      if (membre && botPeutGererRole(serveur, role)) await membre.roles.remove(role, 'Fin de l’anniversaire').catch(() => undefined);
      executer('UPDATE anniversaires SET role_donne_le = NULL WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, r.utilisateur_id);
    }
  }

  if (maintenant.heure < reglages.hour) return;
  const echus = lireTout<LigneAnniversaire>('SELECT * FROM anniversaires WHERE serveur_id = ? AND (annee_annoncee IS NULL OR annee_annoncee < ?)', serveur.id, maintenant.annee).filter((r) => estAnniversaire(r, maintenant));
  if (!echus.length) return;
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
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
        .setDescription('Enregistrer ton anniversaire')
        .addIntegerOption((o) => o.setName('jour').setDescription('Jour').setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((o) => o.setName('mois').setDescription('Mois').setRequired(true).addChoices(...MOIS.map((m, i) => ({ name: m, value: i + 1 }))))
        .addUserOption((o) => o.setName('membre').setDescription('Pour quelqu’un d’autre (staff)')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer ton anniversaire')
        .addUserOption((o) => o.setName('membre').setDescription('Pour quelqu’un d’autre (staff)')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les prochains anniversaires')),
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
      // Enregistré aujourd'hui même : on ne le souhaite pas une seconde fois s'il est déjà passé l'heure.
      const ignorerCetteAnnee = estAnniversaire({ jour, mois }, aujourdhui) && aujourdhui.heure >= lireConfig(serveur.id).anniversaires.hour;
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
    { genre: 'channel', cle: 'channel', libelle: 'Salon des anniversaires', lire: (c) => c.anniversaires.channelId, ecrire: (c, v) => void (c.anniversaires.channelId = v) },
    { genre: 'role', cle: 'role', libelle: 'Rôle du jour', attribuable: true, lire: (c) => c.anniversaires.roleId, ecrire: (c, v) => void (c.anniversaires.roleId = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.anniversaires.message, ecrire: (c, v) => void (c.anniversaires.message = v) },
    { genre: 'number', cle: 'hour', libelle: 'Heure d’annonce', min: 0, max: 23, unite: 'h', lire: (c) => c.anniversaires.hour, ecrire: (c, v) => void (c.anniversaires.hour = v) },
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
        const salon = resoudreSalonTexte(interaction.guild, reglages.channelId);
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
