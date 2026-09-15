import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type EmbedBuilder,
  type RepliableInteraction,
} from 'discord.js';
import { repondre } from './interactions';
import { idCourt, CarteExpirante } from './sessions';
import type { GestionnaireComposant } from './types';

interface SessionPagination {
  proprietaireId: string;
  pages: EmbedBuilder[];
  indice: number;
}

const sessions = new CarteExpirante<string, SessionPagination>(10 * 60_000);

function rangees(id: string, session: SessionPagination) {
  const total = session.pages.length;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pg:${id}:prev`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(session.indice === 0),
      new ButtonBuilder()
        .setCustomId(`pg:${id}:noop`)
        .setLabel(`${session.indice + 1} / ${total}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder().setCustomId(`pg:${id}:next`).setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(session.indice >= total - 1),
      new ButtonBuilder().setCustomId(`pg:${id}:close`).setEmoji('❌').setStyle(ButtonStyle.Danger),
    ),
  ];
}

/** Envoie une liste d'embeds paginée (boutons ⬅️ ➡️ ❌, réservés à l'auteur). */
export async function paginer(interaction: RepliableInteraction, pages: EmbedBuilder[], prive = false): Promise<void> {
  if (pages.length === 0) return;
  if (pages.length === 1) {
    await repondre(interaction, { embeds: [pages[0]!], components: [], ephemeral: prive });
    return;
  }
  const id = idCourt();
  const session: SessionPagination = { proprietaireId: interaction.user.id, pages, indice: 0 };
  sessions.ecrire(id, session);
  await repondre(interaction, { embeds: [pages[0]!], components: rangees(id, session), ephemeral: prive });
}

/** Construit des pages à partir de lignes de texte. */
export function lignesEnPages(lignes: string[], parPage: number, construire: (contenu: string, page: number, total: number) => EmbedBuilder): EmbedBuilder[] {
  const total = Math.max(1, Math.ceil(lignes.length / parPage));
  const pages: EmbedBuilder[] = [];
  for (let p = 0; p < total; p++) {
    pages.push(construire(lignes.slice(p * parPage, (p + 1) * parPage).join('\n'), p + 1, total));
  }
  return pages;
}

export const composantPagination: GestionnaireComposant = {
  prefixe: 'pg',
  async bouton(interaction: ButtonInteraction<'cached'>, [id, action]) {
    const session = id ? sessions.lire(id) : undefined;
    if (!session) {
      await interaction.reply({ content: '⌛ Cette pagination a expiré. Relance la commande.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== session.proprietaireId) {
      await interaction.reply({ content: "🔒 Seule la personne ayant lancé la commande peut utiliser ces boutons.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'close') {
      sessions.supprimer(id!);
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.update({ components: [] });
      } else {
        await interaction.message.delete().catch(() => interaction.update({ components: [] }));
      }
      return;
    }
    if (action === 'prev') session.indice = Math.max(0, session.indice - 1);
    if (action === 'next') session.indice = Math.min(session.pages.length - 1, session.indice + 1);
    sessions.prolonger(id!);
    await interaction.update({ embeds: [session.pages[session.indice]!], components: rangees(id!, session) });
  },
};
