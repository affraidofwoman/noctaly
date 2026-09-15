import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import play from 'play-dl';
import prism from 'prism-media';
import { aNiveau, emojiPour, estWhitelist } from '../coeur/acces';
import { bouton, couleurPour, erreur, estLienHttp, nomEnseigne, ok, rangee } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, type PanneauAffiche, prefixePanneau, sur } from '../coeur/noyau';
import { barreProgression, creerRegistre, environnement, ErreurUtilisateur, formaterHorloge, tronquer, Niveau } from '../coeur/outils';
import { lireConfig } from '../coeur/reglages';

const registre = creerRegistre('musique');

export interface Piste {
  titre: string;
  duree: number;
  miniature: string | null;
  url: string | null;
  urlOrigine?: string | null;
  requete?: string | null;
  demandePar: string;
  depuisPlaylist?: boolean;
}

export type PisteResolue = Omit<Piste, 'demandePar'>;

// - FFmpeg -

function trouverFfmpeg(): string | null {
  const candidats: string[] = [];
  if (environnement.cheminFfmpeg) candidats.push(environnement.cheminFfmpeg);
  try {
    const fourni = require('ffmpeg-static') as string | null;
    if (fourni) candidats.push(fourni);
  } catch {}
  candidats.push('ffmpeg', 'avconv');
  for (const c of candidats) {
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true, timeout: 10_000 });
      if (!r.error && r.status === 0) return c;
    } catch {}
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

const FILTRES = process.env.MUSIQUE_FILTRES || ['highpass=f=35', 'dynaudnorm=f=400:g=9:p=0.85:m=4', 'alimiter=level_in=1:level_out=1:limit=0.92:attack=5:release=50'].join(',');

export function fluxNormalise(saisie: Readable): Readable {
  const transcodeur = new prism.FFmpeg({
    args: ['-analyzeduration', '0', '-probesize', '32', '-loglevel', '0', '-i', '-', '-af', FILTRES, '-f', 's16le', '-ar', '48000', '-ac', '2'],
  });
  transcodeur.on('error', (echec: Error) => registre.debogage(`Transcodage : ${echec.message}`));
  saisie.on('error', (echec: Error) => registre.debogage(`Source : ${echec.message}`));
  return saisie.pipe(transcodeur);
}

// - Binaire yt-dlp autonome -
// Binaire propre à la plateforme, rangé avec les données : ni Python ni fichier dans le dépôt.
const BINAIRES_YTDLP: Record<string, string> = { 'linux:x64': 'yt-dlp_linux', 'linux:arm64': 'yt-dlp_linux_aarch64', 'win32:x64': 'yt-dlp.exe', 'win32:arm64': 'yt-dlp.exe', 'darwin:x64': 'yt-dlp_macos', 'darwin:arm64': 'yt-dlp_macos' };

export function fichierYtdlp(plateforme: string = process.platform, architecture: string = process.arch): { nom: string; chemin: string } | null {
  const nom = BINAIRES_YTDLP[`${plateforme}:${architecture}`];
  return nom ? { nom, chemin: path.join(path.dirname(environnement.cheminBase), 'bin', nom) } : null;
}

interface Commande {
  commande: string;
  parametres: string[];
}

const commandesYtdlp = (): Commande[] => {
  const autonome = fichierYtdlp();
  return [
    ...(environnement.cheminYtdlp ? [{ commande: environnement.cheminYtdlp, parametres: [] }] : []),
    ...(autonome && fs.existsSync(autonome.chemin) ? [{ commande: autonome.chemin, parametres: [] }] : []),
    { commande: 'yt-dlp', parametres: [] },
    { commande: 'python3', parametres: ['-m', 'yt_dlp'] },
  ];
};

// - Mise à jour de yt-dlp -
// Une version téléchargée ne remplace l’actuelle qu’après avoir répondu.
export function verifierExecutable(donnees: Buffer, plateforme: string = process.platform): string | null {
  if (donnees.length < 5_000_000) return `fichier trop petit (${donnees.length} octets)`;
  const entete = donnees.subarray(0, 4);
  const valide = plateforme === 'win32' ? entete.subarray(0, 2).equals(Buffer.from('MZ')) : plateforme === 'linux' ? entete.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) : [0xcffaedfe, 0xcafebabe, 0xfeedfacf].includes(entete.readUInt32BE(0));
  return valide ? null : 'ce n’est pas un exécutable yt-dlp';
}

