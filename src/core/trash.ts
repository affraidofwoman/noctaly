import { ButtonStyle, MessageFlags } from 'discord.js';
import { emojiPour } from './brand';
import { info } from './embeds';
import { aNiveau } from './permissions';
import { bouton, rangee } from './ui';
import { Niveau, type GestionnaireComposant } from './types';

/** Bouton corbeille (comme sur Airline) : supprime le message, réservé à son auteur ou au staff. */
export function rangeeCorbeille(serveurId: string | null, proprietaireId: string) {
  return rangee(bouton(`del:${proprietaireId}`, '', ButtonStyle.Secondary, emojiPour(serveurId, 'corbeille')));
}

export function boutonCorbeille(serveurId: string | null, proprietaireId: string) {
  return bouton(`del:${proprietaireId}`, '', ButtonStyle.Secondary, emojiPour(serveurId, 'corbeille'));
}

export const composantCorbeille: GestionnaireComposant = {
  prefixe: 'del',
  async bouton(interaction, [proprietaireId]) {
    const proprietaire = proprietaireId ?? interaction.message.interactionMetadata?.user.id ?? null;
    if (proprietaire && interaction.user.id !== proprietaire && !aNiveau(interaction.member, Niveau.MODERATEUR)) {
      await interaction.reply({
        embeds: [info(interaction.guild, 'Ce message appartient à la personne qui l’a ouvert.', { emoji: emojiPour(interaction.guildId, 'refus') })],
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
