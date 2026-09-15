import {
  ChannelType,
  GuildMember,
  SlashCommandBuilder,
  version as djsVersion,
  type Guild,
  type User,
} from 'discord.js';
import { etatBot } from '../../core/bot';
import { embedEnseigne, nomEnseigne, info } from '../../core/embeds';
import { repondre } from '../../core/interactions';
import { lireNiveau, libelleNiveau } from '../../core/permissions';
import { resoudreUtilisateur, membreCible } from '../../core/resolve';
import { formaterNombre, tronquer } from '../../core/text';
import { formaterDuree, marqueTemps } from '../../core/time';
import { rangeeCorbeille } from '../../core/trash';
import { sur, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { crediterVocal, traiterEtatVocal, resynchroniserVocal } from '../../services/voice';
import { whitelistsMembre } from '../../core/whitelists';
import { accueilAide, surMenuAide } from './help';

function embedInfoMembre(serveur: Guild, utilisateur: User, membre: GuildMember | null) {
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`👤 ${membre?.displayName ?? utilisateur.displayName}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Utilisateur', value: `${utilisateur}\n\`${utilisateur.id}\``, inline: true },
      { name: 'Compte créé', value: `${marqueTemps(utilisateur.createdTimestamp, 'D')}\n${marqueTemps(utilisateur.createdTimestamp, 'R')}`, inline: true },
    );
  if (membre) {
    const roles = membre.roles.cache
      .filter((r) => r.id !== serveur.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.toString());
    const whitelistsListe = whitelistsMembre(utilisateur.id, serveur.id);
    embed.addFields(
      { name: 'Arrivée', value: membre.joinedTimestamp ? `${marqueTemps(membre.joinedTimestamp, 'D')}\n${marqueTemps(membre.joinedTimestamp, 'R')}` : '—', inline: true },
      { name: 'Accès bot', value: libelleNiveau(lireNiveau(membre)), inline: true },
      { name: 'Whitelists', value: whitelistsListe.length ? whitelistsListe.map((w) => `${w.emoji} ${w.libelle}`).join(' · ') : '—', inline: true },
      { name: 'Booster', value: membre.premiumSinceTimestamp ? `depuis ${marqueTemps(membre.premiumSinceTimestamp, 'R')}` : 'Non', inline: true },
      { name: `Rôles (${roles.length})`, value: roles.length ? tronquer(roles.join(' '), 1024) : '—', inline: false },
    );
    if (membre.displayColor) embed.setColor(membre.displayColor);
  }
  if (utilisateur.bot) embed.setDescription('🤖 Ce compte est un bot.');
  const banniere = utilisateur.bannerURL({ size: 1024 });
  if (banniere) embed.setImage(banniere);
  return embed;
}

function embedInfoServeur(serveur: Guild) {
  const salons = serveur.channels.cache;
  const texte = salons.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).size;
  const vocal = salons.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).size;
  return embedEnseigne(serveur)
    .setTitle(`🏠 ${serveur.name}`)
    .setThumbnail(serveur.iconURL({ size: 256 }))
    .setImage(serveur.bannerURL({ size: 1024 }))
    .addFields(
      { name: 'Propriétaire', value: `<@${serveur.ownerId}>`, inline: true },
      { name: 'Enseigne', value: nomEnseigne(serveur), inline: true },
      { name: 'Création', value: marqueTemps(serveur.createdTimestamp, 'D'), inline: true },
      { name: 'Membres', value: formaterNombre(serveur.memberCount), inline: true },
      { name: 'Salons', value: `${texte} textuels · ${vocal} vocaux`, inline: true },
      { name: 'Rôles', value: String(serveur.roles.cache.size - 1), inline: true },
      { name: 'Boosts', value: `${serveur.premiumSubscriptionCount ?? 0} (niveau ${serveur.premiumTier})`, inline: true },
      { name: 'Émojis', value: String(serveur.emojis.cache.size), inline: true },
      { name: 'ID', value: `\`${serveur.id}\``, inline: true },
    );
}

