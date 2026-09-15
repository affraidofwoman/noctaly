import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig, modifierConfig } from '../../core/guildConfig';
import { journal, historiser, resoudreSalonTexte } from '../../core/logService';
import { aNiveau } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { neutraliserMentions, barreProgression, tronquer } from '../../core/text';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';

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
  pending: { label: 'En attente', emoji: '⏳', kind: 'primary' as const },
  accepted: { label: 'Acceptée', emoji: '✅', kind: 'success' as const },
  denied: { label: 'Refusée', emoji: '❌', kind: 'error' as const },
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
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
  if (!salon) throw new ErreurUtilisateur('Le salon des suggestions n’est pas configuré (`/setup` → Communauté).');
  const texte = neutraliserMentions(contenu.trim());
  if (texte.length < 10) throw new ErreurUtilisateur('Ta suggestion est trop courte (10 caractères minimum).');
  const recents = lire<{ n: number }>('SELECT COUNT(*) AS n FROM suggestions WHERE serveur_id = ? AND auteur_id = ? AND cree_le > ?', serveur.id, membre.id, Date.now() - 3_600_000)?.n ?? 0;
  if (recents >= 5 && !aNiveau(membre, Niveau.STAFF)) throw new ErreurUtilisateur('Tu as déjà proposé 5 suggestions cette heure-ci. Reviens un peu plus tard !');
  const numero = modifierConfig(serveur.id, (c) => void (c.suggestions.counter += 1)).suggestions.counter;
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
    .addStringOption((o) => o.setName('idee').setDescription('Ta suggestion (vide = formulaire)').setMaxLength(2000)),
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
    { genre: 'channel', cle: 'channel', libelle: 'Salon des suggestions', lire: (c) => c.suggestions.channelId, ecrire: (c, v) => void (c.suggestions.channelId = v) },
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
