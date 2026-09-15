import {
  type APIEmbed,
  type APIEmbedField,
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  version as djsVersion,
  type Guild,
  GuildMember,
  SlashCommandBuilder,
  type User,
} from 'discord.js';
import { aAcces, libelleNiveauVu, whitelistsMembreVues } from '../coeur/acces';
import { bouton, boutonCorbeille, couleurPour, embedEnseigne, info, nomEnseigne, rangee, rangeeCorbeille, repondre } from '../coeur/affichage';
import { type CommandePrefixe, type CommandeSlash, etatBot, lireAiguilleur, type ModuleBot, niveauRequis, sur } from '../coeur/noyau';
import { formaterDuree, formaterNombre, marqueTemps, membreCible, resoudreUtilisateur, tronquer, type CategorieAide, CATEGORIES_AIDE, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import { crediterVocal, embedStatistiques, resynchroniserVocal, traiterEtatVocal } from './niveaux';

// - Aide façon Airline -
// Tout d’un coup, en tableau : une ligne par commande, jumelles regroupées.
interface OptionJson {
  type: number;
  name: string;
  options?: { type: number; name: string }[];
}

export function ligneCommande(json: { name: string; description: string; options?: OptionJson[] }, autorise: (groupe: string | null, sous: string | null) => boolean, prefixes: string[]): string | null {
  const sous: string[] = [];
  let avecSous = false;
  for (const o of json.options ?? []) {
    if (o.type === ApplicationCommandOptionType.Subcommand) {
      avecSous = true;
      if (autorise(null, o.name)) sous.push(o.name);
    } else if (o.type === ApplicationCommandOptionType.SubcommandGroup) {
      avecSous = true;
      for (const interne of o.options ?? []) if (autorise(o.name, interne.name)) sous.push(`${o.name} ${interne.name}`);
    }
  }
  if (avecSous ? !sous.length : !autorise(null, null)) return null;
  const tete = [`**/${json.name}**`, ...prefixes.map((p) => `**${p}**`)].join(' · ');
  return `${tete}${sous.length ? ` ${sous.join(' · ')}` : ''} — ${json.description}`;
}

export interface EntreePrefixe {
  declencheur: string;
  nom: string;
  description: string;
  usage?: string;
}

const JUMELLES: [string, string][] = [
  ['pause', 'resume'],
  ['pic', 'banner'],
  ['join', 'leave'],
  ['daily', 'gold'],
];

export function pairesPrefixe(entrees: EntreePrefixe[]): string[] {
  const triees = [...entrees].sort((a, b) => a.declencheur.localeCompare(b.declencheur, 'fr'));
  const parDeclencheur = new Map(triees.map((e) => [e.declencheur, e]));
  const pris = new Set<string>();
  const lignes: string[] = [];
  for (const e of triees) {
    if (pris.has(e.declencheur)) continue;
    pris.add(e.declencheur);
    const prefixe = e.declencheur.slice(0, e.declencheur.length - e.nom.length);
    const jumelle = [`un${e.nom}`, ...JUMELLES.filter(([a]) => a === e.nom).map(([, b]) => b)]
      .map((nom) => parDeclencheur.get(`${prefixe}${nom}`))
      .find((j) => j && !pris.has(j.declencheur));
    if (jumelle) pris.add(jumelle.declencheur);
    const noms = [e, ...(jumelle ? [jumelle] : [])].map((x) => `**${x.declencheur}**`).join(' · ');
    lignes.push(`${noms}${!jumelle && e.usage ? ` \`${e.usage}\`` : ''} — ${e.description}`);
  }
  return lignes;
}

const longueurVisible = (ligne: string) => ligne.replace(/<a?:\w+:\d+>/g, ' ').replace(/\*\*|`/g, '').length;

export function tableauAide(sections: { titre: string; lignes: string[] }[], options: { couleur: number; titre: string; accroche: string; pied: string }): APIEmbed[] {
  const embeds: APIEmbed[] = [];
  let champs: APIEmbedField[] = [];
  let taille = 0;
  let colonnes = 0;
  const fermer = () => {
    if (!champs.length) return;
    embeds.push({ color: options.couleur, fields: champs });
    champs = [];
    taille = 0;
    colonnes = 0;
  };
  for (const s of sections) {
    const valeur = tronquer(s.lignes.join('\n'), 1024);
    const poids = s.titre.length + valeur.length;
    const enColonne = s.lignes.length <= 8 && s.lignes.every((l) => longueurVisible(l) <= 30);
    if (champs.length >= 24 || (champs.length && taille + poids > 5000)) fermer();
    if (!enColonne) colonnes = 0;
    else if (colonnes === 2) {
      champs.push({ name: '​', value: '⠀', inline: false });
      colonnes = 0;
    }
    champs.push({ name: s.titre, value: valeur, inline: enColonne });
    taille += poids;
    colonnes = enColonne ? colonnes + 1 : 0;
  }
  fermer();
  if (embeds.length) {
    embeds[0]!.title = options.titre;
    embeds[0]!.description = options.accroche;
    embeds.at(-1)!.footer = { text: options.pied };
  }
  return embeds;
}

function sectionsAide(membre: GuildMember): { titre: string; lignes: string[] }[] {
  const aiguilleur = lireAiguilleur();
  const serveurId = membre.guild.id;
  const prefixes = lireConfig(serveurId).prefixes;
  const permis = (niveau: Niveau, whitelist?: string) => niveau < Niveau.PROPRIETAIRE_BOT && aAcces(membre, niveau, whitelist);
  const sections: { titre: string; lignes: string[] }[] = [];
  for (const categorie of Object.keys(CATEGORIES_AIDE) as CategorieAide[]) {
    if (categorie === 'owner') continue;
    const vus = new Set<string>();
    const aPrefixe: EntreePrefixe[] = [];
    for (const { commande, module } of aiguilleur.commandesPrefixe.values()) {
      const cle = `${commande.domaine}:${commande.nom}`;
      if (commande.categorie !== categorie || commande.horsAide || vus.has(cle) || !moduleActif(serveurId, module.id) || !permis(commande.niveau ?? Niveau.MEMBRE, commande.whitelist)) continue;
      vus.add(cle);
      aPrefixe.push({ declencheur: `${prefixes[commande.domaine]}${commande.nom}`, nom: commande.nom, description: commande.description, usage: commande.usage });
    }
    const lignes: string[] = [];
    for (const { commande, module } of aiguilleur.commandes.values()) {
      if (commande.categorie !== categorie || !moduleActif(serveurId, module.id)) continue;
      const json = commande.donnees.toJSON();
      const memeNom = aPrefixe.filter((p) => p.nom === json.name);
      const ligne = ligneCommande(json as { name: string; description: string; options?: OptionJson[] }, (groupe, sous) => permis(niveauRequis(commande, groupe, sous), commande.whitelist), memeNom.map((p) => p.declencheur));
      if (!ligne) continue;
      lignes.push(ligne);
      for (const p of memeNom) aPrefixe.splice(aPrefixe.indexOf(p), 1);
    }
    lignes.sort((a, b) => a.localeCompare(b, 'fr'));
    lignes.push(...pairesPrefixe(aPrefixe));
    if (lignes.length) sections.push({ titre: `${CATEGORIES_AIDE[categorie].emoji} ${CATEGORIES_AIDE[categorie].label}`, lignes });
  }
  return sections;
}

export function accueilAide(membre: GuildMember) {
  const options = {
    couleur: couleurPour(membre.guild),
    titre: '📚 Tes commandes',
    accroche: `Uniquement celles que tu peux lancer — la liste change avec tes accès.\n-# Ton accès : **${libelleNiveauVu(membre, '')}**`,
    pied: `${nomEnseigne(membre.guild)} · les commandes à sous-commandes s’ouvrent avec leur nom`,
  };
  const sections = sectionsAide(membre);
  let embeds = tableauAide(sections, options);
  // - Trop long : les noms seuls -
  if (JSON.stringify(embeds).length > 5800) embeds = tableauAide(sections.map((s) => ({ titre: s.titre, lignes: s.lignes.map((l) => l.split(' — ')[0]!) })), options);
  return { embeds, components: [rangee(boutonCorbeille(membre.guild.id, membre.id))] };
}

function embedInfoMembre(serveur: Guild, utilisateur: User, membre: GuildMember | null, spectateurId: string) {
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
    const whitelistsListe = whitelistsMembreVues(utilisateur.id, serveur.id, spectateurId);
    embed.addFields(
      { name: 'Arrivée', value: membre.joinedTimestamp ? `${marqueTemps(membre.joinedTimestamp, 'D')}\n${marqueTemps(membre.joinedTimestamp, 'R')}` : '—', inline: true },
      { name: 'Accès bot', value: libelleNiveauVu(membre, spectateurId), inline: true },
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

function embedBot(serveur: Guild) {
  const client = serveur.client;
  const memoire = process.memoryUsage();
  return embedEnseigne(serveur)
    .setTitle('🤖 Le bot')
    .setThumbnail(client.user.displayAvatarURL())
    .addFields(
      { name: 'Latence', value: `${client.ws.ping >= 0 ? client.ws.ping : '—'} ms`, inline: true },
      { name: 'En ligne depuis', value: formaterDuree(Date.now() - etatBot.debutLe), inline: true },
      { name: 'Serveurs', value: formaterNombre(client.guilds.cache.size), inline: true },
      { name: 'Mémoire', value: `${Math.round(memoire.rss / 1024 / 1024)} Mo`, inline: true },
      { name: 'Versions', value: `Node.js ${process.version} · discord.js v${djsVersion}`, inline: true },
    );
}

// - /info : une fiche, cinq vues -
type VueInfo = 'membre' | 'photo' | 'banniere' | 'serveur' | 'bot' | 'stats';

const VUES_INFO: { vue: VueInfo; libelle: string; emoji: string }[] = [
  { vue: 'membre', libelle: 'Membre', emoji: '👤' },
  { vue: 'photo', libelle: 'Photo', emoji: '🖼️' },
  { vue: 'banniere', libelle: 'Bannière', emoji: '🎨' },
  { vue: 'serveur', libelle: 'Serveur', emoji: '🏠' },
  { vue: 'stats', libelle: 'Stats', emoji: '📈' },
  { vue: 'bot', libelle: 'Bot', emoji: '🤖' },
];

async function ecranInfo(serveur: Guild, utilisateurId: string, spectateurId: string, vue: VueInfo) {
  const utilisateur = await serveur.client.users.fetch(utilisateurId, { force: vue === 'membre' || vue === 'banniere' });
  const membre = await serveur.members.fetch(utilisateurId).catch(() => null);
  const embed =
    vue === 'membre'
      ? embedInfoMembre(serveur, utilisateur, membre, spectateurId)
      : vue === 'photo' || vue === 'banniere'
        ? await embedImage(serveur, utilisateur, membre, vue === 'photo' ? 'avatar' : 'banner')
        : vue === 'serveur'
          ? embedInfoServeur(serveur)
          : vue === 'stats'
            ? embedStatistiques(serveur)
            : embedBot(serveur);
  const vues = VUES_INFO.filter((v) => v.vue !== 'stats' || moduleActif(serveur.id, 'stats'));
  return {
    embeds: [embed],
    components: [
      rangee(...vues.slice(0, 5).map((v) => bouton(`info:${v.vue}:${utilisateurId}`, v.libelle, v.vue === vue ? ButtonStyle.Primary : ButtonStyle.Secondary, v.emoji).setDisabled(v.vue === vue))),
      rangee(...vues.slice(5).map((v) => bouton(`info:${v.vue}:${utilisateurId}`, v.libelle, v.vue === vue ? ButtonStyle.Primary : ButtonStyle.Secondary, v.emoji).setDisabled(v.vue === vue)), boutonCorbeille(serveur.id, spectateurId)),
    ],
  };
}

const commandeInfo: CommandeSlash = {
  categorie: 'general',
  donnees: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Fiches et infos')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async executer(interaction) {
    await interaction.deferReply();
    await interaction.editReply(await ecranInfo(interaction.guild, (interaction.options.getUser('membre') ?? interaction.user).id, interaction.user.id, 'membre'));
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
      await message.reply({ embeds: [embedInfoMembre(message.guild, utilisateur, membre, message.author.id)], components: [rangeeCorbeille(message.guildId, message.author.id)], allowedMentions: { repliedUser: false } });
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
    alias: ['pp'],
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
    nom: 'ping', horsAide: true,
    domaine: 'general',
    categorie: 'general',
    description: 'La latence du bot',
    async executer(message) {
      await message.reply({ embeds: [info(message.guild, `Pong — **${message.client.ws.ping} ms**`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'bot', horsAide: true,
    alias: ['botinfo'],
    domaine: 'general',
    categorie: 'general',
    description: 'Le bot en chiffres',
    async executer(message) {
      await message.reply({ ...(await ecranInfo(message.guild, message.author.id, message.author.id, 'bot')), allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'stats', horsAide: true,
    alias: ['statistiques'],
    domaine: 'general',
    categorie: 'general',
    description: 'Les stats du serveur',
    async executer(message) {
      await message.reply({ ...(await ecranInfo(message.guild, message.author.id, message.author.id, 'stats')), allowedMentions: { repliedUser: false } });
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
  commandes: [aide, commandeInfo],
  commandesPrefixe,
  composants: [
    {
      prefixe: 'info',
      async bouton(interaction, [vue, utilisateurId]) {
        await interaction.deferUpdate();
        await interaction.editReply(await ecranInfo(interaction.guild, utilisateurId ?? interaction.user.id, interaction.user.id, vue as VueInfo));
      },
    },
  ],
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
