import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { demanderConfirmation } from '../../core/confirm';
import { info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { repondre } from '../../core/interactions';
import { journal } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import { marqueTemps } from '../../core/time';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { oublierEnseignes } from '../../core/brand';
import { creerSauvegarde, listerSauvegardes, purgerSauvegardesAuto, restaurerSauvegarde } from '../../services/backup';

const registre = creerRegistre('sauvegarde');

const sauvegarde: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.STREAMER,
  donnees: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegardes de la configuration du bot')
    .addSubcommand((s) => s.setName('create').setDescription('Créer une sauvegarde maintenant'))
    .addSubcommand((s) => s.setName('list').setDescription('Les sauvegardes'))
    .addSubcommand((s) =>
      s
        .setName('restore')
        .setDescription('Restaurer une sauvegarde')
        .addIntegerOption((o) => o.setName('sauvegarde').setDescription('La sauvegarde').setRequired(true).setAutocomplete(true)),
    ),
  niveauxSousCommandes: { list: Niveau.ADMIN, create: Niveau.ADMIN },
  async autocompletion(interaction) {
    await interaction.respond(
      listerSauvegardes(interaction.guildId).map((b) => ({ name: `#${b.id} · ${b.nom} · ${new Date(b.cree_le).toLocaleString('fr-FR')} · ${Math.round(b.taille / 1024)} Ko`.slice(0, 100), value: b.id })),
    );
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const b = creerSauvegarde(serveur, interaction.user.id);
      void journal(serveur, 'backup', {
        titre: 'Sauvegarde créée',
        ton: 'ok',
        lignes: [`**#${b.id}** · ${Math.round(b.size / 1024)} Ko`],
        fichiers: [new AttachmentBuilder(Buffer.from(JSON.stringify(b.data, null, 2)), { name: `sauvegarde-${serveur.id}-${b.id}.json` })],
        par: interaction.user,
      });
      return interaction.editReply({ embeds: [ok(serveur, `Sauvegarde **#${b.id}** créée (${Math.round(b.size / 1024)} Ko).\n-# Réglages, modules, whitelists, Twitch, rôles à choisir, commandes perso, auto-réponses, badges, boutique, formulaires et blacklist.`)] });
    }
    if (sousCommande === 'list') {
      const lignes = listerSauvegardes(serveur.id).map((b) => `**#${b.id}** · ${b.nom} · ${marqueTemps(b.cree_le, 'f')} · ${Math.round(b.taille / 1024)} Ko · <@${b.cree_par}>`);
      return repondre(interaction, { embeds: [info(serveur, lignes.join('\n') || 'Aucune sauvegarde.', { titre: 'Sauvegardes', sujet: '💾' })], ephemeral: true });
    }
    const id = interaction.options.getInteger('sauvegarde', true);
    if (!listerSauvegardes(serveur.id).some((b) => b.id === id)) throw new ErreurUtilisateur('Sauvegarde introuvable.');
    return demanderConfirmation(interaction, {
      titre: 'Restaurer la sauvegarde ?',
      description: `La configuration actuelle du bot sur ce serveur sera **remplacée** par la sauvegarde **#${id}**.\nUne sauvegarde de l’état actuel est créée juste avant. Les salons et rôles Discord ne sont pas modifiés.`,
      libelleConfirmation: 'Restaurer',
      surConfirmation: async (i) => {
        await i.update({ embeds: [info(serveur, 'Restauration en cours…')], components: [] });
        const securite = creerSauvegarde(serveur, i.user.id, 'avant restauration');
        const resultat = restaurerSauvegarde(serveur.id, id);
        oublierEnseignes();
        void journal(serveur, 'backup', { titre: 'Sauvegarde restaurée', ton: 'alerte', lignes: [`**#${id}** restaurée (${resultat.rows} élément(s))`, `Sauvegarde de sécurité : #${securite.id}`], par: i.user });
        await i.editReply({ embeds: [ok(serveur, `Sauvegarde **#${id}** restaurée (${resultat.rows} élément(s)).\n-# Sauvegarde de sécurité créée avant : **#${securite.id}**.`)] });
      },
    });
  },
};

export const moduleSauvegardes: ModuleBot = {
  id: 'backup',
  nom: 'Sauvegardes',
  emoji: '💾',
  description: 'Sauvegardes manuelles et quotidiennes de la configuration',
  desactivable: true,
  actifParDefaut: true,
  commandes: [sauvegarde],
  taches: [
    {
      nom: 'backup-daily',
      intervalleMs: 24 * 3_600_000,
      async executer(client) {
        for (const serveur of client.guilds.cache.values()) {
          if (!moduleActif(serveur.id, 'backup')) continue;
          try {
            creerSauvegarde(serveur, client.user.id, 'automatique');
            purgerSauvegardesAuto(serveur.id);
          } catch (echec) {
            registre.avertir(`Sauvegarde automatique ${serveur.id} en échec : ${(echec as Error).message}`);
          }
        }
      },
    },
  ],
};
