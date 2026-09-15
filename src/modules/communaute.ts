import {
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type User,
} from 'discord.js';
import { aNiveau, botPeutGererRole, emojiPour } from '../coeur/acces';
import {
  bouton,
  construireFormulaire,
  couleurPour,
  embedEnseigne,
  info,
  lignesEnPages,
  ok,
  paginer,
  rangee,
  repondre,
} from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireJson, lireTout } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import {
  barreProgression,
  creerRegistre,
  ErreurUtilisateur,
  formaterDuree,
  joursDepuis,
  lireDuree,
  marqueTemps,
  medaille,
  neutraliserMentions,
  tronquer, Niveau } from '../coeur/outils';
import { lireConfig, modifierConfig, moduleActif } from '../coeur/reglages';
import { creerTicket } from './tickets';

interface LigneSuggestion {
  id: number;
  serveur_id: string;
  numero: number;
  salon_id: string;
  message_id: string | null;
  auteur_id: string;
  contenu: string;
  statut: 'pending' | 'accepted' | 'denied';
  staff_id: string | null;
  raison_staff: string | null;
  cree_le: number;
}

const STATUTS = {
  pending: { label: 'En attente', emoji: '⏳', kind: 'principale' as const },
  accepted: { label: 'Acceptée', emoji: '✅', kind: 'succes' as const },
  denied: { label: 'Refusée', emoji: '❌', kind: 'erreur' as const },
};

function votes(id: number): { up: number; down: number } {
  const r = lire<{ pour: number; contre: number }>('SELECT SUM(vote = 1) AS pour, SUM(vote = -1) AS contre FROM votes_suggestions WHERE suggestion_id = ?', id);
  return { up: r?.pour ?? 0, down: r?.contre ?? 0 };
}

function afficher(serveur: Guild, s: LigneSuggestion) {
  const { up, down } = votes(s.id);
  const total = up + down;
  const statut = STATUTS[s.statut];
  const auteur = serveur.members.cache.get(s.auteur_id);
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, statut.kind))
    .setAuthor({ name: auteur?.user.tag ?? 'Membre', iconURL: auteur?.user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiPour(serveur.id, 'suggestion')} SUGGESTION #${s.numero}`)
    .setDescription(`<@${s.auteur_id}> propose :\n\n>>> ${tronquer(s.contenu, 3500)}`)
    .addFields(
      { name: 'Votes', value: `👍 **${up}** · 👎 **${down}**\n${barreProgression(total ? up / total : 0.5, 14)}`, inline: true },
      { name: 'Statut', value: `${statut.emoji} ${statut.label}`, inline: true },
    )
    .setFooter({ text: `Suggestion #${s.numero}` })
    .setTimestamp(s.cree_le);
  if (s.staff_id) embed.addFields({ name: `Réponse du staff`, value: `${s.raison_staff ? tronquer(s.raison_staff, 900) : '*Sans commentaire.*'}\n-# par <@${s.staff_id}>`, inline: false });
  const ferme = s.statut !== 'pending';
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton(`sg:up:${s.id}`, String(up), ButtonStyle.Success, '👍').setDisabled(ferme),
        bouton(`sg:down:${s.id}`, String(down), ButtonStyle.Danger, '👎').setDisabled(ferme),
        bouton(`sg:accept:${s.id}`, 'Accepter', ButtonStyle.Secondary, '✅').setDisabled(ferme),
        bouton(`sg:deny:${s.id}`, 'Refuser', ButtonStyle.Secondary, '❌').setDisabled(ferme),
      ),
    ],
  };
}

