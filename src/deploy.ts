import { deployCommands } from './core/deploy';
import { env } from './core/env';
import { modules } from './modules';

async function main(): Promise<void> {
  if (!env.discordToken || !env.clientId) {
    throw new Error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis (voir .env.example)');
  }
  const changed = await deployCommands(modules, { force: true });
  console.log(changed ? '✅ Commandes enregistrées.' : 'ℹ️ Aucune modification.');
  if (!env.devGuildId) console.log('ℹ️ Commandes globales : la propagation peut prendre quelques minutes.');
}

main().catch((err: unknown) => {
  console.error('❌ Échec :', err instanceof Error ? err.message : err);
  process.exit(1);
});
