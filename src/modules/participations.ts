import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  MessageFlags,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { aNiveau, botPeutGererRole } from '../coeur/acces';
import { bouton, type ChampFenetre, construireFormulaire, couleurPour, estLienHttp, ok, rangee, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireJson, lireTout } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandeSlash, type ModuleBot, type PanneauAffiche, prefixePanneau } from '../coeur/noyau';
import {
  ErreurUtilisateur,
  identifiantDepuisTexte,
  lireDuree,
  marqueTemps,
  medaille,
  neutraliserMentions,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import { ajouterPieces } from './economie';
import { ajouterXp } from './niveaux';

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
    .setColor(couleurPour(serveur, c.statut === 'ended' ? 'info' : 'principale'))
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
    if (c.recompense_pieces && moduleActif(serveur.id, 'progression')) ajouterPieces(serveur.id, gagnant.utilisateur_id, c.recompense_pieces, 'contest');
    if (c.recompense_xp && moduleActif(serveur.id, 'progression')) ajouterXp(serveur.id, gagnant.utilisateur_id, c.recompense_xp);
    const role = c.recompense_role_id ? serveur.roles.cache.get(c.recompense_role_id) : null;
    if (membre && role && botPeutGererRole(serveur, role)) await membre.roles.add(role, `Gagnant du concours ${c.nom}`).catch(() => undefined);
  }
  if (serveur && salon) {
    // - Désactive les boutons de vote -
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
        .addStringOption((o) => o.setName('nom').setDescription('Nom du concours').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('participations').setDescription('Durée des dépôts').setRequired(true))
        .addStringOption((o) => o.setName('votes').setDescription('Durée des votes').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Règles et thème').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('jury').setDescription('Rôle du jury'))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces pour le gagnant').setMinValue(0).setMaxValue(10_000_000))
        .addIntegerOption((o) => o.setName('xp').setDescription('XP pour le gagnant').setMinValue(0).setMaxValue(1_000_000))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle pour le gagnant')),
    )
    .addSubcommand((s) =>
      s
        .setName('next')
        .setDescription('Phase suivante')
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
  champs: [{ genre: 'channel', cle: 'channel', libelle: 'Salon des concours', lire: (c) => c.concours.salonDefautId, ecrire: (c, v) => void (c.concours.salonDefautId = v) }],
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

interface Question {
  libelle: string;
  long: boolean;
  obligatoire: boolean;
}

interface DefinitionFormulaire {
  nom: string;
  titre: string;
  description: string;
  questions: Question[];
  salonId: string | null;
  integre?: boolean;
}

interface LigneFormulaire {
  id: number;
  nom: string;
  titre: string;
  description: string;
  questions: string;
  salon_id: string | null;
}

function integre(serveur: Guild, nom: string): DefinitionFormulaire | null {
  const reglages = lireConfig(serveur.id);
  if (nom === 'partenariat') {
    return {
      nom,
      titre: '🤝 Candidature partenariat',
      description: 'Propose un partenariat avec la communauté.',
      salonId: reglages.formulaires.salonPartenariatsId ?? reglages.general.salonStaffId,
      integre: true,
      questions: [
        { libelle: 'Ton nom / pseudo', long: false, obligatoire: true },
        { libelle: 'Nom du serveur ou de la chaîne', long: false, obligatoire: true },
        { libelle: 'Description', long: true, obligatoire: true },
        { libelle: 'Lien (invitation, chaîne…)', long: false, obligatoire: true },
        { libelle: 'Pourquoi un partenariat ?', long: true, obligatoire: true },
      ],
    };
  }
  if (nom === 'staff') {
    return {
      nom,
      titre: '📋 Candidature staff',
      description: 'Rejoindre l’équipe de modération.',
      salonId: reglages.formulaires.salonCandidaturesId ?? reglages.general.salonStaffId,
      integre: true,
      questions: [
        { libelle: 'Âge', long: false, obligatoire: true },
        { libelle: 'Disponibilités', long: true, obligatoire: true },
        { libelle: 'Expérience de modération', long: true, obligatoire: true },
        { libelle: 'Motivation', long: true, obligatoire: true },
      ],
    };
  }
  return null;
}

function lireFormulaire(serveur: Guild, nom: string): DefinitionFormulaire | null {
  const b = integre(serveur, nom);
  if (b) return b;
  const r = lire<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? AND nom = ?', serveur.id, nom);
  return r ? { nom: r.nom, titre: r.titre, description: r.description, questions: lireJson<Question[]>(r.questions, []), salonId: r.salon_id } : null;
}

function fenetreFormulaire(formulaire: DefinitionFormulaire) {
  const champs: ChampFenetre[] = formulaire.questions.slice(0, 5).map((q, i) => ({ id: `q${i}`, libelle: q.libelle, long: q.long, obligatoire: q.obligatoire, longueurMax: q.long ? 1500 : 200 }));
  return construireFormulaire(`form:submit:${formulaire.nom}`, formulaire.titre, champs);
}

export function lireQuestions(saisie: string): Question[] {
  return saisie
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => {
      const facultatif = l.startsWith('?');
      const long = l.endsWith('*');
      return { libelle: l.replace(/^\?/, '').replace(/\*$/, '').trim().slice(0, 45), long, obligatoire: !facultatif };
    })
    .filter((q) => q.libelle.length > 0);
}

