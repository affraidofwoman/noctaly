import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Client, Guild, GuildBasedChannel, GuildMember, Message, Role, User } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const RACINE_PROJET = path.resolve(__dirname, '..', '..', '..');

function texte(nom: string, secours = ''): string {
  const v = process.env[nom];
  return v === undefined || v.trim() === '' ? secours : v.trim();
}

function booleen(nom: string, secours: boolean): boolean {
  const v = texte(nom);
  if (!v) return secours;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(v.toLowerCase());
}

function entier(nom: string, secours: number): number {
  const n = Number.parseInt(texte(nom), 10);
  return Number.isFinite(n) ? n : secours;
}

function liste(nom: string): string[] {
  return texte(nom)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const environnement = {
  jetonDiscord: texte('DISCORD_TOKEN'),
  clientId: texte('DISCORD_CLIENT_ID'),
  secretClient: texte('DISCORD_CLIENT_SECRET'),
  serveurDevId: texte('DEV_GUILD_ID'),
  enregistrementAuto: booleen('AUTO_DEPLOY_COMMANDS', true),
  proprietairesIds: liste('BOT_OWNER_IDS'),

  cheminBase: path.resolve(texte('DATABASE_PATH', './data/bot.sqlite')),
  dossierSauvegardes: path.resolve(texte('BACKUP_DIR', './data/backups')),
  niveauRegistre: texte('LOG_LEVEL', 'info'),
  fuseauParDefaut: texte('DEFAULT_TIMEZONE', 'Europe/Paris'),

  twitchClientId: texte('TWITCH_CLIENT_ID'),
  twitchSecret: texte('TWITCH_CLIENT_SECRET'),
  twitchIntervalleSecondes: Math.max(30, entier('TWITCH_POLL_SECONDS', 60)),
  twitchJetonUtilisateur: texte('TWITCH_USER_TOKEN'),
  twitchJetonRenouvellement: texte('TWITCH_REFRESH_TOKEN'),

  cheminFfmpeg: texte('FFMPEG_PATH'),
  cheminYtdlp: texte('YTDLP_PATH'),

  siteActif: booleen('DASHBOARD_ENABLED', false),
  sitePort: entier('DASHBOARD_PORT', 3000),
  siteUrl: texte('DASHBOARD_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  siteSecret: texte('DASHBOARD_SESSION_SECRET'),
};

export type Environnement = typeof environnement;

export function verifierEnvironnement(): void {
  const manquants: string[] = [];
  if (!environnement.jetonDiscord) manquants.push('DISCORD_TOKEN');
  if (!environnement.clientId) manquants.push('DISCORD_CLIENT_ID');
  if (manquants.length) {
    throw new Error(`Variables d'environnement manquantes : ${manquants.join(', ')} (voir .env.example)`);
  }
  if (environnement.siteActif) {
    if (!environnement.secretClient) throw new Error('DASHBOARD_ENABLED=true nécessite DISCORD_CLIENT_SECRET');
    if (environnement.siteSecret.length < 32) {
      throw new Error('DASHBOARD_SESSION_SECRET doit contenir au moins 32 caractères');
    }
  }
}

const NIVEAUX = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type NiveauRegistre = keyof typeof NIVEAUX;

const seuil = NIVEAUX[(environnement.niveauRegistre as NiveauRegistre) in NIVEAUX ? (environnement.niveauRegistre as NiveauRegistre) : 'info'];

function ecrire(niveau: NiveauRegistre, portee: string, message: string, extra?: unknown): void {
  if (NIVEAUX[niveau] < seuil) return;
  const ligne = `${new Date().toISOString()} ${niveau.toUpperCase().padEnd(5)} [${portee}] ${message}`;
  const sortie = niveau === 'error' || niveau === 'warn' ? console.error : console.log;
  if (extra === undefined) sortie(ligne);
  else if (extra instanceof Error) sortie(ligne, '\n', extra.stack ?? extra.message);
  else sortie(ligne, extra);
}

export interface Registre {
  debogage(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  avertir(message: string, extra?: unknown): void;
  erreur(message: string, extra?: unknown): void;
  enfant(portee: string): Registre;
}

export function creerRegistre(portee: string): Registre {
  return {
    debogage: (m, e) => ecrire('debug', portee, m, e),
    info: (m, e) => ecrire('info', portee, m, e),
    avertir: (m, e) => ecrire('warn', portee, m, e),
    erreur: (m, e) => ecrire('error', portee, m, e),
    enfant: (sousCommande) => creerRegistre(`${portee}:${sousCommande}`),
  };
}

export const registre = creerRegistre('bot');

/** Erreur destinée à l'utilisateur : son message est affiché tel quel. */
export class ErreurUtilisateur extends Error {
  constructor(
    message: string,
    public readonly titre = '❌ Action impossible',
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export const ERREUR_GENERIQUE = "Le bot n'a pas pu effectuer cette action.";

/** Codes d'erreur Discord courants traduits en messages compréhensibles. */
export function decrireErreurDiscord(echec: unknown): string | null {
  const code = (echec as { code?: number } | null)?.code;
  switch (code) {
    case 50013:
      return "Je n'ai pas les permissions nécessaires (vérifie mes permissions et la position de mon rôle).";
    case 50001:
      return "Je n'ai pas accès à ce salon.";
    case 50007:
      return "Impossible d'envoyer un message privé à cet utilisateur.";
    case 10007:
      return 'Ce membre est introuvable sur le serveur.';
    case 10008:
      return 'Ce message est introuvable (peut-être supprimé).';
    case 10003:
      return 'Ce salon est introuvable.';
    case 10011:
      return 'Ce rôle est introuvable.';
    case 30005:
      return 'Le serveur a atteint la limite de rôles.';
    case 30013:
      return 'Le serveur a atteint la limite de salons.';
    case 50035:
      return 'Certaines valeurs fournies sont invalides.';
    default:
      return null;
  }
}

/** Map avec expiration, nettoyée paresseusement (aucun timer permanent par entrée). */
export class CarteExpirante<K, V> {
  private readonly stockage = new Map<K, { value: V; expires: number }>();
  private dernierNettoyage = Date.now();

  constructor(private readonly dureeVieMs: number) {}

  ecrire(cle: K, valeur: V, dureeVieMs = this.dureeVieMs): void {
    this.nettoyer();
    this.stockage.set(cle, { value: valeur, expires: Date.now() + dureeVieMs });
  }

  lire(cle: K): V | undefined {
    const entree = this.stockage.get(cle);
    if (!entree) return undefined;
    if (entree.expires < Date.now()) {
      this.stockage.delete(cle);
      return undefined;
    }
    return entree.value;
  }

  prolonger(cle: K, dureeVieMs = this.dureeVieMs): void {
    const entree = this.stockage.get(cle);
    if (entree) entree.expires = Date.now() + dureeVieMs;
  }

  possede(cle: K): boolean {
    return this.lire(cle) !== undefined;
  }

  supprimer(cle: K): boolean {
    return this.stockage.delete(cle);
  }

  get size(): number {
    this.nettoyer(true);
    return this.stockage.size;
  }

  valeurs(): V[] {
    this.nettoyer(true);
    return [...this.stockage.values()].map((e) => e.value);
  }

  private nettoyer(forcer = false): void {
    const maintenant = Date.now();
    if (!forcer && maintenant - this.dernierNettoyage < 60_000) return;
    this.dernierNettoyage = maintenant;
    for (const [k, e] of this.stockage) if (e.expires < maintenant) this.stockage.delete(k);
  }
}

export function idCourt(octets = 6): string {
  return randomBytes(octets).toString('base64url');
}

const UNITES: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  seconde: 1_000,
  secondes: 1_000,
  m: 60_000,
  min: 60_000,
  mn: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  heure: 3_600_000,
  heures: 3_600_000,
  j: 86_400_000,
  d: 86_400_000,
  jour: 86_400_000,
  jours: 86_400_000,
  sem: 604_800_000,
  w: 604_800_000,
  semaine: 604_800_000,
  semaines: 604_800_000,
  mois: 2_592_000_000,
};

/**
 * Convertit une durée lisible en millisecondes.
 * Exemples : "2h30", "1j 12h", "45m", "90s", "1 semaine", "2h30m".
 * Retourne null si invalide.
 */
export function lireDuree(saisie: string): number | null {
  const brut = saisie.trim().toLowerCase().replace(/,/g, '.');
  if (!brut) return null;
  // "2h30" -> minutes implicites après les heures
  const heureMinute = /^(\d+)\s*h\s*(\d{1,2})$/.exec(brut);
  if (heureMinute) return Number(heureMinute[1]) * 3_600_000 + Number(heureMinute[2]) * 60_000;
  const expression = /(\d+(?:\.\d+)?)\s*([a-zé]+)/g;
  let total = 0;
  let consomme = '';
  let correspondance: RegExpExecArray | null;
  while ((correspondance = expression.exec(brut)) !== null) {
    const unite = UNITES[correspondance[2]!.normalize('NFD').replace(/[\u0300-\u036f]/g, '')] ?? UNITES[correspondance[2]!];
    if (!unite) return null;
    total += Number(correspondance[1]) * unite;
    consomme += correspondance[0];
  }
  if (!consomme || consomme.replace(/\s/g, '') !== brut.replace(/\s/g, '')) {
    if (/^\d+$/.test(brut)) return Number(brut) * 60_000; // nombre seul = minutes
    return null;
  }
  return total > 0 ? Math.round(total) : null;
}

export function formaterDuree(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '0 s';
  const parties: string[] = [];
  const jours = Math.floor(ms / 86_400_000);
  const heures = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secondes = Math.floor((ms % 60_000) / 1000);
  if (jours) parties.push(`${jours} j`);
  if (heures) parties.push(`${heures} h`);
  if (minutes) parties.push(`${minutes} min`);
  if (secondes && !jours && !heures) parties.push(`${secondes} s`);
  return parties.join(' ');
}

export function formaterHorloge(secondes: number): string {
  if (!Number.isFinite(secondes) || secondes <= 0) return '🔴 Direct';
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type StyleHorodatage = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

export function marqueTemps(ms: number, style: StyleHorodatage = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function joursDepuis(ms: number, maintenant = Date.now()): number {
  return Math.floor((maintenant - ms) / 86_400_000);
}

interface PartiesFuseau {
  annee: number;
  mois: number;
  jour: number;
  heure: number;
  minute: number;
  seconde: number;
  jourSemaine: number;
}

const formateurs = new Map<string, Intl.DateTimeFormat>();

function formateur(fuseauHoraire: string): Intl.DateTimeFormat {
  let f = formateurs.get(fuseauHoraire);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuseauHoraire,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formateurs.set(fuseauHoraire, f);
  }
  return f;
}

export function fuseauValide(fuseauHoraire: string): boolean {
  try {
    formateur(fuseauHoraire);
    return true;
  } catch {
    return false;
  }
}

const JOURS_SEMAINE: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Décompose un instant dans un fuseau horaire donné. */
export function partiesFuseau(ms: number, fuseauHoraire: string): PartiesFuseau {
  const fuseauSur = fuseauValide(fuseauHoraire) ? fuseauHoraire : 'UTC';
  const parties = Object.fromEntries(formateur(fuseauSur).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    annee: Number(parties.year),
    mois: Number(parties.month),
    jour: Number(parties.day),
    heure: Number(parties.hour),
    minute: Number(parties.minute),
    seconde: Number(parties.second),
    jourSemaine: JOURS_SEMAINE[parties.weekday as string] ?? 0,
  };
}

/** Convertit une date/heure "murale" d'un fuseau en timestamp UTC (ms). */
export function heureFuseauEnUtc(annee: number, mois: number, jour: number, heure: number, minute: number, fuseauHoraire: string): number {
  const estimation = Date.UTC(annee, mois - 1, jour, heure, minute);
  let resultat = estimation;
  // Deux itérations suffisent pour gérer les changements d'heure
  for (let i = 0; i < 2; i++) {
    const p = partiesFuseau(resultat, fuseauHoraire);
    const enUtc = Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute);
    resultat += estimation - enUtc;
  }
  return resultat;
}

/** Clé de jour "AAAA-MM-JJ" dans le fuseau donné. */
export function cleJour(ms: number, fuseauHoraire: string): string {
  const p = partiesFuseau(ms, fuseauHoraire);
  return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
}

export function cleJourPrecedent(cle: string): string {
  const [y, m, d] = cle.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return date.toISOString().slice(0, 10);
}

/**
 * Analyse une date "JJ/MM/AAAA" (ou "JJ/MM") et une heure "HH:MM" / "21h" dans un fuseau.
 * Retourne null si invalide.
 */
export function lireDateHeure(dateSaisie: string, heureSaisie: string, fuseauHoraire: string, maintenant = Date.now()): number | null {
  const mp = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(dateSaisie.trim());
  const tm = /^(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?$/i.exec(heureSaisie.trim());
  if (!mp || !tm) return null;
  const jour = Number(mp[1]);
  const mois = Number(mp[2]);
  let annee = mp[3] ? Number(mp[3]) : partiesFuseau(maintenant, fuseauHoraire).annee;
  if (annee < 100) annee += 2000;
  const heure = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31 || heure > 23 || minute > 59) return null;
  const verification = new Date(Date.UTC(annee, mois - 1, jour));
  if (verification.getUTCMonth() !== mois - 1) return null;
  let resultat = heureFuseauEnUtc(annee, mois, jour, heure, minute, fuseauHoraire);
  if (!mp[3] && resultat < maintenant) resultat = heureFuseauEnUtc(annee + 1, mois, jour, heure, minute, fuseauHoraire);
  return resultat;
}

export function formaterDate(ms: number, fuseauHoraire: string, avecHeure = true): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: fuseauValide(fuseauHoraire) ? fuseauHoraire : 'UTC',
    dateStyle: 'long',
    ...(avecHeure ? { timeStyle: 'short' } : {}),
  }).format(new Date(ms));
}

export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function tronquer(valeur: string, max: number): string {
  if (valeur.length <= max) return valeur;
  return `${valeur.slice(0, Math.max(0, max - 1))}…`;
}

export { escapeMarkdown } from 'discord.js';

/** Neutralise les mentions de masse dans un texte fourni par un utilisateur. */
export function neutraliserMentions(valeur: string): string {
  return valeur.replace(/@(everyone|here)/gi, '@\u200b$1');
}

export function barreProgression(taux: number, taille = 12): string {
  const r = Math.min(1, Math.max(0, Number.isFinite(taux) ? taux : 0));
  const rempli = Math.round(r * taille);
  return `${'▰'.repeat(rempli)}${'▱'.repeat(taille - rempli)}`;
}

export function pluriel(nombre: number, singulier: string, formePlurielle = `${singulier}s`): string {
  return `${nombre} ${Math.abs(nombre) > 1 ? formePlurielle : singulier}`;
}

export function formaterNombre(valeur: number): string {
  return new Intl.NumberFormat('fr-FR').format(valeur);
}

export function identifiantDepuisTexte(valeur: string, max = 90): string {
  return (
    valeur
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'x'
  );
}

export function decouper<T>(articles: T[], taille: number): T[][] {
  const sortie: T[][] = [];
  for (let i = 0; i < articles.length; i += taille) sortie.push(articles.slice(i, i + taille));
  return sortie;
}

export function estIdentifiant(valeur: string): boolean {
  return /^\d{17,20}$/.test(valeur);
}

export function medaille(rang: number): string {
  return rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉' : `**${rang}.**`;
}

/** Limiteur à fenêtre glissante, en mémoire. */
export class LimiteurFenetre {
  private readonly passages = new Map<string, number[]>();
  private dernierNettoyage = Date.now();

  constructor(
    private readonly limite: number,
    private readonly fenetreMs: number,
  ) {}

  /** Enregistre un passage ; retourne false si la limite est dépassée. */
  compter(cle: string, maintenant = Date.now()): boolean {
    this.nettoyer(maintenant);
    const liste = (this.passages.get(cle) ?? []).filter((t) => maintenant - t < this.fenetreMs);
    if (liste.length >= this.limite) {
      this.passages.set(cle, liste);
      return false;
    }
    liste.push(maintenant);
    this.passages.set(cle, liste);
    return true;
  }

  nombre(cle: string, maintenant = Date.now()): number {
    return (this.passages.get(cle) ?? []).filter((t) => maintenant - t < this.fenetreMs).length;
  }

  reinitialiser(cle: string): void {
    this.passages.delete(cle);
  }

  private nettoyer(maintenant: number): void {
    if (maintenant - this.dernierNettoyage < 60_000) return;
    this.dernierNettoyage = maintenant;
    for (const [k, liste] of this.passages) {
      if (liste.every((t) => maintenant - t >= this.fenetreMs)) this.passages.delete(k);
    }
  }
}

/** Cooldowns par clé (ex : commande + utilisateur). */
export class Delais {
  private readonly jusqua = new Map<string, number>();

  /** Retourne le temps restant en ms (0 = disponible, et le cooldown est alors armé). */
  prendre(cle: string, dureeMs: number, maintenant = Date.now()): number {
    const fin = this.jusqua.get(cle) ?? 0;
    if (fin > maintenant) return fin - maintenant;
    this.jusqua.set(cle, maintenant + dureeMs);
    if (this.jusqua.size > 5_000) {
      for (const [k, v] of this.jusqua) if (v <= maintenant) this.jusqua.delete(k);
    }
    return 0;
  }
}

export function idDepuisMention(valeur: string | undefined): string | null {
  if (!valeur) return null;
  const m = /^<(?:@[!&]?|#)(\d{17,20})>$/.exec(valeur.trim()) ?? /^(\d{17,20})$/.exec(valeur.trim());
  return m ? m[1]! : null;
}

export async function resoudreMembre(serveur: Guild, valeur: string | undefined): Promise<GuildMember | null> {
  const id = idDepuisMention(valeur);
  if (!id) return null;
  return serveur.members.cache.get(id) ?? (await serveur.members.fetch(id).catch(() => null));
}

export async function resoudreUtilisateur(client: Client, valeur: string | undefined): Promise<User | null> {
  const id = idDepuisMention(valeur);
  if (!id) return null;
  return client.users.cache.get(id) ?? (await client.users.fetch(id).catch(() => null));
}

export function resoudreRole(serveur: Guild, valeur: string | undefined): Role | null {
  const id = idDepuisMention(valeur);
  if (id) return serveur.roles.cache.get(id) ?? null;
  if (!valeur) return null;
  const minuscule = valeur.toLowerCase();
  return serveur.roles.cache.find((r) => r.name.toLowerCase() === minuscule) ?? null;
}

export function resoudreSalon(serveur: Guild, valeur: string | undefined): GuildBasedChannel | null {
  const id = idDepuisMention(valeur);
  return id ? (serveur.channels.cache.get(id) ?? null) : null;
}

/** Cible d'une commande à préfixe : mention/ID en argument, sinon la personne à qui l'on répond. */
export async function membreCible(message: Message<true>, argument: string | undefined): Promise<GuildMember | null> {
  const depuisArgument = await resoudreMembre(message.guild, argument);
  if (depuisArgument) return depuisArgument;
  if (message.reference?.messageId) {
    const reference = await message.fetchReference().catch(() => null);
    if (reference?.member) return reference.member;
  }
  return null;
}
