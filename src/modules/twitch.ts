import fs from 'node:fs';
import path from 'node:path';
import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { enHexa, enseigneDe, lireCouleur } from '../coeur/acces';
import {
  aideVariables,
  bouton,
  boutonLien,
  construireFormulaire,
  embedEnseigne,
  estLienHttp,
  info,
  ok,
  rangee,
  remplirModele,
  repondre,
} from '../coeur/affichage';
import { afficherPage, lirePageReglage, type PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot } from '../coeur/noyau';
import { creerRegistre, environnement, ErreurUtilisateur, formaterDuree, formaterNombre, marqueTemps, tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';

const registre = creerRegistre('twitch');

const HELIX = 'https://api.twitch.tv/helix';

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
  tags?: string[];
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  offline_image_url: string;
  description: string;
}

export interface TwitchClip {
  id: string;
  url: string;
  broadcaster_id: string;
  creator_name: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
}

export interface TwitchVideo {
  id: string;
  url: string;
  title: string;
  created_at: string;
  duration: string;
}

export function twitchConfigure(): boolean {
  return !!environnement.twitchClientId && !!environnement.twitchSecret;
}

let jetonApplication: { token: string; expires: number } | null = null;

async function lireJetonApplication(forcer = false): Promise<string> {
  if (!forcer && jetonApplication && jetonApplication.expires > Date.now() + 60_000) return jetonApplication.token;
  const reponse = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environnement.twitchClientId, client_secret: environnement.twitchSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!reponse.ok) throw new Error(`Jeton Twitch refusé (HTTP ${reponse.status}) : vérifie TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET`);
  const donnees = (await reponse.json()) as { access_token: string; expires_in: number };
  jetonApplication = { token: donnees.access_token, expires: Date.now() + donnees.expires_in * 1000 };
  return jetonApplication.token;
}