function versionYtdlp(fichier: string): string | null {
  const r = spawnSync(fichier, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const version = r.status === 0 ? r.stdout.trim().split('\n')[0] : '';
  return version || null;
}

export async function mettreAJourYtdlp(): Promise<string> {
  const cible = fichierYtdlp();
  if (!cible) return `aucun binaire pour ${process.platform} ${process.arch}`;
  if (toutesSessions().some((s) => s.actuel)) return 'lecture en cours, report';
  const actuelle = fs.existsSync(cible.chemin) ? versionYtdlp(cible.chemin) : null;
  const entete = { 'User-Agent': 'noctaly', Accept: 'application/vnd.github+json' };
  const derniere = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: entete, signal: AbortSignal.timeout(15_000) });
  if (!derniere.ok) throw new Error(`GitHub a répondu ${derniere.status}`);
  const tag = String(((await derniere.json()) as { tag_name?: string }).tag_name ?? '').trim();
  if (!tag) throw new Error('aucune version publiée lisible');
  if (actuelle === tag) return `déjà à jour (${tag})`;
  const reponse = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${cible.nom}`, { headers: entete, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!reponse.ok) throw new Error(`téléchargement refusé (${reponse.status})`);
  const donnees = Buffer.from(await reponse.arrayBuffer());
  const refus = verifierExecutable(donnees);
  if (refus) throw new Error(refus);
  const temporaire = `${cible.chemin}.nouveau`;
  fs.mkdirSync(path.dirname(cible.chemin), { recursive: true });
  fs.writeFileSync(temporaire, donnees, { mode: 0o755 });
  const nouvelle = versionYtdlp(temporaire);
  if (!nouvelle) {
    fs.rmSync(temporaire, { force: true });
    throw new Error('la version téléchargée ne répond pas, remplacement annulé');
  }
  fs.renameSync(temporaire, cible.chemin);
  choisis = null;
  return `${actuelle ?? 'aucune'} → ${nouvelle}`;
}

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
  for (const commande of choisis ? [choisis, ...commandesYtdlp()] : commandesYtdlp()) {
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
  for (const commande of choisis ? [choisis, ...commandesYtdlp()] : commandesYtdlp()) {
    try {
      return await rechercheYtdlp(commande, requete);
    } catch (echec) {
      if (!introuvable(echec)) registre.debogage(`Recherche yt-dlp en échec : ${(echec as Error).message}`);
    }
  }
  return null;
}

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

// - Résolution -

export type ResultatResolution = { genre: 'track'; piste: PisteResolue } | { genre: 'playlist'; nom: string; pistes: PisteResolue[] } | { genre: 'error'; raison: string };

export async function resoudre(saisie: string): Promise<ResultatResolution> {
  const requete = saisie.trim();
  const type = await play.validate(requete).catch(() => false as const);
  try {
    switch (type) {
      case 'yt_video': {
        const info = await play.video_basic_info(requete);
        const d = info.video_details;
        return { genre: 'track', piste: { titre: d.title ?? 'Vidéo YouTube', duree: d.durationInSec, miniature: d.thumbnails[0]?.url ?? null, url: d.url } };
      }
      case 'yt_playlist': {
        const liste = await play.playlist_info(requete, { incomplete: true });
        const videos = await liste.all_videos();
        return {
          genre: 'playlist',
          nom: liste.title ?? 'Playlist YouTube',
          pistes: videos.slice(0, LIMITE_PLAYLIST).map((v) => ({ titre: v.title ?? 'Vidéo', duree: v.durationInSec, miniature: v.thumbnails[0]?.url ?? null, url: v.url })),
        };
      }
      case 'so_track':
      case 'so_playlist': {
        const soundcloud = await play.soundcloud(requete);
        if (soundcloud.type === 'track') return { genre: 'track', piste: { titre: soundcloud.name, duree: soundcloud.durationInSec, miniature: (soundcloud as { thumbnail?: string }).thumbnail ?? null, url: soundcloud.url } };
        const pistes = await (soundcloud as import('play-dl').SoundCloudPlaylist).all_tracks();
        return { genre: 'playlist', nom: soundcloud.name, pistes: pistes.slice(0, LIMITE_PLAYLIST).map((t) => ({ titre: t.name, duree: t.durationInSec, miniature: t.thumbnail ?? null, url: t.url })) };
      }
      case 'sp_track':
      case 'sp_playlist':
      case 'sp_album': {
        if (!spotifyActif()) return { genre: 'error', raison: 'Spotify n’est pas configuré sur ce bot (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).' };
        const id = idSpotify(requete);
        if (!id) return { genre: 'error', raison: 'Lien Spotify illisible.' };
        if (type === 'sp_track') return { genre: 'track', piste: depuisSpotify(await appelSpotify<SpotifyTrack>(`tracks/${id}`)) };
        if (type === 'sp_album') {
          const album = await appelSpotify<{ name: string; images: { url: string }[]; tracks: { items: SpotifyTrack[] } }>(`albums/${id}`);
          return { genre: 'playlist', nom: album.name, pistes: album.tracks.items.map((t) => depuisSpotify(t, album.images[0]?.url ?? null)) };
        }
        const playlist = await appelSpotify<{ name: string; tracks: { items: { track: SpotifyTrack | null }[]; next: string | null } }>(`playlists/${id}`);
        const pistes: PisteResolue[] = playlist.tracks.items.filter((i) => i.track).map((i) => depuisSpotify(i.track!));
        let suivant = playlist.tracks.next;
        while (suivant && pistes.length < LIMITE_PLAYLIST) {
          const page = await appelSpotify<{ items: { track: SpotifyTrack | null }[]; next: string | null }>(suivant);
          pistes.push(...page.items.filter((i) => i.track).map((i) => depuisSpotify(i.track!)));
          suivant = page.next;
        }
        return { genre: 'playlist', nom: playlist.name, pistes };
      }
      case 'dz_track':
      case 'dz_playlist':
      case 'dz_album': {
        const dz = await play.deezer(requete);
        if (dz.type === 'track') {
          const t = dz as import('play-dl').DeezerTrack;
          return { genre: 'track', piste: { titre: `${t.title} — ${t.artist.name}`, duree: t.durationInSec, miniature: null, url: null, urlOrigine: t.url, requete: `${t.title} ${t.artist.name}` } };
        }
        const liste = dz as import('play-dl').DeezerPlaylist | import('play-dl').DeezerAlbum;
        const morceaux = await liste.all_tracks();
        return {
          genre: 'playlist',
          nom: liste.title,
          pistes: morceaux.slice(0, LIMITE_PLAYLIST).map((t) => ({ titre: `${t.title} — ${t.artist.name}`, duree: t.durationInSec, miniature: null, url: null, urlOrigine: t.url, requete: `${t.title} ${t.artist.name}` })),
        };
      }
      default: {
        if (/^https?:\/\//i.test(requete)) return { genre: 'error', raison: 'Ce lien n’est pas pris en charge (YouTube, SoundCloud, Spotify, Deezer).' };
        const trouve = await chercherYoutube(requete);
        return trouve ? { genre: 'track', piste: trouve } : { genre: 'error', raison: `Rien trouvé pour \`${requete.slice(0, 100)}\`.` };
      }
    }
  } catch (echec) {
    return { genre: 'error', raison: `Recherche impossible : \`${(echec as Error).message.slice(0, 200)}\`` };
  }
}

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

const registreLecteur = creerRegistre('musique');

export type ModeBoucle = 'off' | 'track' | 'queue';
export const LIBELLES_BOUCLE: Record<ModeBoucle, string> = { off: 'désactivée', track: 'le morceau', queue: 'la file' };

export const FILE_ACTIVE_MAX = 1000;
const HISTORIQUE_MAX = 20;

export interface EvenementsLecteur {
  surDebut(session: LecteurServeur, piste: Piste): void;
  surErreur(session: LecteurServeur, piste: Piste | null, erreur: Error): void;
  surFin(session: LecteurServeur): void;
}

export class LecteurServeur {
  connexion: VoiceConnection | null = null;
  readonly lecteur: AudioPlayer;
  ressource: AudioResource | null = null;
  file: Piste[] = [];
  reserve: Piste[] = [];
  historique: Piste[] = [];
  actuel: Piste | null = null;
  boucle: ModeBoucle = 'off';
  volume: number;
  salonTexteId: string | null = null;
  votesPasser = new Set<string>();
  joues = 0;
  messagePanneauId: string | null = null;
  private minuteurInactivite: NodeJS.Timeout | null = null;
  private minuteurVide: NodeJS.Timeout | null = null;
  private detruit = false;
  private demarrage = false;

