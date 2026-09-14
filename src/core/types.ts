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
import type { SetupPage } from './setup';

/**
 * Niveaux d'accès, du plus bas au plus haut.
 * Chaque niveau garde tout ce que donnent les précédents.
 */
export enum PermLevel {
  MEMBER = 0,
  SUPPORT = 1,
  STAFF = 2,
  MODERATOR = 3,
  ADMIN = 4,
  STREAMER = 5,
  BOT_OWNER = 6,
}

export const PERM_LEVEL_LABELS: Record<PermLevel, string> = {
  [PermLevel.MEMBER]: 'Membre',
  [PermLevel.SUPPORT]: 'Support',
  [PermLevel.STAFF]: 'Staff',
  [PermLevel.MODERATOR]: 'Système',
  [PermLevel.ADMIN]: 'Admin',
  [PermLevel.STREAMER]: 'Streamer',
  [PermLevel.BOT_OWNER]: 'Owner bot',
};

export type HelpCategory =
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

export const HELP_CATEGORIES: Record<HelpCategory, { label: string; emoji: string }> = {
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

export interface CommandData {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface SlashCommand {
  data: CommandData;
  category: HelpCategory;
  /** Niveau minimum requis pour la commande (défaut : MEMBER). */
  level?: PermLevel;
  /** Niveau par sous-commande : clé "sub" ou "groupe sub". Prioritaire sur `level`. */
  subLevels?: Record<string, PermLevel>;
  /** Whitelist qui donne accès à la commande même sans le niveau requis. */
  whitelist?: string;
  cooldownSeconds?: number;
  execute(interaction: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

/** Domaines de préfixes, à la manière du bot Airline : + sanctions, & salons, = général, . owner, m! musique. */
export type PrefixDomain = 'sanction' | 'salon' | 'general' | 'owner' | 'music';

export const PREFIX_DOMAINS: Record<PrefixDomain, { label: string; emoji: string; defaultPrefix: string }> = {
  sanction: { label: 'Sanctions', emoji: '🛡️', defaultPrefix: '+' },
  salon: { label: 'Salons', emoji: '🔑', defaultPrefix: '&' },
  general: { label: 'Général', emoji: '📌', defaultPrefix: '=' },
  owner: { label: 'Owner', emoji: '👑', defaultPrefix: '.' },
  music: { label: 'Musique', emoji: '🎵', defaultPrefix: 'm!' },
};

export interface PrefixCommand {
  name: string;
  aliases?: string[];
  domain: PrefixDomain;
  category: HelpCategory;
  description: string;
  usage?: string;
  level?: PermLevel;
  whitelist?: string;
  execute(message: Message<true>, args: string[]): Promise<unknown>;
}

export interface ComponentHandler {
  /** Préfixe du customId (avant le premier ":"). Doit être unique. */
  prefix: string;
  /** Niveau minimum pour utiliser le composant (défaut : MEMBER). */
  level?: PermLevel;
  whitelist?: string;
  button?(interaction: ButtonInteraction<'cached'>, args: string[]): Promise<unknown>;
  select?(interaction: AnySelectMenuInteraction<'cached'>, args: string[]): Promise<unknown>;
  modal?(interaction: ModalSubmitInteraction<'cached'>, args: string[]): Promise<unknown>;
}

export type EventResult = void | 'stop';

export interface ModuleEvent<K extends keyof ClientEvents> {
  event: K;
  /** Priorité d'exécution : plus petit = plus tôt (défaut 100). */
  priority: number;
  /** Retourner "stop" interrompt les modules suivants pour cet événement. */
  run(...args: ClientEvents[K]): unknown;
}

export type AnyModuleEvent = { [K in keyof ClientEvents]: ModuleEvent<K> }[keyof ClientEvents];

export function on<K extends keyof ClientEvents>(
  event: K,
  run: (...args: ClientEvents[K]) => unknown,
  priority = 100,
): AnyModuleEvent {
  return { event, run, priority } as unknown as AnyModuleEvent;
}

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  runOnStart?: boolean;
  run(client: Client<true>): Promise<void>;
}

/** Test déclenchable depuis /test (ex : envoyer un faux message de bienvenue). */
export interface ModuleTest {
  id: string;
  label: string;
  emoji: string;
  description: string;
  /** Retourne un court compte rendu affiché à l'administrateur. */
  run(interaction: AnySelectMenuInteraction<'cached'>): Promise<string>;
}

export interface BotModule {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** false = module cœur, toujours actif. */
  toggleable: boolean;
  defaultEnabled: boolean;
  commands?: SlashCommand[];
  prefixCommands?: PrefixCommand[];
  components?: ComponentHandler[];
  events?: AnyModuleEvent[];
  tasks?: ScheduledTask[];
  setupPages?: SetupPage[];
  tests?: ModuleTest[];
  onReady?(client: Client<true>): Promise<void>;
  onShutdown?(): Promise<void> | void;
}
