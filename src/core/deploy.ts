import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REST, Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { environnement } from './env';
import { creerRegistre } from './logger';
import type { ModuleBot } from './types';

const registre = creerRegistre('deploy');

export function construireCommandes(modules: ModuleBot[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const charge = modules.flatMap((m) => (m.commandes ?? []).map((c) => c.donnees.toJSON()));
  const noms = new Set<string>();
  for (const commande of charge) {
    if (noms.has(commande.name)) throw new Error(`Commande en double : /${commande.name}`);
    noms.add(commande.name);
  }
  if (charge.length > 100) throw new Error(`Trop de commandes (${charge.length}/100)`);
  return charge;
}

/**
 * Enregistre les commandes auprès de Discord.
 * En mode automatique, l'envoi n'a lieu que si les commandes ont changé (empreinte stockée).
 */
export async function enregistrerCommandes(modules: ModuleBot[], options: { force?: boolean } = {}): Promise<boolean> {
  const charge = construireCommandes(modules);
  const cible = environnement.serveurDevId ? `guild:${environnement.serveurDevId}` : 'global';
  const empreinte = createHash('sha256').update(cible).update(JSON.stringify(charge)).digest('hex');
  const fichierEmpreinte = path.join(path.dirname(environnement.cheminBase), '.commands-hash');

  if (!options.force) {
    try {
      if (fs.readFileSync(fichierEmpreinte, 'utf8').trim() === empreinte) {
        registre.info('Commandes déjà à jour, aucun envoi nécessaire.');
        return false;
      }
    } catch {
      /* première exécution */
    }
  }

  const reste = new REST({ version: '10' }).setToken(environnement.jetonDiscord);
  const route = environnement.serveurDevId
    ? Routes.applicationGuildCommands(environnement.clientId, environnement.serveurDevId)
    : Routes.applicationCommands(environnement.clientId);
  await reste.put(route, { body: charge });
  fs.mkdirSync(path.dirname(fichierEmpreinte), { recursive: true });
  fs.writeFileSync(fichierEmpreinte, empreinte);
  registre.info(`${charge.length} commandes enregistrées (${cible}).`);
  return true;
}
