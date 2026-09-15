import {
  MessageFlags,
  type EmbedBuilder,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from 'discord.js';
import { erreur, ok } from './embeds';
import { decrireErreurDiscord, ERREUR_GENERIQUE, ErreurUtilisateur } from './errors';
import { journal } from './logService';
import { creerRegistre } from './logger';

const registre = creerRegistre('interaction');

type ChargeReponse = Omit<InteractionReplyOptions, 'flags'> & { ephemeral?: boolean };

/** Répond à une interaction quel que soit son état (déjà répondue, différée…). */
export async function repondre(interaction: RepliableInteraction, charge: ChargeReponse): Promise<void> {
  const { ephemeral: prive, ...reste } = charge;
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(reste as InteractionEditReplyOptions);
    } else if (interaction.replied) {
      await interaction.followUp({ ...reste, flags: prive ? MessageFlags.Ephemeral : undefined });
    } else {
      await interaction.reply({ ...reste, flags: prive ? MessageFlags.Ephemeral : undefined });
    }
  } catch (echec) {
    const code = (echec as { code?: number }).code;
    // 10062 : interaction expirée, 40060 : déjà acquittée → rien à faire
    if (code !== 10062 && code !== 40060) registre.avertir('Réponse impossible', echec);
  }
}

export function repondreEmbed(interaction: RepliableInteraction, embed: EmbedBuilder, prive = true): Promise<void> {
  return repondre(interaction, { embeds: [embed], components: [], ephemeral: prive });
}

export function repondreSucces(interaction: RepliableInteraction, description: string, titre?: string, prive = true): Promise<void> {
  return repondreEmbed(interaction, ok(interaction.guild, description, titre ? { titre } : undefined), prive);
}

export function repondreErreur(interaction: RepliableInteraction, description: string, titre?: string): Promise<void> {
  return repondreEmbed(interaction, erreur(interaction.guild, description, titre ? { titre } : undefined), true);
}

export async function differerPrive(interaction: RepliableInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

/** Transforme n'importe quelle erreur en message propre pour l'utilisateur. */
export async function traiterErreurInteraction(interaction: RepliableInteraction, echec: unknown, portee: string): Promise<void> {
  if (echec instanceof ErreurUtilisateur) {
    await repondreErreur(interaction, echec.message);
    return;
  }
  const messageDiscord = decrireErreurDiscord(echec);
  if (messageDiscord) {
    registre.avertir(`[${portee}] ${messageDiscord}`);
    await repondreErreur(interaction, messageDiscord);
    return;
  }
  registre.erreur(`[${portee}] Erreur non gérée`, echec);
  if (interaction.guild) {
    // Le détail technique va au staff (#sante-log), jamais au membre.
    void journal(interaction.guild, 'health', {
      titre: 'Erreur technique',
      ton: 'alerte',
      lignes: [`**Où** : \`${portee}\``, `**Par** : <@${interaction.user.id}>`, `\`\`\`${String((echec as Error)?.stack ?? echec).slice(0, 1500)}\`\`\``],
    });
  }
  await repondreErreur(interaction, `Une erreur est survenue.\n${ERREUR_GENERIQUE}`);
}
