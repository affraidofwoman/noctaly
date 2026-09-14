import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import play from 'play-dl';
import prism from 'prism-media';
import { env } from '../../core/env';
import { createLogger } from '../../core/logger';

const log = createLogger('musique');

export interface Track {
  title: string;
  duration: number;
  thumbnail: string | null;
  url: string | null;
  /** Lien d'origine (Spotify, Deezer) quand la lecture passe par une recherche YouTube. */
  originalUrl?: string | null;
  /** Recherche YouTube à faire au moment de jouer (pistes Spotify/Deezer). */
  query?: string | null;
  requestedBy: string;
  fromPlaylist?: boolean;
}

export type Resolved = Omit<Track, 'requestedBy'>;

// ─── FFmpeg ────────────────────────────────────────────────────────────────

function findFfmpeg(): string | null {
  const candidates: string[] = [];
  if (env.ffmpegPath) candidates.push(env.ffmpegPath);
  try {
    const bundled = require('ffmpeg-static') as string | null;
    if (bundled) candidates.push(bundled);
  } catch {
    /* ffmpeg-static absent */
  }
  candidates.push('ffmpeg', 'avconv');
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true, timeout: 10_000 });
      if (!r.error && r.status === 0) return c;
    } catch {
      /* suivant */
    }
  }
  return null;
}

export const FFMPEG = findFfmpeg();
if (FFMPEG) {
  if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = FFMPEG;
  const dir = path.dirname(path.resolve(FFMPEG));
  if (FFMPEG.includes(path.sep) && !String(process.env.PATH).split(path.delimiter).includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  }
} else {
  log.error('FFmpeg introuvable (ni ffmpeg-static, ni ffmpeg sur le PATH) : la musique ne produira aucun son.');
}

/** Filtres repris d'Airline : coupe les infra-graves, normalise et limite pour un volume régulier. */
const FILTERS = process.env.MUSIQUE_FILTRES || ['highpass=f=35', 'dynaudnorm=f=400:g=9:p=0.85:m=4', 'alimiter=level_in=1:level_out=1:limit=0.92:attack=5:release=50'].join(',');

export function normalizedStream(input: Readable): Readable {
  const transcoder = new prism.FFmpeg({
    args: ['-analyzeduration', '0', '-probesize', '32', '-loglevel', '0', '-i', '-', '-af', FILTERS, '-f', 's16le', '-ar', '48000', '-ac', '2'],
  });
  transcoder.on('error', (err: Error) => log.debug(`Transcodage : ${err.message}`));
  input.on('error', (err: Error) => log.debug(`Source : ${err.message}`));
  return input.pipe(transcoder);
}

// ─── yt-dlp (plusieurs commandes et stratégies, comme sur Airline) ────────

const BUNDLED_YTDLP = path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'bin', 'yt-dlp');

interface Command {
  command: string;
  args: string[];
}

const COMMANDS: Command[] = [
  ...(env.ytdlpPath ? [{ command: env.ytdlpPath, args: [] }] : []),
  { command: 'yt-dlp', args: [] },
  ...(fs.existsSync(BUNDLED_YTDLP) ? [{ command: 'python3', args: [BUNDLED_YTDLP] }, { command: 'python', args: [BUNDLED_YTDLP] }] : []),
  { command: 'python3', args: ['-m', 'yt_dlp'] },
  { command: 'python', args: ['-m', 'yt_dlp'] },
];

const STRATEGIES: { name: string; args: string[] }[] = [
  { name: 'défaut', args: [] },
  { name: 'client android', args: ['--extractor-args', 'youtube:player_client=android'] },
  { name: 'client ios', args: ['--extractor-args', 'youtube:player_client=ios'] },
  { name: 'client web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari'] },
  { name: 'client tv', args: ['--extractor-args', 'youtube:player_client=tv'] },
];

let chosen: Command | null = null;
const notFound = (err: unknown) => /ENOENT|No module named|not recognized/i.test((err as Error)?.message ?? '');

function run(cmd: Command, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(cmd.command, [...cmd.args, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function ytdlpStream(cmd: Command, url: string, strategy: { args: string[] }): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const p = run(cmd, ['-f', 'bestaudio/best', '-o', '-', '--quiet', '--no-warnings', '--no-playlist', ...strategy.args, url]);
    p.stdin.end();
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        fn();
      }
    };
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.once('error', (err) => finish(() => reject(err)));
    const onReadable = () => {
      if (p.stdout.readableLength === 0) return;
      p.stdout.off('readable', onReadable);
      finish(() => resolve(p.stdout));
    };
    p.stdout.on('readable', onReadable);
    p.once('close', (code) => finish(() => reject(new Error(stderr.trim().split('\n').filter(Boolean).pop() || `code ${code}`))));
  });
}