  constructor(
    readonly serveur: Guild,
    private readonly evenements: EvenementsLecteur,
    private readonly surDestruction: (serveurId: string) => void,
  ) {
    this.volume = Math.min(Math.max(lireConfig(serveur.id).musique.volumeParDefaut, 1), 200) / 100;
    this.lecteur = createAudioPlayer();
    this.lecteur.on(AudioPlayerStatus.Idle, () => void this.suivant());
    this.lecteur.on('error', (echec) => {
      registreLecteur.avertir(`Erreur de lecture sur ${this.serveur.id} : ${echec.message}`);
      this.evenements.surErreur(this, this.actuel, echec);
    });
  }

  get channelId(): string | null {
    return this.connexion?.joinConfig.channelId ?? null;
  }

  get paused(): boolean {
    return this.lecteur.state.status === AudioPlayerStatus.Paused || this.lecteur.state.status === AudioPlayerStatus.AutoPaused;
  }

  get waiting(): number {
    return this.file.length + this.reserve.length;
  }

  get elapsed(): number {
    return Math.floor((this.ressource?.playbackDuration ?? 0) / 1000);
  }

  rejoindre(salon: VoiceBasedChannel): VoiceConnection {
    if (this.connexion && this.connexion.joinConfig.channelId === salon.id && this.connexion.state.status !== VoiceConnectionStatus.Destroyed) return this.connexion;
    this.connexion?.destroy();
    const connexion = joinVoiceChannel({
      channelId: salon.id,
      guildId: salon.guild.id,
      adapterCreator: salon.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connexion.subscribe(this.lecteur);
    this.connexion = connexion;
    connexion.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connexion, VoiceConnectionStatus.Signalling, 5_000), entersState(connexion, VoiceConnectionStatus.Connecting, 5_000)]);
      } catch {
        if (this.connexion === connexion) this.detruire();
      }
    });
    return connexion;
  }

  ajouter(pistes: Piste[]): { position: number; immediat: boolean; reserves: number } {
    const enLecture = !!this.actuel || this.demarrage;
    const position = this.file.length + this.reserve.length + 1;
    const place = Math.max(0, FILE_ACTIVE_MAX - this.file.length);
    this.file.push(...pistes.slice(0, place));
    if (pistes.length > place) this.reserve.push(...pistes.slice(place));
    const fileMax = lireConfig(this.serveur.id).musique.fileMax;
    if (fileMax > 0 && this.waiting > fileMax * 25) this.reserve.length = Math.max(0, fileMax * 25 - this.file.length);
    this.annulerInactivite();
    if (!enLecture) void this.suivant();
    return { position, immediat: !enLecture, reserves: this.reserve.length };
  }

  private recharger(): void {
    if (!this.reserve.length) return;
    const place = FILE_ACTIVE_MAX - this.file.length;
    if (place > 0) this.file.push(...this.reserve.splice(0, place));
  }

  private async jouer(piste: Piste): Promise<void> {
    this.actuel = piste;
    this.votesPasser.clear();
    this.demarrage = true;
    try {
      const flux = await ouvrirPiste(piste);
      const ressource = createAudioResource(flux, { inputType: StreamType.Raw, inlineVolume: true });
      ressource.volume?.setVolumeLogarithmic(this.volume);
      this.ressource = ressource;
      if (this.connexion && this.connexion.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connexion, VoiceConnectionStatus.Ready, 20_000).catch(() => {
          throw new Error('la connexion vocale n’est jamais devenue prête (vérifie mes permissions Parler)');
        });
      }
      this.lecteur.play(ressource);
      this.joues++;
      this.evenements.surDebut(this, piste);
    } finally {
      this.demarrage = false;
    }
  }

  async suivant(): Promise<void> {
    if (this.detruit || this.demarrage) return;
    const termine = this.actuel;
    if (termine) {
      if (this.boucle === 'track') {
        await this.jouer(termine).catch((echec: Error) => this.echouer(termine, echec));
        return;
      }
      this.historique.push(termine);
      if (this.historique.length > HISTORIQUE_MAX) this.historique.shift();
      if (this.boucle === 'queue') this.file.push(termine);
    }
    this.recharger();
    const aVenir = this.file.shift();
    if (!aVenir) {
      this.actuel = null;
      this.ressource = null;
      this.evenements.surFin(this);
      this.armerInactivite();
      return;
    }
    await this.jouer(aVenir).catch((echec: Error) => this.echouer(aVenir, echec));
  }

  private async echouer(piste: Piste, echec: Error): Promise<void> {
    registreLecteur.avertir(`Lecture impossible (${piste.titre}) : ${echec.message}`);
    this.evenements.surErreur(this, piste, echec);
    if (this.boucle === 'track') this.boucle = 'off';
    this.actuel = null;
    await this.suivant();
  }

  passer(): Piste | null {
    const ignores = this.actuel;
    const boucle = this.boucle;
    if (boucle === 'track') this.boucle = 'off';
    this.lecteur.stop(true);
    if (boucle === 'track') setTimeout(() => (this.boucle = boucle), 1_000).unref();
    return ignores;
  }

  precedent(): Piste | null {
    const anterieur = this.historique.pop();
    if (!anterieur) return null;
    if (this.actuel) this.file.unshift(this.actuel);
    this.file.unshift(anterieur);
    this.actuel = null;
    this.lecteur.stop(true);
    if (this.lecteur.state.status === AudioPlayerStatus.Idle && !this.demarrage) void this.suivant();
    return anterieur;
  }

  basculerPause(): boolean {
    if (this.paused) this.lecteur.unpause();
    else this.lecteur.pause();
    return this.paused;
  }

  reglerVolume(pourcentage: number): void {
    this.volume = Math.min(Math.max(pourcentage, 1), 200) / 100;
    this.ressource?.volume?.setVolumeLogarithmic(this.volume);
  }

  melanger(): number {
    const lireTout = [...this.file, ...this.reserve];
    for (let i = lireTout.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [lireTout[i], lireTout[j]] = [lireTout[j]!, lireTout[i]!];
    }
    this.file = lireTout.slice(0, FILE_ACTIVE_MAX);
    this.reserve = lireTout.slice(FILE_ACTIVE_MAX);
    return lireTout.length;
  }

  retirer(position: number): Piste | null {
    const indice = position - 1;
    if (indice < 0) return null;
    if (indice < this.file.length) {
      const [retiree] = this.file.splice(indice, 1);
      this.recharger();
      return retiree ?? null;
    }
    const enReserve = indice - this.file.length;
    return this.reserve.splice(enReserve, 1)[0] ?? null;
  }

  retirerPistesPlaylist(): number {
    const avant = this.waiting;
    this.file = this.file.filter((t) => !t.depuisPlaylist);
    this.reserve = this.reserve.filter((t) => !t.depuisPlaylist);
    this.recharger();
    return avant - this.waiting;
  }

  tempsAvant(indice: number): number {
    let total = this.actuel ? Math.max(0, (this.actuel.duree || 0) - this.elapsed) : 0;
    const lireTout = this.reserve.length ? [...this.file, ...this.reserve] : this.file;
    for (let i = 0; i < indice; i++) total += lireTout[i]?.duree || 0;
    return total;
  }

  estDansLeSalon(membre: GuildMember): boolean {
    return !!this.channelId && membre.voice.channelId === this.channelId;
  }

  auditeursHumains(): number {
    const salon = this.channelId ? this.serveur.channels.cache.get(this.channelId) : null;
    return salon && salon.isVoiceBased() ? salon.members.filter((m) => !m.user.bot).size : 0;
  }

  votesRequis(): number {
    return Math.max(1, Math.ceil(this.auditeursHumains() / 2));
  }

  private armerInactivite(): void {
    this.annulerInactivite();
    this.minuteurInactivite = setTimeout(() => this.detruire(), 5 * 60_000);
    this.minuteurInactivite.unref();
  }

  private annulerInactivite(): void {
    if (this.minuteurInactivite) clearTimeout(this.minuteurInactivite);
    this.minuteurInactivite = null;
  }

  verifierVide(): void {
    const minutes = lireConfig(this.serveur.id).musique.quitterSiVideMinutes;
    if (!this.channelId || minutes <= 0) return;
    if (this.auditeursHumains() > 0) {
      if (this.minuteurVide) clearTimeout(this.minuteurVide);
      this.minuteurVide = null;
      return;
    }
    if (this.minuteurVide) return;
    this.minuteurVide = setTimeout(() => {
      if (this.auditeursHumains() === 0) this.detruire();
    }, minutes * 60_000);
    this.minuteurVide.unref();
  }

  detruire(): void {
    if (this.detruit) return;
    this.detruit = true;
    this.annulerInactivite();
    if (this.minuteurVide) clearTimeout(this.minuteurVide);
    this.file = [];
    this.reserve = [];
    this.lecteur.stop(true);
    try {
      this.connexion?.destroy();
    } catch {}
    this.connexion = null;
    this.surDestruction(this.serveur.id);
  }
}

