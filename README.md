# 🤖 Twitch Community Bot

Bot Discord **all-in-one** pour les serveurs de streamers Twitch, entièrement en français.
Pensé pour **plusieurs streamers** : chaque serveur peut porter l’**enseigne** d’un streamer (nom, couleur, logo, émojis, chaîne Twitch).

> **Le principe :** j’ajoute le bot → `/setup` → quelques clics → le serveur est prêt.

Conventions reprises du bot **Airline** : `/help` « Tes commandes », tickets à boutons par motif avec transcript HTML, logs rangés dans un salon par type, whitelists par ID (`/wl`), enseignes (`/custom`), préfixes par domaine (`+` sanctions, `&` salons, `=` général, `.` owner, `m!` musique), lecteur musique yt-dlp + FFmpeg.

---

## Sommaire

1. [Fonctionnalités](#-fonctionnalités)
2. [Installation](#-installation)
3. [Discord Developer Portal](#-discord-developer-portal)
4. [Fichier .env](#-fichier-env)
5. [Lancement](#-lancement)
6. [Premiers pas sur un serveur](#-premiers-pas-sur-un-serveur)
7. [Accès : niveaux, rôles et whitelists](#-accès--niveaux-rôles-et-whitelists)
8. [Enseignes streamers (/custom)](#-enseignes-streamers-custom)
9. [Préfixes](#%EF%B8%8F-préfixes)
10. [Twitch](#-twitch)
11. [Musique](#-musique)
12. [Dashboard web](#-dashboard-web)
13. [Liste des commandes](#-liste-des-commandes)
14. [Architecture et modules](#%EF%B8%8F-architecture-et-modules)
15. [Base de données et sauvegardes](#-base-de-données-et-sauvegardes)
16. [Docker / VPS](#-docker--vps)
17. [Tests](#-tests)
18. [Dépannage](#-dépannage)

---

## ✨ Fonctionnalités

| | | |
|---|---|---|
| 👋 Bienvenue (carte image, MP, compteur) | 🚪 Départs avec statistiques | 🎭 Rôles automatiques |
| 📜 Logs (21 salons nommés, auteur via journal d’audit) | 🛡️ Modération complète + blacklist | 🤖 AutoMod (spam, liens, mots interdits…) |
| 🎫 Tickets (motifs, claim, transcripts HTML) | 🎉 Giveaways (conditions, pause, reroll) | 🔴 Twitch multi-chaînes (live, fin, clips, raids) |
| 🎵 Musique (YouTube, SoundCloud, Spotify, Deezer) | ⭐ XP, niveaux, rôles de niveau | 🏆 Rôles d’ancienneté (OG) |
| 💡 Suggestions votées | 📊 Sondages | 🎭 Rôles à réaction / boutons / menus / notifications |
| 💤 AFK | 🚨 Signalements & feedback | 📈 Statistiques |
| 👤 Profils & 🏅 badges | 🎂 Anniversaires | ⏰ Rappels persistants |
| 📅 Événements avec RSVP | 📣 Annonces avec aperçu | 📦 Embed builder |
| 🧩 Commandes personnalisées | 💬 Réponses automatiques | 📨 Suivi des invitations |
| 🚀 Boosts et récompenses | 💰 Économie virtuelle + boutique | 🎯 Quêtes & séries |
| 🎲 Mini-jeux | 🏆 Concours (votes, jury) | 📜 Règlement à accepter |
| 🔐 Vérification (clic ou code) | 🚨 Anti-raid | 💥 Anti-nuke |
| 📝 Formulaires, partenariats, candidatures staff | 💾 Sauvegardes & restauration | 🌐 Dashboard web |

**40 modules**, tous activables/désactivables par serveur (`/modules`), **85 commandes slash** et plus d’une centaine de commandes à préfixe.

---

## 📦 Installation

**Prérequis**

- [Node.js](https://nodejs.org) **22.13 ou plus récent** (Node 24 recommandé). La base de données utilise le SQLite intégré à Node : aucune dépendance native à compiler.
- Pour la musique : **FFmpeg** (fourni automatiquement par `ffmpeg-static`) et **Python 3** (pour le `yt-dlp` fourni dans `assets/bin`).

```bash
npm install
```

```bash
npm run build
```

---

## 🧰 Discord Developer Portal

1. Va sur <https://discord.com/developers/applications> → **New Application**.
2. Onglet **Bot** :
   - **Reset Token** → copie le jeton dans `DISCORD_TOKEN` (ne le partage jamais).
   - Active les **Privileged Gateway Intents** : **Server Members Intent** et **Message Content Intent** (obligatoires : arrivées, AutoMod, préfixes, XP).
3. Onglet **General Information** : copie l’**Application ID** dans `DISCORD_CLIENT_ID`.
4. Onglet **OAuth2** (pour le dashboard) : copie le **Client Secret** dans `DISCORD_CLIENT_SECRET` et ajoute la redirection `https://ton-domaine/callback`.
5. **Inviter le bot** : OAuth2 → URL Generator → scopes `bot` + `applications.commands`.
   - Permissions : **Administrateur** (le plus simple), ou au minimum : Gérer les rôles, Gérer les salons, Gérer les messages, Expulser, Bannir, Exclure temporairement, Voir les logs du serveur, Gérer le serveur (invitations), Envoyer des messages, Intégrer des liens, Joindre des fichiers, Ajouter des réactions, Lire l’historique, Se connecter, Parler.
6. Place le **rôle du bot en haut** de la liste des rôles : il ne peut donner ou retirer que les rôles situés **en dessous** du sien.

---

## 🔑 Fichier .env

Copie `.env.example` en `.env` et remplis-le. Les variables principales :

| Variable | Rôle |
|---|---|
| `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` | **Obligatoires** |
| `BOT_OWNER_IDS` | IDs des owners du bot (tous les droits partout, `/custom`, whitelist owner) |
| `DEV_GUILD_ID` | Serveur de test : commandes enregistrées instantanément |
| `AUTO_DEPLOY_COMMANDS` | Enregistre les commandes au démarrage si elles ont changé |
| `DATABASE_PATH`, `BACKUP_DIR` | Emplacement de la base et des sauvegardes |
| `DEFAULT_TIMEZONE` | Fuseau par défaut (`Europe/Paris`) |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Annonces de live |
| `TWITCH_USER_TOKEN` / `TWITCH_REFRESH_TOKEN` | Optionnels : raids, follows, abonnements |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optionnels : liens Spotify |
| `DASHBOARD_ENABLED`, `DASHBOARD_URL`, `DASHBOARD_SESSION_SECRET` | Dashboard web |

Aucun secret n’est écrit dans le code.

---

## 🚀 Lancement

```bash
npm start
```

Au premier démarrage la base est créée (`data/bot.sqlite`) et les commandes sont enregistrées automatiquement. Pour forcer l’enregistrement :

```bash
npm run deploy
```

> Commandes **globales** : leur apparition peut prendre quelques minutes. Avec `DEV_GUILD_ID`, c’est immédiat sur ce serveur.

En développement (compile puis lance) :

```bash
npm run dev
```

---

## 🧭 Premiers pas sur un serveur

1. **`/quicksetup`** — crée (sans jamais écraser) les salons de base : bienvenue, règlement, annonces, lives, général, médias, suggestions, tickets, giveaways, et les catégories **Logs · …** avec un salon par type.
2. **`/setup`** — l’assistant : Bienvenue, Logs, Tickets, Giveaways, Twitch, Modération, Musique, Rôles, Communauté, Sécurité & accès, Apparence. Tout se règle avec des menus, des boutons et des formulaires.
3. **`/modules`** — coche les modules à garder. XP, économie, quêtes, mini-jeux, concours et vérification sont désactivés par défaut.
4. **`/wl`** — donne les accès à ton équipe (voir ci-dessous).
5. **`/test`** — diagnostic des permissions du bot et tests (message de bienvenue, logs, annonce Twitch…).
6. **`/ticket panneau`**, **`/rules`**, **`/verify`**, **`/notificationrole`** — pose les panneaux.

---

## 🔐 Accès : niveaux, rôles et whitelists

Sept niveaux, chacun garde les droits des précédents :

| Niveau | Obtenu par |
|---|---|
| 👑 **Owner bot** | `BOT_OWNER_IDS` ou whitelist **owner** (globale) |
| 🎥 **Streamer** | Propriétaire du serveur, rôle Streamer, whitelist **streamer** |
| 🛠️ **Admin** | Permission Administrateur / Gérer le serveur, rôle Admin, whitelist **admin** |
| 🛡️ **Système** | Rôle Système, whitelist **sys** — sanctions |
| ⭐ **Staff** | Rôle Staff, whitelist **staff** — tickets, suggestions, événements, annonces |
| 🎫 **Support** | Rôle Support, whitelist **support** — tickets |
| **Membre** | Tout le monde |

**Whitelists ciblées** (sans niveau) : 🔎 **logs** (voir les salons de logs et `/logs`), 🚧 **bypass** (ignoré par l’AutoMod, l’anti-raid et les salons de commandes), 🎉 **giveaway** (gérer les giveaways), 🎧 **dj** (musique).

- `/wl` → choisis une whitelist pour voir sa liste, ajouter ou retirer.
- `/wl personne:@x` → toutes les whitelists de la personne, un clic pour donner/retirer.
- Raccourcis comme sur Airline : `=sys @x`, `=admin @x`, `=staff @x`, `=wlogs @x`, `.owner @x`… (seul : affiche la liste).
- On ne peut distribuer que les whitelists **en dessous** de son niveau. Les salons de logs sont automatiquement ouverts aux whitelists concernées.
- `/help` n’affiche **que** les commandes que la personne peut lancer.

Les rôles d’accès se choisissent dans `/setup` → **Sécurité & accès** (le bot n’impose aucun nom de rôle).

---

## 🎨 Enseignes streamers (/custom)

Réservé aux owners du bot. Une enseigne = un streamer :

- **nom**, **couleur** (palettes ou code exact), **pied de page**, **logo**, **fond de la carte de bienvenue** ;
- **chaîne Twitch** (bouton « Suivre la chaîne de l’enseigne » dans `/twitch setup`) et **liens** (Twitch, YouTube, X, TikTok, Instagram) ;
- **serveurs couverts** (un serveur appartient à une seule enseigne) ;
- **émojis** : remplace seulement ceux que tu veux (émojis personnalisés `<:nom:id>` acceptés).

Tous les messages envoyés sur un serveur prennent la direction artistique de son enseigne (thème « Enseigne » par défaut, modifiable dans `/config apparence`).

---

## ⌨️ Préfixes

| Domaine | Défaut | Exemples |
|---|---|---|
| Sanctions | `+` | `+ban`, `+mute @x 10m`, `+warn`, `+pic`, `+badword` |
| Salons | `&` | `&clear 50`, `&lock`, `&l0all`, `&bl` |
| Général | `=` | `=help`, `=ui`, `=rank`, `=remind 2h30 live`, `=sys @x` |
| Owner | `.` | `.servers`, `.custom`, `.gbl` |
| Musique | `m!` | `m!play`, `m!skip`, `m!panel` |

Préfixes et **salons de commandes** (là où les préfixes fonctionnent) : `/config prefixes`. Les commandes personnalisées ont leur propre préfixe (`!` par défaut).

---

## 🔴 Twitch

1. Crée une application sur <https://dev.twitch.tv/console/apps> (redirection : `http://localhost`), puis renseigne `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET`.
2. `/twitch setup` → salon et rôle par défaut, messages, couleur.
3. `/twitch add chaine:pseudo` (autant de chaînes que tu veux, 25 par serveur). Chaque chaîne a son salon, son rôle, son message, sa couleur et ses options : miniature, fin de live, changements de jeu/titre, clips, événements.
4. `/twitch test` pour vérifier le rendu.

Fonctionnement : un seul appel API par lot de 100 chaînes toutes les `TWITCH_POLL_SECONDS`, **anti-doublon** persistant (redémarrage sans nouvelle annonce), tolérance aux micro-coupures (5 min), message de live mis à jour (viewers, jeu), transformé en résumé à la fin (durée, pic, rediffusion).

**Raids, follows et abonnements (optionnel)** : ils passent par EventSub et demandent un jeton **utilisateur** du streamer (`TWITCH_USER_TOKEN`, scopes `moderator:read:followers` et `channel:read:subscriptions`, plus `TWITCH_REFRESH_TOKEN` pour le renouvellement). Les raids fonctionnent pour toutes les chaînes suivies ; follows et abonnements uniquement pour la chaîne du compte du jeton (limitation Twitch).

---

## 🎵 Musique

- Sources : recherche YouTube, liens YouTube (vidéo ou playlist), SoundCloud, Deezer, Spotify (avec `SPOTIFY_CLIENT_ID/SECRET`, lecture via YouTube).
- Lecture : `yt-dlp` (plusieurs clients de secours, comme Airline) puis `play-dl` en dernier recours, audio normalisé par FFmpeg.
- File illimitée avec réserve, boucle morceau/file, mélange, précédent, vote pour passer, départ automatique quand le salon est vide.
- **DJ** (rôles DJ, whitelist dj ou staff) : passent sans vote et peuvent tout arrêter.
- Panneau complet : `m!panel` ou les boutons ⏮️ ⏯️ ⏭️ 🔀 🔁 ⏹️ sous « NOW PLAYING ».

Si YouTube bloque ton hébergeur : mets à jour `assets/bin/yt-dlp` (dernière version sur <https://github.com/yt-dlp/yt-dlp/releases>) ou renseigne `YOUTUBE_COOKIE`.

---

## 🌐 Dashboard web

1. Dans le `.env` : `DASHBOARD_ENABLED=true`, `DASHBOARD_URL=https://ton-domaine`, `DASHBOARD_SESSION_SECRET=` (32 caractères aléatoires minimum), `DISCORD_CLIENT_SECRET`.
2. Ajoute `https://ton-domaine/callback` dans les redirections OAuth2 de l’application.
3. Mets un reverse proxy HTTPS (Caddy, Nginx…) devant `DASHBOARD_PORT`.

Pages : **Accueil, Modules, Tickets, Giveaways, Twitch, Modération, Logs, Personnalisation**. Accès réservé aux personnes de niveau **Admin** sur le serveur (mêmes règles que le bot : rôles, permissions et whitelists). Sécurité : sessions signées HttpOnly, jetons CSRF, CSP stricte, limitation de débit, aucune donnée sensible exposée. Point de santé : `GET /health`.

---

## 📚 Liste des commandes

### 📌 Général
`/help` · `/ping` · `/avatar` · `/userinfo` · `/serverinfo` · `/botinfo` · `/stats` · `/profile` — préfixes `=help` `=ui` `=si` `+pic` `+banner` `=profil`

### ⚙️ Configuration
`/setup` · `/quicksetup` · `/modules` · `/config voir|apparence|permissions|prefixes|reset` · `/test` · `/wl` · `/custom` · `/logs voir|salons` · `/backup create|list|restore` · `/rules` · `/verify` · `/autorole`

### 🛡️ Modération
`/warn` · `/unwarn` · `/warnings` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban` · `/blacklist ajouter|retirer|info|liste` · `/clear` · `/slowmode` · `/lock` · `/unlock` · `/lockdown start|end|status` · `/antiraid status|panique|fin` · `/antinuke status|confiance`
Préfixes : `+ban` `+kick` `+mute` `+unmute` `+warn` `+unwarn` `+warns` `+baninfo` `+unbanall` `+badword` · `&clear` `&lock` `&unlock` `&l0all` `&unl0all` `&slowmode` `&bl` `&unbl` `&blinfo` · `.gbl` `.ungbl`

### 🎫 Tickets
`/ticket setup|config|panneau|close|reopen|add|remove|claim|transcript|list` — `=ticket` `=tickets`

### 🎉 Giveaways
`/giveaway start|end|reroll|pause|resume|list|menu` — `=giveaway`

### 🔴 Twitch
`/twitch setup|add|remove|list|test` — `=twitch`

### 🎵 Musique
`/play` · `/pause` · `/resume` · `/skip` · `/stop` · `/queue` · `/nowplaying` · `/volume` · `/loop` · `/shuffle` · `/join` · `/leave`
Préfixes : `m!play` `m!join` `m!pause` `m!resume` `m!skip` `m!previous` `m!stop` `m!shuffle` `m!annuler` `m!queue` `m!np` `m!volume` `m!loop` `m!remove` `m!panel` `m!help`

### ⭐ Communauté
`/suggest` · `/poll` · `/afk` · `/rank` · `/level` · `/leaderboard` · `/xp` · `/event create|cancel|list` · `/feedback` · `/report` · `/invites` · `/boost` · `/badge` · `/birthday set|remove|list` · `/remind set|list|cancel` · `/contest create|next|list` · `/partner` · `/staffapply` · `/form create|panel|delete|list`

### 🎭 Rôles
`/autorole` · `/reactionrole creer|ajouter|retirer|supprimer|liste` · `/notificationrole`

### 📝 Personnalisation
`/announce` · `/embed create|edit` · `/customcommand add|remove|list` · `/autoresponse add|remove|list`

### 💰 Économie & jeux
`/balance` · `/daily` · `/give` · `/shop voir|inventaire|ajouter|retirer|crediter` · `/quest` · `/8ball` · `/coinflip` · `/dice` · `/rps`

**Variables** utilisables dans les messages : `{user}` `{mention}` `{username}` `{userid}` `{server}` `{membercount}` `{createdat}` `{channel}` `{role}` `{date}` `{time}` `{streamer}` `{game}` `{title}` `{viewers}` `{url}` `{level}` `{boosts}` `{brand}` `{twitch}`.

---

## 🏗️ Architecture et modules

```
src/
  index.ts              démarrage, arrêt propre
  deploy.ts             enregistrement des commandes
  core/                 socle commun (ne dépend d'aucun module)
    dispatcher.ts       commandes, préfixes, composants, événements (isolation des erreurs)
    setup.ts            moteur des pages /setup (déclaratives)
    guildConfig.ts      configuration typée par serveur (cache + fusion avec les défauts)
    permissions.ts      niveaux d'accès      whitelists.ts   whitelists par ID
    brand.ts            enseignes streamers   embeds.ts       identité visuelle
    logService.ts       salons de logs        scheduler.ts    tâches périodiques (un seul timer)
    pagination.ts · confirm.ts · trash.ts · variables.ts · time.ts · ui.ts …
  services/             logique métier partagée (tickets, giveaways, twitch, musique, xp, économie…)
  modules/<id>/         un dossier = un module (commandes, préfixes, boutons, événements, tâches, pages /setup, tests)
  modules/index.ts      REGISTRE : la liste des modules chargés
  dashboard/            serveur web
  database/             SQLite + migrations versionnées
tests/                  tests node:test
```

**Chaque module est indépendant** : une erreur dans un module est capturée et n’interrompt jamais les autres (événements exécutés un par un, commandes et boutons isolés).

- **Désactiver** un module sur un serveur : `/modules` ou le dashboard.
- **Supprimer** un module : retire sa ligne dans `src/modules/index.ts` (et son dossier si tu veux). Ses commandes, boutons, tâches et pages de `/setup` disparaissent avec lui.
- **Ajouter** un module : crée `src/modules/mon-module/index.ts` qui exporte un `BotModule` (`id`, `name`, `emoji`, `commands`, `prefixCommands`, `components`, `events`, `tasks`, `setupPages`, `tests`) puis ajoute-le au registre.
- Les **boutons** utilisent des identifiants sans état (`prefixe:action:id`) : ils continuent de marcher après un redémarrage.

---

## 💾 Base de données et sauvegardes

- **SQLite** (`node:sqlite`, mode WAL), fichier `data/bot.sqlite`, créé automatiquement.
- Migrations versionnées dans `src/database/migrations.ts` (ne jamais modifier une migration publiée : en ajouter une nouvelle).
- Tout est persistant : giveaways, rappels, événements, anniversaires, Twitch, XP, tickets, sondages, concours… et reprend normalement après un redémarrage.
- `/backup create` sauvegarde la configuration du bot du serveur (réglages, modules, whitelists, Twitch, rôles à choisir, commandes perso, auto-réponses, badges, boutique, formulaires, blacklist) ; une sauvegarde automatique est faite chaque jour (7 conservées). `/backup restore` demande confirmation et crée une sauvegarde de sécurité juste avant. Les salons et rôles Discord ne sont jamais modifiés par une restauration.

---

## 🐳 Docker / VPS

```bash
docker compose up -d --build
```

Le conteneur inclut FFmpeg et Python, garde `data/` dans un volume et expose le port 3000 pour le dashboard.

Sans Docker, sur un VPS : installe Node 24, FFmpeg et Python 3, puis lance le bot avec un gestionnaire de processus (pm2, systemd…) :

```bash
npm ci && npm run build && npm start
```

---

## 🧪 Tests

```bash
npm test
```

59 tests : base de données et migrations, configuration par serveur, modules activables, niveaux et whitelists, préfixes, durées et fuseaux horaires, warns et actions automatiques, giveaways (tirage et conditions), tickets (qui voit quoi), rappels, Twitch (API simulée : anti-doublon, changements, fin de live), rôles automatiques, XP, économie, badges, AutoMod, et intégrité globale (toutes les commandes valides pour Discord, aucun doublon, toutes les pages `/setup` dans les limites de composants).

---

## 🩺 Dépannage

| Problème | Solution |
|---|---|
| `Intents refusés` au démarrage | Active **Server Members** et **Message Content** dans le Developer Portal |
| `Jeton Discord invalide` | Vérifie `DISCORD_TOKEN` (regénère-le si besoin) |
| Les commandes n’apparaissent pas | Attends quelques minutes (commandes globales) ou mets `DEV_GUILD_ID`, puis `npm run deploy` |
| « Je ne peux pas donner ce rôle » | Monte le rôle du bot au-dessus du rôle concerné |
| Aucune annonce Twitch | `/test` → « État de la connexion Twitch », vérifie les clés et le salon |
| Pas de son en musique | `/test` → « État du lecteur » (FFmpeg), Python 3 installé, `yt-dlp` à jour |
| La carte de bienvenue ne s’affiche pas | `npm install` sur l’hébergeur (module `@napi-rs/canvas`) ; copie les polices Emoji/JP d’Airline dans `assets/fonts` pour ces caractères |
| Les commandes `+`/`&`/`=` ne répondent pas | Préfixes et salons de commandes dans `/config prefixes` ; un accès refusé ne répond rien (comme Airline) |

Le bot ne montre jamais d’erreur technique aux membres : les détails sont dans la console et le salon `#sante-log`.