async function youtubeStream(url: string): Promise<Readable> {
  const failures: string[] = [];
  for (const cmd of chosen ? [chosen, ...COMMANDS] : COMMANDS) {
    for (const strategy of STRATEGIES) {
      try {
        const stream = await ytdlpStream(cmd, url, strategy);
        chosen = cmd;
        return stream;
      } catch (err) {
        if (notFound(err)) {
          failures.push(`${cmd.command} absent`);
          break;
        }
        failures.push(`${cmd.command} [${strategy.name}] : ${(err as Error).message}`);
      }
    }
  }
  chosen = null;
  // Dernier recours : play-dl.
  try {
    const source = await play.stream(url, { discordPlayerCompatibility: true });
    return source.stream;
  } catch (err) {
    failures.push(`play-dl : ${(err as Error).message}`);
  }
  throw new Error(`aucune méthode de lecture n’a fonctionné (${failures.slice(0, 3).join(' | ')})`);
}

function ytdlpSearch(cmd: Command, query: string): Promise<Resolved | null> {
  return new Promise((resolve, reject) => {
    const p = run(cmd, [`ytsearch1:${query}`, '--no-playlist', '--quiet', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(duration)s\t%(thumbnail)s']);
    p.stdin.end();
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.once('error', reject);
    p.once('close', (code) => {
      const line = out.split('\n').map((l) => l.trim()).find(Boolean);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `code ${code}`));
      if (!line) return resolve(null);
      const [id, title, duration, thumb] = line.split('\t');
      if (!id || !title) return resolve(null);
      resolve({ title, duration: Number(duration) || 0, thumbnail: thumb && thumb !== 'NA' ? thumb : null, url: `https://www.youtube.com/watch?v=${id}` });
    });
  });
}

export async function searchYoutube(query: string): Promise<Resolved | null> {
  try {
    const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
    const v = results[0];
    if (v) return { title: v.title ?? query, duration: v.durationInSec, thumbnail: v.thumbnails[0]?.url ?? null, url: v.url };
  } catch (err) {
    log.debug(`Recherche play-dl en échec : ${(err as Error).message}`);
  }
  for (const cmd of chosen ? [chosen, ...COMMANDS] : COMMANDS) {
    try {
      return await ytdlpSearch(cmd, query);
    } catch (err) {
      if (!notFound(err)) log.debug(`Recherche yt-dlp en échec : ${(err as Error).message}`);
    }
  }
  return null;
}

// ─── Spotify (API officielle, puis recherche YouTube au moment de jouer) ──

let spotifyToken: { token: string; expires: number } | null = null;
export const spotifyEnabled = () => !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET;

