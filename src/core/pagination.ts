import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type EmbedBuilder,
  type RepliableInteraction,
} from 'discord.js';
import { reply } from './interactions';
import { shortId, TtlMap } from './sessions';
import type { ComponentHandler } from './types';

interface PaginationSession {
  ownerId: string;
  pages: EmbedBuilder[];
  index: number;
}

const sessions = new TtlMap<string, PaginationSession>(10 * 60_000);

function rows(id: string, session: PaginationSession) {
  const total = session.pages.length;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pg:${id}:prev`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(session.index === 0),
      new ButtonBuilder()
        .setCustomId(`pg:${id}:noop`)
        .setLabel(`${session.index + 1} / ${total}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder().setCustomId(`pg:${id}:next`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(session.index >= total - 1),
      new ButtonBuilder().setCustomId(`pg:${id}:close`).setEmoji('❌').setStyle(ButtonStyle.Danger),
    ),
  ];
}

/** Envoie une liste d'embeds paginée (boutons ⬅️ ➡️ ❌, réservés à l'auteur). */
export async function paginate(interaction: RepliableInteraction, pages: EmbedBuilder[], ephemeral = false): Promise<void> {
  if (pages.length === 0) return;
  if (pages.length === 1) {
    await reply(interaction, { embeds: [pages[0]!], components: [], ephemeral });
    return;
  }
  const id = shortId();
  const session: PaginationSession = { ownerId: interaction.user.id, pages, index: 0 };
  sessions.set(id, session);
  await reply(interaction, { embeds: [pages[0]!], components: rows(id, session), ephemeral });
}

/** Construit des pages à partir de lignes de texte. */
export function linesToPages(lines: string[], perPage: number, build: (content: string, page: number, total: number) => EmbedBuilder): EmbedBuilder[] {
  const total = Math.max(1, Math.ceil(lines.length / perPage));
  const pages: EmbedBuilder[] = [];
  for (let p = 0; p < total; p++) {
    pages.push(build(lines.slice(p * perPage, (p + 1) * perPage).join('\n'), p + 1, total));
  }
  return pages;
}

export const paginationComponent: ComponentHandler = {
  prefix: 'pg',
  async button(interaction: ButtonInteraction<'cached'>, [id, action]) {
    const session = id ? sessions.get(id) : undefined;
    if (!session) {
      await interaction.reply({ content: '⌛ Cette pagination a expiré. Relance la commande.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({ content: "🔒 Seule la personne ayant lancé la commande peut utiliser ces boutons.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'close') {
      sessions.delete(id!);
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.update({ components: [] });
      } else {
        await interaction.message.delete().catch(() => interaction.update({ components: [] }));
      }
      return;
    }
    if (action === 'prev') session.index = Math.max(0, session.index - 1);
    if (action === 'next') session.index = Math.min(session.pages.length - 1, session.index + 1);
    sessions.touch(id!);
    await interaction.update({ embeds: [session.pages[session.index]!], components: rows(id!, session) });
  },
};
