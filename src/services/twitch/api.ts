import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../core/env';
import { createLogger } from '../../core/logger';

const log = createLogger('twitch');

const HELIX = 'https://api.twitch.tv/helix';

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
  tags?: string[];
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  description: string;
}

export interface TwitchClip {
  id: string;
  url: string;
  broadcaster_id: string;
  creator_name: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
}

export interface TwitchVideo {
  id: string;
  url: string;
  title: string;
  created_at: string;
  duration: string;
}

export function isTwitchConfigured(): boolean {
  return !!env.twitchClientId && !!env.twitchClientSecret;
}

let appToken: { token: string; expires: number } | null = null;

async function getAppToken(force = false): Promise<string> {
  if (!force && appToken && appToken.expires > Date.now() + 60_000) return appToken.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.twitchClientId, client_secret: env.twitchClientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jeton Twitch refusé (HTTP ${res.status}) : vérifie TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return appToken.token;
}

/** Appel Helix authentifié (jeton d'application), avec renouvellement et respect du rate limit. */
export async function helix<T>(endpoint: string, params: [string, string][] = [], retry = true): Promise<T[]> {
  if (!isTwitchConfigured()) throw new Error('Twitch n’est pas configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
  const url = new URL(`${HELIX}/${endpoint}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetch(url, {
    headers: { 'Client-Id': env.twitchClientId, Authorization: `Bearer ${await getAppToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 && retry) {
    await getAppToken(true);
    return helix<T>(endpoint, params, false);
  }
  if (res.status === 429 && retry) {
    const reset = Number(res.headers.get('ratelimit-reset')) * 1000;
    const wait = Math.min(Math.max(reset - Date.now(), 1000), 30_000);
    log.warn(`Rate limit Twitch, nouvelle tentative dans ${Math.round(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
    return helix<T>(endpoint, params, false);
  }
  if (!res.ok) throw new Error(`Twitch ${endpoint} : HTTP ${res.status}`);
  const body = (await res.json()) as { data: T[] };
  return body.data ?? [];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lives en cours pour une liste de pseudos (par lots de 100). */
export async function getStreams(logins: string[]): Promise<TwitchStream[]> {
  const unique = [...new Set(logins.map((l) => l.toLowerCase()))];
  const result: TwitchStream[] = [];
  for (const part of chunks(unique, 100)) {
    result.push(...(await helix<TwitchStream>('streams', [...part.map((l) => ['user_login', l] as [string, string]), ['first', '100']])));
  }
  return result;
}

export async function getUsers(logins: string[]): Promise<TwitchUser[]> {
  const unique = [...new Set(logins.map((l) => l.toLowerCase()))];
  const result: TwitchUser[] = [];
  for (const part of chunks(unique, 100)) result.push(...(await helix<TwitchUser>('users', part.map((l) => ['login', l]))));
  return result;
}

export async function getClips(broadcasterId: string, since: number): Promise<TwitchClip[]> {
  return helix<TwitchClip>('clips', [
    ['broadcaster_id', broadcasterId],
    ['started_at', new Date(since).toISOString()],
    ['first', '20'],
  ]);
}

export async function getLatestVod(broadcasterId: string): Promise<TwitchVideo | null> {
  const videos = await helix<TwitchVideo>('videos', [
    ['user_id', broadcasterId],
    ['type', 'archive'],
    ['first', '1'],
  ]).catch(() => []);
  return videos[0] ?? null;
}

export async function getGameBoxArt(gameId: string): Promise<string | null> {
  if (!gameId) return null;
  const games = await helix<{ box_art_url: string }>('games', [['id', gameId]]).catch(() => []);
  return games[0]?.box_art_url.replace('{width}', '285').replace('{height}', '380') ?? null;
}

export function streamThumbnail(stream: TwitchStream): string {
  // Paramètre anti-cache : Discord garde sinon la première miniature indéfiniment.
  return `${stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')}?t=${Math.floor(Date.now() / 300_000)}`;
}

export const LOGIN_PATTERN = /^[a-z0-9_]{3,25}$/;

export function normalizeLogin(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

// ─── Jeton utilisateur (EventSub : raids, follows, abonnements) ────────────

const TOKEN_FILE = path.join(path.dirname(env.databasePath), 'twitch-user-token.json');

export interface UserToken {
  access: string;
  refresh: string | null;
}

export function loadUserToken(): UserToken | null {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as UserToken;
    if (saved.access) return saved;
  } catch {
    /* pas de jeton sauvegardé */
  }
  return env.twitchUserToken ? { access: env.twitchUserToken, refresh: env.twitchRefreshToken || null } : null;
}

export async function refreshUserToken(token: UserToken): Promise<UserToken | null> {
  if (!token.refresh || !env.twitchClientSecret) return null;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.twitchClientId, client_secret: env.twitchClientSecret, grant_type: 'refresh_token', refresh_token: token.refresh }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string; refresh_token: string };
  const next = { access: data.access_token, refresh: data.refresh_token };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next), { mode: 0o600 });
  return next;
}

export async function validateUserToken(token: UserToken): Promise<{ user_id: string; login: string; scopes: string[] } | null> {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.access}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  return (await res.json()) as { user_id: string; login: string; scopes: string[] };
}