export async function appelHelix<T>(route: string, parametres: [string, string][] = [], reessayer = true): Promise<T[]> {
  if (!twitchConfigure()) throw new Error('Twitch n’est pas configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
  const url = new URL(`${HELIX}/${route}`);
  for (const [k, v] of parametres) url.searchParams.append(k, v);
  const reponse = await fetch(url, {
    headers: { 'Client-Id': environnement.twitchClientId, Authorization: `Bearer ${await lireJetonApplication()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (reponse.status === 401 && reessayer) {
    await lireJetonApplication(true);
    return appelHelix<T>(route, parametres, false);
  }
  if (reponse.status === 429 && reessayer) {
    const reinitialiser = Number(reponse.headers.get('ratelimit-reset')) * 1000;
    const attendre = Math.min(Math.max(reinitialiser - Date.now(), 1000), 30_000);
    registre.avertir(`Rate limit Twitch, nouvelle tentative dans ${Math.round(attendre / 1000)} s`);
    await new Promise((r) => setTimeout(r, attendre));
    return appelHelix<T>(route, parametres, false);
  }
  if (!reponse.ok) throw new Error(`Twitch ${route} : HTTP ${reponse.status}`);
  const corps = (await reponse.json()) as { data: T[] };
  return corps.data ?? [];
}

function morceaux<T>(articles: T[], taille: number): T[][] {
  const sortie: T[][] = [];
  for (let i = 0; i < articles.length; i += taille) sortie.push(articles.slice(i, i + taille));
  return sortie;
}

export async function lireLives(pseudos: string[]): Promise<TwitchStream[]> {
  const unique = [...new Set(pseudos.map((l) => l.toLowerCase()))];
  const resultat: TwitchStream[] = [];
  for (const partie of morceaux(unique, 100)) {
    resultat.push(...(await appelHelix<TwitchStream>('streams', [...partie.map((l) => ['user_login', l] as [string, string]), ['first', '100']])));
  }
  return resultat;
}

export async function lireComptes(pseudos: string[]): Promise<TwitchUser[]> {
  const unique = [...new Set(pseudos.map((l) => l.toLowerCase()))];
  const resultat: TwitchUser[] = [];
  for (const partie of morceaux(unique, 100)) resultat.push(...(await appelHelix<TwitchUser>('users', partie.map((l) => ['login', l]))));
  return resultat;
}

// - Bannière d’une chaîne -
// Celle du profil, sinon l’image hors ligne ; gardée six heures.
const bannieres = new Map<string, { url: string | null; expire: number }>();

export async function banniereTwitch(pseudo: string): Promise<string | null> {
  const cle = pseudo.toLowerCase();
  const gardee = bannieres.get(cle);
  if (gardee && gardee.expire > Date.now()) return gardee.url;
  let url: string | null = null;
  try {
    const reponse = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query($login: String!) { user(login: $login) { bannerImageURL offlineImageURL } }', variables: { login: cle } }),
      signal: AbortSignal.timeout(8_000),
    });
    const corps = reponse.ok ? ((await reponse.json()) as { data?: { user?: { bannerImageURL?: string | null; offlineImageURL?: string | null } | null } }) : null;
    url = corps?.data?.user?.bannerImageURL || corps?.data?.user?.offlineImageURL || null;
  } catch {
    url = null;
  }
  if (!url && twitchConfigure()) {
    const [compte] = await lireComptes([cle]).catch(() => []);
    url = compte?.offline_image_url || null;
  }
  bannieres.set(cle, { url, expire: Date.now() + 6 * 3_600_000 });
  if (bannieres.size > 200) bannieres.delete(bannieres.keys().next().value!);
  return url;
}

export async function lireClips(diffuseurId: string, depuis: number): Promise<TwitchClip[]> {
  return appelHelix<TwitchClip>('clips', [
    ['broadcaster_id', diffuseurId],
    ['started_at', new Date(depuis).toISOString()],
    ['first', '20'],
  ]);
}

export async function lireDerniereVod(diffuseurId: string): Promise<TwitchVideo | null> {
  const videos = await appelHelix<TwitchVideo>('videos', [
    ['user_id', diffuseurId],
    ['type', 'archive'],
    ['first', '1'],
  ]).catch(() => []);
  return videos[0] ?? null;
}

export async function lireJaquette(jeuId: string): Promise<string | null> {
  if (!jeuId) return null;
  const jeux = await appelHelix<{ box_art_url: string }>('games', [['id', jeuId]]).catch(() => []);
  return jeux[0]?.box_art_url.replace('{width}', '285').replace('{height}', '380') ?? null;
}

export function miniatureLive(flux: TwitchStream): string {
  return `${flux.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')}?t=${Math.floor(Date.now() / 300_000)}`;
}

export const MOTIF_PSEUDO = /^[a-z0-9_]{3,25}$/;

export function normaliserPseudo(saisie: string): string {
  return saisie
    .trim()
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

const FICHIER_JETON = path.join(path.dirname(environnement.cheminBase), 'twitch-user-token.json');

export interface JetonUtilisateur {
  access: string;
  refresh: string | null;
}

export function chargerJetonUtilisateur(): JetonUtilisateur | null {
  try {
    const enregistre = JSON.parse(fs.readFileSync(FICHIER_JETON, 'utf8')) as JetonUtilisateur;
    if (enregistre.access) return enregistre;
  } catch {}
  return environnement.twitchJetonUtilisateur ? { access: environnement.twitchJetonUtilisateur, refresh: environnement.twitchJetonRenouvellement || null } : null;
}

export async function renouvelerJetonUtilisateur(jeton: JetonUtilisateur): Promise<JetonUtilisateur | null> {
  if (!jeton.refresh || !environnement.twitchSecret) return null;
  const reponse = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environnement.twitchClientId, client_secret: environnement.twitchSecret, grant_type: 'refresh_token', refresh_token: jeton.refresh }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!reponse.ok) return null;
  const donnees = (await reponse.json()) as { access_token: string; refresh_token: string };
  const suivant = { access: donnees.access_token, refresh: donnees.refresh_token };
  fs.mkdirSync(path.dirname(FICHIER_JETON), { recursive: true });
  fs.writeFileSync(FICHIER_JETON, JSON.stringify(suivant), { mode: 0o600 });
  return suivant;
}

export async function validerJetonUtilisateur(jeton: JetonUtilisateur): Promise<{ user_id: string; login: string; scopes: string[] } | null> {
  const reponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${jeton.access}` }, signal: AbortSignal.timeout(10_000) });
  if (!reponse.ok) return null;
  return (await reponse.json()) as { user_id: string; login: string; scopes: string[] };
}

const registreNotifications = creerRegistre('twitch');

export interface LigneChaineTwitch {
  id: number;
  serveur_id: string;
  pseudo: string;
  diffuseur_id: string | null;
  nom_affiche: string | null;
  image_profil: string | null;
  salon_id: string;
  role_id: string | null;
  message: string | null;
  couleur: string | null;
  afficher_image: number;
  notifier_fin: number;
  notifier_changements: number;
  notifier_clips: number;
  notifier_evenements: number;
  live_id: string | null;
  message_live_id: string | null;
  live_debut_le: number | null;
  live_vu_le: number | null;
  dernier_titre: string | null;
  dernier_jeu: string | null;
  derniers_spectateurs: number | null;
  pic_spectateurs: number | null;
  dernier_clip_le: number | null;
  cree_le: number;
}

// - Micro-coupures -
// Un live absent moins longtemps reste le même live : ni fin ni nouvelle annonce.
export const GRACE_HORS_LIGNE_MS = 5 * 60_000;

export function listerChaines(serveurId?: string): LigneChaineTwitch[] {
  return serveurId
    ? lireTout<LigneChaineTwitch>('SELECT * FROM chaines_twitch WHERE serveur_id = ? ORDER BY pseudo', serveurId)
    : lireTout<LigneChaineTwitch>('SELECT * FROM chaines_twitch');
}

export function lireChaine(serveurId: string, pseudo: string): LigneChaineTwitch | undefined {
  return lire<LigneChaineTwitch>('SELECT * FROM chaines_twitch WHERE serveur_id = ? AND pseudo = ?', serveurId, pseudo.toLowerCase());
}

export function lireChaineParId(id: number): LigneChaineTwitch | undefined {
  return lire<LigneChaineTwitch>('SELECT * FROM chaines_twitch WHERE id = ?', id);
}

export async function ajouterChaine(serveurId: string, pseudo: string, salonId: string, roleId: string | null): Promise<LigneChaineTwitch> {
  const [utilisateur] = await lireComptes([pseudo]);
  if (!utilisateur) throw new Error('introuvable');
  executer(
    `INSERT INTO chaines_twitch (serveur_id, pseudo, diffuseur_id, nom_affiche, image_profil, salon_id, role_id, cree_le, dernier_clip_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, pseudo) DO UPDATE SET salon_id = excluded.salon_id, role_id = excluded.role_id, diffuseur_id = excluded.diffuseur_id,
       nom_affiche = excluded.nom_affiche, image_profil = excluded.image_profil`,
    serveurId,
    utilisateur.login,
    utilisateur.id,
    utilisateur.display_name,
    utilisateur.profile_image_url,
    salonId,
    roleId,
    Date.now(),
    Date.now(),
  );
  return lireChaine(serveurId, utilisateur.login)!;
}

export function retirerChaine(serveurId: string, pseudo: string): boolean {
  return executer('DELETE FROM chaines_twitch WHERE serveur_id = ? AND pseudo = ?', serveurId, pseudo.toLowerCase()).changes > 0;
}

export function modifierChaine(id: number, correctif: Partial<Pick<LigneChaineTwitch, 'salon_id' | 'role_id' | 'message' | 'couleur' | 'afficher_image' | 'notifier_fin' | 'notifier_changements' | 'notifier_clips' | 'notifier_evenements'>>): void {
  const cles = Object.keys(correctif) as (keyof typeof correctif)[];
  if (!cles.length) return;
  executer(`UPDATE chaines_twitch SET ${cles.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cles.map((k) => correctif[k] ?? null), id);
}

function couleurDe(serveur: Guild, salonVise: LigneChaineTwitch): number {
  return lireCouleur(salonVise.couleur) ?? lireCouleur(lireConfig(serveur.id).twitch.couleur) ?? enseigneDe(serveur.id).couleur;
}

function variablesLive(serveur: Guild, salonVise: LigneChaineTwitch, flux: Pick<TwitchStream, 'user_name' | 'game_name' | 'title' | 'viewer_count'> | null) {
  return {
    guild: serveur,
    role: salonVise.role_id ? serveur.roles.cache.get(salonVise.role_id) ?? null : null,
    extra: {
      streamer: flux?.user_name ?? salonVise.nom_affiche ?? salonVise.pseudo,
      jeu: flux?.game_name || 'Sans catégorie',
      title: flux?.title ?? salonVise.dernier_titre ?? '',
      spectateurs: flux ? formaterNombre(flux.viewer_count) : '0',
      url: `https://twitch.tv/${salonVise.pseudo}`,
      enseigne: enseigneDe(serveur.id).cle ? enseigneDe(serveur.id).nom : serveur.name,
    },
  };
}

export function construireMessageLive(serveur: Guild, salonVise: LigneChaineTwitch, flux: TwitchStream) {
  const reglages = lireConfig(serveur.id).twitch;
  const variables = variablesLive(serveur, salonVise, flux);
  const contenu = remplirModele(salonVise.message || reglages.messageLive, variables);
  const url = `https://twitch.tv/${salonVise.pseudo}`;
  const embed = new EmbedBuilder()
    .setColor(couleurDe(serveur, salonVise))
    .setAuthor({ name: `${flux.user_name} est en LIVE !`, iconURL: salonVise.image_profil ?? undefined, url })
    .setTitle(tronquer(flux.title || 'Live en cours', 256))
    .setURL(url)
    .addFields(
      { name: '🎮 Jeu', value: flux.game_name || 'Sans catégorie', inline: true },
      { name: '👥 Viewers', value: formaterNombre(flux.viewer_count), inline: true },
      { name: '⏱️ Depuis', value: marqueTemps(Date.parse(flux.started_at), 'R'), inline: true },
    )
    .setFooter({ text: 'Twitch', iconURL: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png' })
    .setTimestamp(Date.parse(flux.started_at));
  if (salonVise.image_profil && estLienHttp(salonVise.image_profil)) embed.setThumbnail(salonVise.image_profil);
  if (salonVise.afficher_image && estLienHttp(flux.thumbnail_url)) embed.setImage(miniatureLive(flux));
  return {
    content: tronquer(contenu, 2000),
    embeds: [embed],
    components: [rangee(boutonLien(url, 'REGARDER LE LIVE', '🔴'))],
    allowedMentions: { roles: salonVise.role_id ? [salonVise.role_id] : [], parse: [] as ('everyone' | 'roles' | 'users')[] },
  };
}

function construireEmbedFin(serveur: Guild, salonVise: LigneChaineTwitch, urlVod: string | null) {
  const duree = salonVise.live_debut_le ? Date.now() - salonVise.live_debut_le : 0;
  const embed = new EmbedBuilder()
    .setColor(0x4e5058)
    .setAuthor({ name: `${salonVise.nom_affiche ?? salonVise.pseudo} était en live`, iconURL: salonVise.image_profil ?? undefined, url: `https://twitch.tv/${salonVise.pseudo}` })
    .setTitle(tronquer(salonVise.dernier_titre || 'Live terminé', 256))
    .setURL(`https://twitch.tv/${salonVise.pseudo}`)
    .setDescription('⚫ Le live est terminé.')
    .addFields(
      { name: '🎮 Dernier jeu', value: salonVise.dernier_jeu || '—', inline: true },
      { name: '⏱️ Durée', value: duree ? formaterDuree(duree) : '—', inline: true },
      { name: '📈 Pic de viewers', value: formaterNombre(salonVise.pic_spectateurs ?? 0), inline: true },
    )
    .setTimestamp();
  if (salonVise.image_profil) embed.setThumbnail(salonVise.image_profil);
  const boutons = urlVod ? [rangee(boutonLien(urlVod, 'Revoir le live', '📼'))] : [rangee(boutonLien(`https://twitch.tv/${salonVise.pseudo}`, 'La chaîne', '💜'))];
  return { embeds: [embed], components: boutons };
}

function salonCible(serveur: Guild, salonVise: LigneChaineTwitch): GuildTextBasedChannel | null {
  return resoudreSalonTexte(serveur, salonVise.salon_id);
}

async function surLive(client: Client, salonVise: LigneChaineTwitch, flux: TwitchStream): Promise<void> {
  const serveur = client.guilds.cache.get(salonVise.serveur_id);
  if (!serveur) return;
  const salon = salonCible(serveur, salonVise);
  const debutLe = Date.parse(flux.started_at);
  let messageId: string | null = null;
  if (salon) {
    // - Annonce du live -
    // Un envoi raté ne bloque jamais l’enregistrement du live, sinon doublons.
    const envoye = await (async () => salon.send(construireMessageLive(serveur, salonVise, flux)))().catch((echec: Error) => {
      registreNotifications.avertir(`Notification de live non envoyée (${salonVise.pseudo} → ${serveur.id}) : ${echec.message}`);
      return null;
    });
    messageId = envoye?.id ?? null;
    if (envoye && envoye.crosspostable) await envoye.crosspost().catch(() => undefined);
  }
  executer(
    `UPDATE chaines_twitch SET live_id = ?, message_live_id = ?, live_debut_le = ?, live_vu_le = ?, dernier_titre = ?, dernier_jeu = ?, derniers_spectateurs = ?, pic_spectateurs = ? WHERE id = ?`,
    flux.id,
    messageId,
    debutLe,
    Date.now(),
    flux.title,
    flux.game_name,
    flux.viewer_count,
    flux.viewer_count,
    salonVise.id,
  );
  historiser(serveur.id, 'twitch', 'live', null, null, { login: salonVise.pseudo, title: flux.title, game: flux.game_name });
  void journal(serveur, 'twitch', {
    titre: 'Live lancé',
    ton: 'ok',
    lignes: [`**Chaîne** : [${flux.user_name}](https://twitch.tv/${salonVise.pseudo})`, `**Jeu** : ${flux.game_name || '—'}`, `**Titre** : ${tronquer(flux.title, 300)}`, salon ? `**Annonce** : <#${salon.id}>` : '⚠️ Salon d’annonce inutilisable'],
  });
}

async function surMiseAJour(client: Client, salonVise: LigneChaineTwitch, flux: TwitchStream): Promise<void> {
  const serveur = client.guilds.cache.get(salonVise.serveur_id);
  if (!serveur) return;
  const changements: string[] = [];
  if (salonVise.dernier_jeu !== null && flux.game_name !== salonVise.dernier_jeu) changements.push(`🎮 **Jeu** : ${salonVise.dernier_jeu || '—'} → **${flux.game_name || '—'}**`);
  if (salonVise.dernier_titre !== null && flux.title !== salonVise.dernier_titre) changements.push(`📺 **Titre** : ${tronquer(flux.title, 250)}`);
  executer(
    'UPDATE chaines_twitch SET live_vu_le = ?, dernier_titre = ?, dernier_jeu = ?, derniers_spectateurs = ?, pic_spectateurs = MAX(COALESCE(pic_spectateurs, 0), ?) WHERE id = ?',
    Date.now(),
    flux.title,
    flux.game_name,
    flux.viewer_count,
    flux.viewer_count,
    salonVise.id,
  );
  const salon = salonCible(serveur, salonVise);
  if (salon && salonVise.message_live_id) {
    const message = await salon.messages.fetch(salonVise.message_live_id).catch(() => null);
    if (message) await message.edit(construireMessageLive(serveur, { ...salonVise, dernier_titre: flux.title }, flux)).catch(() => undefined);
  }
  if (!changements.length) return;
  void journal(serveur, 'twitch', { titre: 'Live modifié', ton: 'info', lignes: [`**Chaîne** : ${flux.user_name}`, ...changements] });
  if (salonVise.notifier_changements && salon) {
    const embed = new EmbedBuilder()
      .setColor(couleurDe(serveur, salonVise))
      .setAuthor({ name: flux.user_name, iconURL: salonVise.image_profil ?? undefined, url: `https://twitch.tv/${salonVise.pseudo}` })
      .setDescription(changements.join('\n'));
    await salon.send({ embeds: [embed], components: [rangee(boutonLien(`https://twitch.tv/${salonVise.pseudo}`, 'Rejoindre le live', '🔴'))] }).catch(() => undefined);
  }
}

async function surHorsLigne(client: Client, salonVise: LigneChaineTwitch): Promise<void> {
  const serveur = client.guilds.cache.get(salonVise.serveur_id);
  executer('UPDATE chaines_twitch SET live_id = NULL, message_live_id = NULL, live_vu_le = NULL WHERE id = ?', salonVise.id);
  if (!serveur) return;
  const vod = salonVise.diffuseur_id ? await lireDerniereVod(salonVise.diffuseur_id).catch(() => null) : null;
  const salon = salonCible(serveur, salonVise);
  if (salon && salonVise.message_live_id) {
    const message = await salon.messages.fetch(salonVise.message_live_id).catch(() => null);
    if (message) await message.edit({ content: message.content, ...construireEmbedFin(serveur, salonVise, vod?.url ?? null), allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  if (salonVise.notifier_fin && salon) {
    const texte = remplirModele(lireConfig(serveur.id).twitch.messageFin, variablesLive(serveur, salonVise, null));
    if (texte.trim()) await salon.send({ content: tronquer(texte, 2000), allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  historiser(serveur.id, 'twitch', 'offline', null, null, { login: salonVise.pseudo, peak: salonVise.pic_spectateurs });
  void journal(serveur, 'twitch', {
    titre: 'Live terminé',
    ton: 'neutre',
    lignes: [`**Chaîne** : ${salonVise.nom_affiche ?? salonVise.pseudo}`, salonVise.live_debut_le ? `**Durée** : ${formaterDuree(Date.now() - salonVise.live_debut_le)}` : null, `**Pic de viewers** : ${salonVise.pic_spectateurs ?? 0}`],
  });
}

export async function sonderLives(client: Client): Promise<void> {
  const salons = listerChaines().filter((c) => client.guilds.cache.has(c.serveur_id) && moduleActif(c.serveur_id, 'twitch'));
  if (!salons.length) return;
  const lives = await lireLives(salons.map((c) => c.pseudo));
  const parPseudo = new Map(lives.map((s) => [s.user_login.toLowerCase(), s]));
  const maintenant = Date.now();
  for (const salonVise of salons) {
    try {
      const flux = parPseudo.get(salonVise.pseudo);
      if (flux) {
        if (salonVise.live_id === flux.id) await surMiseAJour(client, salonVise, flux);
        else if (salonVise.live_id && salonVise.live_vu_le && maintenant - salonVise.live_vu_le < GRACE_HORS_LIGNE_MS && Date.parse(flux.started_at) - (salonVise.live_debut_le ?? 0) < GRACE_HORS_LIGNE_MS * 2) {
          executer('UPDATE chaines_twitch SET live_id = ? WHERE id = ?', flux.id, salonVise.id);
          await surMiseAJour(client, { ...salonVise, live_id: flux.id }, flux);
        } else await surLive(client, salonVise, flux);
      } else if (salonVise.live_id && (!salonVise.live_vu_le || maintenant - salonVise.live_vu_le >= GRACE_HORS_LIGNE_MS)) {
        await surHorsLigne(client, salonVise);
      }
    } catch (echec) {
      registreNotifications.avertir(`Traitement Twitch ${salonVise.pseudo} (${salonVise.serveur_id}) en échec : ${(echec as Error).message}`);
    }
  }
}

export async function sonderClips(client: Client): Promise<void> {
  const salons = listerChaines().filter((c) => c.notifier_clips && c.diffuseur_id && client.guilds.cache.has(c.serveur_id) && moduleActif(c.serveur_id, 'twitch'));
  for (const salonVise of salons) {
    const depuis = salonVise.dernier_clip_le ?? Date.now() - 3_600_000;
    const clips = (await lireClips(salonVise.diffuseur_id!, depuis).catch(() => [])).filter((c) => Date.parse(c.created_at) > depuis).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!clips.length) continue;
    const serveur = client.guilds.cache.get(salonVise.serveur_id)!;
    const salon = salonCible(serveur, salonVise);
    for (const clip of clips.slice(-5)) {
      if (!salon) break;
      const embed = new EmbedBuilder()
        .setColor(couleurDe(serveur, salonVise))
        .setAuthor({ name: `Nouveau clip — ${salonVise.nom_affiche ?? salonVise.pseudo}`, iconURL: salonVise.image_profil ?? undefined })
        .setTitle(tronquer(clip.title, 256))
        .setURL(clip.url)
        .setImage(clip.thumbnail_url)
        .setFooter({ text: `Clippé par ${clip.creator_name} · ${Math.round(clip.duration)} s` });
      await salon.send({ embeds: [embed], components: [rangee(boutonLien(clip.url, 'Voir le clip', '🎬'))] }).catch(() => undefined);
    }
    executer('UPDATE chaines_twitch SET dernier_clip_le = ? WHERE id = ?', Math.max(...clips.map((c) => Date.parse(c.created_at))), salonVise.id);
  }
}

export async function diffuserEvenementTwitch(client: Client, diffuseurId: string, titre: string, description: string, url: string): Promise<void> {
  const salons = listerChaines().filter((c) => c.diffuseur_id === diffuseurId && c.notifier_evenements && moduleActif(c.serveur_id, 'twitch'));
  for (const salonVise of salons) {
    const serveur = client.guilds.cache.get(salonVise.serveur_id);
    if (!serveur) continue;
    const salon = salonCible(serveur, salonVise);
    const embed = new EmbedBuilder().setColor(couleurDe(serveur, salonVise)).setAuthor({ name: titre, iconURL: salonVise.image_profil ?? undefined, url }).setDescription(description).setTimestamp();
    if (salon) await salon.send({ embeds: [embed], components: [rangee(boutonLien(url, 'La chaîne', '💜'))] }).catch(() => undefined);
    void journal(serveur, 'twitch', { titre, ton: 'info', lignes: [description] });
  }
}

const registreAbonnements = creerRegistre('eventsub');

interface WsMessage {
  metadata: { message_type: string; subscription_type?: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
    subscription?: { type: string };
    event?: Record<string, unknown>;
  };
}

export class ClientAbonnementsTwitch {
  private prise: WebSocket | null = null;
  private jeton: JetonUtilisateur | null = chargerJetonUtilisateur();
  private compteJeton: { user_id: string; login: string; scopes: string[] } | null = null;
  private minuteurMaintien: NodeJS.Timeout | null = null;
  private delaiReconnexion = 5_000;
  private arrete = false;
  private abonnes = new Set<string>();

  constructor(private readonly client: Client<true>) {}

  get enabled(): boolean {
    return !!this.jeton && !!environnement.twitchClientId;
  }

  async demarrer(): Promise<void> {
    if (!this.enabled) return;
    this.compteJeton = await validerJetonUtilisateur(this.jeton!);
    if (!this.compteJeton) {
      const renouvele = await renouvelerJetonUtilisateur(this.jeton!).catch(() => null);
      if (renouvele) {
        this.jeton = renouvele;
        this.compteJeton = await validerJetonUtilisateur(renouvele);
      }
    }
    if (!this.compteJeton) {
      registreAbonnements.avertir('TWITCH_USER_TOKEN invalide ou expiré : EventSub (raids, follows, subs) désactivé.');
      return;
    }
    registreAbonnements.info(`EventSub connecté au compte Twitch ${this.compteJeton.login}.`);
    this.connecter('wss://eventsub.wss.twitch.tv/ws');
  }

  arreter(): void {
    this.arrete = true;
    if (this.minuteurMaintien) clearTimeout(this.minuteurMaintien);
    this.prise?.close();
  }

  private connecter(url: string): void {
    if (this.arrete) return;
    const prise = new WebSocket(url);
    this.prise = prise;
    prise.addEventListener('message', (evenement) => {
      void this.surMessage(String(evenement.data)).catch((echec: unknown) => registreAbonnements.avertir(`Message EventSub en échec : ${(echec as Error).message}`));
    });
    prise.addEventListener('close', () => {
      if (this.prise !== prise || this.arrete) return;
      this.abonnes.clear();
      registreAbonnements.avertir(`EventSub déconnecté, reconnexion dans ${this.delaiReconnexion / 1000} s`);
      setTimeout(() => this.connecter('wss://eventsub.wss.twitch.tv/ws'), this.delaiReconnexion).unref();
      this.delaiReconnexion = Math.min(this.delaiReconnexion * 2, 300_000);
    });
    prise.addEventListener('error', () => undefined);
  }

  private armerMaintien(secondes: number): void {
    if (this.minuteurMaintien) clearTimeout(this.minuteurMaintien);
    this.minuteurMaintien = setTimeout(() => this.prise?.close(), (secondes + 10) * 1000);
    this.minuteurMaintien.unref();
  }

  private async surMessage(brut: string): Promise<void> {
    const charge = JSON.parse(brut) as WsMessage;
    const type = charge.metadata.message_type;
    if (charge.payload.session?.keepalive_timeout_seconds) this.armerMaintien(charge.payload.session.keepalive_timeout_seconds);
    else if (type === 'session_keepalive' || type === 'notification') this.armerMaintien(30);

    if (type === 'session_welcome' && charge.payload.session) {
      this.delaiReconnexion = 5_000;
      await this.abonnerTout(charge.payload.session.id);
    } else if (type === 'session_reconnect' && charge.payload.session?.reconnect_url) {
      const ancien = this.prise;
      this.connecter(charge.payload.session.reconnect_url);
      setTimeout(() => ancien?.close(), 5_000).unref();
    } else if (type === 'notification' && charge.payload.subscription && charge.payload.event) {
      await this.surEvenement(charge.payload.subscription.type, charge.payload.event);
    }
  }

  private async creerAbonnement(sessionId: string, type: string, version: string, condition: Record<string, string>): Promise<void> {
    const cle = `${type}:${JSON.stringify(condition)}`;
    if (this.abonnes.has(cle)) return;
    const reponse = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': environnement.twitchClientId, Authorization: `Bearer ${this.jeton!.access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (reponse.status === 401) {
      const renouvele = await renouvelerJetonUtilisateur(this.jeton!).catch(() => null);
      if (renouvele) this.jeton = renouvele;
      return;
    }
    if (reponse.ok || reponse.status === 409) this.abonnes.add(cle);
    else registreAbonnements.debogage(`Abonnement EventSub ${type} refusé (HTTP ${reponse.status})`);
  }

  private async abonnerTout(sessionId: string): Promise<void> {
    const moi = this.compteJeton!;
    const diffuseurs = [...new Set(listerChaines().filter((c) => c.notifier_evenements && c.diffuseur_id).map((c) => c.diffuseur_id!))];
    for (const id of diffuseurs.slice(0, 250)) {
      await this.creerAbonnement(sessionId, 'channel.raid', '1', { to_broadcaster_user_id: id });
    }
    if (diffuseurs.includes(moi.user_id)) {
      if (moi.scopes.includes('moderator:read:followers')) await this.creerAbonnement(sessionId, 'channel.follow', '2', { broadcaster_user_id: moi.user_id, moderator_user_id: moi.user_id });
      if (moi.scopes.includes('channel:read:subscriptions')) {
        await this.creerAbonnement(sessionId, 'channel.subscribe', '1', { broadcaster_user_id: moi.user_id });
        await this.creerAbonnement(sessionId, 'channel.subscription.gift', '1', { broadcaster_user_id: moi.user_id });
        await this.creerAbonnement(sessionId, 'channel.subscription.message', '1', { broadcaster_user_id: moi.user_id });
      }
    }
  }

  resynchroniser(): void {
    this.prise?.close();
  }

  private async surEvenement(type: string, e: Record<string, unknown>): Promise<void> {
    const texte = (k: string) => String(e[k] ?? '');
    switch (type) {
      case 'channel.raid':
        return diffuserEvenementTwitch(
          this.client,
          texte('to_broadcaster_user_id'),
          '⚔️ Raid entrant !',
          `**${texte('from_broadcaster_user_name')}** débarque avec **${formaterNombre(Number(e.viewers ?? 0))}** viewers !`,
          `https://twitch.tv/${texte('to_broadcaster_user_login')}`,
        );
      case 'channel.follow':
        return diffuserEvenementTwitch(this.client, texte('broadcaster_user_id'), '💜 Nouveau follow', `Merci **${texte('user_name')}** pour le follow !`, `https://twitch.tv/${texte('broadcaster_user_login')}`);
      case 'channel.subscribe':
        if (e.is_gift) return;
        return diffuserEvenementTwitch(this.client, texte('broadcaster_user_id'), '⭐ Nouvel abonnement', `**${texte('user_name')}** vient de s’abonner (tier ${Number(texte('tier')) / 1000}) !`, `https://twitch.tv/${texte('broadcaster_user_login')}`);
      case 'channel.subscription.message':
        return diffuserEvenementTwitch(
          this.client,
          texte('broadcaster_user_id'),
          '⭐ Réabonnement',
          `**${texte('user_name')}** se réabonne — **${texte('cumulative_months')} mois** !`,
          `https://twitch.tv/${texte('broadcaster_user_login')}`,
        );
      case 'channel.subscription.gift':
        return diffuserEvenementTwitch(
          this.client,
          texte('broadcaster_user_id'),
          '🎁 Abonnements offerts',
          `**${e.is_anonymous ? 'Un anonyme' : texte('user_name')}** offre **${texte('total')}** abonnement(s) !`,
          `https://twitch.tv/${texte('broadcaster_user_login')}`,
        );
    }
  }
}

const registreTwitch = creerRegistre('twitch');
let abonnementsTwitch: ClientAbonnementsTwitch | null = null;

function exigerTwitch(): void {
  if (!twitchConfigure()) throw new ErreurUtilisateur('Twitch n’est pas relié : l’hébergeur doit renseigner `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` dans le fichier .env.');
}

function exigerChaine(serveurId: string, id: string | number | undefined): LigneChaineTwitch {
  const rangee = lireChaineParId(Number(id));
  if (!rangee || rangee.serveur_id !== serveurId) throw new ErreurUtilisateur('Cette chaîne n’est plus suivie.');
  return rangee;
}

async function suivre(serveur: Guild, pseudoBrut: string, salonId: string | null, roleId: string | null): Promise<LigneChaineTwitch> {
  exigerTwitch();
  const pseudo = normaliserPseudo(pseudoBrut);
  if (!MOTIF_PSEUDO.test(pseudo)) throw new ErreurUtilisateur('Pseudo Twitch invalide (3 à 25 caractères : lettres, chiffres, _).');
  if (listerChaines(serveur.id).length >= 25 && !lireChaine(serveur.id, pseudo)) throw new ErreurUtilisateur('25 chaînes maximum par serveur.');
  const reglages = lireConfig(serveur.id).twitch;
  const cible = salonId ?? reglages.salonDefautId;
  if (!cible) throw new ErreurUtilisateur('Choisis un salon d’annonce (option `salon`, ou salon par défaut dans `/twitch setup`).');
  const rangee = await ajouterChaine(serveur.id, pseudo, cible, roleId ?? reglages.roleDefautId).catch((echec: Error) => {
    if (echec.message === 'introuvable') throw new ErreurUtilisateur(`La chaîne **${pseudo}** n’existe pas sur Twitch.`);
    throw echec;
  });
  abonnementsTwitch?.resynchroniser();
  return rangee;
}

// - Écrans -

function ecranListe(serveur: Guild, note?: string) {
  const rangees = listerChaines(serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🔴 Chaînes Twitch suivies')
    .setDescription(
      [
        note,
        rangees.length ? 'Choisis une chaîne pour régler son salon, son rôle, son message et ses notifications.' : '*Aucune chaîne suivie. Ajoute la première !*',
        twitchConfigure() ? null : '\n⚠️ `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` manquants dans le .env : aucune notification ne partira.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  for (const r of rangees.slice(0, 24)) {
    embed.addFields({
      name: `${r.live_id ? '🔴' : '⚫'} ${r.nom_affiche ?? r.pseudo}`,
      value: tronquer(`<#${r.salon_id}>${r.role_id ? ` · <@&${r.role_id}>` : ''}${r.live_id ? `\n-# en live depuis ${marqueTemps(r.live_debut_le ?? Date.now(), 'R')}` : ''}`, 1024),
      inline: true,
    });
  }
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (rangees.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('twc:open')
          .setPlaceholder('Régler une chaîne')
          .addOptions(rangees.slice(0, 25).map((r) => ({ label: r.nom_affiche ?? r.pseudo, value: String(r.id), emoji: r.live_id ? '🔴' : '⚫', description: `twitch.tv/${r.pseudo}` }))),
      ),
    );
  }
  composants.push(rangee(bouton('twc:add', 'Ajouter une chaîne', ButtonStyle.Success, '➕'), bouton('twc:back', 'Réglages Twitch', ButtonStyle.Secondary, '⚙️')));
  return { embeds: [embed], components: composants };
}

function ecranChaine(serveur: Guild, r: LigneChaineTwitch, note?: string) {
  const drapeau = (v: number) => (v ? '🟢' : '🔴');
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: `twitch.tv/${r.pseudo}`, iconURL: r.image_profil ?? undefined, url: `https://twitch.tv/${r.pseudo}` })
    .setTitle(`🔴 ${r.nom_affiche ?? r.pseudo}`)
    .setDescription(
      [
        note,
        `• Salon — <#${r.salon_id}>`,
        `• Rôle mentionné — ${r.role_id ? `<@&${r.role_id}>` : '*aucun*'}`,
        `• Couleur — ${r.couleur ?? '*par défaut*'}`,
        `• Message — ${r.message ? `\`${tronquer(r.message, 150)}\`` : '*celui du serveur*'}`,
        '',
        `${drapeau(r.afficher_image)} Miniature du live · ${drapeau(r.notifier_fin)} Fin de live · ${drapeau(r.notifier_changements)} Jeu/titre · ${drapeau(r.notifier_clips)} Clips · ${drapeau(r.notifier_evenements)} Raids/follows/subs`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  if (r.image_profil) embed.setThumbnail(r.image_profil);
  const selecteurSalon = new ChannelSelectMenuBuilder()
    .setCustomId(`twc:chan:${r.id}`)
    .setPlaceholder('Salon d’annonce')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (serveur.channels.cache.has(r.salon_id)) selecteurSalon.setDefaultChannels(r.salon_id);
  const selecteurRole = new RoleSelectMenuBuilder().setCustomId(`twc:role:${r.id}`).setPlaceholder('Rôle mentionné (aucun = personne)').setMinValues(0).setMaxValues(1);
  if (r.role_id && serveur.roles.cache.has(r.role_id)) selecteurRole.setDefaultRoles(r.role_id);
  const basculer = (cle: string, texteLibelle: string, sur: number) => bouton(`twc:tog:${r.id}:${cle}`, texteLibelle, sur ? ButtonStyle.Success : ButtonStyle.Secondary, sur ? '🟢' : '🔴');
  return {
    embeds: [embed],
    components: [
      rangee(selecteurSalon),
      rangee(selecteurRole),
      rangee(basculer('afficher_image', 'Miniature', r.afficher_image), basculer('notifier_fin', 'Fin', r.notifier_fin), basculer('notifier_changements', 'Jeu/titre', r.notifier_changements), basculer('notifier_clips', 'Clips', r.notifier_clips), basculer('notifier_evenements', 'Événements', r.notifier_evenements)),
      rangee(
        bouton(`twc:msg:${r.id}`, 'Message & couleur', ButtonStyle.Primary, '📝'),
        bouton(`twc:test:${r.id}`, 'Tester', ButtonStyle.Secondary, '🧪'),
        bouton(`twc:del:${r.id}`, 'Ne plus suivre', ButtonStyle.Danger, '🗑️'),
        bouton('twc:list', 'Toutes les chaînes', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function liveFactice(r: LigneChaineTwitch): TwitchStream {
  return {
    id: 'test',
    user_id: r.diffuseur_id ?? '0',
    user_login: r.pseudo,
    user_name: r.nom_affiche ?? r.pseudo,
    game_id: '',
    game_name: r.dernier_jeu || 'Just Chatting',
    title: r.dernier_titre || 'Live de test — tout fonctionne !',
    viewer_count: 42,
    started_at: new Date().toISOString(),
    thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${r.pseudo}-{width}x{height}.jpg`,
  };
}

async function envoyerTest(serveur: Guild, client: Client, r: LigneChaineTwitch): Promise<string> {
  const [live] = twitchConfigure() ? await lireLives([r.pseudo]).catch(() => []) : [];
  const salon = serveur.channels.cache.get(r.salon_id);
  if (!salon?.isTextBased()) throw new ErreurUtilisateur('Le salon d’annonce est introuvable.');
  const charge = construireMessageLive(serveur, r, live ?? liveFactice(r));
  await salon.send({ ...charge, content: `🧪 **Test** — ${charge.content}`, allowedMentions: { parse: [] } });
  void client;
  return `✅ Notification de test postée dans <#${salon.id}>${live ? ' (avec le live réel en cours)' : ''}.`;
}

// - Setup -

const pageReglage: PageReglage = {
  id: 'twitch',
  section: 'twitch',
  titre: 'Twitch',
  emoji: '🔴',
  moduleId: 'twitch',
  description: `Les réglages par défaut des annonces de live. Chaque chaîne peut avoir son salon, son rôle, son message et sa couleur.\n-# Variables : ${['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    {
      genre: 'channel',
      cle: 'channel',
      libelle: 'Salon d’annonce par défaut',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      lire: (c) => c.twitch.salonDefautId,
      ecrire: (c, v) => void (c.twitch.salonDefautId = v),
    },
    { genre: 'role', cle: 'role', libelle: 'Rôle mentionné par défaut', lire: (c) => c.twitch.roleDefautId, ecrire: (c, v) => void (c.twitch.roleDefautId = v) },
    { genre: 'text', cle: 'live', libelle: 'Message de live', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.twitch.messageLive, ecrire: (c, v) => void (c.twitch.messageLive = v) },
    { genre: 'text', cle: 'end', libelle: 'Message de fin (vide = aucun)', long: true, longueurMax: 1500, lire: (c) => c.twitch.messageFin, ecrire: (c, v) => void (c.twitch.messageFin = v) },
    {
      genre: 'text',
      cle: 'color',
      libelle: 'Couleur (#hex)',
      longueurMax: 7,
      lire: (c) => c.twitch.couleur,
      ecrire: (c, v) => void (c.twitch.couleur = enHexa(lireCouleur(v) ?? 0x9146ff)),
      validate: (v) => (lireCouleur(v) !== null ? null : 'Code hexadécimal attendu (ex : #9146FF).'),
    },
  ],
  actions: [
    {
      id: 'channels',
      libelle: 'Chaînes suivies',
      emoji: '📺',
      async executer(interaction) {
        await interaction.update(ecranListe(interaction.guild));
      },
    },
    {
      id: 'brand',
      libelle: 'Suivre la chaîne de l’enseigne',
      emoji: '💜',
      async executer(interaction) {
        const pseudo = enseigneDe(interaction.guildId).pseudoTwitch;
        if (!pseudo) throw new ErreurUtilisateur('L’enseigne de ce serveur n’a pas de chaîne Twitch (réglable par l’owner bot).');
        await interaction.deferUpdate();
        const r = await suivre(interaction.guild, pseudo, null, null);
        await interaction.editReply(ecranChaine(interaction.guild, r, `✅ **${r.nom_affiche}** est suivie.`));
      },
    },
  ],
};

// - Commandes -

const optionPseudo = (o: import('discord.js').SlashCommandStringOption) => o.setName('chaine').setDescription('Pseudo ou lien Twitch').setRequired(true).setMaxLength(100);

const twitch: CommandeSlash = {
  categorie: 'twitch',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('Annonces Twitch')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les annonces'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Suivre une chaîne')
        .addStringOption(optionPseudo)
        .addChannelOption((o) => o.setName('salon').setDescription('Salon d’annonce').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner')),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer une chaîne').addStringOption((o) => optionPseudo(o).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Les chaînes suivies'))
    .addSubcommand((s) => s.setName('test').setDescription('Annonce de test').addStringOption((o) => optionPseudo(o).setAutocomplete(true))),
  niveauxSousCommandes: { list: Niveau.STAFF },
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listerChaines(interaction.guildId)
        .filter((r) => r.pseudo.includes(saisie))
        .slice(0, 25)
        .map((r) => ({ name: r.nom_affiche ?? r.pseudo, value: r.pseudo })),
    );
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    switch (sousCommande) {
      case 'setup':
        return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('twitch')!), ephemeral: true });
      case 'list':
        return repondre(interaction, { ...ecranListe(serveur), ephemeral: true });
      case 'add': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await suivre(serveur, interaction.options.getString('chaine', true), interaction.options.getChannel('salon')?.id ?? null, interaction.options.getRole('role')?.id ?? null);
        return interaction.editReply(ecranChaine(serveur, r, `✅ **${r.nom_affiche}** est suivie.`));
      }
      case 'remove': {
        const pseudo = normaliserPseudo(interaction.options.getString('chaine', true));
        if (!retirerChaine(serveur.id, pseudo)) throw new ErreurUtilisateur(`**${pseudo}** n’est pas suivie ici.`);
        return repondre(interaction, { embeds: [ok(serveur, `**${pseudo}** n’est plus suivie.`)], ephemeral: true });
      }
      case 'test': {
        const r = lireChaine(serveur.id, normaliserPseudo(interaction.options.getString('chaine', true)));
        if (!r) throw new ErreurUtilisateur('Cette chaîne n’est pas suivie ici.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ embeds: [info(serveur, await envoyerTest(serveur, interaction.client, r))] });
      }
    }
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'twitch',
    alias: ['lives'],
    domaine: 'general',
    categorie: 'twitch',
    description: 'Les chaînes suivies',
    niveau: Niveau.STAFF,
    async executer(message) {
      const { embeds } = ecranListe(message.guild);
      await message.reply({ embeds, allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleTwitch: ModuleBot = {
  id: 'twitch',
  nom: 'Twitch',
  emoji: '🔴',
  description: 'Annonces de live multi-chaînes, fin de live, clips, raids',
  desactivable: true,
  actifParDefaut: true,
  commandes: [twitch],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'twc',
      niveau: Niveau.ADMIN,
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, cle]) {
        const serveur = interaction.guild;
        switch (action) {
          case 'list':
            return interaction.update(ecranListe(serveur));
          case 'back':
            return interaction.update(afficherPage(serveur, lirePageReglage('twitch')!));
          case 'add':
            return interaction.showModal(
              construireFormulaire('twc:addm', 'Suivre une chaîne', [{ id: 'login', libelle: 'Pseudo ou lien Twitch', indication: 'ex : zerator', longueurMax: 100 }]),
            );
          case 'tog': {
            const r = exigerChaine(serveur.id, id);
            const autorise = ['afficher_image', 'notifier_fin', 'notifier_changements', 'notifier_clips', 'notifier_evenements'] as const;
            const champ = autorise.find((k) => k === cle);
            if (!champ) return;
            modifierChaine(r.id, { [champ]: r[champ] ? 0 : 1 });
            if (champ === 'notifier_evenements') abonnementsTwitch?.resynchroniser();
            const suivant = exigerChaine(serveur.id, id);
            const note = champ === 'notifier_evenements' && suivant.notifier_evenements && !abonnementsTwitch?.enabled ? '⚠️ Les événements (raids, follows, subs) demandent `TWITCH_USER_TOKEN` dans le .env.' : undefined;
            return interaction.update(ecranChaine(serveur, suivant, note));
          }
          case 'msg': {
            const r = exigerChaine(serveur.id, id);
            return interaction.showModal(
              construireFormulaire(`twc:msgm:${r.id}`, `Annonce de ${r.nom_affiche ?? r.pseudo}`.slice(0, 45), [
                { id: 'message', libelle: 'Message (vide = celui du serveur)', long: true, valeur: r.message, obligatoire: false, longueurMax: 1500, indication: '🔴 {streamer} est en LIVE ! {role}' },
                { id: 'color', libelle: 'Couleur #hex (vide = par défaut)', valeur: r.couleur, obligatoire: false, longueurMax: 7 },
              ]),
            );
          }
          case 'test': {
            const r = exigerChaine(serveur.id, id);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return interaction.editReply({ embeds: [info(serveur, await envoyerTest(serveur, interaction.client, r))] });
          }
          case 'del': {
            const r = exigerChaine(serveur.id, id);
            retirerChaine(serveur.id, r.pseudo);
            return interaction.update(ecranListe(serveur, `✅ **${r.nom_affiche ?? r.pseudo}** n’est plus suivie.`));
          }
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(ecranChaine(serveur, exigerChaine(serveur.id, interaction.values[0])));
        const r = exigerChaine(serveur.id, id);
        if (action === 'chan' && interaction.isChannelSelectMenu()) modifierChaine(r.id, { salon_id: interaction.values[0]! });
        if (action === 'role' && interaction.isRoleSelectMenu()) modifierChaine(r.id, { role_id: interaction.values[0] ?? null });
        return interaction.update(ecranChaine(serveur, exigerChaine(serveur.id, id), '✅ C’est enregistré.'));
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        const repondreEcran = async (charge: ReturnType<typeof ecranChaine>) => {
          if (interaction.isFromMessage()) await interaction.update(charge);
          else await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
        };
        if (action === 'addm') {
          await interaction.deferUpdate().catch(() => undefined);
          const r = await suivre(serveur, interaction.fields.getTextInputValue('login'), null, null);
          await interaction.editReply(ecranChaine(serveur, r, `✅ **${r.nom_affiche}** est suivie.`));
          return;
        }
        if (action === 'msgm') {
          const r = exigerChaine(serveur.id, id);
          const couleurBrute = interaction.fields.getTextInputValue('color').trim();
          const couleur = couleurBrute ? lireCouleur(couleurBrute) : null;
          if (couleurBrute && couleur === null) throw new ErreurUtilisateur('Couleur attendue au format #9146FF.');
          modifierChaine(r.id, { message: interaction.fields.getTextInputValue('message').trim() || null, couleur: couleur !== null ? enHexa(couleur) : null });
          await repondreEcran(ecranChaine(serveur, exigerChaine(serveur.id, id), '✅ C’est enregistré.'));
        }
      },
    },
  ],
  taches: [
    {
      nom: 'twitch-streams',
      intervalleMs: environnement.twitchIntervalleSecondes * 1000,
      auDemarrage: true,
      async executer(client) {
        if (twitchConfigure()) await sonderLives(client);
      },
    },
    {
      nom: 'twitch-clips',
      intervalleMs: 5 * 60_000,
      async executer(client) {
        if (twitchConfigure()) await sonderClips(client);
      },
    },
  ],
  async auDemarrage(client) {
    if (!twitchConfigure()) {
      registreTwitch.avertir('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET absents : les annonces de live sont inactives.');
      return;
    }
    abonnementsTwitch = new ClientAbonnementsTwitch(client);
    await abonnementsTwitch.demarrer().catch((echec: unknown) => registreTwitch.avertir(`EventSub non démarré : ${(echec as Error).message}`));
  },
  aLArret() {
    abonnementsTwitch?.arreter();
  },
  tests: [
    {
      id: 'variables',
      libelle: 'Variables des annonces',
      emoji: '🧩',
      description: 'Les variables utilisables dans les messages de live',
      async executer() {
        return aideVariables(['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand', 'server']);
      },
    },
    {
      id: 'status',
      libelle: 'État de la connexion Twitch',
      emoji: '📡',
      description: 'Clés API, EventSub et chaînes suivies',
      async executer(interaction) {
        const rangees = listerChaines(interaction.guildId);
        return [
          `${twitchConfigure() ? '✅' : '❌'} Clés API Twitch`,
          `${abonnementsTwitch?.enabled ? '✅' : 'ℹ️'} EventSub (raids, follows, subs)${abonnementsTwitch?.enabled ? '' : ' — nécessite TWITCH_USER_TOKEN'}`,
          `📺 ${rangees.length} chaîne(s) suivie(s), ${rangees.filter((r) => r.live_id).length} en live`,
          `⏱️ Vérification toutes les ${environnement.twitchIntervalleSecondes} s`,
        ].join('\n');
      },
    },
  ],
};
