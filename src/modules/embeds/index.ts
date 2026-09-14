import { SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../core/errors';
import { reply } from '../../core/interactions';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { editorPayload, newDraft, onBuilderButton, onBuilderModal, onBuilderSelect, storeDraft } from '../../services/embedBuilder';

const embed: SlashCommand = {
  category: 'customization',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Créer ou modifier un embed')
    .addSubcommand((s) => s.setName('create').setDescription('Créer un embed pas à pas'))
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Modifier un embed envoyé par le bot')
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message (clic droit → Copier le lien)').setRequired(true)),
    ),
  async execute(interaction) {
    const guild = interaction.guild;
    const draft = newDraft(guild, interaction.user.id, 'embed');
    if (interaction.options.getSubcommand() === 'edit') {
      const m = /channels\/(\d+)\/(\d+)\/(\d+)/.exec(interaction.options.getString('lien', true));
      if (!m || m[1] !== guild.id) throw new UserError('Lien de message invalide (il doit venir de ce serveur).');
      const channel = guild.channels.cache.get(m[2]!);
      const message = channel?.isTextBased() ? await channel.messages.fetch(m[3]!).catch(() => null) : null;
      if (!message) throw new UserError('Message introuvable.');
      if (message.author.id !== interaction.client.user.id) throw new UserError('Je ne peux modifier que mes propres messages.');
      const source = message.embeds[0];
      Object.assign(draft, {
        title: source?.title ?? '',
        description: source?.description ?? '',
        color: source?.color ?? draft.color,
        url: source?.url ?? '',
        authorName: source?.author?.name ?? '',
        authorIcon: source?.author?.iconURL ?? '',
        footer: source?.footer?.text ?? '',
        image: source?.image?.url ?? '',
        thumbnail: source?.thumbnail?.url ?? '',
        timestamp: !!source?.timestamp,
        fields: source?.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })) ?? [],
        content: message.content,
        editMessage: { channelId: channel!.id, messageId: message.id },
      });
      storeDraft(draft);
    }
    await reply(interaction, { ...editorPayload(guild, draft), ephemeral: true });
  },
};

export const embedsModule: BotModule = {
  id: 'embeds',
  name: 'Embed builder',
  emoji: '📦',
  description: 'Créer et modifier des embeds au clic',
  toggleable: true,
  defaultEnabled: true,
  commands: [embed],
  components: [
    {
      prefix: 'eb',
      level: PermLevel.STAFF,
      button: (i, args) => onBuilderButton(i, args),
      select: (i, args) => onBuilderSelect(i, args),
      modal: (i, args) => onBuilderModal(i, args),
    },
  ],
};
