import { SlashCommandBuilder } from 'discord.js';
import { getConfig } from '../../core/guildConfig';
import type { SetupPage } from '../../core/setup';
import { toHex } from '../../core/brand';
import { buildModal } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { newDraft, onBuilderButton, onBuilderModal, onBuilderSelect, storeDraft } from '../../services/embedBuilder';

const announce: SlashCommand = {
  category: 'customization',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder().setName('announce').setDescription('Rédiger une annonce avec aperçu'),
  async execute(interaction) {
    const draft = newDraft(interaction.guild, interaction.user.id, 'announce');
    draft.channelId = getConfig(interaction.guildId).announcements.defaultChannelId;
    storeDraft(draft);
    const defaultButton = draft.buttons[0] ? `${draft.buttons[0].label} | ${draft.buttons[0].url}` : '';
    await interaction.showModal(
      buildModal(`an:announcem:${draft.id}`, 'Nouvelle annonce', [
        { id: 'title', label: 'Titre', value: '📢 NOUVELLE ANNONCE', maxLength: 256, placeholder: '🎮 STREAM CE SOIR !' },
        { id: 'message', label: 'Message', long: true, maxLength: 4000, placeholder: 'Rendez-vous à 21h !' },
        { id: 'image', label: 'Image (lien, facultatif)', required: false, maxLength: 500 },
        { id: 'color', label: 'Couleur (facultatif)', required: false, value: toHex(draft.color), maxLength: 30 },
        { id: 'button', label: 'Bouton « Texte | lien » (facultatif)', required: false, value: defaultButton, maxLength: 300 },
      ]),
    );
  },
};

const setupPage: SetupPage = {
  id: 'announcements',
  section: 'community',
  title: 'Annonces',
  emoji: '📣',
  moduleId: 'announcements',
  order: 7,
  description: '`/announce` ouvre un formulaire, montre l’aperçu, puis publie (et diffuse automatiquement dans un salon d’annonces).',
  fields: [{ kind: 'channel', key: 'channel', label: 'Salon des annonces par défaut', get: (c) => c.announcements.defaultChannelId, set: (c, v) => void (c.announcements.defaultChannelId = v) }],
};

export const announcementsModule: BotModule = {
  id: 'announcements',
  name: 'Annonces',
  emoji: '📣',
  description: 'Générateur d’annonces avec aperçu avant publication',
  toggleable: true,
  defaultEnabled: true,
  commands: [announce],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'an',
      level: PermLevel.STAFF,
      button: (i, args) => onBuilderButton(i, args),
      select: (i, args) => onBuilderSelect(i, args),
      modal: (i, args) => onBuilderModal(i, args),
    },
  ],
};