async function spotifyApi<T>(route: string): Promise<T> {
  if (!spotifyToken || spotifyToken.expires < Date.now()) {
    const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`jeton Spotify refusé (${res.status})`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    spotifyToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  }
  const res = await fetch(route.startsWith('http') ? route : `https://api.spotify.com/v1/${route}`, { headers: { Authorization: `Bearer ${spotifyToken.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Spotify ${res.status}`);
  return (await res.json()) as T;
}

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { images?: { url: string }[] };
}

function fromSpotify(t: SpotifyTrack, thumb: string | null = null): Resolved {
  return {
    title: `${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
    duration: Math.round(t.duration_ms / 1000),
    thumbnail: t.album?.images?.[0]?.url ?? thumb,
    url: null,
    originalUrl: `https://open.spotify.com/track/${t.id}`,
    query: `${t.name} ${t.artists.map((a) => a.name).join(' ')}`,
  };
}

const spotifyId = (url: string) => /(?:track|playlist|album)\/([a-zA-Z0-9]+)/.exec(url)?.[1] ?? null;

export const PLAYLIST_LIMIT = 5000;

// ─── Résolution ────────────────────────────────────────────────────────────

export type ResolveResult = { kind: 'track'; track: Resolved } | { kind: 'playlist'; name: string; tracks: Resolved[] } | { kind: 'error'; reason: string };

export async function resolve(input: string): Promise<ResolveResult> {
  const query = input.trim();
  const type = await play.validate(query).catch(() => false as const);
  try {
    switch (type) {
      case 'yt_video': {
        const info = await play.video_basic_info(query);
        const d = info.video_details;
        return { kind: 'track', track: { title: d.title ?? 'Vidéo YouTube', duration: d.durationInSec, thumbnail: d.thumbnails[0]?.url ?? null, url: d.url } };
      }
      case 'yt_playlist': {
        const pl = await play.playlist_info(query, { incomplete: true });
        const videos = await pl.all_videos();
        return {
          kind: 'playlist',
          name: pl.title ?? 'Playlist YouTube',
          tracks: videos.slice(0, PLAYLIST_LIMIT).map((v) => ({ title: v.title ?? 'Vidéo', duration: v.durationInSec, thumbnail: v.thumbnails[0]?.url ?? null, url: v.url })),
        };
      }
      case 'so_track':
      case 'so_playlist': {
        const so = await play.soundcloud(query);
        if (so.type === 'track') return { kind: 'track', track: { title: so.name, duration: so.durationInSec, thumbnail: (so as { thumbnail?: string }).thumbnail ?? null, url: so.url } };
        const tracks = await (so as import('play-dl').SoundCloudPlaylist).all_tracks();
        return { kind: 'playlist', name: so.name, tracks: tracks.slice(0, PLAYLIST_LIMIT).map((t) => ({ title: t.name, duration: t.durationInSec, thumbnail: t.thumbnail ?? null, url: t.url })) };
      }
      case 'sp_track':
      case 'sp_playlist':
      case 'sp_album': {
        if (!spotifyEnabled()) return { kind: 'error', reason: 'Spotify n’est pas configuré sur ce bot (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).' };
        const id = spotifyId(query);
        if (!id) return { kind: 'error', reason: 'Lien Spotify illisible.' };
        if (type === 'sp_track') return { kind: 'track', track: fromSpotify(await spotifyApi<SpotifyTrack>(`tracks/${id}`)) };
        if (type === 'sp_album') {
          const album = await spotifyApi<{ name: string; images: { url: string }[]; tracks: { items: SpotifyTrack[] } }>(`albums/${id}`);
          return { kind: 'playlist', name: album.name, tracks: album.tracks.items.map((t) => fromSpotify(t, album.images[0]?.url ?? null)) };
        }
        const playlist = await spotifyApi<{ name: string; tracks: { items: { track: SpotifyTrack | null }[]; next: string | null } }>(`playlists/${id}`);
        const tracks: Resolved[] = playlist.tracks.items.filter((i) => i.track).map((i) => fromSpotify(i.track!));
        let next = playlist.tracks.next;
        while (next && tracks.length < PLAYLIST_LIMIT) {
          const page = await spotifyApi<{ items: { track: SpotifyTrack | null }[]; next: string | null }>(next);
          tracks.push(...page.items.filter((i) => i.track).map((i) => fromSpotify(i.track!)));
          next = page.next;
        }
        return { kind: 'playlist', name: playlist.name, tracks };
      }
      case 'dz_track':
      case 'dz_playlist':
      case 'dz_album': {
        const dz = await play.deezer(query);
        if (dz.type === 'track') {
          const t = dz as import('play-dl').DeezerTrack;
          return { kind: 'track', track: { title: `${t.title} — ${t.artist.name}`, duration: t.durationInSec, thumbnail: null, url: null, originalUrl: t.url, query: `${t.title} ${t.artist.name}` } };
        }
        const list = dz as import('play-dl').DeezerPlaylist | import('play-dl').DeezerAlbum;
        const all = await list.all_tracks();
        return {
          kind: 'playlist',
          name: list.title,
          tracks: all.slice(0, PLAYLIST_LIMIT).map((t) => ({ title: `${t.title} — ${t.artist.name}`, duration: t.durationInSec, thumbnail: null, url: null, originalUrl: t.url, query: `${t.title} ${t.artist.name}` })),
        };
      }
      default: {
        if (/^https?:\/\//i.test(query)) return { kind: 'error', reason: 'Ce lien n’est pas pris en charge (YouTube, SoundCloud, Spotify, Deezer).' };
        const found = await searchYoutube(query);
        return found ? { kind: 'track', track: found } : { kind: 'error', reason: `Rien trouvé pour \`${query.slice(0, 100)}\`.` };
      }
    }
  } catch (err) {
    return { kind: 'error', reason: `Recherche impossible : \`${(err as Error).message.slice(0, 200)}\`` };
  }
}

/** Ouvre le flux audio brut (PCM 48 kHz) d'une piste. */
export async function openTrack(track: Track): Promise<Readable> {
  if (!FFMPEG) throw new Error('FFmpeg est introuvable sur la machine du bot');
  if (!track.url && track.query) {
    const found = await searchYoutube(track.query);
    if (!found?.url) throw new Error(`introuvable sur YouTube : ${track.query}`);
    track.url = found.url;
    track.thumbnail ??= found.thumbnail;
    if (!track.duration) track.duration = found.duration;
  }
  if (!track.url) throw new Error('piste sans lien');
  if (/youtu\.?be/.test(track.url)) return normalizedStream(await youtubeStream(track.url));
  const source = await play.stream(track.url);
  return normalizedStream(source.stream);
}

export async function initSources(): Promise<void> {
  try {
    const id = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: id } });
  } catch (err) {
    log.debug(`SoundCloud non configuré : ${(err as Error).message}`);
  }
  if (process.env.YOUTUBE_COOKIE) await play.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } }).catch(() => undefined);
}
