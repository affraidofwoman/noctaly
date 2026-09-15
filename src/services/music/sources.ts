import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import play from 'play-dl';
import prism from 'prism-media';
import { environnement } from '../../core/env';
import { creerRegistre } from '../../core/logger';

const registre = creerRegistre('musique');

export interface Piste {
  titre: string;
  duree: number;
  miniature: string | null;
  url: string | null;
  /** Lien d'origine (Spotify, Deezer) quand la lecture passe par une recherche YouTube. */
  urlOrigine?: string | null;
  /** Recherche YouTube à faire au moment de jouer (pistes Spotify/Deezer). */
  requete?: string | null;
  demandePar: string;
  depuisPlaylist?: boolean;
}

export type PisteResolue = Omit<Piste, 'demandePar'>;

// ─── FFmpeg ────────────────────────────────────────────────────────────────

function trouverFfmpeg(): string | null {
  const candidats: string[] = [];
  if (environnement.cheminFfmpeg) candidats.push(environnement.cheminFfmpeg);
  try {
    const fourni = require('ffmpeg-static') as string | null;
    if (fourni) candidats.push(fourni);
  } catch {
    /* ffmpeg-static absent */
  }
  candidats.push('ffmpeg', 'avconv');
  for (const c of candidats) {
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true, timeout: 10_000 });
      if (!r.error && r.status === 0) return c;
    } catch {
      /* suivant */
    }
  }
  return null;
}

export const FFMPEG = trouverFfmpeg();
if (FFMPEG) {
  if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = FFMPEG;
  const dossier = path.dirname(path.resolve(FFMPEG));
  if (FFMPEG.includes(path.sep) && !String(process.env.PATH).split(path.delimiter).includes(dossier)) {
    process.env.PATH = `${dossier}${path.delimiter}${process.env.PATH ?? ''}`;
  }
} else {
  registre.erreur('FFmpeg introuvable (ni ffmpeg-static, ni ffmpeg sur le PATH) : la musique ne produira aucun son.');
}

/** Filtres repris d'Airline : coupe les infra-graves, normalise et limite pour un volume régulier. */
const FILTRES = process.env.MUSIQUE_FILTRES || ['highpass=f=35', 'dynaudnorm=f=400:g=9:p=0.85:m=4', 'alimiter=level_in=1:level_out=1:limit=0.92:attack=5:release=50'].join(',');

export function fluxNormalise(saisie: Readable): Readable {
  const transcodeur = new prism.FFmpeg({
    args: ['-analyzeduration', '0', '-probesize', '32', '-loglevel', '0', '-i', '-', '-af', FILTRES, '-f', 's16le', '-ar', '48000', '-ac', '2'],
  });
  transcodeur.on('error', (echec: Error) => registre.debogage(`Transcodage : ${echec.message}`));
  saisie.on('error', (echec: Error) => registre.debogage(`Source : ${echec.message}`));
  return saisie.pipe(transcodeur);
}

// ─── yt-dlp (plusieurs commandes et stratégies, comme sur Airline) ────────

const YTDLP_FOURNI = path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'bin', 'yt-dlp');

interface Commande {
  commande: string;
  parametres: string[];
}

const COMMANDES: Commande[] = [
  ...(environnement.cheminYtdlp ? [{ commande: environnement.cheminYtdlp, parametres: [] }] : []),
  { commande: 'yt-dlp', parametres: [] },
  ...(fs.existsSync(YTDLP_FOURNI) ? [{ commande: 'python3', parametres: [YTDLP_FOURNI] }, { commande: 'python', parametres: [YTDLP_FOURNI] }] : []),
  { commande: 'python3', parametres: ['-m', 'yt_dlp'] },
  { commande: 'python', parametres: ['-m', 'yt_dlp'] },
];

const STRATEGIES: { name: string; args: string[] }[] = [
  { name: 'défaut', args: [] },
  { name: 'client android', args: ['--extractor-args', 'youtube:player_client=android'] },
  { name: 'client ios', args: ['--extractor-args', 'youtube:player_client=ios'] },
  { name: 'client web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari'] },
  { name: 'client tv', args: ['--extractor-args', 'youtube:player_client=tv'] },
];