async function soumettre(interaction: ModalSubmitInteraction<'cached'>, formulaire: DefinitionFormulaire) {
  const serveur = interaction.guild;
  const salon = resoudreSalonTexte(serveur, formulaire.salonId ?? lireConfig(serveur.id).general.salonStaffId);
  if (!salon) throw new ErreurUtilisateur('Ce formulaire n’a pas de salon de réception. Préviens le staff.');
  const reponses = formulaire.questions.slice(0, 5).map((q, i) => ({ q: q.libelle, a: neutraliserMentions(interaction.fields.getTextInputValue(`q${i}`).trim()) }));
  const r = executer('INSERT INTO reponses_formulaires (serveur_id, formulaire, utilisateur_id, reponses, cree_le) VALUES (?, ?, ?, ?, ?)', serveur.id, formulaire.nom, interaction.user.id, JSON.stringify(reponses), Date.now());
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, 'info'))
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${formulaire.titre} — #${r.lastInsertRowid}`)
    .setDescription(`<@${interaction.user.id}> \`${interaction.user.id}\``)
    .addFields(reponses.map((x) => ({ name: tronquer(x.q, 256), value: tronquer(x.a || '—', 1024), inline: false })))
    .setTimestamp();
  await salon.send({
    embeds: [embed],
    components: [rangee(bouton(`form:ok:${r.lastInsertRowid}`, 'Accepter', ButtonStyle.Success, '✅'), bouton(`form:no:${r.lastInsertRowid}`, 'Refuser', ButtonStyle.Danger, '❌'))],
    allowedMentions: { parse: [] },
  });
  historiser(serveur.id, 'community', `form-${formulaire.nom}`, interaction.user.id, interaction.user.id, { id: r.lastInsertRowid });
  void journal(serveur, 'community', { titre: 'Formulaire reçu', ton: 'info', lignes: [`**${formulaire.titre}** de <@${interaction.user.id}>`] });
  await interaction.reply({ embeds: [ok(serveur, 'Merci ! Ta réponse a bien été envoyée au staff. Tu recevras un message privé quand elle sera traitée.')], flags: MessageFlags.Ephemeral });
}

// - /formulaire : créer, lister, supprimer -
function panneauFormulaires(serveur: Guild, note?: string) {
  const rangees = lireTout<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? ORDER BY nom', serveur.id);
  const lignes = ['🤝 **Partenariat** — intégré', '📋 **Candidature staff** — intégré', ...rangees.map((r) => `📝 **${r.titre}** — ${lireJson<Question[]>(r.questions, []).length} question(s) → <#${r.salon_id}>`)];
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle('📝 Formulaires')
    .setDescription([note, lignes.join('\n'), '', '-# Les membres y accèdent par `/contact`, ou par un bouton posé avec `/affiche`.'].filter((l) => l !== undefined).join('\n'));
  return {
    embeds: [embed],
    components: [rangee(bouton('form:nouveau', 'Créer un formulaire', ButtonStyle.Success, '➕'), bouton('form:suppression', 'Supprimer', ButtonStyle.Secondary, '🗑️').setDisabled(!rangees.length))],
  };
}