async function embedImage(serveur: Guild, utilisateur: User, membre: GuildMember | null, genre: 'avatar' | 'banner') {
  if (genre === 'banner') {
    const complet = await utilisateur.fetch(true).catch(() => utilisateur);
    const url = complet.bannerURL({ size: 2048 });
    if (!url) return info(serveur, `**${utilisateur.displayName}** n’a pas de bannière.`);
    return embedEnseigne(serveur).setTitle(`Bannière de ${utilisateur.displayName}`).setURL(url).setImage(url);
  }
  const urlGlobale = utilisateur.displayAvatarURL({ size: 2048 });
  const urlServeur = membre?.avatarURL({ size: 2048 }) ?? null;
  return embedEnseigne(serveur)
    .setTitle(`Photo de profil de ${utilisateur.displayName}`)
    .setURL(urlServeur ?? urlGlobale)
    .setImage(urlServeur ?? urlGlobale)
    .setDescription([`[Globale](${urlGlobale})`, urlServeur ? `[Serveur](${urlServeur})` : null].filter(Boolean).join(' · '));
}

const aide: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder().setName('help').setDescription('Tes commandes'),
  async executer(interaction) {
    await repondre(interaction, accueilAide(interaction.member));
  },
};

const ping: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder().setName('ping').setDescription('La latence du bot'),
  async executer(interaction) {
    const ws = interaction.client.ws.ping;
    const embed = embedEnseigne(interaction.guild)
      .setTitle('🏓 Pong')
      .setDescription(
        [`• Latence — **${ws >= 0 ? `${ws} ms` : '—'}**`, `• En ligne depuis — **${formaterDuree(Date.now() - etatBot.debutLe)}**`].join('\n'),
      );
    await repondre(interaction, { embeds: [embed], ephemeral: true });
  },
};

const avatar: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Photo de profil ou bannière')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addStringOption((o) =>
      o.setName('type').setDescription('Quoi').addChoices({ name: 'Photo de profil', value: 'avatar' }, { name: 'Bannière', value: 'banner' }),
    ),
  async executer(interaction) {
    const utilisateur = interaction.options.getUser('membre') ?? interaction.user;
    const membre = interaction.options.getMember('membre') ?? (utilisateur.id === interaction.user.id ? interaction.member : null);
    const genre = (interaction.options.getString('type') ?? 'avatar') as 'avatar' | 'banner';
    const embed = await embedImage(interaction.guild, utilisateur, membre instanceof GuildMember ? membre : null, genre);
    await repondre(interaction, { embeds: [embed], components: [rangeeCorbeille(interaction.guildId, interaction.user.id)] });
  },
};

const infoMembre: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Fiche d’un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async executer(interaction) {
    const utilisateur = await (interaction.options.getUser('membre') ?? interaction.user).fetch();
    const membre = interaction.options.getMember('membre') ?? (utilisateur.id === interaction.user.id ? interaction.member : null);
    await repondre(interaction, {
      embeds: [embedInfoMembre(interaction.guild, utilisateur, membre instanceof GuildMember ? membre : null)],
      components: [rangeeCorbeille(interaction.guildId, interaction.user.id)],
    });
  },
};

const infoServeur: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder().setName('serverinfo').setDescription('Fiche du serveur'),
  async executer(interaction) {
    await repondre(interaction, { embeds: [embedInfoServeur(interaction.guild)], components: [rangeeCorbeille(interaction.guildId, interaction.user.id)] });
  },
};

