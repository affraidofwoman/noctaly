import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type AttachmentBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type OverwriteResolvable,
  type PermissionResolvable,
  type User,
} from 'discord.js';
import { executer } from '../database/db';
import { lireConfig, modifierConfig } from './guildConfig';
import { creerRegistre } from './logger';
import { moduleActif } from './moduleManager';
import { tronquer } from './text';
import { membresListe, type WhitelistId } from './whitelists';

const registre = creerRegistre('journal');

export type TypeJournal =
  | 'sanction'
  | 'blacklist'
  | 'clear'
  | 'automod'
  | 'role'
  | 'whitelist'
  | 'autorole'
  | 'member'
  | 'message'
  | 'channel'
  | 'voice'
  | 'command'
  | 'security'
  | 'backup'
  | 'health'
  | 'ticket'
  | 'giveaway'
  | 'twitch'
  | 'invite'
  | 'boost'
  | 'community';

export interface DefinitionSalonJournal {
  type: TypeJournal;
  nom: string;
  description: string;
}

export interface DefinitionCategorieJournal {
  categorie: string;
  /** Permission Discord qui donne la vue sur la catégorie. */
  permissionVue: PermissionResolvable;
  /** Whitelists qui donnent la vue sur la catégorie. */
  whitelistsVue: WhitelistId[];
  salons: DefinitionSalonJournal[];
}

/** Structure des salons de logs, à la manière du bot Airline : un salon nommé par type. */
export const STRUCTURE_JOURNAUX: DefinitionCategorieJournal[] = [
  {
    categorie: 'Logs · Sanctions',
    permissionVue: PermissionFlagsBits.BanMembers,
    whitelistsVue: ['sys', 'logs'],
    salons: [
      { type: 'sanction', nom: 'sanction-log', description: 'Warns, timeouts, kicks, bans et unbans' },
      { type: 'blacklist', nom: 'bl-log', description: 'Blacklist : &bl et &unbl' },
      { type: 'clear', nom: 'clear-log', description: 'Suppressions de messages (&clear)' },
      { type: 'automod', nom: 'automod-log', description: 'Filtres : spam, liens, invitations, mots interdits' },
    ],
  },
  {
    categorie: 'Logs · Rôles & Accès',
    permissionVue: PermissionFlagsBits.ManageRoles,
    whitelistsVue: ['admin', 'logs'],
    salons: [
      { type: 'role', nom: 'role-log', description: 'Rôles créés, modifiés, supprimés, donnés ou retirés' },
      { type: 'whitelist', nom: 'wl-log', description: 'Whitelists accordées ou retirées (/wl)' },
      { type: 'autorole', nom: 'autorole-log', description: 'Rôles automatiques, rôles à réaction et niveaux' },
    ],
  },
  {
    categorie: 'Logs · Serveur',
    permissionVue: PermissionFlagsBits.ManageGuild,
    whitelistsVue: ['admin', 'logs'],
    salons: [
      { type: 'member', nom: 'membre-log', description: 'Arrivées et départs de membres' },
      { type: 'message', nom: 'message-log', description: 'Messages modifiés ou supprimés' },
      { type: 'channel', nom: 'salon-log', description: 'Salons créés, supprimés ou modifiés' },
      { type: 'voice', nom: 'vocal-log', description: 'Connexions, déconnexions et déplacements' },
      { type: 'command', nom: 'commande-log', description: 'Commandes utilisées' },
      { type: 'security', nom: 'securite-log', description: 'Anti-raid, anti-nuke et lockdown' },
      { type: 'backup', nom: 'backup-log', description: 'Sauvegardes de la configuration' },
      { type: 'health', nom: 'sante-log', description: 'État du bot et alertes techniques' },
    ],
  },
  {
    categorie: 'Logs · Communauté',
    permissionVue: PermissionFlagsBits.ManageMessages,
    whitelistsVue: ['staff', 'logs'],
    salons: [
      { type: 'ticket', nom: 'ticket-logs', description: 'Ouverture, fermeture et transcripts des tickets' },
      { type: 'giveaway', nom: 'giveaway-log', description: 'Giveaways lancés, terminés et relancés' },
      { type: 'twitch', nom: 'twitch-log', description: 'Lives, changements de jeu et de titre' },
      { type: 'invite', nom: 'invite-log', description: 'Invitations utilisées' },
      { type: 'boost', nom: 'boost-log', description: 'Boosts du serveur' },
      { type: 'community', nom: 'communaute-log', description: 'Suggestions, signalements, formulaires, événements' },
    ],
  },
];

