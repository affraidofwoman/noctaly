import { get, run } from '../database/db';
import { env } from './env';
import type { LogType } from './logService';
import { THEMES, type ThemeColors, type ThemeId } from './themes';
import type { PrefixDomain } from './types';

export type AutoModAction = 'delete' | 'warn' | 'timeout';

export type TicketButtonStyle = 'Primary' | 'Secondary' | 'Success' | 'Danger';

export interface TicketCategory {
  /** Identifiant stable, aussi utilisé comme préfixe du salon (ex : support-pseudo). */
  id: string;
  label: string;
  emoji: string;
  description: string;
  style: TicketButtonStyle;
  /** Rôles qui voient ce type de ticket et sont mentionnés à l'ouverture. */
  roles: string[];
}

export interface WarnAutoAction {
  warns: number;
  action: 'timeout' | 'kick' | 'ban';
  durationMinutes: number;
}

export interface QuestDefinition {
  id: string;
  label: string;
  type: 'messages' | 'voice_minutes' | 'giveaways' | 'daily';
  target: number;
  rewardXp: number;
  rewardCoins: number;
}

export interface GuildConfig {
  general: {
    timezone: string;
    /** "brand" = couleurs de l'enseigne du streamer. */
    theme: ThemeId | 'brand';
    colors: ThemeColors;
    footer: string;
    staffChannelId: string | null;
    statusRotation: boolean;
  };
  prefixes: Record<PrefixDomain, string>;
  commands: {
    /** Salons où les commandes à préfixe marchent (vide = partout). */
    allowedChannels: string[];
    /** Supprimer le message de commande après exécution. */
    deleteTrigger: boolean;
  };
  permissions: {
    streamer: string[];
    admin: string[];
    moderator: string[];
    staff: string[];
    support: string[];
    member: string[];
  };
  welcome: {
    channelId: string | null;
    message: string;
    useEmbed: boolean;
    title: string;
    imageMode: 'none' | 'card' | 'url';
    imageUrl: string;
    dmEnabled: boolean;
    dmMessage: string;
    counterChannelId: string | null;
    counterFormat: string;
  };
  leave: {
    channelId: string | null;
    message: string;
    useEmbed: boolean;
  };
  autorole: {
    memberRoles: string[];
    botRoles: string[];
    delaySeconds: number;
  };
  logs: {
    /** Salon utilisé pour les types sans salon dédié. */
    fallbackChannelId: string | null;
    channels: Partial<Record<LogType, string>>;
    disabled: LogType[];
    ignoredChannels: string[];
  };
  tickets: {
    panelChannelId: string | null;
    parentCategoryId: string | null;
    /** Rôles qui voient tous les tickets (en plus des rôles par catégorie). */
    staffRoles: string[];
    maxOpenPerUser: number;
    categories: TicketCategory[];
    panelTitle: string;
    panelIntro: string;
    panelFooter: string;
    /** buttons = un bouton par motif (Airline v1) ; v2 = sections avec bouton ; menu = un bouton puis « Quel est le sujet ? ». */
    panelStyle: 'buttons' | 'v2' | 'menu';
    welcomeTitle: string;
    welcomeMessage: string;
    welcomeFooter: string;
    /** delete = transcript puis suppression (comme Airline) ; archive = salon verrouillé, suppression manuelle. */
    closeMode: 'delete' | 'archive';
    transcriptToUser: boolean;
    counter: number;
  };
  giveaways: {
    defaultChannelId: string | null;
    pingRoleId: string | null;
    dmWinners: boolean;
    logParticipations: boolean;
  };
  twitch: {
    defaultChannelId: string | null;
    defaultRoleId: string | null;
    liveMessage: string;
    endMessage: string;
    color: string;
  };
  music: {
    djRoles: string[];
    defaultVolume: number;
    maxQueue: number;
    leaveOnEmptyMinutes: number;
    announceNowPlaying: boolean;
  };
  moderation: {
    dmOnAction: boolean;
    /** Phrase ajoutée aux messages privés de sanction (comment contester). */
    contactText: string;
    autoActions: WarnAutoAction[];
    defaultTimeoutMinutes: number;
    /** Supprimer les messages des dernières X heures lors d'un ban (0 à 168). */
    banDeleteHours: number;
  };
  automod: {
    spam: { enabled: boolean; messages: number; seconds: number };
    duplicates: { enabled: boolean; count: number };
    links: { enabled: boolean; whitelist: string[] };
    invites: { enabled: boolean };
    badWords: { enabled: boolean; words: string[] };
    mentions: { enabled: boolean; max: number };
    caps: { enabled: boolean; percent: number; minLength: number };
    action: AutoModAction;
    timeoutMinutes: number;
    ignoreStaff: boolean;
    whitelistUsers: string[];
    whitelistRoles: string[];
    whitelistChannels: string[];
  };
  xp: {
    min: number;
    max: number;
    cooldownSeconds: number;
    voiceXpPerMinute: number;
    announce: 'off' | 'same' | 'channel' | 'dm';
    announceChannelId: string | null;
    levelUpMessage: string;
    noXpChannels: string[];
    noXpRoles: string[];
    stackRoles: boolean;
  };
  seniority: {
    tiers: { days: number; roleId: string }[];
    stack: boolean;
  };
  suggestions: {
    channelId: string | null;
    createThread: boolean;
    counter: number;
  };
  birthdays: {
    channelId: string | null;
    roleId: string | null;
    message: string;
    hour: number;
  };
  reminders: {
    maxPerUser: number;
  };
  announcements: {
    defaultChannelId: string | null;
  };
  customcommands: {
    prefix: string;
  };
  invites: {
    channelId: string | null;
    fakeAccountDays: number;
  };
  boosts: {
    channelId: string | null;
    message: string;
    boosterRoleId: string | null;
    rewards: { count: number; roleId: string | null; badgeId: string | null; coins: number }[];
  };
  events: {
    defaultChannelId: string | null;
    pingRoleId: string | null;
    reminderMinutes: number;
  };
  games: {
    eightBall: boolean;
    coinflip: boolean;
    dice: boolean;
    rps: boolean;
  };
  economy: {
    currencyName: string;
    currencyEmoji: string;
    dailyAmount: number;
    streakBonus: number;
    perMessage: number;
    messageCooldownSeconds: number;
  };
  quests: {
    list: QuestDefinition[];
    streakMilestones: { days: number; coins: number; xp: number }[];
    announce: boolean;
  };
  profiles: {
    autoBadges: boolean;
  };
  rules: {
    channelId: string | null;
    title: string;
    sections: { title: string; content: string }[];
    acceptRoleId: string | null;
    removeRoleId: string | null;
  };
  verification: {
    channelId: string | null;
    verifiedRoleId: string | null;
    unverifiedRoleId: string | null;
    method: 'button' | 'captcha';
    minAccountAgeDays: number;
  };
  antiraid: {
    joinThreshold: number;
    joinWindowSeconds: number;
    minAccountAgeDays: number;
    suspiciousAction: 'none' | 'timeout' | 'kick';
    autoLockdown: boolean;
    mentionThreshold: number;
    alertChannelId: string | null;
  };
  antinuke: {
    windowSeconds: number;
    thresholds: {
      channelDelete: number;
      channelCreate: number;
      roleDelete: number;
      roleCreate: number;
      ban: number;
      kick: number;
      webhookCreate: number;
    };
    action: 'alert' | 'strip' | 'kick' | 'ban';
    trustedUsers: string[];
  };
  reports: {
    channelId: string | null;
    mode: 'channel' | 'ticket';
  };
  feedback: {
    channelId: string | null;
  };
  forms: {
    partnershipChannelId: string | null;
    staffApplyChannelId: string | null;
  };
  stats: {
    trackVoice: boolean;
  };
  contests: {
    defaultChannelId: string | null;
  };
  setup: {
    completedAt: number | null;
  };
}

