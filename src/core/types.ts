import type {
  AnySelectMenuInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  Message,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { PageReglage } from './setup';

/**
 * Niveaux d'accès, du plus bas au plus haut.
 * Chaque niveau garde tout ce que donnent les précédents.
 */
export enum Niveau {
  MEMBRE = 0,
  SUPPORT = 1,
  STAFF = 2,
  MODERATEUR = 3,
  ADMIN = 4,
  STREAMER = 5,
  PROPRIETAIRE_BOT = 6,
}

export const LIBELLES_NIVEAUX: Record<Niveau, string> = {
  [Niveau.MEMBRE]: 'Membre',
  [Niveau.SUPPORT]: 'Support',
  [Niveau.STAFF]: 'Staff',
  [Niveau.MODERATEUR]: 'Système',
  [Niveau.ADMIN]: 'Admin',
  [Niveau.STREAMER]: 'Streamer',
  [Niveau.PROPRIETAIRE_BOT]: 'Owner bot',
};

export type CategorieAide =
  | 'general'
  | 'moderation'
  | 'salons'
  | 'tickets'
  | 'giveaways'
  | 'music'
  | 'twitch'
  | 'community'
  | 'roles'
  | 'economy'
  | 'customization'
  | 'admin'
  | 'owner';

export const CATEGORIES_AIDE: Record<CategorieAide, { label: string; emoji: string }> = {
  general: { label: 'Pour tout le monde', emoji: '📌' },
  community: { label: 'Communauté', emoji: '⭐' },
  economy: { label: 'Économie & jeux', emoji: '💰' },
  music: { label: 'Musique', emoji: '🎵' },
  twitch: { label: 'Twitch', emoji: '🔴' },
  tickets: { label: 'Tickets', emoji: '🎫' },
  giveaways: { label: 'Giveaways', emoji: '🎉' },
  roles: { label: 'Rôles', emoji: '🎭' },
  moderation: { label: 'Sanctions', emoji: '🛡️' },
  salons: { label: 'Tenir les salons', emoji: '🔑' },
  customization: { label: 'Poster et animer', emoji: '📝' },
  admin: { label: 'Le serveur', emoji: '⚙️' },
  owner: { label: 'Réglages du bot', emoji: '👑' },
};

export interface DonneesCommande {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface CommandeSlash {
  donnees: DonneesCommande;
  categorie: CategorieAide;
  /** Niveau minimum requis pour la commande (défaut : MEMBER). */
  niveau?: Niveau;
  /** Niveau par sous-commande : clé "sub" ou "groupe sub". Prioritaire sur `level`. */
  niveauxSousCommandes?: Record<string, Niveau>;
  /** Whitelist qui donne accès à la commande même sans le niveau requis. */
  whitelist?: string;
  delaiSecondes?: number;
  executer(interaction: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocompletion?(interaction: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

/** Domaines de préfixes, à la manière du bot Airline : + sanctions, & salons, = général, . owner, m! musique. */
export type DomainePrefixe = 'sanction' | 'salon' | 'general' | 'owner' | 'music';

export const DOMAINES_PREFIXES: Record<DomainePrefixe, { label: string; emoji: string; prefixeParDefaut: string }> = {
  sanction: { label: 'Sanctions', emoji: '🛡️', prefixeParDefaut: '+' },
  salon: { label: 'Salons', emoji: '🔑', prefixeParDefaut: '&' },
  general: { label: 'Général', emoji: '📌', prefixeParDefaut: '=' },
  owner: { label: 'Owner', emoji: '👑', prefixeParDefaut: '.' },
  music: { label: 'Musique', emoji: '🎵', prefixeParDefaut: 'm!' },
};

export interface CommandePrefixe {
  nom: string;
  alias?: string[];
  domaine: DomainePrefixe;
  categorie: CategorieAide;
  description: string;
  usage?: string;
  niveau?: Niveau;
  whitelist?: string;
  executer(message: Message<true>, parametres: string[]): Promise<unknown>;
}

export interface GestionnaireComposant {
  /** Préfixe du customId (avant le premier ":"). Doit être unique. */
  prefixe: string;
  /** Niveau minimum pour utiliser le composant (défaut : MEMBER). */
  niveau?: Niveau;
  whitelist?: string;
  bouton?(interaction: ButtonInteraction<'cached'>, parametres: string[]): Promise<unknown>;
  menu?(interaction: AnySelectMenuInteraction<'cached'>, parametres: string[]): Promise<unknown>;
  fenetre?(interaction: ModalSubmitInteraction<'cached'>, parametres: string[]): Promise<unknown>;
}

export type ResultatEvenement = void | 'stop';

export interface EvenementModuleUnique<K extends keyof ClientEvents> {
  evenement: K;
  /** Priorité d'exécution : plus petit = plus tôt (défaut 100). */
  priorite: number;
  /** Retourner "stop" interrompt les modules suivants pour cet événement. */
  executer(...parametres: ClientEvents[K]): unknown;
}

export type EvenementModule = { [K in keyof ClientEvents]: EvenementModuleUnique<K> }[keyof ClientEvents];

export function sur<K extends keyof ClientEvents>(
  evenement: K,
  executer: (...parametres: ClientEvents[K]) => unknown,
  priorite = 100,
): EvenementModule {
  return { event: evenement, run: executer, priority: priorite } as unknown as EvenementModule;
}

export interface TachePlanifiee {
  nom: string;
  intervalleMs: number;
  auDemarrage?: boolean;
  executer(client: Client<true>): Promise<void>;
}

/** Test déclenchable depuis /test (ex : envoyer un faux message de bienvenue). */
export interface TestModule {
  id: string;
  libelle: string;
  emoji: string;
  description: string;
  /** Retourne un court compte rendu affiché à l'administrateur. */
  executer(interaction: AnySelectMenuInteraction<'cached'>): Promise<string>;
}

export interface ModuleBot {
  id: string;
  nom: string;
  emoji: string;
  description: string;
  /** false = module cœur, toujours actif. */
  desactivable: boolean;
  actifParDefaut: boolean;
  commandes?: CommandeSlash[];
  commandesPrefixe?: CommandePrefixe[];
  composants?: GestionnaireComposant[];
  evenements?: EvenementModule[];
  taches?: TachePlanifiee[];
  pagesReglage?: PageReglage[];
  tests?: TestModule[];
  auDemarrage?(client: Client<true>): Promise<void>;
  aLArret?(): Promise<void> | void;
}
