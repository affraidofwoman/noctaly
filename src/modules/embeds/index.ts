import { SlashCommandBuilder } from 'discord.js';
import { ErreurUtilisateur } from '../../core/errors';
import { repondre } from '../../core/interactions';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { affichageEditeur, nouveauBrouillon, surBoutonRedaction, surFenetreRedaction, surMenuRedaction, stockerBrouillon } from '../../services/embedBuilder';

const embed: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Créer ou modifier un embed')
    .addSubcommand((s) => s.setName('create').setDescription('Créer un embed pas à pas'))
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Modifier un embed envoyé par le bot')
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message (clic droit → Copier le lien)').setRequired(true)),
    ),
  async executer(interaction) {
    const serveur = interaction.guild;
    const brouillon = nouveauBrouillon(serveur, interaction.user.id, 'embed');
    if (interaction.options.getSubcommand() === 'edit') {
      const m = /channels\/(\d+)\/(\d+)\/(\d+)/.exec(interaction.options.getString('lien', true));
      if (!m || m[1] !== serveur.id) throw new ErreurUtilisateur('Lien de message invalide (il doit venir de ce serveur).');
      const salon = serveur.channels.cache.get(m[2]!);
      const message = salon?.isTextBased() ? await salon.messages.fetch(m[3]!).catch(() => null) : null;
      if (!message) throw new ErreurUtilisateur('Message introuvable.');
      if (message.author.id !== interaction.client.user.id) throw new ErreurUtilisateur('Je ne peux modifier que mes propres messages.');
      const source = message.embeds[0];
      Object.assign(brouillon, {
        title: source?.title ?? '',
        description: source?.description ?? '',
        color: source?.color ?? brouillon.couleur,
        url: source?.url ?? '',
        authorName: source?.author?.name ?? '',
        authorIcon: source?.author?.iconURL ?? '',
        footer: source?.footer?.text ?? '',
        image: source?.image?.url ?? '',
        thumbnail: source?.thumbnail?.url ?? '',
        timestamp: !!source?.timestamp,
        fields: source?.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })) ?? [],
        content: message.content,
        editMessage: { channelId: salon!.id, messageId: message.id },
      });
      stockerBrouillon(brouillon);
    }
    await repondre(interaction, { ...affichageEditeur(serveur, brouillon), ephemeral: true });
  },
};

export const moduleRedaction: ModuleBot = {
  id: 'embeds',
  nom: 'Embed builder',
  emoji: '📦',
  description: 'Créer et modifier des embeds au clic',
  desactivable: true,
  actifParDefaut: true,
  commandes: [embed],
  composants: [
    {
      prefixe: 'eb',
      niveau: Niveau.STAFF,
      bouton: (i, parametres) => surBoutonRedaction(i, parametres),
      menu: (i, parametres) => surMenuRedaction(i, parametres),
      fenetre: (i, parametres) => surFenetreRedaction(i, parametres),
    },
  ],
};
