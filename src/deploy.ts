import { enregistrerCommandes } from './core/deploy';
import { environnement } from './core/env';
import { modules } from './modules';

async function demarrer(): Promise<void> {
  if (!environnement.jetonDiscord || !environnement.clientId) {
    throw new Error('DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis (voir .env.example)');
  }
  const change = await enregistrerCommandes(modules, { force: true });
  console.log(change ? '✅ Commandes enregistrées.' : 'ℹ️ Aucune modification.');
  if (!environnement.serveurDevId) console.log('ℹ️ Commandes globales : la propagation peut prendre quelques minutes.');
}

demarrer().catch((echec: unknown) => {
  console.error('❌ Échec :', echec instanceof Error ? echec.message : echec);
  process.exit(1);
});