const sessions = new Map<string, LecteurServeur>();

export function lireSession(serveurId: string): LecteurServeur | undefined {
  return sessions.get(serveurId);
}

export function obtenirSession(serveur: Guild, evenements: EvenementsLecteur): LecteurServeur {
  let session = sessions.get(serveur.id);
  if (!session) {
    session = new LecteurServeur(serveur, evenements, (id) => sessions.delete(id));
    sessions.set(serveur.id, session);
  }
  return session;
}

export function toutesSessions(): LecteurServeur[] {
  return [...sessions.values()];
}

export function detruireTout(): void {
  for (const s of sessions.values()) s.detruire();
}

export type { Client };

const registreMusique = creerRegistre('musique');
const derniereAnnonce = new Map<string, Message>();

// - Rendu -

const titreLie = (t: Piste) => {
  const url = t.urlOrigine ?? t.url;
  return url ? `[${tronquer(t.titre, 200)}](${url})` : tronquer(t.titre, 200);
};

function controles(session: LecteurServeur | undefined, serveurId: string): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const enPause = session?.paused ?? false;
  const boucle = session?.boucle ?? 'off';
  return [
    rangee(
      bouton('mu:prev', '', ButtonStyle.Secondary, '⏮️').setDisabled(!session?.historique.length),
      bouton('mu:toggle', '', enPause ? ButtonStyle.Success : ButtonStyle.Primary, '⏯️'),
      bouton('mu:skip', '', ButtonStyle.Secondary, '⏭️'),
    ),
    rangee(
      bouton('mu:shuffle', '', ButtonStyle.Secondary, '🔀'),
      bouton('mu:loop', boucle === 'off' ? '' : boucle === 'track' ? '1' : '∞', boucle === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success, '🔁'),
      bouton('mu:stop', '', ButtonStyle.Danger, '⏹️'),
      bouton('mu:queue', '', ButtonStyle.Secondary, emojiPour(serveurId, 'message')),
    ),
  ];
}

export function embedLecture(serveur: Guild, session: LecteurServeur | undefined): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(couleurPour(serveur)).setAuthor({ name: '🎵 NOW PLAYING' });
  const piste = session?.actuel;
  if (!session || !piste) {
    return embed.setDescription('💤 **Rien en lecture.** Lance `/play` ou `m!play <titre ou lien>` pour démarrer.');
  }
  const ecoule = Math.min(session.elapsed, piste.duree || session.elapsed);
  embed
    .setDescription(
      [
        `${session.paused ? '⏸️' : '▶️'} **${titreLie(piste)}**`,
        `${barreProgression(piste.duree ? ecoule / piste.duree : 0, 16)}  \`${formaterHorloge(ecoule)} / ${formaterHorloge(piste.duree)}\``,
      ].join('\n'),
    )
    .addFields(
      { name: '🔊 Volume', value: `${Math.round(session.volume * 100)} %`, inline: true },
      { name: '🔁 Boucle', value: LIBELLES_BOUCLE[session.boucle], inline: true },
      { name: '📋 En attente', value: `${session.waiting} morceau${session.waiting > 1 ? 'x' : ''}`, inline: true },
      { name: '👤 Demandé par', value: `<@${piste.demandePar}>`, inline: true },
      { name: '⏳ Restant', value: piste.duree ? formaterHorloge(Math.max(0, piste.duree - ecoule)) : '—', inline: true },
      { name: '🎧 Salon', value: session.channelId ? `<#${session.channelId}>` : '—', inline: true },
    )
    .setFooter({ text: `${nomEnseigne(serveur)} · m!play · m!skip · m!stop · m!panel` });
  if (piste.miniature && estLienHttp(piste.miniature)) embed.setThumbnail(piste.miniature);
  return embed;
}

