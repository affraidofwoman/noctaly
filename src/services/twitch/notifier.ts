import { EmbedBuilder, type Client, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { enseigneDe, lireCouleur } from '../../core/brand';
import { lireConfig } from '../../core/guildConfig';
import { journal, historiser, resoudreSalonTexte } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import { formaterNombre, tronquer } from '../../core/text';
import { formaterDuree, marqueTemps } from '../../core/time';
import { estLienHttp, boutonLien, rangee } from '../../core/ui';
import { remplirModele } from '../../core/variables';
import { lireClips, lireDerniereVod, lireLives, lireComptes, miniatureLive, type TwitchStream } from './api';

const registre = creerRegistre('twitch');

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

/** Un live absent moins longtemps que cela est considéré comme une micro-coupure (pas de fin, pas de doublon). */
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
  return lireCouleur(salonVise.couleur) ?? lireCouleur(lireConfig(serveur.id).twitch.color) ?? enseigneDe(serveur.id).couleur;
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

/** Message de live : « 🔴 {streamer} est en LIVE ! » + jeu, titre, viewers et bouton « REGARDER LE LIVE ». */
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
    // Une annonce impossible à construire ou à envoyer ne doit jamais bloquer l'enregistrement du live (sinon doublons).
    const envoye = await (async () => salon.send(construireMessageLive(serveur, salonVise, flux)))().catch((echec: Error) => {
      registre.avertir(`Notification de live non envoyée (${salonVise.pseudo} → ${serveur.id}) : ${echec.message}`);
      return null;
    });
    messageId = envoye?.id ?? null;
    // Publication automatique dans les salons d'annonces pour les serveurs abonnés.
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

/** Un tour de sondage : une seule requête par lot de 100 chaînes, pour tous les serveurs. */
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
        // Reprise après une coupure courte : même live, on ne renotifie pas.
        else if (salonVise.live_id && salonVise.live_vu_le && maintenant - salonVise.live_vu_le < GRACE_HORS_LIGNE_MS && Date.parse(flux.started_at) - (salonVise.live_debut_le ?? 0) < GRACE_HORS_LIGNE_MS * 2) {
          executer('UPDATE chaines_twitch SET live_id = ? WHERE id = ?', flux.id, salonVise.id);
          await surMiseAJour(client, { ...salonVise, live_id: flux.id }, flux);
        } else await surLive(client, salonVise, flux);
      } else if (salonVise.live_id && (!salonVise.live_vu_le || maintenant - salonVise.live_vu_le >= GRACE_HORS_LIGNE_MS)) {
        await surHorsLigne(client, salonVise);
      }
    } catch (echec) {
      registre.avertir(`Traitement Twitch ${salonVise.pseudo} (${salonVise.serveur_id}) en échec : ${(echec as Error).message}`);
    }
  }
}

/** Nouveaux clips depuis le dernier passage. */
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

/** Événements EventSub (raid, follow, abonnement) envoyés aux serveurs qui suivent la chaîne. */
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


