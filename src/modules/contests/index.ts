import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { moduleActif } from '../../core/moduleManager';
import { botPeutGererRole } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { medaille, neutraliserMentions, tronquer } from '../../core/text';
import { lireDuree, marqueTemps } from '../../core/time';
import { bouton, construireFormulaire, estLienHttp, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { ajouterPieces } from '../../services/economy';
import { ajouterXp } from '../../services/xp';

interface LigneConcours {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  nom: string;
  description: string;
  statut: 'submissions' | 'voting' | 'ended';
  fin_participations_le: number;
  fin_votes_le: number;
  role_jury_id: string | null;
  recompense_pieces: number;
  recompense_xp: number;
  recompense_role_id: string | null;
  cree_par: string;
}

interface LigneParticipation {
  id: number;
  concours_id: number;
  utilisateur_id: string;
  contenu: string;
  message_id: string | null;
  cree_le: number;
}

const POIDS_JURY = 3;

function score(participationId: number): number {
  return lire<{ s: number }>('SELECT COALESCE(SUM(score), 0) AS s FROM votes_concours WHERE participation_id = ?', participationId)?.s ?? 0;
}

function participationsDe(concoursId: number): LigneParticipation[] {
  return lireTout<LigneParticipation>('SELECT * FROM participations_concours WHERE concours_id = ? ORDER BY cree_le', concoursId);
}

function classementConcours(concoursId: number): (LigneParticipation & { score: number })[] {
  return participationsDe(concoursId)
    .map((e) => ({ ...e, score: score(e.id) }))
    .sort((a, b) => b.score - a.score || a.cree_le - b.cree_le);
}

function exigerConcours(serveurId: string, id: number | string | undefined): LigneConcours {
  const c = lire<LigneConcours>('SELECT * FROM concours WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!c) throw new ErreurUtilisateur('Concours introuvable.');
  return c;
}

function messageConcours(serveur: Guild, c: LigneConcours) {
  const entrees = participationsDe(c.id).length;
  const recompenses = [c.recompense_pieces ? `${c.recompense_pieces} ${lireConfig(serveur.id).economie.emojiMonnaie}` : null, c.recompense_xp ? `${c.recompense_xp} XP` : null, c.recompense_role_id ? `<@&${c.recompense_role_id}>` : null].filter(Boolean);
  const phase = c.statut === 'submissions' ? `📝 Participations jusqu’à ${marqueTemps(c.fin_participations_le, 'R')}` : c.statut === 'voting' ? `🗳️ Votes jusqu’à ${marqueTemps(c.fin_votes_le, 'R')}` : '🏁 Concours terminé';
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, c.statut === 'ended' ? 'info' : 'primary'))
    .setTitle(`🏆 CONCOURS — ${tronquer(c.nom.toUpperCase(), 230)}`)
    .setDescription([c.description, '', phase, `👥 **${entrees}** participation(s)`, c.role_jury_id ? `⚖️ Jury : <@&${c.role_jury_id}> (vote ×${POIDS_JURY})` : null, recompenses.length ? `🎁 Récompenses : ${recompenses.join(' · ')}` : null].filter((l) => l !== null).join('\n'));
  if (c.statut === 'ended') {
    const meilleurs = classementConcours(c.id).slice(0, 3);
    if (meilleurs.length) embed.addFields({ name: 'Classement', value: meilleurs.map((e, i) => `${medaille(i + 1)} <@${e.utilisateur_id}> — **${e.score}** point(s)`).join('\n') });
  }
  return {
    embeds: [embed],
    components: c.statut === 'submissions' ? [rangee(bouton(`ct:join:${c.id}`, 'Participer', ButtonStyle.Success, '📝'))] : [],
  };
}

function messageParticipation(serveur: Guild, c: LigneConcours, e: LigneParticipation) {
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setAuthor({ name: `Participation #${e.id} — ${c.nom}` })
    .setDescription(`<@${e.utilisateur_id}>\n\n${tronquer(e.contenu, 3500)}`);
  const lien = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))/i.exec(e.contenu)?.[1];
  if (lien && estLienHttp(lien)) embed.setImage(lien);
  return { embeds: [embed], components: c.statut === 'voting' ? [rangee(bouton(`ct:vote:${e.id}`, `Voter (${score(e.id)})`, ButtonStyle.Primary, '🗳️'))] : [], allowedMentions: { parse: [] as [] } };
}