function embedFile(serveur: Guild, session: LecteurServeur, page = 0): EmbedBuilder {
  const lireTout = [...session.file, ...session.reserve];
  const parPage = 10;
  const pages = Math.max(1, Math.ceil(lireTout.length / parPage));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const lignes = lireTout.slice(p * parPage, (p + 1) * parPage).map((t, i) => `**${p * parPage + i + 1}.** ${tronquer(t.titre, 80)} \`[${formaterHorloge(t.duree)}]\` — <@${t.demandePar}>`);
  return new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle('📋 File d’attente')
    .setDescription(
      `${session.actuel ? `**En cours :** ${titreLie(session.actuel)} \`[${formaterHorloge(session.actuel.duree)}]\`\n\n` : ''}${lignes.length ? lignes.join('\n') : '_Rien après le morceau en cours._'}`,
    )
    .setFooter({ text: `Page ${p + 1}/${pages} · ${lireTout.length} en attente · Boucle : ${LIBELLES_BOUCLE[session.boucle]} · Volume : ${Math.round(session.volume * 100)}%` });
}

// - Événements du lecteur -

function salonTexte(session: LecteurServeur): GuildTextBasedChannel | null {
  const salonVise = session.salonTexteId ? session.serveur.channels.cache.get(session.salonTexteId) : null;
  return salonVise && salonVise.isTextBased() ? (salonVise as GuildTextBasedChannel) : null;
}

async function annonce(session: LecteurServeur, charge: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<MessageActionRowComponentBuilder>[] }) {
  const salon = salonTexte(session);
  if (!salon) return;
  const envoye = await salon.send(charge).catch(() => null);
  const precedent = derniereAnnonce.get(session.serveur.id);
  if (envoye) derniereAnnonce.set(session.serveur.id, envoye);
  if (precedent && envoye && precedent.id !== envoye.id) await precedent.delete().catch(() => undefined);
}

const evenements: EvenementsLecteur = {
  surDebut(session) {
    if (!lireConfig(session.serveur.id).musique.annoncerLecture) return;
    void annonce(session, { embeds: [embedLecture(session.serveur, session)], components: controles(session, session.serveur.id) });
  },
  surErreur(session, piste, erreur) {
    void annonce(session, {
      embeds: [new EmbedBuilder().setColor(couleurPour(session.serveur, 'erreur')).setDescription(`⚠️ Impossible de lire **${tronquer(piste?.titre ?? 'ce morceau', 150)}** : \`${tronquer(erreur.message, 200)}\`. Passage au suivant.`)],
    });
  },
  surFin(session) {
    void annonce(session, { embeds: [new EmbedBuilder().setColor(couleurPour(session.serveur)).setDescription('📭 File terminée. Ajoute un morceau avec `m!play` — je quitte le vocal dans 5 minutes sinon.')] });
  },
};

function estDj(membre: GuildMember): boolean {
  const reglages = lireConfig(membre.guild.id).musique;
  return aNiveau(membre, Niveau.STAFF) || estWhitelist('dj', membre.id, membre.guild.id) || membre.roles.cache.some((r) => reglages.rolesDj.includes(r.id));
}

function exigerSession(serveur: Guild, exigerPiste = false): LecteurServeur {
  const session = lireSession(serveur.id);
  if (!session?.connexion) throw new ErreurUtilisateur('Je ne suis pas en vocal.');
  if (exigerPiste && !session.actuel) throw new ErreurUtilisateur('Rien n’est en train de jouer.');
  return session;
}

function exigerMemeSalon(membre: GuildMember, session: LecteurServeur): void {
  if (!session.estDansLeSalon(membre) && !estDj(membre)) throw new ErreurUtilisateur('Rejoins le salon vocal du bot pour contrôler la lecture.');
}

function vocalDe(membre: GuildMember) {
  const salon = membre.voice.channel;
  if (!salon) throw new ErreurUtilisateur('Rejoins un salon vocal d’abord.');
  const permissions = salon.permissionsFor(membre.guild.members.me!);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new ErreurUtilisateur('Je n’ai pas la permission de rejoindre / parler dans ce salon.');
  const occupe = lireSession(membre.guild.id);
  if (occupe?.channelId && occupe.channelId !== salon.id && occupe.actuel && !estDj(membre)) throw new ErreurUtilisateur(`Je joue déjà dans <#${occupe.channelId}>.`);
  return salon;
}

async function lancerLecture(membre: GuildMember, salonTexteId: string, requete: string): Promise<EmbedBuilder> {
  if (!requete.trim()) throw new ErreurUtilisateur('Usage : `m!play <lien ou recherche>`.');
  if (!FFMPEG) throw new ErreurUtilisateur('FFmpeg est introuvable sur la machine du bot : la musique est indisponible.');
  const salon = vocalDe(membre);
  const resultat = await resoudre(requete);
  if (resultat.genre === 'error') throw new ErreurUtilisateur(resultat.raison);
  const session = obtenirSession(membre.guild, evenements);
  session.salonTexteId = salonTexteId;
  session.rejoindre(salon);
  const serveur = membre.guild;

  if (resultat.genre === 'playlist') {
    if (!resultat.pistes.length) throw new ErreurUtilisateur('Cette playlist est vide ou inaccessible.');
    const pistes = resultat.pistes.map((t) => ({ ...t, demandePar: membre.id, depuisPlaylist: true }));
    const { reserves } = session.ajouter(pistes);
    return ok(serveur, `Playlist **${tronquer(resultat.nom, 100)}** ajoutée — **${pistes.length}** morceaux, à partir de **${tronquer(pistes[0]!.titre, 100)}**${reserves ? ` — dont **${reserves}** en réserve, qui remonteront tout seuls` : ''}.`);
  }

  const piste: Piste = { ...resultat.piste, demandePar: membre.id };
  const { position, immediat } = session.ajouter([piste]);
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setAuthor({ name: immediat ? 'Lecture en cours' : 'Ajouté à la file' })
    .addFields({ name: 'Morceau', value: titreLie(piste) })
    .setFooter({ text: `Demandé par ${membre.user.username}`, iconURL: membre.user.displayAvatarURL({ size: 64 }) });
  if (piste.miniature && estLienHttp(piste.miniature)) embed.setThumbnail(piste.miniature);
  if (immediat) embed.addFields({ name: 'Durée du morceau', value: formaterHorloge(piste.duree), inline: true });
  else {
    embed.addFields(
      { name: 'Avant lecture (estimé)', value: formaterHorloge(session.tempsAvant(position - 1)), inline: true },
      { name: 'Durée du morceau', value: formaterHorloge(piste.duree), inline: true },
      { name: 'Position dans la file', value: String(position), inline: true },
    );
  }
  return embed;
}

type Action = 'pause' | 'resume' | 'toggle' | 'skip' | 'stop' | 'shuffle' | 'prev' | 'join' | 'leave' | 'cancelplaylist';

