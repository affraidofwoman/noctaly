import {
  MessageFlags,
  type EmbedBuilder,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from 'discord.js';
import { erreur, ok } from './embeds';
import { describeDiscordError, GENERIC_ERROR, UserError } from './errors';
import { journal } from './logService';
import { createLogger } from './logger';

const log = createLogger('interaction');

type ReplyPayload = Omit<InteractionReplyOptions, 'flags'> & { ephemeral?: boolean };

/** Répond à une interaction quel que soit son état (déjà répondue, différée…). */
export async function reply(interaction: RepliableInteraction, payload: ReplyPayload): Promise<void> {
  const { ephemeral, ...rest } = payload;
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(rest as InteractionEditReplyOptions);
    } else if (interaction.replied) {
      await interaction.followUp({ ...rest, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    } else {
      await interaction.reply({ ...rest, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    }
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 10062 : interaction expirée, 40060 : déjà acquittée → rien à faire
    if (code !== 10062 && code !== 40060) log.warn('Réponse impossible', err);
  }
}

export function replyEmbed(interaction: RepliableInteraction, embed: EmbedBuilder, ephemeral = true): Promise<void> {
  return reply(interaction, { embeds: [embed], components: [], ephemeral });
}

export function replySuccess(interaction: RepliableInteraction, description: string, title?: string, ephemeral = true): Promise<void> {
  return replyEmbed(interaction, ok(interaction.guild, description, title ? { titre: title } : undefined), ephemeral);
}

export function replyError(interaction: RepliableInteraction, description: string, title?: string): Promise<void> {
  return replyEmbed(interaction, erreur(interaction.guild, description, title ? { titre: title } : undefined), true);
}

export async function deferEphemeral(interaction: RepliableInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

/** Transforme n'importe quelle erreur en message propre pour l'utilisateur. */
export async function handleInteractionError(interaction: RepliableInteraction, err: unknown, scope: string): Promise<void> {
  if (err instanceof UserError) {
    await replyError(interaction, err.message);
    return;
  }
  const discordMessage = describeDiscordError(err);
  if (discordMessage) {
    log.warn(`[${scope}] ${discordMessage}`);
    await replyError(interaction, discordMessage);
    return;
  }
  log.error(`[${scope}] Erreur non gérée`, err);
  if (interaction.guild) {
    // Le détail technique va au staff (#sante-log), jamais au membre.
    void journal(interaction.guild, 'health', {
      title: 'Erreur technique',
      tone: 'alerte',
      lines: [`**Où** : \`${scope}\``, `**Par** : <@${interaction.user.id}>`, `\`\`\`${String((err as Error)?.stack ?? err).slice(0, 1500)}\`\`\``],
    });
  }
  await replyError(interaction, `Une erreur est survenue.\n${GENERIC_ERROR}`);
}
