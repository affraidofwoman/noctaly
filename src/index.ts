import { ActivityType, Events, type Client } from 'discord.js';
import { botState } from './core/bot';
import { createClient } from './core/client';
import { confirmComponent } from './core/confirm';
import { deployCommands } from './core/deploy';
import { Dispatcher } from './core/dispatcher';
import { assertRuntimeEnv, env } from './core/env';
import { getConfig } from './core/guildConfig';
import { journal } from './core/logService';
import { createLogger } from './core/logger';
import { registerModules } from './core/moduleManager';
import { paginationComponent } from './core/pagination';
import { scheduler } from './core/scheduler';
import { registerSetupPages } from './core/setup';
import { trashComponent } from './core/trash';
import { closeDatabase, openDatabase, run } from './database/db';
import { startDashboard, stopDashboard } from './dashboard/server';
import { bindActivityClient } from './services/activity';
import { modules } from './modules';

const log = createLogger('main');

function trackGuild(guildId: string, joined: boolean): void {
  if (joined) {
    run(
      `INSERT INTO guilds (guild_id, joined_at) VALUES (?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET left_at = NULL`,
      guildId,
      Date.now(),
    );
  } else {
    run('UPDATE guilds SET left_at = ? WHERE guild_id = ?', Date.now(), guildId);
  }
}

function startPresenceRotation(client: Client<true>): void {
  let index = 0;
  const update = () => {
    const members = client.guilds.cache.reduce((sum, g) => sum + g.memberCount, 0);
    const statuses: { name: string; type: ActivityType }[] = [
      { name: `🎮 avec ${members} membres`, type: ActivityType.Custom },
      { name: '🔴 Twitch', type: ActivityType.Custom },
      { name: '🎫 /ticket • 🎉 Giveaways', type: ActivityType.Custom },
      { name: '❓ /help pour découvrir le bot', type: ActivityType.Custom },
    ];
    const status = statuses[index++ % statuses.length]!;
    client.user.setPresence({ activities: [{ name: status.name, type: status.type }], status: 'online' });
  };
  update();
  // Une mise à jour toutes les 5 minutes : largement sous les limites de l'API.
  setInterval(update, 5 * 60_000).unref();
}

async function main(): Promise<void> {
  assertRuntimeEnv();
  openDatabase();
  registerModules(modules);
  registerSetupPages(modules.flatMap((m) => m.setupPages ?? []));

  const client = createClient();
  const dispatcher = new Dispatcher(modules, [paginationComponent, confirmComponent, trashComponent]);
  botState.dispatcher = dispatcher;
  dispatcher.attach(client);

  for (const mod of modules) for (const task of mod.tasks ?? []) scheduler.add(task);

  client.once(Events.ClientReady, async (ready) => {
    botState.client = ready;
    bindActivityClient(ready);
    log.info(`Connecté en tant que ${ready.user.tag} sur ${ready.guilds.cache.size} serveur(s).`);
    for (const guild of ready.guilds.cache.values()) {
      trackGuild(guild.id, true);
      getConfig(guild.id);
    }

    if (env.autoDeploy) {
      await deployCommands(modules).catch((err: unknown) => log.error('Enregistrement des commandes impossible', err));
    }

    for (const mod of modules) {
      if (!mod.onReady) continue;
      try {
        await mod.onReady(ready);
      } catch (err) {
        log.error(`Initialisation du module ${mod.id} en échec`, err);
      }
    }

    scheduler.start(ready);
    startPresenceRotation(ready);

    const uptimeNote = `**Modules** : ${modules.length} · **Serveurs** : ${ready.guilds.cache.size} · **Node** : ${process.version}`;
    for (const guild of ready.guilds.cache.values()) {
      void journal(guild, 'health', { title: 'Bot démarré', tone: 'ok', lines: [uptimeNote, `**Twitch** : ${env.twitchClientId ? 'configuré' : 'non configuré'}`] });
    }

    if (env.dashboardEnabled) {
      try {
        startDashboard(ready);
      } catch (err) {
        log.error('Dashboard non démarré', err);
      }
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    trackGuild(guild.id, true);
    log.info(`Ajouté au serveur ${guild.name} (${guild.id})`);
  });
  client.on(Events.GuildDelete, (guild) => {
    trackGuild(guild.id, false);
    log.info(`Retiré du serveur ${guild.id}`);
  });
  client.on(Events.Error, (err) => log.error('Erreur client Discord', err));
  client.on(Events.Warn, (msg) => log.warn(msg));
  client.on(Events.ShardDisconnect, () => log.warn('Déconnecté de Discord, reconnexion automatique…'));

  runningClient = client;
  process.once('SIGINT', () => {
    log.info('Arrêt demandé (SIGINT)…');
    void exitCleanly(0);
  });
  process.once('SIGTERM', () => {
    log.info('Arrêt demandé (SIGTERM)…');
    void exitCleanly(0);
  });

  await client.login(env.discordToken);
}

let runningClient: Client | null = null;
let exiting = false;

/** Arrêt propre : tâches, modules, dashboard, connexion Discord puis base de données. */
async function exitCleanly(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  scheduler.stop();
  for (const mod of modules) {
    if (mod.onShutdown) await Promise.resolve(mod.onShutdown()).catch(() => undefined);
  }
  stopDashboard();
  await runningClient?.destroy().catch(() => undefined);
  closeDatabase();
  // Laisse les connexions se fermer : un exit immédiat fait planter libuv sous Windows.
  setTimeout(() => process.exit(code), 300);
}

process.on('unhandledRejection', (reason) => log.error('Promesse rejetée non gérée', reason));
process.on('uncaughtException', (err) => log.error('Exception non capturée', err));

main().catch((err: unknown) => {
  const message = String((err as Error)?.message ?? err);
  if ((err as { code?: string }).code === 'TokenInvalid') log.error('Jeton Discord invalide : vérifie DISCORD_TOKEN dans le fichier .env.');
  else if (/disallowed intents/i.test(message)) {
    log.error('Intents refusés : active « Server Members Intent » et « Message Content Intent » dans le Developer Portal (Bot → Privileged Gateway Intents).');
  } else log.error('Démarrage impossible', err);
  void exitCleanly(1);
});