function executerAction(membre: GuildMember, action: Action, salonTexteId: string | null): string {
  const serveur = membre.guild;
  if (action === 'join') {
    const salon = vocalDe(membre);
    const session = obtenirSession(serveur, evenements);
    if (salonTexteId) session.salonTexteId = salonTexteId;
    session.rejoindre(salon);
    return `✅ Rejoint **${salon.name}**.`;
  }
  const session = exigerSession(serveur, ['pause', 'resume', 'toggle', 'skip', 'prev'].includes(action));
  exigerMemeSalon(membre, session);
  switch (action) {
    case 'pause':
      if (session.paused) return 'ℹ️ Déjà en pause.';
      session.basculerPause();
      return '⏸️ Lecture en pause.';
    case 'resume':
      if (!session.paused) return 'ℹ️ La lecture n’est pas en pause.';
      session.basculerPause();
      return '▶️ Lecture reprise.';
    case 'toggle':
      return session.basculerPause() ? '⏸️ Lecture en pause.' : '▶️ Lecture reprise.';
    case 'skip': {
      const actuel = session.actuel!;
      if (estDj(membre) || actuel.demandePar === membre.id || session.auditeursHumains() <= 2) {
        session.passer();
        return `⏭️ **${tronquer(actuel.titre, 150)}** passé.`;
      }
      session.votesPasser.add(membre.id);
      const requis = session.votesRequis();
      if (session.votesPasser.size < requis) return `🗳️ Vote pour passer **${tronquer(actuel.titre, 120)}** : **${session.votesPasser.size}/${requis}**.`;
      session.passer();
      return `⏭️ **${tronquer(actuel.titre, 150)}** passé (vote majoritaire).`;
    }
    case 'prev': {
      const anterieur = session.precedent();
      return anterieur ? `⏮️ Retour à **${tronquer(anterieur.titre, 150)}**.` : 'ℹ️ Aucun morceau précédent.';
    }
    case 'shuffle':
      if (session.waiting < 2) throw new ErreurUtilisateur('Pas assez de morceaux en attente pour mélanger.');
      return `🔀 File mélangée — **${session.melanger()}** morceaux.`;
    case 'cancelplaylist': {
      const n = session.retirerPistesPlaylist();
      return n ? `✅ Playlist annulée — **${n}** morceau(x) retiré(s).` : 'ℹ️ Aucune playlist en attente.';
    }
    case 'stop':
    case 'leave': {
      if (!estDj(membre) && session.auditeursHumains() > 1 && session.actuel?.demandePar !== membre.id) {
        throw new ErreurUtilisateur('Seul un DJ (ou la personne seule en vocal) peut tout arrêter.');
      }
      const joues = session.joues;
      session.detruire();
      derniereAnnonce.get(serveur.id)?.edit({ components: [] }).catch(() => undefined);
      return `🎵 Merci d’avoir écouté avec **${nomEnseigne(serveur)}** ! La file est vidée et je quitte le vocal.${joues ? ` **${joues}** morceau${joues > 1 ? 'x' : ''} joué${joues > 1 ? 's' : ''} cette session.` : ''}`;
    }
  }
  return '';
}

function reglerVolume(membre: GuildMember, brut: string): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const valeur = Number.parseInt(brut, 10);
  if (!Number.isFinite(valeur) || valeur < 1 || valeur > 200) throw new ErreurUtilisateur('Volume entre 1 et 200.');
  session.reglerVolume(valeur);
  return `🔊 Volume réglé à **${valeur}%**.`;
}

function reglerBoucle(membre: GuildMember, brut: string | null): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const correspondance: Record<string, ModeBoucle> = { off: 'off', non: 'off', piste: 'track', track: 'track', morceau: 'track', file: 'queue', queue: 'queue' };
  const ordre: ModeBoucle[] = ['off', 'track', 'queue'];
  const mode = brut ? correspondance[brut.toLowerCase()] : ordre[(ordre.indexOf(session.boucle) + 1) % ordre.length];
  if (!mode) throw new ErreurUtilisateur('Usage : `m!loop <off|piste|file>`.');
  session.boucle = mode;
  return `🔁 Boucle : **${LIBELLES_BOUCLE[mode]}**.`;
}

function retirerPosition(membre: GuildMember, brut: string): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const position = Number.parseInt(brut, 10);
  if (!Number.isFinite(position) || position < 1 || position > session.waiting) throw new ErreurUtilisateur(`Usage : \`m!remove <position>\` (1 à ${session.waiting}).`);
  const retiree = session.retirer(position);
  if (!retiree) throw new ErreurUtilisateur('Cette position n’existe plus.');
  if (retiree.demandePar !== membre.id && !estDj(membre)) {
    session.file.splice(position - 1, 0, retiree);
    throw new ErreurUtilisateur('Tu ne peux retirer que tes propres morceaux.');
  }
  return `🗑️ **${tronquer(retiree.titre, 150)}** retiré de la file.`;
}

// - Panneau (m!panel) -

const OPTIONS_PANNEAU: { value: string; label: string; description: string; emoji: string }[] = [
  { value: 'queue', label: 'File d’attente', description: 'Les morceaux en attente', emoji: '📋' },
  { value: 'shuffle', label: 'Mélanger la file', description: 'Ordre aléatoire', emoji: '🔀' },
  { value: 'loop-off', label: 'Boucle : désactivée', description: 'Lecture normale', emoji: '➡️' },
  { value: 'loop-track', label: 'Boucle : le morceau', description: 'Répète le morceau en cours', emoji: '🔂' },
  { value: 'loop-queue', label: 'Boucle : la file', description: 'Répète toute la file', emoji: '🔁' },
  ...[10, 25, 50, 75, 100, 125, 150, 200].map((v) => ({ value: `vol-${v}`, label: `Volume ${v} %`, description: v <= 25 ? 'Fond sonore' : v <= 75 ? 'Posé' : v === 100 ? 'Normal' : 'Fort', emoji: v <= 25 ? '🔈' : v <= 100 ? '🔉' : '📢' })),
  { value: 'join', label: 'Rejoindre mon salon', description: 'Fait venir le bot', emoji: '📥' },
  { value: 'cancelplaylist', label: 'Annuler la playlist', description: 'Retire les morceaux de playlist', emoji: '🚪' },
];

function affichagePanneau(serveur: Guild) {
  const session = lireSession(serveur.id);
  const menu = new StringSelectMenuBuilder().setCustomId('mu:panel').setPlaceholder('Une action…').addOptions(OPTIONS_PANNEAU);
  return { embeds: [embedLecture(serveur, session)], components: [...controles(session, serveur.id), rangee(menu)] };
}

// - Commandes à préfixe m! -

async function repondreTexte(message: Message<true>, texte: string) {
  await message.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(message.guild)).setDescription(texte)], allowedMentions: { repliedUser: false } });
}

