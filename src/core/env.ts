import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name);
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(str(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  discordToken: str('DISCORD_TOKEN'),
  clientId: str('DISCORD_CLIENT_ID'),
  clientSecret: str('DISCORD_CLIENT_SECRET'),
  devGuildId: str('DEV_GUILD_ID'),
  autoDeploy: bool('AUTO_DEPLOY_COMMANDS', true),
  ownerIds: list('BOT_OWNER_IDS'),

  databasePath: path.resolve(str('DATABASE_PATH', './data/bot.sqlite')),
  backupDir: path.resolve(str('BACKUP_DIR', './data/backups')),
  logLevel: str('LOG_LEVEL', 'info'),
  defaultTimezone: str('DEFAULT_TIMEZONE', 'Europe/Paris'),

  twitchClientId: str('TWITCH_CLIENT_ID'),
  twitchClientSecret: str('TWITCH_CLIENT_SECRET'),
  twitchPollSeconds: Math.max(30, int('TWITCH_POLL_SECONDS', 60)),
  twitchUserToken: str('TWITCH_USER_TOKEN'),
  twitchRefreshToken: str('TWITCH_REFRESH_TOKEN'),

  ffmpegPath: str('FFMPEG_PATH'),
  ytdlpPath: str('YTDLP_PATH'),

  dashboardEnabled: bool('DASHBOARD_ENABLED', false),
  dashboardPort: int('DASHBOARD_PORT', 3000),
  dashboardUrl: str('DASHBOARD_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  dashboardSecret: str('DASHBOARD_SESSION_SECRET'),
};

export type Env = typeof env;

export function assertRuntimeEnv(): void {
  const missing: string[] = [];
  if (!env.discordToken) missing.push('DISCORD_TOKEN');
  if (!env.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) {
    throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')} (voir .env.example)`);
  }
  if (env.dashboardEnabled) {
    if (!env.clientSecret) throw new Error('DASHBOARD_ENABLED=true nécessite DISCORD_CLIENT_SECRET');
    if (env.dashboardSecret.length < 32) {
      throw new Error('DASHBOARD_SESSION_SECRET doit contenir au moins 32 caractères');
    }
  }
}
