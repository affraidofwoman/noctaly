import { all, get, parseJson, run, transaction } from '../database/db';

/**
 * ENSEIGNES STREAMERS
 * Chaque streamer a sa direction artistique (nom, couleur, logo, pied, émojis, liens)
 * et la liste des serveurs qui la portent. Les messages du bot prennent celle du serveur où ils sont envoyés.
 */

export const DEFAULT_COLOR = 0x9146ff;

export const EMOJI_KEYS = {
  valide: '✅',
  probleme: '❌',
  refus: '⛔',
  info: 'ℹ️',
  attention: '⚠️',
  attente: '⏳',
  ticket: '🎫',
  giveaway: '🎉',
  cadeau: '🎁',
  live: '🔴',
  twitch: '💜',
  musique: '🎵',
  bienvenue: '👋',
  depart: '🚪',
  sanction: '🛡️',
  whitelist: '🔐',
  couronne: '👑',
  etoile: '⭐',
  stats: '📊',
  message: '💬',
  vocal: '🎙️',
  role: '🎭',
  cle: '🔑',
  corbeille: '🗑️',
  lien: '🔗',
  anniversaire: '🎂',
  rappel: '⏰',
  annonce: '📢',
  argent: '💰',
  niveau: '🏆',
  boost: '🚀',
  suggestion: '💡',
} as const;

export type EmojiKey = keyof typeof EMOJI_KEYS;

export interface StreamerLinks {
  twitch?: string;
  youtube?: string;
  x?: string;
  tiktok?: string;
  instagram?: string;
  discord?: string;
}

export interface Brand {
  key: string | null;
  name: string;
  color: number;
  hasCustomColor: boolean;
  footer: string | null;
  logo: string | null;
  background: string | null;
  twitchLogin: string | null;
  links: StreamerLinks;
  emojis: Partial<Record<EmojiKey, string>>;
}

export interface StreamerRow {
  key: string;
  name: string;
  color: number | null;
  footer: string | null;
  logo: string | null;
  background: string | null;
  twitch_login: string | null;
  links: string;
  emojis: string;
  created_at: number;
  updated_at: number;
}

export const KEY_PATTERN = /^[a-z0-9_-]{2,32}$/;
const IMAGE_PATTERN = /^https:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const CUSTOM_EMOJI_PATTERN = /^<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>$/;

export function isImageUrl(value: string): boolean {
  return IMAGE_PATTERN.test(value.trim());
}

/** Un émoji personnalisé Discord ou un émoji unicode court. */
export function isEmojiValue(value: string): boolean {
  const v = value.trim();
  if (CUSTOM_EMOJI_PATTERN.test(v)) return true;
  return v.length > 0 && v.length <= 8 && /\p{Extended_Pictographic}/u.test(v);
}

export function parseColor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? Number.parseInt(m[1]!, 16) : null;
}

export function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

/** Palettes proposées dans /custom, lisibles sur le fond sombre de Discord. */
export const PALETTES = [
  {
    name: 'Twitch',
    description: 'Violets et tons néon',
    tones: [
      { name: 'Twitch', color: 0x9146ff },
      { name: 'Lavande', color: 0xbf94ff },
      { name: 'Aubergine', color: 0x5c16c5 },
      { name: 'Néon', color: 0x7b5cff },
      { name: 'Magenta', color: 0xe91e8c },
      { name: 'Glace', color: 0x46c8ff },
    ],
  },
  {
    name: 'Pastel',
    description: 'Douces et chaleureuses',
    tones: [
      { name: 'Dragée', color: 0xf2b8cd },
      { name: 'Brume', color: 0xb8d4f2 },
      { name: 'Menthe', color: 0xb8f2d8 },
      { name: 'Sable', color: 0xf2e2b8 },
      { name: 'Lilas', color: 0xd8b8f2 },
      { name: 'Abricot', color: 0xf2cdb8 },
    ],
  },
  {
    name: 'Vif',
    description: 'Lumineuses, elles sautent aux yeux',
    tones: [
      { name: 'Cyan', color: 0x46c8ff },
      { name: 'Citron', color: 0xe8e83a },
      { name: 'Corail', color: 0xff6f5f },
      { name: 'Turquoise', color: 0x2fd8c8 },
      { name: 'Fuchsia', color: 0xff5fbf },
      { name: 'Lime', color: 0x8fe83a },
    ],
  },
  {
    name: 'Profond',
    description: 'Saturées et franches',
    tones: [
      { name: 'Encre', color: 0x2f4f8f },
      { name: 'Sapin', color: 0x1f6f4f },
      { name: 'Grenat', color: 0x8f2f4f },
      { name: 'Ambre', color: 0xcf8f1f },
      { name: 'Prune', color: 0x5f2f8f },
      { name: 'Ardoise', color: 0x3f4f5f },
    ],
  },
];

const guildCache = new Map<string, { brand: Brand; expires: number }>();
const CACHE_MS = 5 * 60_000;