async function rafraichir(client: Client, c: LigneConcours): Promise<void> {
  const serveur = client.guilds.cache.get(c.serveur_id);
  const salon = serveur ? resoudreSalonTexte(serveur, c.salon_id) : null;
  if (!serveur || !salon || !c.message_id) return;
  const message = await salon.messages.fetch(c.message_id).catch(() => null);
  await message?.edit(messageConcours(serveur, c)).catch(() => undefined);
}

async function ouvrirVotes(client: Client, c: LigneConcours): Promise<void> {
  executer("UPDATE concours SET statut = 'voting' WHERE id = ?", c.id);
  const modifie = { ...c, status: 'voting' as const };
  const serveur = client.guilds.cache.get(c.serveur_id);
  const salon = serveur ? resoudreSalonTexte(serveur, c.salon_id) : null;
  if (serveur && salon) {
    await salon.send({ embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setDescription(`🗳️ Les votes du concours **${c.nom}** sont ouverts jusqu’à ${marqueTemps(c.fin_votes_le, 'f')} !`)] }).catch(() => undefined);
    for (const e of participationsDe(c.id)) {
      const envoye = await salon.send(messageParticipation(serveur, modifie, e)).catch(() => null);
      if (envoye) executer('UPDATE participations_concours SET message_id = ? WHERE id = ?', envoye.id, e.id);
    }
  }
  await rafraichir(client, modifie);
}

async function conclure(client: Client, c: LigneConcours): Promise<void> {
  executer("UPDATE concours SET statut = 'ended' WHERE id = ?", c.id);
  const modifie = { ...c, status: 'ended' as const };
  const serveur = client.guilds.cache.get(c.serveur_id);
  const salon = serveur ? resoudreSalonTexte(serveur, c.salon_id) : null;
  const meilleurs = classementConcours(c.id);
  const gagnant = meilleurs[0];
  if (serveur && gagnant && gagnant.score > 0) {
    const membre = await serveur.members.fetch(gagnant.utilisateur_id).catch(() => null);
    if (c.recompense_pieces && moduleActif(serveur.id, 'economy')) ajouterPieces(serveur.id, gagnant.utilisateur_id, c.recompense_pieces, 'contest');
    if (c.recompense_xp && moduleActif(serveur.id, 'xp')) ajouterXp(serveur.id, gagnant.utilisateur_id, c.recompense_xp);
    const role = c.recompense_role_id ? serveur.roles.cache.get(c.recompense_role_id) : null;
    if (membre && role && botPeutGererRole(serveur, role)) await membre.roles.add(role, `Gagnant du concours ${c.nom}`).catch(() => undefined);
  }
  if (serveur && salon) {
    // Désactive les boutons de vote.
    for (const e of participationsDe(c.id)) {
      if (!e.message_id) continue;
      const m = await salon.messages.fetch(e.message_id).catch(() => null);
      await m?.edit(messageParticipation(serveur, modifie, e)).catch(() => undefined);
    }
    const texte = gagnant && gagnant.score > 0 ? `🏆 Bravo <@${gagnant.utilisateur_id}>, tu remportes le concours **${c.nom}** avec **${gagnant.score}** point(s) !` : `🏁 Le concours **${c.nom}** est terminé, sans vote.`;
    await salon.send({ content: texte, allowedMentions: { users: gagnant ? [gagnant.utilisateur_id] : [] } }).catch(() => undefined);
    void journal(serveur, 'community', { titre: 'Concours terminé', ton: 'ok', lignes: [texte, `**Participations** : ${meilleurs.length}`] });
  }
  await rafraichir(client, modifie);
}

