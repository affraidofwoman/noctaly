import fs from 'node:fs';
import path from 'node:path';
import { environnement } from '../../core/env';
import { creerRegistre } from '../../core/logger';

const registre = creerRegistre('twitch');

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

export function twitchConfigure(): boolean {
  return !!environnement.twitchClientId && !!environnement.twitchSecret;
}

let jetonApplication: { token: string; expires: number } | null = null;

async function lireJetonApplication(forcer = false): Promise<string> {
  if (!forcer && jetonApplication && jetonApplication.expires > Date.now() + 60_000) return jetonApplication.token;
  const reponse = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environnement.twitchClientId, client_secret: environnement.twitchSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!reponse.ok) throw new Error(`Jeton Twitch refusé (HTTP ${reponse.status}) : vérifie TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET`);
  const donnees = (await reponse.json()) as { access_token: string; expires_in: number };
  jetonApplication = { token: donnees.access_token, expires: Date.now() + donnees.expires_in * 1000 };
  return jetonApplication.token;
}

/** Appel Helix authentifié (jeton d'application), avec renouvellement et respect du rate limit. */
export async function appelHelix<T>(route: string, parametres: [string, string][] = [], reessayer = true): Promise<T[]> {
  if (!twitchConfigure()) throw new Error('Twitch n’est pas configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
  const url = new URL(`${HELIX}/${route}`);
  for (const [k, v] of parametres) url.searchParams.append(k, v);
  const reponse = await fetch(url, {
    headers: { 'Client-Id': environnement.twitchClientId, Authorization: `Bearer ${await lireJetonApplication()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (reponse.status === 401 && reessayer) {
    await lireJetonApplication(true);
    return appelHelix<T>(route, parametres, false);
  }
  if (reponse.status === 429 && reessayer) {
    const reinitialiser = Number(reponse.headers.get('ratelimit-reset')) * 1000;
    const attendre = Math.min(Math.max(reinitialiser - Date.now(), 1000), 30_000);
    registre.avertir(`Rate limit Twitch, nouvelle tentative dans ${Math.round(attendre / 1000)} s`);
    await new Promise((r) => setTimeout(r, attendre));
    return appelHelix<T>(route, parametres, false);
  }
  if (!reponse.ok) throw new Error(`Twitch ${route} : HTTP ${reponse.status}`);
  const corps = (await reponse.json()) as { data: T[] };
  return corps.data ?? [];
}

function morceaux<T>(articles: T[], taille: number): T[][] {
  const sortie: T[][] = [];
  for (let i = 0; i < articles.length; i += taille) sortie.push(articles.slice(i, i + taille));
  return sortie;
}

/** Lives en cours pour une liste de pseudos (par lots de 100). */
export async function lireLives(pseudos: string[]): Promise<TwitchStream[]> {
  const unique = [...new Set(pseudos.map((l) => l.toLowerCase()))];
  const resultat: TwitchStream[] = [];
  for (const partie of morceaux(unique, 100)) {
    resultat.push(...(await appelHelix<TwitchStream>('streams', [...partie.map((l) => ['user_login', l] as [string, string]), ['first', '100']])));
  }
  return resultat;
}

export async function lireComptes(pseudos: string[]): Promise<TwitchUser[]> {
  const unique = [...new Set(pseudos.map((l) => l.toLowerCase()))];
  const resultat: TwitchUser[] = [];
  for (const partie of morceaux(unique, 100)) resultat.push(...(await appelHelix<TwitchUser>('users', partie.map((l) => ['login', l]))));
  return resultat;
}

export async function lireClips(diffuseurId: string, depuis: number): Promise<TwitchClip[]> {
  return appelHelix<TwitchClip>('clips', [
    ['broadcaster_id', diffuseurId],
    ['started_at', new Date(depuis).toISOString()],
    ['first', '20'],
  ]);
}

export async function lireDerniereVod(diffuseurId: string): Promise<TwitchVideo | null> {
  const videos = await appelHelix<TwitchVideo>('videos', [
    ['user_id', diffuseurId],
    ['type', 'archive'],
    ['first', '1'],
  ]).catch(() => []);
  return videos[0] ?? null;
}

export async function lireJaquette(jeuId: string): Promise<string | null> {
  if (!jeuId) return null;
  const jeux = await appelHelix<{ box_art_url: string }>('games', [['id', jeuId]]).catch(() => []);
  return jeux[0]?.box_art_url.replace('{width}', '285').replace('{height}', '380') ?? null;
}

export function miniatureLive(flux: TwitchStream): string {
  // Paramètre anti-cache : Discord garde sinon la première miniature indéfiniment.
  return `${flux.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')}?t=${Math.floor(Date.now() / 300_000)}`;
}

export const MOTIF_PSEUDO = /^[a-z0-9_]{3,25}$/;

export function normaliserPseudo(saisie: string): string {
  return saisie
    .trim()
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

// ─── Jeton utilisateur (EventSub : raids, follows, abonnements) ────────────

const FICHIER_JETON = path.join(path.dirname(environnement.cheminBase), 'twitch-user-token.json');

export interface JetonUtilisateur {
  access: string;
  refresh: string | null;
}

export function chargerJetonUtilisateur(): JetonUtilisateur | null {
  try {
    const enregistre = JSON.parse(fs.readFileSync(FICHIER_JETON, 'utf8')) as JetonUtilisateur;
    if (enregistre.access) return enregistre;
  } catch {
    /* pas de jeton sauvegardé */
  }
  return environnement.twitchJetonUtilisateur ? { access: environnement.twitchJetonUtilisateur, refresh: environnement.twitchJetonRenouvellement || null } : null;
}

export async function renouvelerJetonUtilisateur(jeton: JetonUtilisateur): Promise<JetonUtilisateur | null> {
  if (!jeton.refresh || !environnement.twitchSecret) return null;
  const reponse = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environnement.twitchClientId, client_secret: environnement.twitchSecret, grant_type: 'refresh_token', refresh_token: jeton.refresh }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!reponse.ok) return null;
  const donnees = (await reponse.json()) as { access_token: string; refresh_token: string };
  const suivant = { access: donnees.access_token, refresh: donnees.refresh_token };
  fs.mkdirSync(path.dirname(FICHIER_JETON), { recursive: true });
  fs.writeFileSync(FICHIER_JETON, JSON.stringify(suivant), { mode: 0o600 });
  return suivant;
}

export async function validerJetonUtilisateur(jeton: JetonUtilisateur): Promise<{ user_id: string; login: string; scopes: string[] } | null> {
  const reponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${jeton.access}` }, signal: AbortSignal.timeout(10_000) });
  if (!reponse.ok) return null;
  return (await reponse.json()) as { user_id: string; login: string; scopes: string[] };
}
