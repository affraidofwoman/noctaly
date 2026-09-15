import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

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
