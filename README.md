# Bot communautaire Twitch

Bot Discord tout-en-un pour les serveurs de streamers Twitch, entièrement en français.
Pensé pour **plusieurs streamers** : chaque serveur peut porter l’**enseigne** d’un streamer (nom, couleur, logo, émojis, chaîne Twitch), et tout reste cloisonné par serveur.

> **Le principe :** j’ajoute le bot → `/setup` → quelques clics → le serveur est prêt.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Installation](#installation)
3. [Discord Developer Portal](#discord-developer-portal)
4. [Fichier .env](#fichier-env)
5. [Lancement](#lancement)
6. [Premiers pas sur un serveur](#premiers-pas-sur-un-serveur)
7. [Accès : niveaux, rôles et whitelists](#accès--niveaux-rôles-et-whitelists)
8. [Progression](#progression)
9. [Préfixes](#préfixes)
10. [Twitch](#twitch)
11. [Musique](#musique)
12. [Site web](#site-web)
13. [Liste des commandes](#liste-des-commandes)
14. [Organisation du code](#organisation-du-code)
15. [Base de données et sauvegardes](#base-de-données-et-sauvegardes)
16. [Hébergement](#hébergement)
17. [Dépannage](#dépannage)

---

## Fonctionnalités

| | | |
|---|---|---|
| 👋 Bienvenue en image, bannière Twitch en fond | 🚪 Départs avec statistiques | 🎭 Rôles automatiques |
| 📜 Logs rangés par type (auteur via le journal d’audit) | 🛡️ Sanctions complètes, blacklist d’enseigne | 🤖 AutoMod (spam, liens, mots interdits…) |
| 🎫 Tickets par motif, transcripts HTML | 🎉 Giveaways (conditions, pause, nouveau tirage) | 🔴 Twitch multi-chaînes (live, fin, clips, raids) |
| 🎵 Musique (YouTube, SoundCloud, Spotify, Deezer) | 🌟 Progression : niveaux, gold, rangs E à S | 🧍 Avatars homme ou femme à collectionner |
| 🎁 Coffres et objets par rareté | 🎯 Quêtes du jour et de la semaine | 🏆 Classements par période |
| 💡 Suggestions votées | 📊 Sondages | 🎭 Rôles à boutons, menus et notifications |
| 💤 AFK | 🚨 Signalements et avis | 📈 Statistiques du serveur |
| 🏅 Badges | 🎂 Anniversaires | ⏰ Rappels persistants |
| 📅 Événements avec réponses | 📣 Annonces avec aperçu | 📦 Rédaction d’embeds |
| 🧩 Commandes personnalisées | 💬 Réponses automatiques | 📨 Suivi des invitations |
| 🚀 Boosts et récompenses | 🎲 Mini-jeux | 🏆 Concours (votes, jury) |
| 📜 Règlement à accepter | 🔐 Vérification (clic ou code) | 🚨 Anti-raid et 💥 anti-nuke |
| 📝 Formulaires, partenariats, candidatures | 💾 Sauvegardes et restauration | 🌐 Site d’administration |

Tous les modules s’activent ou se coupent par serveur avec `/modules`. Les commandes longues affichent une barre de progression (pourcentage, avancement, temps restant).

---

## Installation

**Prérequis**

- [Node.js](https://nodejs.org) **22.13 ou plus récent** (Node 24 recommandé). La base de données utilise le SQLite intégré à Node.
- Rien d’autre pour la musique : le bot télécharge tout seul la version autonome de `yt-dlp` pour son système (sans Python) et la met à jour chaque jour. FFmpeg est fourni par `ffmpeg-static`.

```bash
npm install
```

```bash
npm run build
```

---

## Discord Developer Portal

1. Va sur <https://discord.com/developers/applications> → **New Application**.
2. Onglet **Bot** :
   - **Reset Token** → copie le jeton dans `DISCORD_TOKEN` (ne le partage jamais).
   - Active **Server Members Intent** et **Message Content Intent** (arrivées, AutoMod, préfixes, progression).
3. Onglet `General Information` : copie l’**Application ID** dans `DISCORD_CLIENT_ID`.
4. Onglet **OAuth2** (pour le site) : copie le **Client Secret** dans `DISCORD_CLIENT_SECRET` et ajoute la redirection `https://ton-domaine/callback`.
5. **Inviter le bot** : OAuth2 → URL Generator → scopes `bot` et `applications.commands`, permission **Administrateur** (le plus simple).
6. Place le **rôle du bot en haut** de la liste : il ne peut donner ou retirer que les rôles situés en dessous du sien.

---

## Fichier .env

Crée un fichier `.env` à la racine du bot avec ces variables.

| Variable | Rôle |
|---|---|
| `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` | **Obligatoires** |
| `BOT_OWNER_IDS` | Propriétaires du bot |
| `DEV_GUILD_ID` | Serveur de test : commandes enregistrées tout de suite |
| `AUTO_DEPLOY_COMMANDS` | Enregistre les commandes au démarrage si elles ont changé |
| `DATABASE_PATH`, `BACKUP_DIR` | Emplacement de la base et des sauvegardes |
| `DEFAULT_TIMEZONE` | Fuseau par défaut (`Europe/Paris`) |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Annonces de live |
| `TWITCH_USER_TOKEN` / `TWITCH_REFRESH_TOKEN` | Facultatifs : raids, follows, abonnements |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Facultatifs : liens Spotify |
| `DASHBOARD_ENABLED`, `DASHBOARD_URL`, `DASHBOARD_SESSION_SECRET` | Site d’administration |

Le fichier `.env` n’est jamais suivi par git.

---

## Lancement

```bash
npm start
```

Au premier démarrage la base est créée (`data/bot.sqlite`) et les commandes sont enregistrées. Pour forcer l’enregistrement :

```bash
npm run deploy
```

---

## Premiers pas sur un serveur

1. **`/quicksetup`** — crée, sans rien écraser, les salons de base et les catégories de logs.
2. **`/setup`** — l’assistant : bienvenue, logs, tickets, giveaways, Twitch, modération, musique, rôles, communauté, sécurité, apparence.
3. **`/modules`** — garde uniquement ce qui sert au serveur.
4. **`/wl`** — donne les accès à l’équipe.
5. **`/test`** — vérifie les permissions du bot et essaie les messages.

---

## Accès : niveaux, rôles et whitelists

Chaque niveau garde les droits des précédents.

| Niveau | Obtenu par |
|---|---|
| 🎥 **Streamer** | Propriétaire du serveur, rôle Streamer, whitelist **streamer** |
| 🛠️ **Admin** | Administrateur ou Gérer le serveur, rôle Admin, whitelist **admin** |
| 🛡️ **Système** | Rôle Système, whitelist **sys** — sanctions |
| ⭐ **Staff** | Rôle Staff, whitelist **staff** |
| 🎫 **Support** | Rôle Support, whitelist **support** — tickets |
| **Membre** | Tout le monde |

Whitelists ciblées : 🔎 **logs**, 🚧 **bypass**, 🎉 **giveaway**, 🎧 **dj**.

- `/wl` : voir une liste, ajouter ou retirer ; `/wl personne:@x` : toutes les whitelists d’une personne.
- On ne distribue que les whitelists **en dessous** de son niveau. Les salons de logs s’ouvrent automatiquement aux bonnes whitelists.
- `/help` n’affiche que les commandes que la personne peut lancer ; un accès refusé ne répond rien en public.
- Un serveur sans rôles réglés reste utilisable : le propriétaire et les administrateurs gardent la main.

---

## Progression

- **XP et gold** en parlant (avec un délai entre deux gains) et en vocal à plusieurs ; chaque niveau gagné rapporte du gold.
- **Rangs** : E, D, C, B, A puis S. Chaque rang débloque de nouvelles coupes et tenues.
- **Avatar** (`=avatar`) : au premier passage on choisit homme ou femme (définitif) et son teint, ou le personnage suit un rôle réglé dans `/setup`.
- **Coffres** (`=shop`) : un par catégorie (cheveux, yeux, tenues), objet tiré selon la rareté — Commun 45 %, Peu commun 25 %, Rare 15 %, Épique 10 %, Légendaire 4 %, Mythique 1 %. Un coffre ne redonne jamais un objet déjà possédé.
- **Inventaire** (`=inv`) : collection par catégorie, puis par modèle et par couleur ; un clic équipe.
- **Quêtes** (`=quest`) : quatre du jour (récompense immédiate) et cinq de la semaine (bouton « Valider »).
- **Classements** (`=lb`) : messages, vocal, XP, gold, réputation — du jour, de la semaine, du mois ou depuis toujours.
- **Statut** (`=lvl`) : rang, niveau, XP, positions du mois, messages et vocal sur 24 h, 7 jours et le mois.
- `=bio`, `=settings` (notifications et bonus XP), `=rep @membre` (une réputation par jour), `=jeu` (centre de commandes).

---

## Préfixes

| Domaine | Défaut | Exemples |
|---|---|---|
| Sanctions | `+` | `+ban`, `+mute @x 10m`, `+warn`, `+gbl` |
| Salons | `&` | `&clear 50`, `&lock`, `&l0all` |
| Général | `=` | `=help`, `=lvl`, `=avatar`, `=remind 2h30 live` |
| Musique | `m!` | `m!play`, `m!skip`, `m!panel` |

Préfixes et salons de commandes : `/config prefixes`.

---

## Twitch

1. Crée une application sur <https://dev.twitch.tv/console/apps>, puis renseigne `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET`.
2. `/twitch setup` → salon, rôle, messages, couleur.
3. `/twitch add` pour chaque chaîne suivie (salon, rôle, message et options propres).
4. `/twitch test` pour voir le rendu.

Annonce unique par live même après un redémarrage, tolérance aux micro-coupures, message mis à jour pendant le live puis résumé à la fin. La carte de bienvenue prend automatiquement la bannière Twitch du streamer.

---

## Musique

- Recherche YouTube, liens YouTube, SoundCloud, Deezer et Spotify (lecture via YouTube).
- `yt-dlp` avec plusieurs clients de secours, mis à jour chaque jour ; `play-dl` en dernier recours.
- File avec réserve, boucle, mélange, précédent, vote pour passer, départ automatique quand le salon se vide.

---

## Site web

1. Dans le `.env` : `DASHBOARD_ENABLED=true`, `DASHBOARD_URL`, `DASHBOARD_SESSION_SECRET` (32 caractères aléatoires minimum) et `DISCORD_CLIENT_SECRET`.
2. Ajoute `https://ton-domaine/callback` dans les redirections OAuth2.
3. Place un proxy HTTPS devant `DASHBOARD_PORT`.

Pages : accueil, modules, tickets, giveaways, Twitch, modération, logs, personnalisation. Réservé au niveau Admin du serveur. Point de santé : `GET /health`.

---

## Liste des commandes

### 📌 Pour tout le monde
`/help` · `/ping` · `/photo` · `/userinfo` · `/serverinfo` · `/botinfo` · `/stats` · `=help` · `=ui` · `=si` · `+pic` · `+banner`

### 🌟 Progression
`/niveau` · `/classement` · `/rangs` · `/quetes` · `/avatar` · `/boutique` · `/quotidien` · `/gold` · `/donner` · `/rep` · `/parametres` · `=lvl` · `=lb` · `=rangs` · `=quest` · `=avatar` · `=inv` · `=shop` · `=daily` · `=gold` · `=give` · `=rep` · `=bio` · `=settings` · `=jeu`

### ⭐ Communauté
`/suggest` · `/poll` · `/afk` · `/report` · `/feedback` · `/badge` · `/birthday` · `/remind` · `/event` · `/invites` · `/boost` · `/contest` · `/partner` · `/staffapply`

### 🎲 Mini-jeux
`/8ball` · `/coinflip` · `/dice` · `/rps`

### 🎵 Musique
`/play` · `/pause` · `/resume` · `/skip` · `/stop` · `/join` · `/leave` · `/shuffle` · `/queue` · `/nowplaying` · `/volume` · `/loop` · `m!play` · `m!panel` · `m!help`

### 🔴 Twitch · 🎫 Tickets · 🎉 Giveaways
`/twitch` · `/ticket` · `/giveaway`

### 🎭 Rôles
`/autorole` · `/reactionrole` · `/notificationrole`

### 🛡️ Sanctions et salons
`/warn` · `/unwarn` · `/warnings` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban` · `/blacklist` · `/clear` · `/slowmode` · `/lock` · `/unlock` · `/lockdown` · `/antiraid` · `/antinuke` · `+unbanall` · `+gbl` · `+ungbl` · `&l0all` · `&unl0all`

### 📝 Poster et animer
`/announce` · `/embed` · `/customcommand` · `/autoresponse`

### ⚙️ Le serveur
`/setup` · `/quicksetup` · `/modules` · `/config` · `/test` · `/wl` · `/logs` · `/progression` · `/rules` · `/verify` · `/form` · `/backup`

**Variables** utilisables dans les messages : `{user}` `{mention}` `{username}` `{userid}` `{server}` `{membercount}` `{createdat}` `{channel}` `{role}` `{date}` `{time}` `{streamer}` `{game}` `{title}` `{viewers}` `{url}` `{level}` `{boosts}` `{brand}` `{twitch}`.

---

## Organisation du code

```
src/
  demarrage.ts        démarrage et arrêt propre
  enregistrement.ts   enregistrement des commandes
  site.ts             site d’administration
  coeur/              socle commun (outils, base, réglages, accès, affichage, journaux, aiguilleur, assistant)
  modules/            un fichier par domaine (progression, tickets, twitch, musique, modération…)
  modules/liste.ts    la liste des modules chargés
assets/               polices et fond de bienvenue
```

Chaque module est isolé : une erreur dans un module n’interrompt jamais les autres. Pour retirer un module, enlève sa ligne dans `src/modules/liste.ts`.

---

## Base de données et sauvegardes

- SQLite (`node:sqlite`, mode WAL) dans `data/bot.sqlite`, créé automatiquement ; migrations versionnées dans `src/coeur/base.ts`.
- Tout est persistant et reprend après un redémarrage.
- `/backup create` sauvegarde la configuration du serveur ; une sauvegarde automatique est faite chaque jour (7 conservées). `/backup restore` crée d’abord une sauvegarde de sécurité.

---

## Hébergement

Sur un panel d’hébergement (image Node.js 24) :

| Réglage | Valeur |
|---|---|
| Adresse du dépôt Git | `https://github.com/affraidofwoman/noctaly` |
| Branche | `main` |
| Fichier principal | `dist/src/demarrage.js` |
| Commande avant démarrage | `npm run build` |
| Modules natifs à compiler | `ffmpeg-static` |
| Installation auto des dépendances | activée |

Le fichier `.env` et le dossier `data/` se créent sur l’hébergeur et ne sont jamais envoyés sur GitHub. Pour un dépôt privé, le jeton GitHub doit avoir la permission **Contents : lecture**.

Sans panel : Node 24 puis un gestionnaire de processus (pm2, systemd…).

```bash
npm ci && npm run build && npm start
```

---

## Dépannage

| Problème | Solution |
|---|---|
| `Intents refusés` au démarrage | Active **Server Members** et **Message Content** dans le Developer Portal |
| `Jeton Discord invalide` | Vérifie `DISCORD_TOKEN` |
| Les commandes n’apparaissent pas | Attends quelques minutes ou renseigne `DEV_GUILD_ID`, puis `npm run deploy` |
| « Je ne peux pas donner ce rôle » | Monte le rôle du bot au-dessus du rôle concerné |
| Aucune annonce Twitch | `/test` → état de la connexion Twitch, vérifie les clés et le salon |
| Pas de son | `/test` → état du lecteur ; au premier démarrage, yt-dlp met une minute à se télécharger |
| Pas d’image (bienvenue, cartes) | `npm install` sur l’hébergeur (module `@napi-rs/canvas`) |

Le bot ne montre jamais d’erreur technique aux membres : les détails vont dans la console et le salon `#sante-log`.
