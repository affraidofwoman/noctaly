import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type User,
} from 'discord.js';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { journal, historiser, resoudreSalonTexte } from '../../core/logService';
import { moduleActif } from '../../core/moduleManager';
import { aNiveau } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { neutraliserMentions, tronquer } from '../../core/text';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { creerTicket } from '../../services/tickets';

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
            .setColor(couleurPour(serveur, 'warning'))
            .setTitle('🚨 Signalement')
            .setDescription(`**Signalé :** <@${cible.id}> \`${cible.id}\`\n**Raison :** ${nettoyer}${preuve ? `\n**Preuve :** ${tronquer(preuve, 500)}` : ''}`),
        ],
        allowedMentions: { parse: [] },
      });
      historiser(serveur.id, 'community', 'report', cible.id, membre.id, { reason: nettoyer, ticket: salon.id });
      return `Ton signalement a ouvert un ticket privé : <#${salon.id}>`;
    }
  }

  const salon = resoudreSalonTexte(serveur, reglages.signalements.channelId ?? reglages.general.salonStaffId);
  if (!salon) throw new ErreurUtilisateur('Le salon des signalements n’est pas configuré. Ouvre plutôt un ticket.');
  await salon.send({
    embeds: [
      new EmbedBuilder()
        .setColor(couleurPour(serveur, 'warning'))
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
    .setDescription('Signaler un membre au staff')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Ce qui s’est passé').setRequired(true).setMaxLength(1000))
    .addStringOption((o) => o.setName('preuve').setDescription('Lien vers un message ou une capture').setMaxLength(500)),
  async executer(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const texte = await envoyerSignalement(interaction.member, interaction.options.getUser('membre', true), interaction.options.getString('raison', true), interaction.options.getString('preuve'));
    await interaction.editReply({ embeds: [ok(interaction.guild, texte)] });
  },
};

const avis: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 60,
  donnees: new SlashCommandBuilder().setName('feedback').setDescription('Donner ton avis au staff'),
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

const pageReglage: PageReglage = {
  id: 'reports',
  section: 'community',
  titre: 'Signalements & feedback',
  emoji: '🚨',
  moduleId: 'reports',
  ordre: 5,
  description: 'Où arrivent `/report` et `/feedback`. Sans salon, c’est le salon staff général qui est utilisé.',
  champs: [
    { kind: 'channel', cle: 'reports', libelle: 'Salon des signalements', get: (c) => c.signalements.channelId, set: (c, v) => void (c.signalements.channelId = v) },
    { kind: 'channel', cle: 'feedback', libelle: 'Salon des feedbacks', get: (c) => c.avis.channelId, set: (c, v) => void (c.avis.channelId = v) },
    {
      kind: 'choice',
      cle: 'mode',
      libelle: 'Signalement',
      options: [
        { value: 'channel', label: 'Envoyé dans le salon staff', emoji: '📨' },
        { value: 'ticket', label: 'Ouvre un ticket privé', emoji: '🎫' },
      ],
      get: (c) => c.signalements.mode,
      set: (c, v) => void (c.signalements.mode = v as 'channel' | 'ticket'),
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
  pagesReglage: [pageReglage],
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
          embed.setColor(couleurPour(interaction.guild, 'success')).setFooter({ text: `Traité par ${interaction.user.tag}` });
          await interaction.update({ embeds: [embed], components: [] });
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action]) {
        if (action !== 'feedback') return;
        const serveur = interaction.guild;
        const reglages = lireConfig(serveur.id);
        const salon = resoudreSalonTexte(serveur, reglages.avis.channelId ?? reglages.general.salonStaffId);
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