export const DEFAULT_TICKET_CATEGORIES: TicketCategory[] = [
  { id: 'support', label: 'Support', emoji: '🎫', description: 'Une question ou un souci ? On t’aide.', style: 'Primary', roles: [] },
  { id: 'sanction', label: 'Sanction', emoji: '🛡️', description: 'Sanctionné et tu penses que c’est injuste ? Explique-toi ici.', style: 'Danger', roles: [] },
  { id: 'partenariat', label: 'Partenariat', emoji: '🤝', description: 'Proposer un partenariat ou une collaboration.', style: 'Success', roles: [] },
  { id: 'giveaway', label: 'Giveaway', emoji: '🎁', description: 'Réclamer un gain de giveaway.', style: 'Success', roles: [] },
  { id: 'autre', label: 'Autre', emoji: '📢', description: 'Tout le reste. Si tu hésites, prends celui-là.', style: 'Secondary', roles: [] },
];

export const DEFAULT_PREFIXES: Record<PrefixDomain, string> = {
  sanction: '+',
  salon: '&',
  general: '=',
  owner: '.',
  music: 'm!',
};

export function defaultConfig(): GuildConfig {
  return {
    general: {
      timezone: env.defaultTimezone,
      theme: 'brand',
      colors: { ...THEMES.twitch.colors },
      footer: '',
      staffChannelId: null,
      statusRotation: true,
    },
    prefixes: { ...DEFAULT_PREFIXES },
    commands: { allowedChannels: [], deleteTrigger: false },
    permissions: { streamer: [], admin: [], moderator: [], staff: [], support: [], member: [] },
    welcome: {
      channelId: null,
      message: '🎉 Bienvenue {mention} !\n\nTu es maintenant membre de **{server}**.\n\nNous sommes désormais **{membercount} membres** !',
      useEmbed: true,
      title: '👋 BIENVENUE',
      imageMode: 'card',
      imageUrl: '',
      dmEnabled: false,
      dmMessage: 'Bienvenue sur **{server}**, {username} ! Pense à lire le règlement 📜',
      counterChannelId: null,
      counterFormat: '👥 Membres : {membercount}',
    },
    leave: {
      channelId: null,
      message: '👋 **{username}** a quitté le serveur.\nNous sommes maintenant **{membercount} membres**.',
      useEmbed: true,
    },
    autorole: { memberRoles: [], botRoles: [], delaySeconds: 0 },
    logs: { fallbackChannelId: null, channels: {}, disabled: [], ignoredChannels: [] },
    tickets: {
      panelChannelId: null,
      parentCategoryId: null,
      staffRoles: [],
      maxOpenPerUser: 2,
      categories: DEFAULT_TICKET_CATEGORIES.map((c) => ({ ...c, roles: [] })),
      panelTitle: '🎫 Support {brand}',
      panelIntro: 'Une question, un souci, une demande ? Choisis le motif, on prend le relais.',
      panelFooter: 'Support • {brand} • un ticket par demande',
      panelStyle: 'buttons',
      welcomeTitle: '🎫 Ticket ouvert',
      welcomeMessage: 'Bienvenue {mention}.\n\nExplique ta demande ici, le plus clairement possible — ça nous fait gagner du temps à tous les deux.\nLe staff te répond dès qu’il passe.',
      welcomeFooter: 'Ferme le ticket une fois réglé — tu recevras la conversation en MP.',
      closeMode: 'delete',
      transcriptToUser: true,
      counter: 0,
    },
    giveaways: { defaultChannelId: null, pingRoleId: null, dmWinners: true, logParticipations: false },
    twitch: {
      defaultChannelId: null,
      defaultRoleId: null,
      liveMessage: '🔴 **{streamer}** est en LIVE ! {role}',
      endMessage: '⚫ Le live de **{streamer}** est terminé. Merci à tous d\'être passés !',
      color: '#9146FF',
    },
    music: { djRoles: [], defaultVolume: 60, maxQueue: 200, leaveOnEmptyMinutes: 2, announceNowPlaying: true },
    moderation: {
      dmOnAction: true,
      contactText: 'Si tu souhaites discuter de ta sanction, ouvre un ticket sur le serveur.',
      banDeleteHours: 0,
      autoActions: [
        { warns: 3, action: 'timeout', durationMinutes: 60 },
        { warns: 5, action: 'kick', durationMinutes: 0 },
        { warns: 7, action: 'ban', durationMinutes: 0 },
      ],
      defaultTimeoutMinutes: 10,
    },
    automod: {
      spam: { enabled: true, messages: 6, seconds: 5 },
      duplicates: { enabled: true, count: 4 },
      links: {
        enabled: false,
        whitelist: ['youtube.com', 'youtu.be', 'twitch.tv', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'discord.com', 'tenor.com', 'giphy.com'],
      },
      invites: { enabled: true },
      badWords: { enabled: false, words: [] },
      mentions: { enabled: true, max: 6 },
      caps: { enabled: false, percent: 75, minLength: 12 },
      action: 'delete',
      timeoutMinutes: 5,
      ignoreStaff: true,
      whitelistUsers: [],
      whitelistRoles: [],
      whitelistChannels: [],
    },
    xp: {
      min: 15,
      max: 25,
      cooldownSeconds: 60,
      voiceXpPerMinute: 2,
      announce: 'same',
      announceChannelId: null,
      levelUpMessage: '🎉 Bravo {mention}, tu passes **niveau {level}** !',
      noXpChannels: [],
      noXpRoles: [],
      stackRoles: true,
    },
    seniority: { tiers: [], stack: false },
    suggestions: { channelId: null, createThread: false, counter: 0 },
    birthdays: {
      channelId: null,
      roleId: null,
      message: '🎂 Joyeux anniversaire {mention} ! 🎉\n\nToute la communauté te souhaite une excellente journée !',
      hour: 9,
    },
    reminders: { maxPerUser: 25 },
    announcements: { defaultChannelId: null },
    customcommands: { prefix: '!' },
    invites: { channelId: null, fakeAccountDays: 7 },
    boosts: {
      channelId: null,
      message: '🚀 Merci {mention} pour le boost ! Le serveur compte maintenant **{boosts} boosts** 💜',
      boosterRoleId: null,
      rewards: [],
    },
    events: { defaultChannelId: null, pingRoleId: null, reminderMinutes: 30 },
    games: { eightBall: true, coinflip: true, dice: true, rps: true },
    economy: {
      currencyName: 'Coins',
      currencyEmoji: '💰',
      dailyAmount: 100,
      streakBonus: 10,
      perMessage: 1,
      messageCooldownSeconds: 60,
    },
    quests: {
      list: [
        { id: 'messages20', label: 'Envoyer 20 messages', type: 'messages', target: 20, rewardXp: 100, rewardCoins: 50 },
        { id: 'voice30', label: 'Passer 30 minutes en vocal', type: 'voice_minutes', target: 30, rewardXp: 150, rewardCoins: 50 },
        { id: 'daily', label: 'Récupérer ta récompense /daily', type: 'daily', target: 1, rewardXp: 50, rewardCoins: 0 },
      ],
      streakMilestones: [
        { days: 7, coins: 200, xp: 200 },
        { days: 30, coins: 1000, xp: 1000 },
      ],
      announce: true,
    },
    profiles: { autoBadges: true },
    rules: {
      channelId: null,
      title: '📜 RÈGLEMENT',
      sections: [
        { title: '🤝 Respect', content: 'Sois respectueux envers tous les membres. Aucune insulte, discrimination ou harcèlement.' },
        { title: '💬 Salons', content: 'Utilise les salons pour leur usage prévu. Pas de spam ni de flood.' },
        { title: '📢 Publicité', content: "La publicité non autorisée est interdite, y compris en message privé." },
        { title: '🔞 Contenu', content: 'Aucun contenu NSFW, choquant ou illégal.' },
        { title: '🛡️ Staff', content: "Les décisions du staff doivent être respectées. En cas de désaccord, ouvre un ticket." },
      ],
      acceptRoleId: null,
      removeRoleId: null,
    },
    verification: {
      channelId: null,
      verifiedRoleId: null,
      unverifiedRoleId: null,
      method: 'button',
      minAccountAgeDays: 0,
    },
    antiraid: {
      joinThreshold: 10,
      joinWindowSeconds: 15,
      minAccountAgeDays: 3,
      suspiciousAction: 'none',
      autoLockdown: false,
      mentionThreshold: 15,
      alertChannelId: null,
    },
    antinuke: {
      windowSeconds: 30,
      thresholds: { channelDelete: 3, channelCreate: 8, roleDelete: 3, roleCreate: 8, ban: 4, kick: 5, webhookCreate: 4 },
      action: 'alert',
      trustedUsers: [],
    },
    reports: { channelId: null, mode: 'channel' },
    feedback: { channelId: null },
    forms: { partnershipChannelId: null, staffApplyChannelId: null },
    stats: { trackVoice: true },
    contests: { defaultChannelId: null },
    setup: { completedAt: null },
  };
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fusion profonde : les objets sont fusionnés, les tableaux et scalaires stockés remplacent les défauts. */
export function deepMerge<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(stored)) {
    if (stored === undefined) return defaults;
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
    if (defaults !== null && stored !== null && typeof defaults !== typeof stored) return defaults;
    return stored as T;
  }
  const out: Plain = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in defaults)) {
      // Clés libres (ex : overrides de logs) : on garde les objets ouverts
      if (Object.keys(defaults).length === 0) out[key] = value;
      continue;
    }
    out[key] = deepMerge((defaults as Plain)[key], value);
  }
  return out as T;
}

const cache = new Map<string, GuildConfig>();

export function getConfig(guildId: string): GuildConfig {
  const cached = cache.get(guildId);
  if (cached) return cached;
  const row = get<{ data: string }>('SELECT data FROM guild_settings WHERE guild_id = ?', guildId);
  let stored: unknown = {};
  if (row) {
    try {
      stored = JSON.parse(row.data);
    } catch {
      stored = {};
    }
  }
  const config = deepMerge(defaultConfig(), stored);
  cache.set(guildId, config);
  return config;
}

/** Modifie la configuration d'un serveur via une fonction et la persiste. */
export function updateConfig(guildId: string, mutate: (config: GuildConfig) => void): GuildConfig {
  const draft = structuredClone(getConfig(guildId));
  mutate(draft);
  saveConfig(guildId, draft);
  return draft;
}

export function saveConfig(guildId: string, config: GuildConfig): void {
  const normalized = deepMerge(defaultConfig(), config);
  run(
    `INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    guildId,
    JSON.stringify(normalized),
    Date.now(),
  );
  cache.set(guildId, normalized);
}

export function resetConfigCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}