const commandeFormulaire: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('formulaire').setDescription('Les formulaires'),
  async executer(interaction) {
    await repondre(interaction, { ...panneauFormulaires(interaction.guild), ephemeral: true });
  },
};
const panneauFormulaire: PanneauAffiche = {
  id: 'formulaire',
  alias: ['form', 'candidature'],
  nom: 'Formulaire',
  emoji: '📝',
  groupe: 'Accueil',
  quoi: 'Partenariat, candidature staff ou formulaire créé',
  choix(serveur) {
    const rangees = lireTout<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? ORDER BY nom', serveur.id);
    return [{ label: 'Partenariat', value: 'partenariat' }, { label: 'Candidature staff', value: 'staff' }, ...rangees.map((r) => ({ label: tronquer(r.titre, 100), value: r.nom }))].slice(0, 25);
  },
  async poser(salon, membre, valeur) {
    const formulaire = lireFormulaire(membre.guild, valeur ?? '');
    if (!formulaire) throw new ErreurUtilisateur('Formulaire introuvable.');
    const envoye = await salon.send({
      embeds: [new EmbedBuilder().setColor(couleurPour(membre.guild)).setTitle(`📝 ${formulaire.titre}`).setDescription(formulaire.description || 'Un clic sur le bouton, quelques questions, et c’est envoyé.')],
      components: [rangee(bouton(`form:open:${formulaire.nom}`, 'Remplir le formulaire', ButtonStyle.Primary, '📝'))],
    });
    return `Bouton posté : ${envoye.url}`;
  },
};

const pageReglageFormulaires: PageReglage = {
  id: 'forms',
  section: 'community',
  titre: 'Formulaires',
  emoji: '📝',
  moduleId: 'forms',
  ordre: 15,
  description: 'Où arrivent les candidatures intégrées (via `/contact`). Les formulaires personnalisés se créent avec `/formulaire`.',
  champs: [
    { genre: 'channel', cle: 'partner', libelle: 'Salon des partenariats', lire: (c) => c.formulaires.salonPartenariatsId, ecrire: (c, v) => void (c.formulaires.salonPartenariatsId = v) },
    { genre: 'channel', cle: 'staff', libelle: 'Salon des candidatures staff', lire: (c) => c.formulaires.salonCandidaturesId, ecrire: (c, v) => void (c.formulaires.salonCandidaturesId = v) },
  ],
};