const infoBot: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder().setName('botinfo').setDescription('Le bot en chiffres'),
  async executer(interaction) {
    const client = interaction.client;
    const memoire = process.memoryUsage();
    const embed = embedEnseigne(interaction.guild)
      .setTitle('🤖 Le bot')
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription(
        [
          `• Serveurs — **${formaterNombre(client.guilds.cache.size)}**`,
          `• En ligne depuis — **${formaterDuree(Date.now() - etatBot.debutLe)}**`,
          `• Latence — **${client.ws.ping} ms**`,
          `• Mémoire — **${Math.round(memoire.rss / 1024 / 1024)} Mo**`,
          `• Node.js — **${process.version}** · discord.js **v${djsVersion}**`,
        ].join('\n'),
      );
    await repondre(interaction, { embeds: [embed], ephemeral: true });
  },
};

async function membreDuPrefixe(message: import('discord.js').Message<true>, argument: string | undefined) {
  const membre = await membreCible(message, argument);
  if (membre) return { user: membre.user, member: membre };
  const utilisateur = (await resoudreUtilisateur(message.client, argument)) ?? message.author;
  const membreSecours = utilisateur.id === message.author.id ? message.member : null;
  return { user: utilisateur, member: membreSecours };
}

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'help',
    domaine: 'general',
    categorie: 'general',
    description: 'Tes commandes',
    async executer(message) {
      if (!message.member) return;
      await message.reply({ ...accueilAide(message.member), allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'ui',
    alias: ['userinfo'],
    domaine: 'general',
    categorie: 'general',
    description: 'Fiche d’un membre',
    usage: '[membre]',
    async executer(message, parametres) {
      const { user: utilisateur, member: membre } = await membreDuPrefixe(message, parametres[0]);
      await message.reply({ embeds: [embedInfoMembre(message.guild, utilisateur, membre)], components: [rangeeCorbeille(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'si',
    alias: ['serverinfo'],
    domaine: 'general',
    categorie: 'general',
    description: 'Fiche du serveur',
    async executer(message) {
      await message.reply({ embeds: [embedInfoServeur(message.guild)], components: [rangeeCorbeille(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'pic',
    alias: ['avatar', 'pp'],
    domaine: 'sanction',
    categorie: 'general',
    description: 'Photo de profil',
    usage: '[membre]',
    async executer(message, parametres) {
      const { user: utilisateur, member: membre } = await membreDuPrefixe(message, parametres[0]);
      await message.reply({ embeds: [await embedImage(message.guild, utilisateur, membre, 'avatar')], components: [rangeeCorbeille(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'banner',
    domaine: 'sanction',
    categorie: 'general',
    description: 'Bannière',
    usage: '[membre]',
    async executer(message, parametres) {
      const { user: utilisateur, member: membre } = await membreDuPrefixe(message, parametres[0]);
      await message.reply({ embeds: [await embedImage(message.guild, utilisateur, membre, 'banner')], components: [rangeeCorbeille(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'ping',
    domaine: 'general',
    categorie: 'general',
    description: 'La latence du bot',
    async executer(message) {
      await message.reply({ embeds: [info(message.guild, `Pong — **${message.client.ws.ping} ms**`)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleGeneral: ModuleBot = {
  id: 'general',
  nom: 'Général',
  emoji: '📌',
  description: 'Aide, fiches et informations',
  desactivable: false,
  actifParDefaut: true,
  commandes: [aide, ping, avatar, infoMembre, infoServeur, infoBot],
  commandesPrefixe,
  composants: [
    {
      prefixe: 'help',
      async menu(interaction, [, proprietaireId]) {
        await surMenuAide(interaction, proprietaireId);
      },
    },
  ],
  // Suivi vocal commun : XP, statistiques et quêtes s'y abonnent chacun de leur côté.
  evenements: [sur('voiceStateUpdate', (avant, apres) => traiterEtatVocal(avant, apres), 5)],
  taches: [
    {
      nom: 'voice-flush',
      intervalleMs: 5 * 60_000,
      async executer(client) {
        crediterVocal(client);
      },
    },
  ],
  async auDemarrage(client) {
    resynchroniserVocal(client);
  },
};