export const TYPES_JOURNAUX: DefinitionSalonJournal[] = STRUCTURE_JOURNAUX.flatMap((c) => c.salons);

export function definitionJournal(type: TypeJournal): DefinitionSalonJournal {
  return TYPES_JOURNAUX.find((t) => t.type === type)!;
}

export function motifDe(type: TypeJournal): DefinitionCategorieJournal {
  return STRUCTURE_JOURNAUX.find((c) => c.salons.some((salonVise) => salonVise.type === type))!;
}

export const TONS = {
  neutre: 0x7b5cff,
  ok: 0x3fe08f,
  alerte: 0xe0455a,
  info: 0x46c8ff,
  or: 0xf0b232,
} as const;

export type Ton = keyof typeof TONS;

function salonTexteUtilisable(serveur: Guild, salonId: string | null | undefined): GuildTextBasedChannel | null {
  if (!salonId) return null;
  const salon = serveur.channels.cache.get(salonId);
  if (!salon || !salon.isTextBased() || salon.type === ChannelType.GuildStageVoice) return null;
  const moi = serveur.members.me;
  if (moi) {
    const permissions = salon.permissionsFor(moi);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  }
  return salon as GuildTextBasedChannel;
}

export function resoudreSalonTexte(serveur: Guild, salonId: string | null | undefined): GuildTextBasedChannel | null {
  return salonTexteUtilisable(serveur, salonId);
}

/** Salon d'un type de log : celui choisi dans la configuration, sinon celui qui porte le nom attendu. */
export function salonJournalPour(serveur: Guild, type: TypeJournal): GuildTextBasedChannel | null {
  const reglages = lireConfig(serveur.id).journaux;
  if (reglages.disabled.includes(type)) return null;
  const configure = salonTexteUtilisable(serveur, reglages.channels[type] ?? reglages.salonSecoursId);
  if (configure) return configure;
  const nom = definitionJournal(type).nom;
  const parNom = serveur.channels.cache.find((c) => c.name === nom && c.type === ChannelType.GuildText);
  return parNom ? salonTexteUtilisable(serveur, parNom.id) : null;
}

export interface OptionsJournal {
  titre: string;
  lignes?: (string | null | undefined | false)[];
  ton?: Ton;
  par?: User | null;
  champs?: { name: string; value: string; inline?: boolean }[];
  fichiers?: AttachmentBuilder[];
  miniature?: string | null;
}

export function construireEmbedJournal(options: OptionsJournal): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(TONS[options.ton ?? 'neutre'])
    .setAuthor({ name: tronquer(options.titre, 256) })
    .setTimestamp();
  const description = (options.lignes ?? []).filter(Boolean).join('\n');
  if (description) embed.setDescription(tronquer(description, 4096));
  for (const f of (options.champs ?? []).slice(0, 25)) {
    embed.addFields({ name: tronquer(f.name, 256), value: tronquer(f.value || '—', 1024), inline: f.inline ?? true });
  }
  if (options.miniature) embed.setThumbnail(options.miniature);
  if (options.par) embed.setFooter({ text: tronquer(`par ${options.par.tag}`, 2048), iconURL: options.par.displayAvatarURL({ size: 64 }) });
  return embed;
}

/** Écrit dans le salon de logs du type (si le module Logs est actif). */
export async function journal(serveur: Guild, type: TypeJournal, options: OptionsJournal): Promise<boolean> {
  if (!moduleActif(serveur.id, 'logs')) return false;
  const salon = salonJournalPour(serveur, type);
  if (!salon) return false;
  try {
    await salon.send({ embeds: [construireEmbedJournal(options)], files: options.fichiers ?? [], allowedMentions: { parse: [] } });
    return true;
  } catch (echec) {
    registre.avertir(`Envoi du log ${type} impossible sur ${serveur.id} : ${(echec as Error).message}`);
    return false;
  }
}