export const moduleFormulaires: ModuleBot = {
  id: 'forms',
  nom: 'Formulaires',
  emoji: '📝',
  description: 'Partenariats, candidatures staff et formulaires personnalisés',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeFormulaire],
  panneaux: [panneauFormulaire],
  commandesPrefixe: [prefixePanneau(panneauFormulaire, 'Poser un formulaire')],
  pagesReglage: [pageReglageFormulaires],
  composants: [
    {
      prefixe: 'form',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, argument]) {
        if (action === 'open') {
          const formulaire = lireFormulaire(interaction.guild, argument ?? '');
          if (!formulaire) throw new ErreurUtilisateur('Ce formulaire n’existe plus.');
          return interaction.showModal(fenetreFormulaire(formulaire));
        }
        if (action === 'nouveau' || action === 'suppression') {
          if (!aNiveau(interaction.member, Niveau.ADMIN)) throw new ErreurUtilisateur('Réservé aux admins.');
          const rangees = lireTout<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? ORDER BY nom', interaction.guildId);
          const menu =
            action === 'nouveau'
              ? new ChannelSelectMenuBuilder().setCustomId('form:salon').setPlaceholder('Où arrivent les réponses ?').addChannelTypes(ChannelType.GuildText)
              : new StringSelectMenuBuilder().setCustomId('form:suppr').setPlaceholder('Lequel supprimer ?').addOptions(rangees.slice(0, 25).map((r) => ({ label: tronquer(r.titre, 100), value: r.nom })));
          return interaction.update({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('📝 Formulaires').setDescription(action === 'nouveau' ? 'Choisis le salon où arriveront les réponses.' : 'Quel formulaire supprimer ?')], components: [rangee(menu)] });
        }
        if (!aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Réservé au staff.');
        const sousCommande = lire<{ id: number; utilisateur_id: string; formulaire: string; statut: string }>('SELECT id, utilisateur_id, formulaire, statut FROM reponses_formulaires WHERE id = ? AND serveur_id = ?', Number(argument), interaction.guildId);
        if (!sousCommande) throw new ErreurUtilisateur('Réponse introuvable.');
        if (sousCommande.statut !== 'pending') throw new ErreurUtilisateur('Cette réponse a déjà été traitée.');
        const accepte = action === 'ok';
        executer('UPDATE reponses_formulaires SET statut = ?, traite_par = ? WHERE id = ?', accepte ? 'accepted' : 'denied', interaction.user.id, sousCommande.id);
        const formulaire = lireFormulaire(interaction.guild, sousCommande.formulaire);
        const utilisateur = await interaction.client.users.fetch(sousCommande.utilisateur_id).catch(() => null);
        await utilisateur
          ?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild, accepte ? 'succes' : 'erreur')).setDescription(`${accepte ? '✅' : '❌'} Ta réponse au formulaire **${formulaire?.titre ?? sousCommande.formulaire}** sur **${interaction.guild.name}** a été **${accepte ? 'acceptée' : 'refusée'}**.${accepte ? '\nLe staff va te recontacter.' : ''}`)] })
          .catch(() => undefined);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setColor(couleurPour(interaction.guild, accepte ? 'succes' : 'erreur')).setFooter({ text: `${accepte ? 'Acceptée' : 'Refusée'} par ${interaction.user.tag}` });
        await interaction.update({ embeds: [embed], components: [] });
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action]) {
        if (!aNiveau(interaction.member, Niveau.ADMIN)) throw new ErreurUtilisateur('Réservé aux admins.');
        const valeur = interaction.values[0] ?? '';
        if (action === 'salon') {
          return interaction.showModal(
            construireFormulaire(`form:create:${valeur}`, 'Nouveau formulaire', [
              { id: 'title', libelle: 'Titre', indication: 'Recrutement monteur', longueurMax: 45 },
              { id: 'description', libelle: 'Description du formulaire', obligatoire: false, longueurMax: 300 },
              { id: 'questions', libelle: 'Questions (une par ligne, 5 max)', long: true, longueurMax: 400, indication: 'Âge\nDisponibilités*\n?Lien vers ton portfolio\n(* = réponse longue, ? = facultative)' },
            ]),
          );
        }
        if (action === 'suppr') {
          executer('DELETE FROM formulaires WHERE serveur_id = ? AND nom = ?', interaction.guildId, valeur);
          return interaction.update(panneauFormulaires(interaction.guild, '🗑️ Formulaire supprimé.'));
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, argument]) {
        if (action === 'submit') {
          const formulaire = lireFormulaire(interaction.guild, argument ?? '');
          if (!formulaire) throw new ErreurUtilisateur('Ce formulaire n’existe plus.');
          return soumettre(interaction, formulaire);
        }
        if (action === 'create') {
          if (!aNiveau(interaction.member, Niveau.ADMIN)) throw new ErreurUtilisateur('Réservé aux admins.');
          const titre = interaction.fields.getTextInputValue('title').trim();
          const questions = lireQuestions(interaction.fields.getTextInputValue('questions'));
          if (!questions.length) throw new ErreurUtilisateur('Ajoute au moins une question.');
          const nom = identifiantDepuisTexte(titre, 40);
          if (integre(interaction.guild, nom)) throw new ErreurUtilisateur('Ce nom est réservé.');
          executer(
            `INSERT INTO formulaires (serveur_id, nom, titre, description, questions, salon_id, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(serveur_id, nom) DO UPDATE SET titre = excluded.titre, description = excluded.description, questions = excluded.questions, salon_id = excluded.salon_id`,
            interaction.guildId,
            nom,
            titre,
            interaction.fields.getTextInputValue('description').trim(),
            JSON.stringify(questions),
            argument,
            Date.now(),
          );
          const note = `✅ **${titre}** enregistré (${questions.length} question(s)). Pose son bouton avec \`/affiche\`.`;
          if (interaction.isFromMessage()) await interaction.update(panneauFormulaires(interaction.guild, note));
          else await interaction.reply({ ...panneauFormulaires(interaction.guild, note), flags: MessageFlags.Ephemeral });
        }
      },
    },
  ],
};
