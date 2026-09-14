import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { askConfirmation } from '../../core/confirm';
import { info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { reply } from '../../core/interactions';
import { journal } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import { ts } from '../../core/time';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { forgetBrands } from '../../core/brand';
import { createBackup, listBackups, pruneAutoBackups, restoreBackup } from '../../services/backup';

const log = createLogger('sauvegarde');

const backup: SlashCommand = {
  category: 'admin',
  level: PermLevel.STREAMER,
  data: new SlashCommandBuilder()
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
  subLevels: { list: PermLevel.ADMIN, create: PermLevel.ADMIN },
  async autocomplete(interaction) {
    await interaction.respond(
      listBackups(interaction.guildId).map((b) => ({ name: `#${b.id} · ${b.name} · ${new Date(b.created_at).toLocaleString('fr-FR')} · ${Math.round(b.size / 1024)} Ko`.slice(0, 100), value: b.id })),
    );
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const b = createBackup(guild, interaction.user.id);
      void journal(guild, 'backup', {
        title: 'Sauvegarde créée',
        tone: 'ok',
        lines: [`**#${b.id}** · ${Math.round(b.size / 1024)} Ko`],
        files: [new AttachmentBuilder(Buffer.from(JSON.stringify(b.data, null, 2)), { name: `sauvegarde-${guild.id}-${b.id}.json` })],
        by: interaction.user,
      });
      return interaction.editReply({ embeds: [ok(guild, `Sauvegarde **#${b.id}** créée (${Math.round(b.size / 1024)} Ko).\n-# Réglages, modules, whitelists, Twitch, rôles à choisir, commandes perso, auto-réponses, badges, boutique, formulaires et blacklist.`)] });
    }
    if (sub === 'list') {
      const lines = listBackups(guild.id).map((b) => `**#${b.id}** · ${b.name} · ${ts(b.created_at, 'f')} · ${Math.round(b.size / 1024)} Ko · <@${b.created_by}>`);
      return reply(interaction, { embeds: [info(guild, lines.join('\n') || 'Aucune sauvegarde.', { titre: 'Sauvegardes', sujet: '💾' })], ephemeral: true });
    }
    const id = interaction.options.getInteger('sauvegarde', true);
    if (!listBackups(guild.id).some((b) => b.id === id)) throw new UserError('Sauvegarde introuvable.');
    return askConfirmation(interaction, {
      title: 'Restaurer la sauvegarde ?',
      description: `La configuration actuelle du bot sur ce serveur sera **remplacée** par la sauvegarde **#${id}**.\nUne sauvegarde de l’état actuel est créée juste avant. Les salons et rôles Discord ne sont pas modifiés.`,
      confirmLabel: 'Restaurer',
      onConfirm: async (i) => {
        await i.update({ embeds: [info(guild, 'Restauration en cours…')], components: [] });
        const safety = createBackup(guild, i.user.id, 'avant restauration');
        const result = restoreBackup(guild.id, id);
        forgetBrands();
        void journal(guild, 'backup', { title: 'Sauvegarde restaurée', tone: 'alerte', lines: [`**#${id}** restaurée (${result.rows} élément(s))`, `Sauvegarde de sécurité : #${safety.id}`], by: i.user });
        await i.editReply({ embeds: [ok(guild, `Sauvegarde **#${id}** restaurée (${result.rows} élément(s)).\n-# Sauvegarde de sécurité créée avant : **#${safety.id}**.`)] });
      },
    });
  },
};

export const backupModule: BotModule = {
  id: 'backup',
  name: 'Sauvegardes',
  emoji: '💾',
  description: 'Sauvegardes manuelles et quotidiennes de la configuration',
  toggleable: true,
  defaultEnabled: true,
  commands: [backup],
  tasks: [
    {
      name: 'backup-daily',
      intervalMs: 24 * 3_600_000,
      async run(client) {
        for (const guild of client.guilds.cache.values()) {
          if (!isModuleEnabled(guild.id, 'backup')) continue;
          try {
            createBackup(guild, client.user.id, 'automatique');
            pruneAutoBackups(guild.id);
          } catch (err) {
            log.warn(`Sauvegarde automatique ${guild.id} en échec : ${(err as Error).message}`);
          }
        }
      },
    },
  ],
};