const concours: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('contest')
    .setDescription('Les concours')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un concours')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Meilleur fan art').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('participations').setDescription('Durée des participations (ex : 3j)').setRequired(true))
        .addStringOption((o) => o.setName('votes').setDescription('Durée des votes (ex : 2j)').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Règles et thème').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('jury').setDescription('Rôle du jury (vote ×3)'))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces pour le gagnant').setMinValue(0).setMaxValue(10_000_000))
        .addIntegerOption((o) => o.setName('xp').setDescription('XP pour le gagnant').setMinValue(0).setMaxValue(1_000_000))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle pour le gagnant')),
    )
    .addSubcommand((s) =>
      s
        .setName('next')
        .setDescription('Passer à la phase suivante maintenant')
        .addIntegerOption((o) => o.setName('concours').setDescription('Le concours').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les concours')),
  niveauxSousCommandes: { list: Niveau.MEMBRE },
  async autocompletion(interaction) {
    const rangees = lireTout<LigneConcours>("SELECT * FROM concours WHERE serveur_id = ? AND statut != 'ended' ORDER BY cree_le DESC LIMIT 25", interaction.guildId);
    await interaction.respond(rangees.map((c) => ({ name: tronquer(`#${c.id} · ${c.nom} (${c.statut})`, 100), value: c.id })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'list') {
      const rangees = lireTout<LigneConcours>('SELECT * FROM concours WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 15', serveur.id);
      return repondre(interaction, {
        embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setTitle('🏆 Concours').setDescription(rangees.map((c) => `**#${c.id}** ${tronquer(c.nom, 60)} — ${c.statut === 'submissions' ? '📝 participations' : c.statut === 'voting' ? '🗳️ votes' : '🏁 terminé'} · ${participationsDe(c.id).length} participation(s)`).join('\n') || '*Aucun concours.*')],
        ephemeral: true,
      });
    }
    if (sousCommande === 'next') {
      const c = exigerConcours(serveur.id, interaction.options.getInteger('concours', true));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (c.statut === 'submissions') {
        executer('UPDATE concours SET fin_participations_le = ?, fin_votes_le = MAX(fin_votes_le - (fin_participations_le - ?), ? + 3600000) WHERE id = ?', Date.now(), Date.now(), Date.now(), c.id);
        await ouvrirVotes(interaction.client, exigerConcours(serveur.id, c.id));
      } else if (c.statut === 'voting') await conclure(interaction.client, c);
      return interaction.editReply({ embeds: [ok(serveur, 'Phase suivante lancée.')] });
    }
    const soumettre = lireDuree(interaction.options.getString('participations', true));
    const vote = lireDuree(interaction.options.getString('votes', true));
    if (!soumettre || !vote || soumettre > 60 * 86_400_000 || vote > 60 * 86_400_000) throw new ErreurUtilisateur('Durées invalides (ex : `3j`, `12h`, 60 jours max).');
    const role = interaction.options.getRole('role');
    if (role && !botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle de récompense.');
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(serveur, lireConfig(serveur.id).concours.salonDefautId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const maintenant = Date.now();
    const r = executer(
      'INSERT INTO concours (serveur_id, salon_id, nom, description, fin_participations_le, fin_votes_le, role_jury_id, recompense_pieces, recompense_xp, recompense_role_id, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serveur.id,
      salon.id,
      neutraliserMentions(interaction.options.getString('nom', true)),
      neutraliserMentions(interaction.options.getString('description') ?? ''),
      maintenant + soumettre,
      maintenant + soumettre + vote,
      interaction.options.getRole('jury')?.id ?? null,
      interaction.options.getInteger('pieces') ?? 0,
      interaction.options.getInteger('xp') ?? 0,
      role?.id ?? null,
      interaction.user.id,
      maintenant,
    );
    const c = exigerConcours(serveur.id, r.lastInsertRowid);
    const message = await salon.send(messageConcours(serveur, c));
    executer('UPDATE concours SET message_id = ? WHERE id = ?', message.id, c.id);
    return repondre(interaction, { embeds: [ok(serveur, `Concours publié : ${message.url}`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'contests',
  section: 'community',
  titre: 'Concours',
  emoji: '🏆',
  moduleId: 'contests',
  ordre: 14,
  description: 'Concours en deux phases : participations (texte ou lien d’image) puis votes, avec jury optionnel et récompenses pour le gagnant.',
  champs: [{ kind: 'channel', cle: 'channel', libelle: 'Salon des concours', get: (c) => c.concours.salonDefautId, set: (c, v) => void (c.concours.salonDefautId = v) }],
};

export const moduleConcours: ModuleBot = {
  id: 'contests',
  nom: 'Concours',
  emoji: '🏆',
  description: 'Concours avec participations, votes, jury et classement',
  desactivable: true,
  actifParDefaut: false,
  commandes: [concours],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'ct',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id]) {
        if (action === 'join') {
          const c = exigerConcours(interaction.guildId, id);
          if (c.statut !== 'submissions') throw new ErreurUtilisateur('Les participations sont closes.');
          const existant = lire<LigneParticipation>('SELECT * FROM participations_concours WHERE concours_id = ? AND utilisateur_id = ?', c.id, interaction.user.id);
          return interaction.showModal(
            construireFormulaire(`ct:entry:${c.id}`, `Participer — ${c.nom}`.slice(0, 45), [
              { id: 'content', libelle: 'Ta participation (texte et/ou lien d’image)', long: true, valeur: existant?.contenu, longueurMax: 1500, longueurMin: 5 },
            ]),
          );
        }
        if (action === 'vote') {
          const entree = lire<LigneParticipation>('SELECT * FROM participations_concours WHERE id = ?', Number(id));
          if (!entree) throw new ErreurUtilisateur('Participation introuvable.');
          const c = exigerConcours(interaction.guildId, entree.concours_id);
          if (c.statut !== 'voting') throw new ErreurUtilisateur('Les votes sont clos.');
          if (entree.utilisateur_id === interaction.user.id) throw new ErreurUtilisateur('Tu ne peux pas voter pour ta propre participation.');
          const jury = !!c.role_jury_id && interaction.member.roles.cache.has(c.role_jury_id);
          // Un seul vote par personne dans le concours : voter ailleurs déplace le vote.
          const precedent = lire<{ participation_id: number }>('SELECT v.participation_id FROM votes_concours v JOIN participations_concours e ON e.id = v.participation_id WHERE e.concours_id = ? AND v.utilisateur_id = ?', c.id, interaction.user.id);
          if (precedent?.participation_id === entree.id) {
            executer('DELETE FROM votes_concours WHERE participation_id = ? AND utilisateur_id = ?', entree.id, interaction.user.id);
          } else {
            if (precedent) executer('DELETE FROM votes_concours WHERE participation_id = ? AND utilisateur_id = ?', precedent.participation_id, interaction.user.id);
            executer('INSERT INTO votes_concours (participation_id, utilisateur_id, score, jury) VALUES (?, ?, ?, ?)', entree.id, interaction.user.id, jury ? POIDS_JURY : 1, jury ? 1 : 0);
          }
          await interaction.update(messageParticipation(interaction.guild, c, entree));
          if (precedent && precedent.participation_id !== entree.id) {
            const anterieur = lire<LigneParticipation>('SELECT * FROM participations_concours WHERE id = ?', precedent.participation_id);
            const salon = resoudreSalonTexte(interaction.guild, c.salon_id);
            const m = anterieur?.message_id ? await salon?.messages.fetch(anterieur.message_id).catch(() => null) : null;
            if (anterieur && m) await m.edit(messageParticipation(interaction.guild, c, anterieur)).catch(() => undefined);
          }
          await interaction.followUp({ embeds: [ok(interaction.guild, precedent?.participation_id === entree.id ? 'Vote retiré.' : `Vote enregistré${jury ? ' (jury ×3)' : ''} pour la participation #${entree.id}.`)], flags: MessageFlags.Ephemeral });
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        if (action !== 'entry') return;
        const c = exigerConcours(interaction.guildId, id);
        if (c.statut !== 'submissions') throw new ErreurUtilisateur('Les participations sont closes.');
        const contenu = neutraliserMentions(interaction.fields.getTextInputValue('content').trim());
        executer(
          `INSERT INTO participations_concours (concours_id, utilisateur_id, contenu, cree_le) VALUES (?, ?, ?, ?)
           ON CONFLICT(concours_id, utilisateur_id) DO UPDATE SET contenu = excluded.contenu`,
          c.id,
          interaction.user.id,
          contenu,
          Date.now(),
        );
        await rafraichir(interaction.client, c);
        await interaction.reply({ embeds: [ok(interaction.guild, `Participation enregistrée pour **${c.nom}** ! Les votes ouvrent ${marqueTemps(c.fin_participations_le, 'R')}.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  taches: [
    {
      nom: 'contests',
      intervalleMs: 60_000,
      auDemarrage: true,
      async executer(client) {
        const maintenant = Date.now();
        for (const c of lireTout<LigneConcours>("SELECT * FROM concours WHERE statut = 'submissions' AND fin_participations_le <= ?", maintenant)) await ouvrirVotes(client, c);
        for (const c of lireTout<LigneConcours>("SELECT * FROM concours WHERE statut = 'voting' AND fin_votes_le <= ?", maintenant)) await conclure(client, c);
      },
    },
  ],
};
