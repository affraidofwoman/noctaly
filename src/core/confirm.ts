import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { embedAvertissement } from './embeds';
import { traiterErreurInteraction, repondre } from './interactions';
import { idCourt, CarteExpirante } from './sessions';
import type { GestionnaireComposant } from './types';

interface SessionConfirmation {
  proprietaireId: string;
  surConfirmation(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  surAnnulation?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

const sessions = new CarteExpirante<string, SessionConfirmation>(2 * 60_000);

export interface OptionsConfirmation {
  titre?: string;
  description?: string;
  libelleConfirmation?: string;
  surConfirmation(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  surAnnulation?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

/** Demande une confirmation avant une action dangereuse. Réponse éphémère. */
export async function demanderConfirmation(interaction: RepliableInteraction, options: OptionsConfirmation): Promise<void> {
  const id = idCourt();
  sessions.ecrire(id, { proprietaireId: interaction.user.id, surConfirmation: options.surConfirmation, surAnnulation: options.surAnnulation });
  const embed = embedAvertissement(
    interaction.guild,
    `${options.description ?? 'Cette action est irréversible.'}\n\n-# Cette demande expire dans 2 minutes.`,
    options.titre ?? '⚠️ Êtes-vous sûr ?',
  );
  const rangee = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cf:${id}:yes`).setLabel(options.libelleConfirmation ?? 'Confirmer').setEmoji('✅').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cf:${id}:no`).setLabel('Annuler').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );
  await repondre(interaction, { embeds: [embed], components: [rangee], ephemeral: true });
}

export const composantConfirmation: GestionnaireComposant = {
  prefixe: 'cf',
  async bouton(interaction, [id, action]) {
    const session = id ? sessions.lire(id) : undefined;
    if (!session) {
      await interaction.update({ content: '⌛ Cette confirmation a expiré.', embeds: [], components: [] }).catch(() => undefined);
      return;
    }
    if (interaction.user.id !== session.proprietaireId) {
      await interaction.reply({ content: '🔒 Cette confirmation ne te concerne pas.', flags: MessageFlags.Ephemeral });
      return;
    }
    sessions.supprimer(id!);
    try {
      if (action === 'yes') await session.surConfirmation(interaction);
      else if (session.surAnnulation) await session.surAnnulation(interaction);
      else await interaction.update({ content: '❌ Action annulée.', embeds: [], components: [] });
    } catch (echec) {
      await traiterErreurInteraction(interaction, echec, 'confirmation');
    }
  },
};