const simple = (nom: string, action: Action, description: string, alias: string[] = []): CommandePrefixe => ({
  nom,
  alias,
  domaine: 'music',
  categorie: 'music',
  description,
  async executer(message) {
    if (!message.member) return;
    await repondreTexte(message, executerAction(message.member, action, message.channelId));
  },
});

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'play',
    alias: ['p'],
    domaine: 'music',
    categorie: 'music',
    description: 'Jouer un titre',
    usage: '<titre ou lien>',
    async executer(message, parametres) {
      if (!message.member) return;
      const chargement = await message.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(message.guild)).setDescription('🔎 Recherche…')], allowedMentions: { repliedUser: false } });
      try {
        const embed = await lancerLecture(message.member, message.channelId, parametres.join(' '));
        await chargement.edit({ embeds: [embed] });
      } catch (echec) {
        await chargement.edit({ embeds: [erreur(message.guild, echec instanceof ErreurUtilisateur ? echec.message : 'La lecture a échoué.')] });
      }
    },
  },
  simple('join', 'join', 'Me faire venir'),
  simple('pause', 'pause', 'Suspendre'),
  simple('resume', 'resume', 'Reprendre'),
  simple('skip', 'skip', 'Au suivant', ['s', 'next']),
  simple('previous', 'prev', 'Morceau précédent', ['prev', 'back']),
  simple('stop', 'stop', 'Tout arrêter', ['leave', 'dc']),
  simple('shuffle', 'shuffle', 'Mélanger'),
  simple('annuler', 'cancelplaylist', 'Annuler la playlist'),
  {
    nom: 'queue',
    alias: ['q'],
    domaine: 'music',
    categorie: 'music',
    description: 'Ce qui suit',
    async executer(message, parametres) {
      const session = exigerSession(message.guild);
      await message.reply({ embeds: [embedFile(message.guild, session, (Number(parametres[0]) || 1) - 1)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'nowplaying',
    alias: ['np'],
    domaine: 'music',
    categorie: 'music',
    description: 'En cours',
    async executer(message) {
      await message.reply({ embeds: [embedLecture(message.guild, lireSession(message.guildId))], components: controles(lireSession(message.guildId), message.guildId), allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'volume',
    alias: ['vol', 'v'],
    domaine: 'music',
    categorie: 'music',
    description: 'Volume en %',
    usage: '<1-200>',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, reglerVolume(message.member, parametres[0] ?? ''));
    },
  },
  {
    nom: 'loop',
    domaine: 'music',
    categorie: 'music',
    description: 'Mode de boucle',
    usage: '[off|piste|file]',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, reglerBoucle(message.member, parametres[0] ?? null));
    },
  },
  {
    nom: 'remove',
    alias: ['rm'],
    domaine: 'music',
    categorie: 'music',
    description: 'Retirer un rang',
    usage: '<position>',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, retirerPosition(message.member, parametres[0] ?? ''));
    },
  },
  {
    nom: 'panel',
    domaine: 'music',
    categorie: 'music',
    description: 'Tout au clic',
    async executer(message) {
      await message.channel.send(affichagePanneau(message.guild));
    },
  },
  {
    nom: 'help',
    domaine: 'music',
    categorie: 'music',
    description: 'Les commandes musique',
    async executer(message) {
      const p = lireConfig(message.guildId).prefixes.music;
      const embed = new EmbedBuilder()
        .setColor(couleurPour(message.guild))
        .setTitle('🎵 La musique')
        .setDescription(`Toutes les commandes musique. Le panneau **${p}panel** fait la même chose au clic.`)
        .addFields(
          { name: '🎵 Écouter', value: [`**${p}play** — Un titre ou un lien`, `**${p}join** — Me faire venir`, `**${p}panel** — Tout au clic`].join('\n'), inline: true },
          { name: '⏯️ Pendant la lecture', value: [`**${p}pause** — Suspendre`, `**${p}resume** — Reprendre`, `**${p}skip** — Au suivant`, `**${p}previous** — Précédent`, `**${p}stop** — Tout arrêter`].join('\n'), inline: true },
          { name: '​', value: '⠀', inline: false },
          { name: '📋 La file', value: [`**${p}queue** — Ce qui suit`, `**${p}np** — En cours`, `**${p}shuffle** — Mélanger`, `**${p}remove** — Retirer un rang`].join('\n'), inline: true },
          { name: '⚙️ Réglages', value: [`**${p}volume** — De 1 à 200 %`, `**${p}loop** — off · piste · file`].join('\n'), inline: true },
        )
        .setFooter({ text: `${nomEnseigne(message.guild)} · /help pour le reste du bot` });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
];

// - Commandes slash -

function slash(nom: string, description: string, executer: (i: ChatInputCommandInteraction<'cached'>) => Promise<string | void>, construire?: (b: SlashCommandBuilder) => SlashCommandBuilder): CommandeSlash {
  const constructeur = new SlashCommandBuilder().setName(nom).setDescription(description);
  return {
    categorie: 'music',
    donnees: construire ? construire(constructeur) : constructeur,
    async executer(interaction) {
      const texte = await executer(interaction);
      if (texte) await interaction.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)] });
    },
  };
}

const panneauMusique: PanneauAffiche = {
  id: 'musique',
  alias: ['lecteur'],
  nom: 'Lecteur de musique',
  emoji: '🎵',
  groupe: 'Salons',
  quoi: 'La musique pilotée au clic',
  async poser(salon) {
    return `Lecteur posté : ${(await salon.send(affichagePanneau(salon.guild))).url}`;
  },
};

