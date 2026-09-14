import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REST, Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { env } from './env';
import { createLogger } from './logger';
import type { BotModule } from './types';

const log = createLogger('deploy');

export function buildCommandPayload(modules: BotModule[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const payload = modules.flatMap((m) => (m.commands ?? []).map((c) => c.data.toJSON()));
  const names = new Set<string>();
  for (const cmd of payload) {
    if (names.has(cmd.name)) throw new Error(`Commande en double : /${cmd.name}`);
    names.add(cmd.name);
  }
  if (payload.length > 100) throw new Error(`Trop de commandes (${payload.length}/100)`);
  return payload;
}

/**
 * Enregistre les commandes auprès de Discord.
 * En mode automatique, l'envoi n'a lieu que si les commandes ont changé (empreinte stockée).
 */
export async function deployCommands(modules: BotModule[], options: { force?: boolean } = {}): Promise<boolean> {
  const payload = buildCommandPayload(modules);
  const target = env.devGuildId ? `guild:${env.devGuildId}` : 'global';
  const hash = createHash('sha256').update(target).update(JSON.stringify(payload)).digest('hex');
  const hashFile = path.join(path.dirname(env.databasePath), '.commands-hash');

  if (!options.force) {
    try {
      if (fs.readFileSync(hashFile, 'utf8').trim() === hash) {
        log.info('Commandes déjà à jour, aucun envoi nécessaire.');
        return false;
      }
    } catch {
      /* première exécution */
    }
  }

  const rest = new REST({ version: '10' }).setToken(env.discordToken);
  const route = env.devGuildId
    ? Routes.applicationGuildCommands(env.clientId, env.devGuildId)
    : Routes.applicationCommands(env.clientId);
  await rest.put(route, { body: payload });
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  fs.writeFileSync(hashFile, hash);
  log.info(`${payload.length} commandes enregistrées (${target}).`);
  return true;
}