/** Historise un événement en base (utilisé par /logs et le dashboard). */
export function historiser(
  serveurId: string,
  type: TypeJournal,
  action: string,
  utilisateurId: string | null,
  auteurId: string | null,
  donnees: Record<string, unknown> = {},
): void {
  try {
    executer(
      'INSERT INTO journaux (serveur_id, categorie, type, utilisateur_id, acteur_id, donnees, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
      serveurId,
      type,
      action,
      utilisateurId,
      auteurId,
      JSON.stringify(donnees),
      Date.now(),
    );
  } catch (echec) {
    registre.avertir('Historisation impossible', echec);
  }
}

/** Permissions d'une catégorie de logs : cachée, visible par la permission et les whitelists. */
export function permissionsJournaux(serveur: Guild, definition: DefinitionCategorieJournal): OverwriteResolvable[] {
  const permissionsSalon: OverwriteResolvable[] = [{ id: serveur.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
  const moi = serveur.members.me;
  if (moi) {
    permissionsSalon.push({
      id: moi.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles],
    });
  }
  for (const role of serveur.roles.cache.values()) {
    if (role.id === serveur.id || role.managed) continue;
    if (role.permissions.has(definition.permissionVue)) permissionsSalon.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] });
  }
  const utilisateurs = new Set<string>();
  for (const liste of definition.whitelistsVue) for (const id of membresListe(liste, serveur.id)) utilisateurs.add(id);
  for (const id of membresListe('streamer', serveur.id)) utilisateurs.add(id);
  for (const id of utilisateurs) {
    if (serveur.members.cache.has(id)) permissionsSalon.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
  }
  return permissionsSalon.slice(0, 100);
}

/** Réapplique les accès des salons de logs existants (après un changement de whitelist). */
export async function synchroniserAccesJournaux(serveur: Guild): Promise<number> {
  let modifie = 0;
  for (const definition of STRUCTURE_JOURNAUX) {
    const permissionsSalon = permissionsJournaux(serveur, definition);
    const categorie = serveur.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === definition.categorie);
    const cibles = [
      categorie,
      ...definition.salons.map((salonVise) => salonJournalPour(serveur, salonVise.type)).filter((c) => c && 'parentId' in c && c.parentId === categorie?.id),
    ];
    for (const cible of cibles) {
      if (!cible || !('permissionOverwrites' in cible)) continue;
      try {
        await cible.permissionOverwrites.set(permissionsSalon, 'Mise à jour des accès aux logs');
        modifie++;
      } catch (echec) {
        registre.avertir(`Accès du salon ${cible.id} non mis à jour : ${(echec as Error).message}`);
      }
    }
  }
  return modifie;
}

/**
 * Crée (sans jamais écraser) les catégories et salons de logs manquants, puis les enregistre dans la configuration.
 * Retourne le nombre de salons créés.
 */
export async function creerSalonsJournal(serveur: Guild): Promise<{ cree: number; titreLie: number }> {
  let cree = 0;
  let titreLie = 0;
  const salons: Partial<Record<TypeJournal, string>> = {};
  for (const definition of STRUCTURE_JOURNAUX) {
    let categorie = serveur.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === definition.categorie);
    if (!categorie) {
      categorie = await serveur.channels.create({
        name: definition.categorie,
        type: ChannelType.GuildCategory,
        permissionOverwrites: permissionsJournaux(serveur, definition),
        reason: 'Création des salons de logs',
      });
      cree++;
    }
    for (const salonVise of definition.salons) {
      const existant = serveur.channels.cache.find((c) => c.name === salonVise.nom && c.type === ChannelType.GuildText);
      if (existant) {
        salons[salonVise.type] = existant.id;
        titreLie++;
        continue;
      }
      const salon = await serveur.channels.create({
        name: salonVise.nom,
        type: ChannelType.GuildText,
        parent: categorie.id,
        topic: salonVise.description,
        permissionOverwrites: permissionsJournaux(serveur, definition),
        reason: 'Création des salons de logs',
      });
      salons[salonVise.type] = salon.id;
      cree++;
    }
  }
  modifierConfig(serveur.id, (c) => {
    c.journaux.channels = { ...c.journaux.channels, ...salons };
  });
  return { cree, titreLie };
}
