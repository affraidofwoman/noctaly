import { ButtonStyle, MessageFlags } from 'discord.js';
import { emojiFor } from './brand';
import { info } from './embeds';
import { hasLevel } from './permissions';
import { button, row } from './ui';
import { PermLevel, type ComponentHandler } from './types';

/** Bouton corbeille (comme sur Airline) : supprime le message, réservé à son auteur ou au staff. */
export function trashRow(guildId: string | null, ownerId: string) {
  return row(button(`del:${ownerId}`, '', ButtonStyle.Secondary, emojiFor(guildId, 'corbeille')));
}

export function trashButton(guildId: string | null, ownerId: string) {
  return button(`del:${ownerId}`, '', ButtonStyle.Secondary, emojiFor(guildId, 'corbeille'));
}

export const trashComponent: ComponentHandler = {
  prefix: 'del',
  async button(interaction, [ownerId]) {
    const owner = ownerId ?? interaction.message.interactionMetadata?.user.id ?? null;
    if (owner && interaction.user.id !== owner && !hasLevel(interaction.member, PermLevel.MODERATOR)) {
      await interaction.reply({
        embeds: [info(interaction.guild, 'Ce message appartient à la personne qui l’a ouvert.', { emoji: emojiFor(interaction.guildId, 'refus') })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    await interaction.message.delete().catch(async () => {
      await interaction.editReply({ components: [] }).catch(() => undefined);
    });
  },
};