export function defaultBrand(): Brand {
  return {
    key: null,
    name: process.env.BOT_BRAND_NAME?.trim() || 'Twitch Community',
    color: DEFAULT_COLOR,
    hasCustomColor: false,
    footer: null,
    logo: null,
    background: null,
    twitchLogin: null,
    links: {},
    emojis: {},
  };
}

function toBrand(row: StreamerRow): Brand {
  const emojis: Partial<Record<EmojiKey, string>> = {};
  for (const [k, v] of Object.entries(parseJson<Record<string, string>>(row.emojis, {}))) {
    if (k in EMOJI_KEYS && typeof v === 'string' && isEmojiValue(v)) emojis[k as EmojiKey] = v;
  }
  return {
    key: row.key,
    name: row.name,
    color: row.color ?? DEFAULT_COLOR,
    hasCustomColor: row.color !== null,
    footer: row.footer,
    logo: row.logo,
    background: row.background,
    twitchLogin: row.twitch_login,
    links: parseJson<StreamerLinks>(row.links, {}),
    emojis,
  };
}

export function brandFor(guildId: string | null | undefined): Brand {
  if (!guildId) return defaultBrand();
  const cached = guildCache.get(guildId);
  if (cached && cached.expires > Date.now()) return cached.brand;
  const row = get<StreamerRow>(
    'SELECT s.* FROM streamers s JOIN streamer_guilds g ON g.streamer_key = s.key WHERE g.guild_id = ?',
    guildId,
  );
  const brand = row ? toBrand(row) : defaultBrand();
  guildCache.set(guildId, { brand, expires: Date.now() + CACHE_MS });
  return brand;
}

export function emojiFor(guildId: string | null | undefined, key: EmojiKey): string {
  return brandFor(guildId).emojis[key] ?? EMOJI_KEYS[key];
}

export function forgetBrands(): void {
  guildCache.clear();
}

export function listStreamers(): (StreamerRow & { guilds: string[] })[] {
  const rows = all<StreamerRow>('SELECT * FROM streamers ORDER BY name COLLATE NOCASE');
  const links = all<{ guild_id: string; streamer_key: string }>('SELECT guild_id, streamer_key FROM streamer_guilds');
  return rows.map((r) => ({ ...r, guilds: links.filter((l) => l.streamer_key === r.key).map((l) => l.guild_id) }));
}

export function getStreamer(key: string): (StreamerRow & { guilds: string[] }) | null {
  const row = get<StreamerRow>('SELECT * FROM streamers WHERE key = ?', key);
  if (!row) return null;
  const guilds = all<{ guild_id: string }>('SELECT guild_id FROM streamer_guilds WHERE streamer_key = ?', key).map((g) => g.guild_id);
  return { ...row, guilds };
}

export function createStreamer(key: string, name: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('clé invalide');
  const now = Date.now();
  run('INSERT INTO streamers (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)', key, name.slice(0, 64), now, now);
  forgetBrands();
}

export type StreamerPatch = Partial<{
  name: string;
  color: number | null;
  footer: string | null;
  logo: string | null;
  background: string | null;
  twitch_login: string | null;
  links: StreamerLinks;
  emojis: Partial<Record<EmojiKey, string>>;
}>;

export function updateStreamer(key: string, patch: StreamerPatch): void {
  const current = getStreamer(key);
  if (!current) throw new Error('enseigne introuvable');
  run(
    `UPDATE streamers SET name = ?, color = ?, footer = ?, logo = ?, background = ?, twitch_login = ?, links = ?, emojis = ?, updated_at = ? WHERE key = ?`,
    (patch.name ?? current.name).slice(0, 64),
    patch.color !== undefined ? patch.color : current.color,
    patch.footer !== undefined ? patch.footer?.slice(0, 128) ?? null : current.footer,
    patch.logo !== undefined ? patch.logo : current.logo,
    patch.background !== undefined ? patch.background : current.background,
    patch.twitch_login !== undefined ? patch.twitch_login : current.twitch_login,
    JSON.stringify(patch.links ?? parseJson(current.links, {})),
    JSON.stringify(patch.emojis ?? parseJson(current.emojis, {})),
    Date.now(),
    key,
  );
  forgetBrands();
}

export function setStreamerGuilds(key: string, guildIds: string[]): void {
  transaction(() => {
    run('DELETE FROM streamer_guilds WHERE streamer_key = ?', key);
    for (const id of [...new Set(guildIds)].slice(0, 100)) {
      // Un serveur n'appartient qu'à une seule enseigne : il est retiré de l'ancienne.
      run('INSERT INTO streamer_guilds (guild_id, streamer_key) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET streamer_key = excluded.streamer_key', id, key);
    }
  });
  forgetBrands();
}

export function deleteStreamer(key: string): boolean {
  const r = run('DELETE FROM streamers WHERE key = ?', key);
  run('DELETE FROM streamer_guilds WHERE streamer_key = ?', key);
  forgetBrands();
  return r.changes > 0;
}