const commandes: CommandeSlash[] = [
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Jouer un titre')
      .addStringOption((o) => o.setName('recherche').setDescription('Titre ou lien').setRequired(true).setMaxLength(500)),
    delaiSecondes: 2,
    async executer(interaction) {
      await interaction.deferReply();
      const embed = await lancerLecture(interaction.member, interaction.channelId, interaction.options.getString('recherche', true));
      await interaction.editReply({ embeds: [embed] });
    },
  },
  slash('pause', 'Mettre en pause', async (i) => executerAction(i.member, 'pause', i.channelId)),
  slash('resume', 'Reprendre la lecture', async (i) => executerAction(i.member, 'resume', i.channelId)),
  slash('skip', 'Passer au suivant', async (i) => executerAction(i.member, 'skip', i.channelId)),
  slash('stop', 'Tout arrêter et quitter', async (i) => executerAction(i.member, 'stop', i.channelId)),
  slash('join', 'Rejoindre ton vocal', async (i) => executerAction(i.member, 'join', i.channelId)),
  slash('leave', 'Quitter le vocal', async (i) => executerAction(i.member, 'leave', i.channelId)),
  slash('shuffle', 'Mélanger la file', async (i) => executerAction(i.member, 'shuffle', i.channelId)),
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('La file d’attente')
      .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
    async executer(interaction) {
      const session = exigerSession(interaction.guild);
      await interaction.reply({ embeds: [embedFile(interaction.guild, session, (interaction.options.getInteger('page') ?? 1) - 1)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder().setName('nowplaying').setDescription('Le morceau en cours'),
    async executer(interaction) {
      const session = lireSession(interaction.guildId);
      await interaction.reply({ embeds: [embedLecture(interaction.guild, session)], components: controles(session, interaction.guildId) });
    },
  },
  slash('volume', 'Régler le volume', async (i) => reglerVolume(i.member, String(i.options.getInteger('valeur', true))), (b) =>
    b.addIntegerOption((o) => o.setName('valeur').setDescription('Volume en %').setMinValue(1).setMaxValue(200).setRequired(true)) as SlashCommandBuilder,
  ),
  slash('loop', 'Mode boucle', async (i) => reglerBoucle(i.member, i.options.getString('mode')), (b) =>
    b.addStringOption((o) => o.setName('mode').setDescription('Mode de boucle').addChoices({ name: 'Désactivée', value: 'off' }, { name: 'Le morceau', value: 'piste' }, { name: 'La file', value: 'file' })) as SlashCommandBuilder,
  ),
];

const pageReglage: PageReglage = {
  id: 'music',
  section: 'music',
  titre: 'Musique',
  emoji: '🎵',
  moduleId: 'music',
  description: 'Le lecteur : YouTube, SoundCloud, Spotify (si configuré) et Deezer.\n-# Les DJ (rôles ci-dessous, whitelist DJ ou staff) passent les morceaux sans vote et peuvent tout arrêter.',
  champs: [
    { genre: 'roles', cle: 'dj', libelle: 'Rôles DJ', max: 10, lire: (c) => c.musique.rolesDj, ecrire: (c, v) => void (c.musique.rolesDj = v) },
    { genre: 'toggle', cle: 'announce', libelle: 'Annoncer chaque morceau', lire: (c) => c.musique.annoncerLecture, ecrire: (c, v) => void (c.musique.annoncerLecture = v) },
    { genre: 'number', cle: 'volume', libelle: 'Volume par défaut', min: 1, max: 200, unite: '%', lire: (c) => c.musique.volumeParDefaut, ecrire: (c, v) => void (c.musique.volumeParDefaut = v) },
    { genre: 'number', cle: 'empty', libelle: 'Quitter si seul après', min: 0, max: 60, unite: 'min', lire: (c) => c.musique.quitterSiVideMinutes, ecrire: (c, v) => void (c.musique.quitterSiVideMinutes = v) },
    { genre: 'number', cle: 'maxqueue', libelle: 'Taille de file (×25 en réserve)', min: 10, max: 1000, lire: (c) => c.musique.fileMax, ecrire: (c, v) => void (c.musique.fileMax = v) },
  ],
};

export const moduleMusique: ModuleBot = {
  id: 'music',
  nom: 'Musique',
  emoji: '🎵',
  description: 'Lecteur YouTube / SoundCloud / Spotify / Deezer avec panneau',
  desactivable: true,
  actifParDefaut: true,
  commandes,
  commandesPrefixe: [...commandesPrefixe, prefixePanneau(panneauMusique, 'Poser le lecteur')],
  panneaux: [panneauMusique],
  taches: [
    {
      nom: 'yt-dlp',
      intervalleMs: 24 * 3_600_000,
      auDemarrage: true,
      async executer() {
        const bilan = await mettreAJourYtdlp().catch((echec: Error) => `échec, version actuelle gardée : ${echec.message}`);
        registreMusique.info(`yt-dlp : ${bilan}`);
      },
    },
  ],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'mu',
      async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
        const membre = interaction.member;
        if (action === 'queue') {
          const session = exigerSession(interaction.guild);
          return interaction.reply({ embeds: [embedFile(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        let texte: string;
        if (action === 'loop') texte = reglerBoucle(membre, null);
        else texte = executerAction(membre, action as Action, interaction.channelId);
        const session = lireSession(interaction.guildId);
        await interaction.update({ embeds: [embedLecture(interaction.guild, session)], components: session ? interaction.message.components.length > 2 ? affichagePanneau(interaction.guild).components : controles(session, interaction.guildId) : [] });
        if (texte) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)], flags: MessageFlags.Ephemeral });
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!interaction.isStringSelectMenu()) return;
        const membre = interaction.member;
        const valeur = interaction.values[0] ?? '';
        let texte = '';
        if (valeur === 'queue') {
          const session = exigerSession(interaction.guild);
          return interaction.reply({ embeds: [embedFile(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        if (valeur.startsWith('vol-')) texte = reglerVolume(membre, valeur.slice(4));
        else if (valeur.startsWith('loop-')) texte = reglerBoucle(membre, valeur.slice(5) === 'track' ? 'piste' : valeur.slice(5) === 'queue' ? 'file' : 'off');
        else texte = executerAction(membre, valeur as Action, interaction.channelId);
        await interaction.update(affichagePanneau(interaction.guild));
        if (texte) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('voiceStateUpdate', (avant, apres) => {
      const session = lireSession(apres.guild.id);
      if (!session) return;
      if (apres.id === apres.client.user.id && !apres.channelId) {
        session.detruire();
        return;
      }
      if (avant.channelId === session.channelId || apres.channelId === session.channelId) session.verifierVide();
    }),
  ],
  async auDemarrage() {
    await initialiserSources();
    registreMusique.info(`Musique prête — FFmpeg : ${FFMPEG ? 'oui' : 'NON'} · Spotify : ${spotifyActif() ? 'oui' : 'non'}`);
  },
  aLArret() {
    detruireTout();
  },
  tests: [
    {
      id: 'status',
      libelle: 'État du lecteur',
      emoji: '🎵',
      description: 'FFmpeg, Spotify et sessions en cours',
      async executer() {
        return [
          `${FFMPEG ? '✅' : '❌'} FFmpeg${FFMPEG ? ` (${FFMPEG.length > 40 ? '…' + FFMPEG.slice(-40) : FFMPEG})` : ' introuvable'}`,
          `${spotifyActif() ? '✅' : 'ℹ️'} Spotify${spotifyActif() ? '' : ' non configuré (liens Spotify refusés)'}`,
          `🎧 ${toutesSessions().length} session(s) en cours sur tous les serveurs`,
        ].join('\n');
      },
    },
  ],
};
