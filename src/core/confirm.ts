import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { warningEmbed } from './embeds';
import { handleInteractionError, reply } from './interactions';
import { shortId, TtlMap } from './sessions';
import type { ComponentHandler } from './types';

interface ConfirmSession {
  ownerId: string;
  onConfirm(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  onCancel?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

const sessions = new TtlMap<string, ConfirmSession>(2 * 60_000);

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  onConfirm(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
  onCancel?(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

/** Demande une confirmation avant une action dangereuse. Réponse éphémère. */
export async function askConfirmation(interaction: RepliableInteraction, options: ConfirmOptions): Promise<void> {
  const id = shortId();
  sessions.set(id, { ownerId: interaction.user.id, onConfirm: options.onConfirm, onCancel: options.onCancel });
  const embed = warningEmbed(
    interaction.guild,
    `${options.description ?? 'Cette action est irréversible.'}\n\n-# Cette demande expire dans 2 minutes.`,
    options.title ?? '⚠️ Êtes-vous sûr ?',
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cf:${id}:yes`).setLabel(options.confirmLabel ?? 'Confirmer').setEmoji('✅').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cf:${id}:no`).setLabel('Annuler').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );
  await reply(interaction, { embeds: [embed], components: [row], ephemeral: true });
}

export const confirmComponent: ComponentHandler = {
  prefix: 'cf',
  async button(interaction, [id, action]) {
    const session = id ? sessions.get(id) : undefined;
    if (!session) {
      await interaction.update({ content: '⌛ Cette confirmation a expiré.', embeds: [], components: [] }).catch(() => undefined);
      return;
    }
    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({ content: '🔒 Cette confirmation ne te concerne pas.', flags: MessageFlags.Ephemeral });
      return;
    }
    sessions.delete(id!);
    try {
      if (action === 'yes') await session.onConfirm(interaction);
      else if (session.onCancel) await session.onCancel(interaction);
      else await interaction.update({ content: '❌ Action annulée.', embeds: [], components: [] });
    } catch (err) {
      await handleInteractionError(interaction, err, 'confirmation');
    }
  },
};