let choisis: Commande | null = null;
const introuvable = (echec: unknown) => /ENOENT|No module named|not recognized/i.test((echec as Error)?.message ?? '');

function executer(commande: Commande, parametres: string[]): ChildProcessWithoutNullStreams {
  return spawn(commande.commande, [...commande.parametres, ...parametres], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function fluxYtdlp(commande: Commande, url: string, strategie: { args: string[] }): Promise<Readable> {
  return new Promise((resoudre, rejeter) => {
    const p = executer(commande, ['-f', 'bestaudio/best', '-o', '-', '--quiet', '--no-warnings', '--no-playlist', ...strategie.args, url]);
    p.stdin.end();
    let erreurs = '';
    let fait = false;
    const conclure = (fonction: () => void) => {
      if (!fait) {
        fait = true;
        fonction();
      }
    };
    p.stderr.on('data', (d: Buffer) => (erreurs += d.toString()));
    p.once('error', (echec) => conclure(() => rejeter(echec)));
    const surLisible = () => {
      if (p.stdout.readableLength === 0) return;
      p.stdout.off('readable', surLisible);
      conclure(() => resoudre(p.stdout));
    };
    p.stdout.on('readable', surLisible);
    p.once('close', (code) => conclure(() => rejeter(new Error(erreurs.trim().split('\n').filter(Boolean).pop() || `code ${code}`))));
  });
}

async function fluxYoutube(url: string): Promise<Readable> {
  const echecs: string[] = [];
  for (const commande of choisis ? [choisis, ...COMMANDES] : COMMANDES) {
    for (const strategie of STRATEGIES) {
      try {
        const flux = await fluxYtdlp(commande, url, strategie);
        choisis = commande;
        return flux;
      } catch (echec) {
        if (introuvable(echec)) {
          echecs.push(`${commande.commande} absent`);
          break;
        }
        echecs.push(`${commande.commande} [${strategie.name}] : ${(echec as Error).message}`);
      }
    }
  }
  choisis = null;
  // Dernier recours : play-dl.
  try {
    const source = await play.stream(url, { discordPlayerCompatibility: true });
    return source.stream;
  } catch (echec) {
    echecs.push(`play-dl : ${(echec as Error).message}`);
  }
  throw new Error(`aucune méthode de lecture n’a fonctionné (${echecs.slice(0, 3).join(' | ')})`);
}

function rechercheYtdlp(commande: Commande, requete: string): Promise<PisteResolue | null> {
  return new Promise((resoudre, rejeter) => {
    const p = executer(commande, [`ytsearch1:${requete}`, '--no-playlist', '--quiet', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(duration)s\t%(thumbnail)s']);
    p.stdin.end();
    let sortie = '';
    let echec = '';
    p.stdout.on('data', (d: Buffer) => (sortie += d.toString()));
    p.stderr.on('data', (d: Buffer) => (echec += d.toString()));
    p.once('error', rejeter);
    p.once('close', (code) => {
      const ligne = sortie.split('\n').map((l) => l.trim()).find(Boolean);
      if (code !== 0) return rejeter(new Error(echec.trim().split('\n').pop() || `code ${code}`));
      if (!ligne) return resoudre(null);
      const [id, titre, duree, miniature] = ligne.split('\t');
      if (!id || !titre) return resoudre(null);
      resoudre({ titre, duree: Number(duree) || 0, miniature: miniature && miniature !== 'NA' ? miniature : null, url: `https://www.youtube.com/watch?v=${id}` });
    });
  });
}

export async function chercherYoutube(requete: string): Promise<PisteResolue | null> {
  try {
    const resultats = await play.search(requete, { limit: 1, source: { youtube: 'video' } });
    const v = resultats[0];
    if (v) return { titre: v.title ?? requete, duree: v.durationInSec, miniature: v.thumbnails[0]?.url ?? null, url: v.url };
  } catch (echec) {
    registre.debogage(`Recherche play-dl en échec : ${(echec as Error).message}`);
  }
  for (const commande of choisis ? [choisis, ...COMMANDES] : COMMANDES) {
    try {
      return await rechercheYtdlp(commande, requete);
    } catch (echec) {
      if (!introuvable(echec)) registre.debogage(`Recherche yt-dlp en échec : ${(echec as Error).message}`);
    }
  }
  return null;
}

// ─── Spotify (API officielle, puis recherche YouTube au moment de jouer) ──

let jetonSpotify: { token: string; expires: number } | null = null;
export const spotifyActif = () => !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET;

async function appelSpotify<T>(route: string): Promise<T> {
  if (!jetonSpotify || jetonSpotify.expires < Date.now()) {
    const identifiants = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const reponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${identifiants}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!reponse.ok) throw new Error(`jeton Spotify refusé (${reponse.status})`);
    const donnees = (await reponse.json()) as { access_token: string; expires_in: number };
    jetonSpotify = { token: donnees.access_token, expires: Date.now() + (donnees.expires_in - 60) * 1000 };
  }
  const reponse = await fetch(route.startsWith('http') ? route : `https://api.spotify.com/v1/${route}`, { headers: { Authorization: `Bearer ${jetonSpotify.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!reponse.ok) throw new Error(`Spotify ${reponse.status}`);
  return (await reponse.json()) as T;
}

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { images?: { url: string }[] };
}

function depuisSpotify(t: SpotifyTrack, miniature: string | null = null): PisteResolue {
  return {
    titre: `${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
    duree: Math.round(t.duration_ms / 1000),
    miniature: t.album?.images?.[0]?.url ?? miniature,
    url: null,
    urlOrigine: `https://open.spotify.com/track/${t.id}`,
    requete: `${t.name} ${t.artists.map((a) => a.name).join(' ')}`,
  };
}

const idSpotify = (url: string) => /(?:track|playlist|album)\/([a-zA-Z0-9]+)/.exec(url)?.[1] ?? null;

export const LIMITE_PLAYLIST = 5000;

// ─── Résolution ────────────────────────────────────────────────────────────

export type ResultatResolution = { kind: 'track'; track: PisteResolue } | { kind: 'playlist'; name: string; tracks: PisteResolue[] } | { kind: 'error'; reason: string };

export async function resoudre(saisie: string): Promise<ResultatResolution> {
  const requete = saisie.trim();
  const type = await play.validate(requete).catch(() => false as const);
  try {
    switch (type) {
      case 'yt_video': {
        const info = await play.video_basic_info(requete);
        const d = info.video_details;
        return { kind: 'track', track: { titre: d.title ?? 'Vidéo YouTube', duree: d.durationInSec, miniature: d.thumbnails[0]?.url ?? null, url: d.url } };
      }
      case 'yt_playlist': {
        const liste = await play.playlist_info(requete, { incomplete: true });
        const videos = await liste.all_videos();
        return {
          kind: 'playlist',
          name: liste.title ?? 'Playlist YouTube',
          tracks: videos.slice(0, LIMITE_PLAYLIST).map((v) => ({ titre: v.title ?? 'Vidéo', duree: v.durationInSec, miniature: v.thumbnails[0]?.url ?? null, url: v.url })),
        };
      }
      case 'so_track':
      case 'so_playlist': {
        const soundcloud = await play.soundcloud(requete);
        if (soundcloud.type === 'track') return { kind: 'track', track: { titre: soundcloud.name, duree: soundcloud.durationInSec, miniature: (soundcloud as { thumbnail?: string }).thumbnail ?? null, url: soundcloud.url } };
        const pistes = await (soundcloud as import('play-dl').SoundCloudPlaylist).all_tracks();
        return { kind: 'playlist', name: soundcloud.name, tracks: pistes.slice(0, LIMITE_PLAYLIST).map((t) => ({ titre: t.name, duree: t.durationInSec, miniature: t.thumbnail ?? null, url: t.url })) };
      }
      case 'sp_track':
      case 'sp_playlist':
      case 'sp_album': {
        if (!spotifyActif()) return { kind: 'error', reason: 'Spotify n’est pas configuré sur ce bot (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).' };
        const id = idSpotify(requete);
        if (!id) return { kind: 'error', reason: 'Lien Spotify illisible.' };
        if (type === 'sp_track') return { kind: 'track', track: depuisSpotify(await appelSpotify<SpotifyTrack>(`tracks/${id}`)) };
        if (type === 'sp_album') {
          const album = await appelSpotify<{ name: string; images: { url: string }[]; tracks: { items: SpotifyTrack[] } }>(`albums/${id}`);
          return { kind: 'playlist', name: album.name, tracks: album.tracks.items.map((t) => depuisSpotify(t, album.images[0]?.url ?? null)) };
        }
        const playlist = await appelSpotify<{ name: string; tracks: { items: { track: SpotifyTrack | null }[]; next: string | null } }>(`playlists/${id}`);
        const pistes: PisteResolue[] = playlist.tracks.items.filter((i) => i.track).map((i) => depuisSpotify(i.track!));
        let suivant = playlist.tracks.next;
        while (suivant && pistes.length < LIMITE_PLAYLIST) {
          const page = await appelSpotify<{ items: { track: SpotifyTrack | null }[]; next: string | null }>(suivant);
          pistes.push(...page.items.filter((i) => i.track).map((i) => depuisSpotify(i.track!)));
          suivant = page.next;
        }
        return { kind: 'playlist', name: playlist.name, tracks: pistes };
      }
      case 'dz_track':
      case 'dz_playlist':
      case 'dz_album': {
        const dz = await play.deezer(requete);
        if (dz.type === 'track') {
          const t = dz as import('play-dl').DeezerTrack;
          return { kind: 'track', track: { titre: `${t.title} — ${t.artist.name}`, duree: t.durationInSec, miniature: null, url: null, urlOrigine: t.url, requete: `${t.title} ${t.artist.name}` } };
        }
        const liste = dz as import('play-dl').DeezerPlaylist | import('play-dl').DeezerAlbum;
        const lireTout = await liste.all_tracks();
        return {
          kind: 'playlist',
          name: liste.title,
          tracks: lireTout.slice(0, LIMITE_PLAYLIST).map((t) => ({ titre: `${t.title} — ${t.artist.name}`, duree: t.durationInSec, miniature: null, url: null, urlOrigine: t.url, requete: `${t.title} ${t.artist.name}` })),
        };
      }
      default: {
        if (/^https?:\/\//i.test(requete)) return { kind: 'error', reason: 'Ce lien n’est pas pris en charge (YouTube, SoundCloud, Spotify, Deezer).' };
        const trouve = await chercherYoutube(requete);
        return trouve ? { kind: 'track', track: trouve } : { kind: 'error', reason: `Rien trouvé pour \`${requete.slice(0, 100)}\`.` };
      }
    }
  } catch (echec) {
    return { kind: 'error', reason: `Recherche impossible : \`${(echec as Error).message.slice(0, 200)}\`` };
  }
}

/** Ouvre le flux audio brut (PCM 48 kHz) d'une piste. */
export async function ouvrirPiste(piste: Piste): Promise<Readable> {
  if (!FFMPEG) throw new Error('FFmpeg est introuvable sur la machine du bot');
  if (!piste.url && piste.requete) {
    const trouve = await chercherYoutube(piste.requete);
    if (!trouve?.url) throw new Error(`introuvable sur YouTube : ${piste.requete}`);
    piste.url = trouve.url;
    piste.miniature ??= trouve.miniature;
    if (!piste.duree) piste.duree = trouve.duree;
  }
  if (!piste.url) throw new Error('piste sans lien');
  if (/youtu\.?be/.test(piste.url)) return fluxNormalise(await fluxYoutube(piste.url));
  const source = await play.stream(piste.url);
  return fluxNormalise(source.stream);
}

export async function initialiserSources(): Promise<void> {
  try {
    const id = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: id } });
  } catch (echec) {
    registre.debogage(`SoundCloud non configuré : ${(echec as Error).message}`);
  }
  if (process.env.YOUTUBE_COOKIE) await play.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } }).catch(() => undefined);
}
