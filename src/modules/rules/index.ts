import { ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, SlashCommandBuilder, type GuildTextBasedChannel } from 'discord.js';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { botPeutGererRole } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { bouton, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { executer } from '../../database/db';

function panneauBoutons(serveur: import('discord.js').Guild) {
  const reglages = lireConfig(serveur.id).reglement;
  const embed = new EmbedBuilder().setColor(couleurPour(serveur)).setTitle(tronquer(reglages.title, 256));
  for (const s of reglages.sections.slice(0, 25)) embed.addFields({ name: tronquer(s.title, 256), value: tronquer(s.content, 1024), inline: false });
  embed.setFooter({ text: `${serveur.name} · en restant ici, tu acceptes ces règles` });
  return { embeds: [embed], components: reglages.roleAcceptationId ? [rangee(bouton('rules:accept', 'J’accepte le règlement', ButtonStyle.Success, '✅'))] : [] };
}

/** Sections éditables en texte : « ## Titre » puis le contenu, répété. */
export function lireSections(saisie: string): { title: string; content: string }[] {
  const sortie: { title: string; content: string }[] = [];
  for (const groupe of saisie.split(/^##\s*/m).map((b) => b.trim()).filter(Boolean)) {
    const [titre, ...reste] = groupe.split('\n');
    const contenu = reste.join('\n').trim();
    if (titre && contenu) sortie.push({ title: titre.trim(), content: contenu });
  }
  return sortie.slice(0, 25);
}

const reglement: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Le panneau du règlement')
    .addChannelOption((o) => o.setName('salon').setDescription('Où le poster (salon réglé par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async executer(interaction) {
    const reglages = lireConfig(interaction.guildId).reglement;
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(interaction.guild, reglages.channelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const envoye = await salon.send(panneauBoutons(interaction.guild));
    await repondre(interaction, { embeds: [ok(interaction.guild, `Règlement posté : ${envoye.url}${reglages.roleAcceptationId ? '' : '\n-# Aucun rôle d’acceptation réglé : le bouton n’apparaît pas.'}`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'rules',
  section: 'security',
  titre: 'Règlement',
  emoji: '📜',
  moduleId: 'rules',
  ordre: 1,
  description: 'Le panneau `/rules` avec un bouton « J’accepte » qui donne le rôle membre.\n-# Sections : une ligne `## Titre` puis le texte, répété.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon du règlement', lire: (c) => c.reglement.channelId, ecrire: (c, v) => void (c.reglement.channelId = v) },
    { genre: 'role', cle: 'accept', libelle: 'Rôle donné en acceptant', attribuable: true, lire: (c) => c.reglement.roleAcceptationId, ecrire: (c, v) => void (c.reglement.roleAcceptationId = v) },
    { genre: 'role', cle: 'remove', libelle: 'Rôle retiré en acceptant', attribuable: true, lire: (c) => c.reglement.roleRetireId, ecrire: (c, v) => void (c.reglement.roleRetireId = v) },
    { genre: 'text', cle: 'title', libelle: 'Titre', longueurMax: 200, obligatoire: true, lire: (c) => c.reglement.title, ecrire: (c, v) => void (c.reglement.title = v) },
    {
      genre: 'text',
      cle: 'sections',
      libelle: 'Sections',
      long: true,
      longueurMax: 4000,
      obligatoire: true,
      lire: (c) => c.reglement.sections.map((s) => `## ${s.title}\n${s.content}`).join('\n\n'),
      ecrire: (c, v) => void (c.reglement.sections = lireSections(v)),
      validate: (v) => (lireSections(v).length ? null : 'Au moins une section : `## Titre` puis le texte.'),
    },
  ],
};

export const moduleReglement: ModuleBot = {
  id: 'rules',
  nom: 'Règlement',
  emoji: '📜',
  description: 'Panneau de règlement avec acceptation',
  desactivable: true,
  actifParDefaut: true,
  commandes: [reglement],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'rules',
      async bouton(interaction) {
        const reglages = lireConfig(interaction.guildId).reglement;
        const serveur = interaction.guild;
        const role = reglages.roleAcceptationId ? serveur.roles.cache.get(reglages.roleAcceptationId) : null;
        if (!role || !botPeutGererRole(serveur, role)) throw new ErreurUtilisateur('Le rôle du règlement n’est pas utilisable. Préviens le staff.');
        if (interaction.member.roles.cache.has(role.id)) {
          await interaction.reply({ embeds: [ok(serveur, 'Tu as déjà accepté le règlement. Merci ! 💜')], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.member.roles.add(role, 'Règlement accepté');
        const retirer = reglages.roleRetireId ? serveur.roles.cache.get(reglages.roleRetireId) : null;
        if (retirer && botPeutGererRole(serveur, retirer)) await interaction.member.roles.remove(retirer, 'Règlement accepté').catch(() => undefined);
        executer('INSERT OR IGNORE INTO membres (serveur_id, utilisateur_id, vu_le) VALUES (?, ?, ?)', serveur.id, interaction.user.id, Date.now());
        void journal(serveur, 'autorole', { titre: 'Règlement accepté', ton: 'ok', lignes: [`<@${interaction.user.id}> a reçu <@&${role.id}>`] });
        await interaction.reply({ embeds: [ok(serveur, `Merci ! Tu as maintenant accès au serveur avec le rôle <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