function exigerSuggestion(serveurId: string, id: string | undefined): LigneSuggestion {
  const s = lire<LigneSuggestion>('SELECT * FROM suggestions WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!s) throw new ErreurUtilisateur('Suggestion introuvable.');
  return s;
}

async function creer(membre: GuildMember, contenu: string): Promise<string> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).suggestions;
  const salon = resoudreSalonTexte(serveur, reglages.salonId);
  if (!salon) throw new ErreurUtilisateur('Le salon des suggestions n’est pas configuré (`/setup` → Communauté).');
  const texte = neutraliserMentions(contenu.trim());
  if (texte.length < 10) throw new ErreurUtilisateur('Ta suggestion est trop courte (10 caractères minimum).');
  const recents = lire<{ n: number }>('SELECT COUNT(*) AS n FROM suggestions WHERE serveur_id = ? AND auteur_id = ? AND cree_le > ?', serveur.id, membre.id, Date.now() - 3_600_000)?.n ?? 0;
  if (recents >= 5 && !aNiveau(membre, Niveau.STAFF)) throw new ErreurUtilisateur('Tu as déjà proposé 5 suggestions cette heure-ci. Reviens un peu plus tard !');
  const numero = modifierConfig(serveur.id, (c) => void (c.suggestions.compteur += 1)).suggestions.compteur;
  const r = executer('INSERT INTO suggestions (serveur_id, numero, salon_id, auteur_id, contenu, cree_le) VALUES (?, ?, ?, ?, ?, ?)', serveur.id, numero, salon.id, membre.id, texte, Date.now());
  const s = exigerSuggestion(serveur.id, String(r.lastInsertRowid));
  const message = await salon.send(afficher(serveur, s));
  executer('UPDATE suggestions SET message_id = ? WHERE id = ?', message.id, s.id);
  if (reglages.creerFil && 'threads' in salon) {
    await message.startThread({ name: `Suggestion #${numero}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }).catch(() => undefined);
  }
  historiser(serveur.id, 'community', 'suggestion', membre.id, membre.id, { number: numero });
  void journal(serveur, 'community', { titre: 'Nouvelle suggestion', ton: 'info', lignes: [`**#${numero}** par <@${membre.id}> · [voir](${message.url})`, tronquer(texte, 500)] });
  return message.url;
}

async function rafraichir(serveur: Guild, s: LigneSuggestion): Promise<void> {
  const salon = resoudreSalonTexte(serveur, s.salon_id);
  const message = s.message_id ? await salon?.messages.fetch(s.message_id).catch(() => null) : null;
  await message?.edit(afficher(serveur, s)).catch(() => undefined);
}

const suggerer: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 30,
  donnees: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Proposer une idée')
    .addStringOption((o) => o.setName('idee').setDescription('Ton idée').setMaxLength(2000)),
  async executer(interaction) {
    const idee = interaction.options.getString('idee');
    if (!idee) {
      await interaction.showModal(construireFormulaire('sg:new', 'Nouvelle suggestion', [{ id: 'content', libelle: 'Ton idée', long: true, longueurMin: 10, longueurMax: 2000, indication: 'Créer une soirée communautaire…' }]));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const url = await creer(interaction.member, idee);
    await interaction.editReply({ embeds: [ok(interaction.guild, `Merci ! Ta suggestion est publiée : ${url}`)] });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'suggest',
    alias: ['suggestion', 'idee'],
    domaine: 'general',
    categorie: 'community',
    description: 'Proposer une idée',
    usage: '<idée>',
    async executer(message, parametres) {
      if (!message.member) return;
      const url = await creer(message.member, parametres.join(' '));
      await message.reply({ embeds: [ok(message.guild, `Merci ! Ta suggestion est publiée : ${url}`)], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'suggestions',
  section: 'community',
  titre: 'Suggestions',
  emoji: '💡',
  moduleId: 'suggestions',
  ordre: 2,
  description: 'Les membres proposent avec `/suggest`, votent 👍/👎, et le staff accepte ou refuse avec un commentaire.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des suggestions', lire: (c) => c.suggestions.salonId, ecrire: (c, v) => void (c.suggestions.salonId = v) },
    { genre: 'toggle', cle: 'thread', libelle: 'Fil de discussion', lire: (c) => c.suggestions.creerFil, ecrire: (c, v) => void (c.suggestions.creerFil = v) },
  ],
};

export const moduleSuggestions: ModuleBot = {
  id: 'suggestions',
  nom: 'Suggestions',
  emoji: '💡',
  description: 'Suggestions avec votes et réponse du staff',
  desactivable: true,
  actifParDefaut: true,
  commandes: [suggerer],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'sg',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id]) {
        const s = exigerSuggestion(interaction.guildId, id);
        if (action === 'up' || action === 'down') {
          if (s.statut !== 'pending') throw new ErreurUtilisateur('Cette suggestion est close.');
          const valeur = action === 'up' ? 1 : -1;
          const existant = lire<{ vote: number }>('SELECT vote FROM votes_suggestions WHERE suggestion_id = ? AND utilisateur_id = ?', s.id, interaction.user.id);
          if (existant?.vote === valeur) executer('DELETE FROM votes_suggestions WHERE suggestion_id = ? AND utilisateur_id = ?', s.id, interaction.user.id);
          else executer('INSERT OR REPLACE INTO votes_suggestions (suggestion_id, utilisateur_id, vote) VALUES (?, ?, ?)', s.id, interaction.user.id, valeur);
          await interaction.update(afficher(interaction.guild, s));
          return;
        }
        if (!aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Réservé au staff.');
        await interaction.showModal(
          construireFormulaire(`sg:decide:${s.id}:${action}`, action === 'accept' ? `Accepter la suggestion #${s.numero}` : `Refuser la suggestion #${s.numero}`, [
            { id: 'reason', libelle: 'Commentaire (facultatif)', long: true, obligatoire: false, longueurMax: 900 },
          ]),
        );
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id, decision]) {
        if (action === 'new') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const url = await creer(interaction.member, interaction.fields.getTextInputValue('content'));
          await interaction.editReply({ embeds: [ok(interaction.guild, `Merci ! Ta suggestion est publiée : ${url}`)] });
          return;
        }
        if (action !== 'decide') return;
        if (!aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Réservé au staff.');
        const s = exigerSuggestion(interaction.guildId, id);
        const statut = decision === 'accept' ? 'accepted' : 'denied';
        const raison = interaction.fields.getTextInputValue('reason').trim() || null;
        executer('UPDATE suggestions SET statut = ?, staff_id = ?, raison_staff = ? WHERE id = ?', statut, interaction.user.id, raison, s.id);
        const modifie = exigerSuggestion(interaction.guildId, id);
        await rafraichir(interaction.guild, modifie);
        const auteur = await interaction.client.users.fetch(s.auteur_id).catch(() => null);
        await auteur
          ?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild, STATUTS[statut].kind)).setDescription(`${STATUTS[statut].emoji} Ta suggestion **#${s.numero}** sur **${interaction.guild.name}** a été **${STATUTS[statut].label.toLowerCase()}**.${raison ? `\n\n> ${tronquer(raison, 900)}` : ''}`)] })
          .catch(() => undefined);
        historiser(interaction.guildId, 'community', `suggestion-${statut}`, s.auteur_id, interaction.user.id, { number: s.numero, reason: raison });
        void journal(interaction.guild, 'community', { titre: `Suggestion ${STATUTS[statut].label.toLowerCase()}`, ton: statut === 'accepted' ? 'ok' : 'alerte', lignes: [`**#${s.numero}** de <@${s.auteur_id}>`, raison ? `**Commentaire** : ${raison}` : null], par: interaction.user });
        await interaction.reply({ embeds: [ok(interaction.guild, `Suggestion #${s.numero} ${STATUTS[statut].label.toLowerCase()}.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  tests: [
    {
      id: 'count',
      libelle: 'Résumé des suggestions',
      emoji: '💡',
      description: 'Combien sont en attente, acceptées, refusées',
      async executer(interaction) {
        const rangees = lireTout<{ statut: string; n: number }>('SELECT statut, COUNT(*) AS n FROM suggestions WHERE serveur_id = ? GROUP BY statut', interaction.guildId);
        const n = (s: string) => rangees.find((r) => r.statut === s)?.n ?? 0;
        return `⏳ ${n('pending')} en attente · ✅ ${n('accepted')} acceptées · ❌ ${n('denied')} refusées`;
      },
    },
  ],
};

interface LigneSondage {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  auteur_id: string;
  question: string;
  propositions: string;
  multiple: number;
  fin_le: number | null;
  statut: 'open' | 'closed';
  cree_le: number;
}

const NUMEROS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function decompte(sondage: LigneSondage): { counts: number[]; voters: number } {
  const propositions = lireJson<string[]>(sondage.propositions, []);
  const comptes = propositions.map(() => 0);
  for (const r of lireTout<{ choix: number; n: number }>('SELECT choix, COUNT(*) AS n FROM votes_sondages WHERE sondage_id = ? GROUP BY choix', sondage.id)) {
    if (comptes[r.choix] !== undefined) comptes[r.choix] = r.n;
  }
  const votants = lire<{ n: number }>('SELECT COUNT(DISTINCT utilisateur_id) AS n FROM votes_sondages WHERE sondage_id = ?', sondage.id)?.n ?? 0;
  return { counts: comptes, voters: votants };
}

function afficherSondages(serveur: Guild, sondage: LigneSondage) {
  const propositions = lireJson<string[]>(sondage.propositions, []);
  const { counts: comptes, voters: votants } = decompte(sondage);
  const total = comptes.reduce((a, b) => a + b, 0);
  const ferme = sondage.statut === 'closed';
  const max = Math.max(...comptes);
  const lignes = propositions.map((c, i) => {
    const pourcentage = total ? Math.round((comptes[i]! / total) * 100) : 0;
    const victoire = ferme && max > 0 && comptes[i] === max ? ' 🏆' : '';
    return `${NUMEROS[i]} **${tronquer(c, 80)}**${victoire}\n${barreProgression(total ? comptes[i]! / total : 0, 14)} ${pourcentage}% · ${comptes[i]} vote${comptes[i]! > 1 ? 's' : ''}`;
  });
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, ferme ? 'info' : 'principale'))
    .setAuthor({ name: ferme ? '📊 SONDAGE TERMINÉ' : '📊 SONDAGE' })
    .setTitle(tronquer(sondage.question, 256))
    .setDescription(lignes.join('\n\n'))
    .setFooter({ text: `${votants} participant${votants > 1 ? 's' : ''} · ${sondage.multiple ? 'plusieurs choix possibles' : 'un seul choix'} · #${sondage.id}` });
  if (sondage.fin_le && !ferme) embed.addFields({ name: 'Fin', value: `${marqueTemps(sondage.fin_le, 'R')}`, inline: true });
  const boutons = propositions.map((_, i) => bouton(`poll:vote:${sondage.id}:${i}`, String(comptes[i]), ButtonStyle.Secondary, NUMEROS[i]).setDisabled(ferme));
  const rangees = [];
  for (let i = 0; i < boutons.length; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  if (!ferme) rangees.push(rangee(bouton(`poll:end:${sondage.id}`, 'Terminer', ButtonStyle.Danger, '⏹️')));
  return { embeds: [embed], components: rangees };
}

function exigerSondage(serveurId: string, id: string | undefined): LigneSondage {
  const sondage = lire<LigneSondage>('SELECT * FROM sondages WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!sondage) throw new ErreurUtilisateur('Sondage introuvable.');
  return sondage;
}

async function cloreSondage(client: Client, sondage: LigneSondage): Promise<void> {
  executer("UPDATE sondages SET statut = 'closed' WHERE id = ?", sondage.id);
  const serveur = client.guilds.cache.get(sondage.serveur_id);
  const salon = serveur?.channels.cache.get(sondage.salon_id);
  if (!serveur || !salon?.isTextBased() || !sondage.message_id) return;
  const message = await salon.messages.fetch(sondage.message_id).catch(() => null);
  await message?.edit(afficherSondages(serveur, { ...sondage, statut: 'closed' })).catch(() => undefined);
}

const sondage: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  delaiSecondes: 20,
  donnees: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Créer un sondage')
    .addStringOption((o) => o.setName('question').setDescription('La question').setRequired(true).setMaxLength(250))
    .addStringOption((o) => o.setName('choix').setDescription('Choix séparés par |').setMaxLength(1000))
    .addStringOption((o) => o.setName('duree').setDescription('Durée'))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Autoriser plusieurs choix')),
  async executer(interaction) {
    const brut = interaction.options.getString('choix');
    const propositions = (brut ? brut.split('|') : ['Oui', 'Non']).map((c) => neutraliserMentions(c.trim())).filter(Boolean).slice(0, 10);
    if (propositions.length < 2) throw new ErreurUtilisateur('Il faut au moins 2 choix, séparés par `|`.');
    const dureeBrute = interaction.options.getString('duree');
    const duree = dureeBrute ? lireDuree(dureeBrute) : null;
    if (dureeBrute && (!duree || duree > 30 * 86_400_000)) throw new ErreurUtilisateur('Durée invalide (ex : `1h`, `2j`, 30 jours max).');
    const r = executer(
      'INSERT INTO sondages (serveur_id, salon_id, auteur_id, question, propositions, multiple, fin_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      neutraliserMentions(interaction.options.getString('question', true)),
      JSON.stringify(propositions),
      interaction.options.getBoolean('multiple') ? 1 : 0,
      duree ? Date.now() + duree : null,
      Date.now(),
    );
    const cree = exigerSondage(interaction.guildId, String(r.lastInsertRowid));
    const message = await interaction.reply({ ...afficherSondages(interaction.guild, cree), withResponse: true });
    executer('UPDATE sondages SET message_id = ? WHERE id = ?', message.resource?.message?.id ?? null, cree.id);
    historiser(interaction.guildId, 'community', 'poll', null, interaction.user.id, { id: cree.id });
  },
};

export const moduleSondages: ModuleBot = {
  id: 'polls',
  nom: 'Sondages',
  emoji: '📊',
  description: 'Sondages à boutons avec résultats en direct',
  desactivable: true,
  actifParDefaut: true,
  commandes: [sondage],
  composants: [
    {
      prefixe: 'poll',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, choix]) {
        const p = exigerSondage(interaction.guildId, id);
        if (p.statut === 'closed') throw new ErreurUtilisateur('Ce sondage est terminé.');
        if (action === 'end') {
          if (p.auteur_id !== interaction.user.id && !aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Seul l’auteur ou le staff peut terminer ce sondage.');
          await interaction.deferUpdate();
          await cloreSondage(interaction.client, p);
          return;
        }
        const indice = Number(choix);
        const nombre = lireJson<string[]>(p.propositions, []).length;
        if (!Number.isInteger(indice) || indice < 0 || indice >= nombre) return;
        const deja = lire('SELECT 1 FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ? AND choix = ?', p.id, interaction.user.id, indice);
        if (deja) executer('DELETE FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ? AND choix = ?', p.id, interaction.user.id, indice);
        else {
          if (!p.multiple) executer('DELETE FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ?', p.id, interaction.user.id);
          executer('INSERT OR IGNORE INTO votes_sondages (sondage_id, utilisateur_id, choix) VALUES (?, ?, ?)', p.id, interaction.user.id, indice);
        }
        await interaction.update(afficherSondages(interaction.guild, p));
        if (!deja) await interaction.followUp({ embeds: [ok(interaction.guild, `Vote enregistré : **${tronquer(lireJson<string[]>(p.propositions, [])[indice] ?? '', 80)}**`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  taches: [
    {
      nom: 'polls-end',
      intervalleMs: 30_000,
      auDemarrage: true,
      async executer(client) {
        for (const p of lireTout<LigneSondage>("SELECT * FROM sondages WHERE statut = 'open' AND fin_le IS NOT NULL AND fin_le <= ? LIMIT 20", Date.now())) {
          await cloreSondage(client, p);
        }
      },
    },
  ],
};

async function envoyerSignalement(membre: GuildMember, cible: User, raison: string, preuve: string | null): Promise<string> {
  const serveur = membre.guild;
  if (cible.id === membre.id) throw new ErreurUtilisateur('Tu ne peux pas te signaler toi-même.');
  const reglages = lireConfig(serveur.id);
  const nettoyer = tronquer(neutraliserMentions(raison), 1000);

  if (reglages.signalements.mode === 'ticket' && moduleActif(serveur.id, 'tickets')) {
    const categorie = reglages.tickets.categories.find((c) => c.id === 'sanction' || c.id === 'support') ?? reglages.tickets.categories[0];
    if (categorie) {
      const { salon } = await creerTicket(membre, categorie.id, `Signalement de ${cible.tag}`);
      await salon.send({
        embeds: [
          new EmbedBuilder()
            .setColor(couleurPour(serveur, 'attention'))
            .setTitle('🚨 Signalement')
            .setDescription(`**Signalé :** <@${cible.id}> \`${cible.id}\`\n**Raison :** ${nettoyer}${preuve ? `\n**Preuve :** ${tronquer(preuve, 500)}` : ''}`),
        ],
        allowedMentions: { parse: [] },
      });
      historiser(serveur.id, 'community', 'report', cible.id, membre.id, { reason: nettoyer, ticket: salon.id });
      return `Ton signalement a ouvert un ticket privé : <#${salon.id}>`;
    }
  }

  const salon = resoudreSalonTexte(serveur, reglages.signalements.salonId ?? reglages.general.salonStaffId);
  if (!salon) throw new ErreurUtilisateur('Le salon des signalements n’est pas configuré. Ouvre plutôt un ticket.');
  await salon.send({
    embeds: [
      new EmbedBuilder()
        .setColor(couleurPour(serveur, 'attention'))
        .setAuthor({ name: `Signalé par ${membre.user.tag}`, iconURL: membre.user.displayAvatarURL({ size: 64 }) })
        .setTitle('🚨 Nouveau signalement')
        .setThumbnail(cible.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Membre signalé', value: `<@${cible.id}>\n\`${cible.id}\``, inline: true },
          { name: 'Par', value: `<@${membre.id}>`, inline: true },
          { name: 'Raison', value: nettoyer, inline: false },
          ...(preuve ? [{ name: 'Preuve', value: tronquer(preuve, 1000), inline: false }] : []),
        )
        .setTimestamp(),
    ],
    components: [rangee(bouton(`rep:take:${membre.id}`, 'Je m’en occupe', ButtonStyle.Primary, '🙋'), bouton(`rep:done:${membre.id}`, 'Traité', ButtonStyle.Success, '✅'))],
    allowedMentions: { parse: [] },
  });
  historiser(serveur.id, 'community', 'report', cible.id, membre.id, { reason: nettoyer });
  void journal(serveur, 'community', { titre: 'Signalement', ton: 'alerte', lignes: [`**Signalé** : <@${cible.id}>`, `**Par** : <@${membre.id}>`, `**Raison** : ${nettoyer}`] });
  return 'Merci, ton signalement a été transmis au staff.';
}

const signalement: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 60,
  donnees: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Signaler')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Ce qui s’est passé').setRequired(true).setMaxLength(1000))
    .addStringOption((o) => o.setName('preuve').setDescription('Lien de preuve').setMaxLength(500)),
  async executer(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const texte = await envoyerSignalement(interaction.member, interaction.options.getUser('membre', true), interaction.options.getString('raison', true), interaction.options.getString('preuve'));
    await interaction.editReply({ embeds: [ok(interaction.guild, texte)] });
  },
};

const avis: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 60,
  donnees: new SlashCommandBuilder().setName('feedback').setDescription('Ton avis'),
  async executer(interaction) {
    await interaction.showModal(
      construireFormulaire('rep:feedback', 'Ton avis compte', [
        { id: 'subject', libelle: 'Sujet', longueurMax: 100, indication: 'Le bot, les lives, le serveur…' },
        { id: 'content', libelle: 'Ton message', long: true, longueurMax: 2000 },
        { id: 'rating', libelle: 'Note sur 5 (facultatif)', obligatoire: false, longueurMax: 1 },
      ]),
    );
  },
};

const pageReglageSignalements: PageReglage = {
  id: 'reports',
  section: 'community',
  titre: 'Signalements & feedback',
  emoji: '🚨',
  moduleId: 'reports',
  ordre: 5,
  description: 'Où arrivent `/report` et `/feedback`. Sans salon, c’est le salon staff général qui est utilisé.',
  champs: [
    { genre: 'channel', cle: 'reports', libelle: 'Salon des signalements', lire: (c) => c.signalements.salonId, ecrire: (c, v) => void (c.signalements.salonId = v) },
    { genre: 'channel', cle: 'feedback', libelle: 'Salon des feedbacks', lire: (c) => c.avis.salonId, ecrire: (c, v) => void (c.avis.salonId = v) },
    {
      genre: 'choice',
      cle: 'mode',
      libelle: 'Signalement',
      options: [
        { valeur: 'channel', libelle: 'Envoyé dans le salon staff', emoji: '📨' },
        { valeur: 'ticket', libelle: 'Ouvre un ticket privé', emoji: '🎫' },
      ],
      lire: (c) => c.signalements.mode,
      ecrire: (c, v) => void (c.signalements.mode = v as 'channel' | 'ticket'),
    },
  ],
};

export const moduleSignalements: ModuleBot = {
  id: 'reports',
  nom: 'Signalements & feedback',
  emoji: '🚨',
  description: '/report et /feedback vers le staff',
  desactivable: true,
  actifParDefaut: true,
  commandes: [signalement, avis],
  pagesReglage: [pageReglageSignalements],
  composants: [
    {
      prefixe: 'rep',
      async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
        if (!aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Réservé au staff.');
        const embed = EmbedBuilder.from(interaction.message.embeds[0]!);
        if (action === 'take') {
          embed.setFooter({ text: `Pris en charge par ${interaction.user.tag}` });
          await interaction.update({ embeds: [embed], components: [rangee(bouton('rep:done:x', 'Traité', ButtonStyle.Success, '✅'))] });
        } else {
          embed.setColor(couleurPour(interaction.guild, 'succes')).setFooter({ text: `Traité par ${interaction.user.tag}` });
          await interaction.update({ embeds: [embed], components: [] });
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action]) {
        if (action !== 'feedback') return;
        const serveur = interaction.guild;
        const reglages = lireConfig(serveur.id);
        const salon = resoudreSalonTexte(serveur, reglages.avis.salonId ?? reglages.general.salonStaffId);
        if (!salon) throw new ErreurUtilisateur('Le salon des feedbacks n’est pas configuré.');
        const note = Number(interaction.fields.getTextInputValue('rating'));
        const etoiles = Number.isInteger(note) && note >= 1 && note <= 5 ? `${'⭐'.repeat(note)}${'☆'.repeat(5 - note)}` : null;
        await salon.send({
          embeds: [
            new EmbedBuilder()
              .setColor(couleurPour(serveur, 'info'))
              .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
              .setTitle(`💬 Feedback — ${tronquer(neutraliserMentions(interaction.fields.getTextInputValue('subject')), 200)}`)
              .setDescription(tronquer(neutraliserMentions(interaction.fields.getTextInputValue('content')), 4000))
              .addFields(etoiles ? [{ name: 'Note', value: etoiles, inline: true }] : [])
              .setFooter({ text: `ID ${interaction.user.id}` })
              .setTimestamp(),
          ],
          allowedMentions: { parse: [] },
        });
        historiser(serveur.id, 'community', 'feedback', interaction.user.id, interaction.user.id, {});
        await interaction.reply({ embeds: [ok(serveur, 'Merci pour ton retour, il a bien été transmis au staff !')], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};

interface LigneAfk {
  raison: string;
  depuis: number;
}

const prevenus = new Map<string, number>();

function mettreAfk(serveurId: string, utilisateurId: string, raison: string): void {
  executer('INSERT OR REPLACE INTO afk (serveur_id, utilisateur_id, raison, depuis) VALUES (?, ?, ?, ?)', serveurId, utilisateurId, tronquer(neutraliserMentions(raison || 'AFK'), 200), Date.now());
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;
  const soi = lire<LigneAfk>('SELECT raison, depuis FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, message.author.id);
  if (soi && Date.now() - soi.depuis > 5_000) {
    executer('DELETE FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, message.author.id);
    const note = await message.reply({ embeds: [ok(message.guild, `👋 Bienvenue de retour <@${message.author.id}> ! Tu étais AFK depuis **${formaterDuree(Date.now() - soi.depuis)}**.`)], allowedMentions: { repliedUser: false } }).catch(() => null);
    if (note) setTimeout(() => void note.delete().catch(() => undefined), 10_000).unref();
  }
  const mentionnes = [...message.mentions.users.values()].filter((u) => u.id !== message.author.id && !u.bot).slice(0, 5);
  const lignes: string[] = [];
  for (const utilisateur of mentionnes) {
    const rangee = lire<LigneAfk>('SELECT raison, depuis FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, utilisateur.id);
    if (!rangee) continue;
    const cle = `${message.channelId}:${utilisateur.id}`;
    if ((prevenus.get(cle) ?? 0) > Date.now()) continue;
    prevenus.set(cle, Date.now() + 60_000);
    lignes.push(`💤 <@${utilisateur.id}> est actuellement AFK ${marqueTemps(rangee.depuis, 'R')}.\n**Raison :** ${rangee.raison}`);
  }
  if (prevenus.size > 5_000) for (const [k, v] of prevenus) if (v < Date.now()) prevenus.delete(k);
  if (lignes.length) await message.reply({ embeds: [info(message.guild, lignes.join('\n\n'), { emoji: '💤' })], allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
}

const afk: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Te mettre AFK')
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(200)),
  async executer(interaction) {
    const raison = interaction.options.getString('raison') ?? 'AFK';
    mettreAfk(interaction.guildId, interaction.user.id, raison);
    await repondre(interaction, { embeds: [info(interaction.guild, `💤 <@${interaction.user.id}> est maintenant AFK.\n**Raison :** ${neutraliserMentions(raison)}`)], allowedMentions: { parse: [] } });
  },
};

const commandesPrefixeAfk: CommandePrefixe[] = [
  {
    nom: 'afk',
    domaine: 'general',
    categorie: 'community',
    description: 'Te mettre AFK',
    usage: '[raison]',
    async executer(message, parametres) {
      const raison = parametres.join(' ') || 'AFK';
      mettreAfk(message.guildId, message.author.id, raison);
      await message.reply({ embeds: [info(message.guild, `💤 Tu es maintenant AFK.\n**Raison :** ${neutraliserMentions(raison)}`)], allowedMentions: { parse: [], repliedUser: false } });
    },
  },
];

export const moduleAfk: ModuleBot = {
  id: 'afk',
  nom: 'AFK',
  emoji: '💤',
  description: 'Statut AFK avec rappel quand on te mentionne',
  desactivable: true,
  actifParDefaut: true,
  commandes: [afk],
  commandesPrefixe: commandesPrefixeAfk,
  evenements: [sur('messageCreate', (m) => surMessage(m), 120)],
};

function panneauBoutons(serveur: import('discord.js').Guild) {
  const reglages = lireConfig(serveur.id).reglement;
  const embed = new EmbedBuilder().setColor(couleurPour(serveur)).setTitle(tronquer(reglages.titre, 256));
  for (const s of reglages.sections.slice(0, 25)) embed.addFields({ name: tronquer(s.titre, 256), value: tronquer(s.contenu, 1024), inline: false });
  embed.setFooter({ text: `${serveur.name} · en restant ici, tu acceptes ces règles` });
  return { embeds: [embed], components: reglages.roleAcceptationId ? [rangee(bouton('rules:accept', 'J’accepte le règlement', ButtonStyle.Success, '✅'))] : [] };
}

export function lireSections(saisie: string): { titre: string; contenu: string }[] {
  const sortie: { titre: string; contenu: string }[] = [];
  for (const groupe of saisie.split(/^##\s*/m).map((b) => b.trim()).filter(Boolean)) {
    const [titre, ...reste] = groupe.split('\n');
    const contenu = reste.join('\n').trim();
    if (titre && contenu) sortie.push({ titre: titre.trim(), contenu });
  }
  return sortie.slice(0, 25);
}

const reglement: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Le panneau du règlement')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async executer(interaction) {
    const reglages = lireConfig(interaction.guildId).reglement;
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(interaction.guild, reglages.salonId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const envoye = await salon.send(panneauBoutons(interaction.guild));
    await repondre(interaction, { embeds: [ok(interaction.guild, `Règlement posté : ${envoye.url}${reglages.roleAcceptationId ? '' : '\n-# Aucun rôle d’acceptation réglé : le bouton n’apparaît pas.'}`)], ephemeral: true });
  },
};

const pageReglageReglement: PageReglage = {
  id: 'rules',
  section: 'security',
  titre: 'Règlement',
  emoji: '📜',
  moduleId: 'rules',
  ordre: 1,
  description: 'Le panneau `/rules` avec un bouton « J’accepte » qui donne le rôle membre.\n-# Sections : une ligne `## Titre` puis le texte, répété.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon du règlement', lire: (c) => c.reglement.salonId, ecrire: (c, v) => void (c.reglement.salonId = v) },
    { genre: 'role', cle: 'accept', libelle: 'Rôle donné en acceptant', attribuable: true, lire: (c) => c.reglement.roleAcceptationId, ecrire: (c, v) => void (c.reglement.roleAcceptationId = v) },
    { genre: 'role', cle: 'remove', libelle: 'Rôle retiré en acceptant', attribuable: true, lire: (c) => c.reglement.roleRetireId, ecrire: (c, v) => void (c.reglement.roleRetireId = v) },
    { genre: 'text', cle: 'title', libelle: 'Titre', longueurMax: 200, obligatoire: true, lire: (c) => c.reglement.titre, ecrire: (c, v) => void (c.reglement.titre = v) },
    {
      genre: 'text',
      cle: 'sections',
      libelle: 'Sections',
      long: true,
      longueurMax: 4000,
      obligatoire: true,
      lire: (c) => c.reglement.sections.map((s) => `## ${s.titre}\n${s.contenu}`).join('\n\n'),
      ecrire: (c, v) => void (c.reglement.sections = lireSections(v)),
      validate: (v) => (lireSections(v).length ? null : 'Au moins une section : `## Titre` puis le texte.'),
    },
  ],
};

export const moduleReglement: ModuleBot = {
  id: 'rules',
  nom: 'Règlement',
  emoji: '📜',
  description: 'Panneau de règlement avec acceptation',
  desactivable: true,
  actifParDefaut: true,
  commandes: [reglement],
  pagesReglage: [pageReglageReglement],
  composants: [
    {
      prefixe: 'rules',
      async bouton(interaction) {
        const reglages = lireConfig(interaction.guildId).reglement;
        const serveur = interaction.guild;
        const role = reglages.roleAcceptationId ? serveur.roles.cache.get(reglages.roleAcceptationId) : null;
        if (!role || !botPeutGererRole(serveur, role)) throw new ErreurUtilisateur('Le rôle du règlement n’est pas utilisable. Préviens le staff.');
        if (interaction.member.roles.cache.has(role.id)) {
          await interaction.reply({ embeds: [ok(serveur, 'Tu as déjà accepté le règlement. Merci ! 💜')], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.member.roles.add(role, 'Règlement accepté');
        const retirer = reglages.roleRetireId ? serveur.roles.cache.get(reglages.roleRetireId) : null;
        if (retirer && botPeutGererRole(serveur, retirer)) await interaction.member.roles.remove(retirer, 'Règlement accepté').catch(() => undefined);
        executer('INSERT OR IGNORE INTO membres (serveur_id, utilisateur_id, vu_le) VALUES (?, ?, ?)', serveur.id, interaction.user.id, Date.now());
        void journal(serveur, 'autorole', { titre: 'Règlement accepté', ton: 'ok', lignes: [`<@${interaction.user.id}> a reçu <@&${role.id}>`] });
        await interaction.reply({ embeds: [ok(serveur, `Merci ! Tu as maintenant accès au serveur avec le rôle <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};

const registre = creerRegistre('invitations');

const instantanes = new Map<string, Map<string, { uses: number; inviterId: string | null }>>();

async function instantane(serveur: Guild): Promise<Map<string, { uses: number; inviterId: string | null }> | null> {
  if (!serveur.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invitations = await serveur.invites.fetch().catch(() => null);
  if (!invitations) return null;
  const correspondance = new Map<string, { uses: number; inviterId: string | null }>();
  for (const invitationDiscord of invitations.values()) correspondance.set(invitationDiscord.code, { uses: invitationDiscord.uses ?? 0, inviterId: invitationDiscord.inviterId });
  if (serveur.vanityURLCode) {
    const lienPerso = await serveur.fetchVanityData().catch(() => null);
    if (lienPerso) correspondance.set(`vanity:${lienPerso.code}`, { uses: lienPerso.uses, inviterId: null });
  }
  return correspondance;
}

function comptes(serveurId: string, utilisateurId: string): { total: number; valid: number; faux: number; left: number } {
  const r = lire<{ total: number; faux: number; partis: number }>(
    'SELECT COUNT(*) AS total, SUM(faux) AS faux, SUM(CASE WHEN parti_le IS NOT NULL AND faux = 0 THEN 1 ELSE 0 END) AS partis FROM invitations WHERE serveur_id = ? AND parrain_id = ?',
    serveurId,
    utilisateurId,
  );
  const total = r?.total ?? 0;
  const faux = r?.faux ?? 0;
  const partis = r?.partis ?? 0;
  return { total, valid: total - faux - partis, faux, left: partis };
}

async function surArrivee(membre: GuildMember): Promise<void> {
  if (membre.user.bot) return;
  const serveur = membre.guild;
  const avant = instantanes.get(serveur.id);
  const apres = await instantane(serveur);
  if (!apres) return;
  instantanes.set(serveur.id, apres);
  let code: string | null = null;
  let parrainId: string | null = null;
  if (avant) {
    for (const [c, donnees] of apres) {
      if (donnees.uses > (avant.get(c)?.uses ?? 0)) {
        code = c;
        parrainId = donnees.inviterId;
        break;
      }
    }
    if (!code) {
      const disparues = [...avant.entries()].filter(([c]) => !apres.has(c));
      if (disparues.length === 1) {
        code = disparues[0]![0];
        parrainId = disparues[0]![1].inviterId;
      }
    }
  }
  const faux = joursDepuis(membre.user.createdTimestamp) < lireConfig(serveur.id).invitations.joursCompteFaux || parrainId === membre.id ? 1 : 0;
  executer(
    `INSERT INTO invitations (serveur_id, invite_id, parrain_id, code, arrive_le, faux) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, invite_id) DO UPDATE SET parrain_id = excluded.parrain_id, code = excluded.code, arrive_le = excluded.arrive_le, parti_le = NULL, faux = excluded.faux`,
    serveur.id,
    membre.id,
    parrainId,
    code,
    Date.now(),
    faux,
  );
  const texte = code?.startsWith('vanity:')
    ? `<@${membre.id}> a rejoint via le lien personnalisé **${code.slice(7)}**.`
    : parrainId
      ? `<@${membre.id}> a été invité par <@${parrainId}> (\`${code}\`) — **${comptes(serveur.id, parrainId).valid}** invitation(s) valides.`
      : `<@${membre.id}> a rejoint, invitation inconnue.`;
  void journal(serveur, 'invite', { titre: 'Invitation utilisée', ton: faux ? 'alerte' : 'ok', lignes: [texte, faux ? '⚠️ Compte récent : compté comme **fake**.' : null] });
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).invitations.salonId);
  if (salon) await salon.send({ content: `📨 ${texte}`, allowedMentions: { parse: [] } }).catch(() => undefined);
}

function embedInvitations(serveur: Guild, utilisateur: User) {
  const c = comptes(serveur.id, utilisateur.id);
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle('📨 INVITATIONS')
    .setDescription([`• Invitations — **${c.total}**`, `• Validées — **${c.valid}**`, `• Fake / parties — **${c.faux + c.left}**`, `-# ${c.faux} fake · ${c.left} parti(s)`].join('\n'));
}

function pagesClassement(serveur: Guild) {
  const rangees = lireTout<{ parrain_id: string; valides: number }>(
    'SELECT parrain_id, SUM(CASE WHEN faux = 0 AND parti_le IS NULL THEN 1 ELSE 0 END) AS valides FROM invitations WHERE serveur_id = ? AND parrain_id IS NOT NULL GROUP BY parrain_id HAVING valides > 0 ORDER BY valides DESC LIMIT 100',
    serveur.id,
  );
  const lignes = rangees.map((r, i) => `${medaille(i + 1)} <@${r.parrain_id}> — **${r.valides}** invitation(s)`);
  if (!lignes.length) lignes.push('*Aucune invitation suivie pour l’instant.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('🏆 Classement des invitations').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

const invitations: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Tes invitations')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addBooleanOption((o) => o.setName('classement').setDescription('Voir le classement')),
  async executer(interaction) {
    if (interaction.options.getBoolean('classement')) return paginer(interaction, pagesClassement(interaction.guild));
    return repondre(interaction, { embeds: [embedInvitations(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const commandesPrefixeInvitations: CommandePrefixe[] = [
  {
    nom: 'invites',
    alias: ['invs'],
    domaine: 'general',
    categorie: 'community',
    description: 'Tes invitations',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const utilisateur = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [embedInvitations(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglageInvitations: PageReglage = {
  id: 'invites',
  section: 'community',
  titre: 'Invitations',
  emoji: '📨',
  moduleId: 'invites',
  ordre: 12,
  description: 'Qui a invité qui. Nécessite la permission « Gérer le serveur ». Les comptes trop récents comptent comme fake.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des arrivées (facultatif)', lire: (c) => c.invitations.salonId, ecrire: (c, v) => void (c.invitations.salonId = v) },
    { genre: 'number', cle: 'fake', libelle: 'Compte « fake » si plus jeune que', min: 0, max: 365, unite: 'j', lire: (c) => c.invitations.joursCompteFaux, ecrire: (c, v) => void (c.invitations.joursCompteFaux = v) },
  ],
};

export const moduleInvitations: ModuleBot = {
  id: 'invites',
  nom: 'Invitations',
  emoji: '📨',
  description: 'Suivi des invitations, fakes et classement',
  desactivable: true,
  actifParDefaut: true,
  commandes: [invitations],
  commandesPrefixe: commandesPrefixeInvitations,
  pagesReglage: [pageReglageInvitations],
  evenements: [
    sur('guildMemberAdd', (m) => surArrivee(m), 30),
    sur('guildMemberRemove', (m) => {
      executer('UPDATE invitations SET parti_le = ? WHERE serveur_id = ? AND invite_id = ?', Date.now(), m.guild.id, m.id);
    }),
    sur('inviteCreate', (invitation) => {
      if (!invitation.guild) return;
      instantanes.get(invitation.guild.id)?.set(invitation.code, { uses: invitation.uses ?? 0, inviterId: invitation.inviterId });
    }),
    sur('inviteDelete', (invitation) => {
      if (!invitation.guild) return;
      setTimeout(() => instantanes.get(invitation.guild!.id)?.delete(invitation.code), 10_000).unref();
    }),
  ],
  async auDemarrage(client) {
    for (const serveur of client.guilds.cache.values()) {
      if (!moduleActif(serveur.id, 'invites')) continue;
      const cliche = await instantane(serveur).catch(() => null);
      if (cliche) instantanes.set(serveur.id, cliche);
    }
    registre.info(`Invitations suivies sur ${instantanes.size} serveur(s).`);
  },
};
