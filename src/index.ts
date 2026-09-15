import { ActivityType, Events, type Client } from 'discord.js';
import { etatBot } from './core/bot';
import { creerClient } from './core/client';
import { composantConfirmation } from './core/confirm';
import { enregistrerCommandes } from './core/deploy';
import { Aiguilleur } from './core/dispatcher';
import { verifierEnvironnement, environnement } from './core/env';
import { lireConfig } from './core/guildConfig';
import { journal } from './core/logService';
import { creerRegistre } from './core/logger';
import { enregistrerModules } from './core/moduleManager';
import { composantPagination } from './core/pagination';
import { planificateur } from './core/scheduler';
import { enregistrerPagesReglage } from './core/setup';
import { composantCorbeille } from './core/trash';
import { fermerBase, ouvrirBase, executer } from './database/db';
import { demarrerSite, arreterSite } from './dashboard/server';
import { lierClientActivite } from './services/activity';
import { modules } from './modules';

const registre = creerRegistre('main');

function suivreServeur(serveurId: string, inscrit: boolean): void {
  if (inscrit) {
    executer(
      `INSERT INTO serveurs (serveur_id, arrive_le) VALUES (?, ?)
       ON CONFLICT(serveur_id) DO UPDATE SET parti_le = NULL`,
      serveurId,
      Date.now(),
    );
  } else {
    executer('UPDATE serveurs SET parti_le = ? WHERE serveur_id = ?', Date.now(), serveurId);
  }
}

function demarrerRotationStatut(client: Client<true>): void {
  let indice = 0;
  const mettreAJour = () => {
    const membres = client.guilds.cache.reduce((somme, g) => somme + g.memberCount, 0);
    const statuts: { name: string; type: ActivityType }[] = [
      { name: `🎮 avec ${membres} membres`, type: ActivityType.Custom },
      { name: '🔴 Twitch', type: ActivityType.Custom },
      { name: '🎫 /ticket • 🎉 Giveaways', type: ActivityType.Custom },
      { name: '❓ /help pour découvrir le bot', type: ActivityType.Custom },
    ];
    const statut = statuts[indice++ % statuts.length]!;
    client.user.setPresence({ activities: [{ name: statut.name, type: statut.type }], status: 'online' });
  };
  mettreAJour();
  // Une mise à jour toutes les 5 minutes : largement sous les limites de l'API.
  setInterval(mettreAJour, 5 * 60_000).unref();
}

async function demarrer(): Promise<void> {
  verifierEnvironnement();
  ouvrirBase();
  enregistrerModules(modules);
  enregistrerPagesReglage(modules.flatMap((m) => m.pagesReglage ?? []));

  const client = creerClient();
  const aiguilleur = new Aiguilleur(modules, [composantPagination, composantConfirmation, composantCorbeille]);
  etatBot.aiguilleur = aiguilleur;
  aiguilleur.brancher(client);

  for (const module of modules) for (const tache of module.taches ?? []) planificateur.ajouter(tache);

  client.once(Events.ClientReady, async (pret) => {
    etatBot.client = pret;
    lierClientActivite(pret);
    registre.info(`Connecté en tant que ${pret.user.tag} sur ${pret.guilds.cache.size} serveur(s).`);
    for (const serveur of pret.guilds.cache.values()) {
      suivreServeur(serveur.id, true);
      lireConfig(serveur.id);
    }

    if (environnement.enregistrementAuto) {
      await enregistrerCommandes(modules).catch((echec: unknown) => registre.erreur('Enregistrement des commandes impossible', echec));
    }

    for (const module of modules) {
      if (!module.auDemarrage) continue;
      try {
        await module.auDemarrage(pret);
      } catch (echec) {
        registre.erreur(`Initialisation du module ${module.id} en échec`, echec);
      }
    }

    planificateur.demarrer(pret);
    demarrerRotationStatut(pret);

    const noteDemarrage = `**Modules** : ${modules.length} · **Serveurs** : ${pret.guilds.cache.size} · **Node** : ${process.version}`;
    for (const serveur of pret.guilds.cache.values()) {
      void journal(serveur, 'health', { titre: 'Bot démarré', ton: 'ok', lignes: [noteDemarrage, `**Twitch** : ${environnement.twitchClientId ? 'configuré' : 'non configuré'}`] });
    }

    if (environnement.siteActif) {
      try {
        demarrerSite(pret);
      } catch (echec) {
        registre.erreur('Dashboard non démarré', echec);
      }
    }
  });

  client.on(Events.GuildCreate, (serveur) => {
    suivreServeur(serveur.id, true);
    registre.info(`Ajouté au serveur ${serveur.name} (${serveur.id})`);
  });
  client.on(Events.GuildDelete, (serveur) => {
    suivreServeur(serveur.id, false);
    registre.info(`Retiré du serveur ${serveur.id}`);
  });
  client.on(Events.Error, (echec) => registre.erreur('Erreur client Discord', echec));
  client.on(Events.Warn, (charge) => registre.avertir(charge));
  client.on(Events.ShardDisconnect, () => registre.avertir('Déconnecté de Discord, reconnexion automatique…'));

  clientActif = client;
  process.once('SIGINT', () => {
    registre.info('Arrêt demandé (SIGINT)…');
    void quitterProprement(0);
  });
  process.once('SIGTERM', () => {
    registre.info('Arrêt demandé (SIGTERM)…');
    void quitterProprement(0);
  });

  await client.login(environnement.jetonDiscord);
}

let clientActif: Client | null = null;
let enArret = false;

/** Arrêt propre : tâches, modules, dashboard, connexion Discord puis base de données. */
async function quitterProprement(code: number): Promise<void> {
  if (enArret) return;
  enArret = true;
  planificateur.arreter();
  for (const module of modules) {
    if (module.aLArret) await Promise.resolve(module.aLArret()).catch(() => undefined);
  }
  arreterSite();
  await clientActif?.destroy().catch(() => undefined);
  fermerBase();
  // Laisse les connexions se fermer : un exit immédiat fait planter libuv sous Windows.
  setTimeout(() => process.exit(code), 300);
}

process.on('unhandledRejection', (raison) => registre.erreur('Promesse rejetée non gérée', raison));
process.on('uncaughtException', (echec) => registre.erreur('Exception non capturée', echec));

demarrer().catch((echec: unknown) => {
  const message = String((echec as Error)?.message ?? echec);
  if ((echec as { code?: string }).code === 'TokenInvalid') registre.erreur('Jeton Discord invalide : vérifie DISCORD_TOKEN dans le fichier .env.');
  else if (/disallowed intents/i.test(message)) {
    registre.erreur('Intents refusés : active « Server Members Intent » et « Message Content Intent » dans le Developer Portal (Bot → Privileged Gateway Intents).');
  } else registre.erreur('Démarrage impossible', echec);
  void quitterProprement(1);
});
