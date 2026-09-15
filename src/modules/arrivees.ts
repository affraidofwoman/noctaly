import fs from 'node:fs';
import path from 'node:path';
import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
  SlashCommandBuilder,
} from 'discord.js';
import { botPeutGererRole, emojiPour, enseigneDe, rolesAttribuables } from '../coeur/acces';
import { aideVariables, couleurPour, embedEnseigne, estLienHttp, remplirModele, repondre } from '../coeur/affichage';
import { afficherPage, lirePageReglage, type PageReglage } from '../coeur/assistant';
import { journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import { creerRegistre, RACINE_PROJET, formaterDuree, formaterNombre, tronquer, Niveau } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import { activiteMembre } from './niveaux';
import { banniereTwitch, listerChaines } from './twitch';

const registre = creerRegistre('carte');

const LARGEUR = 1024;
const HAUTEUR = 362;
const RAYON_AVATAR = 95;
const BORDURE_AVATAR = 5;
export const RESSOURCES = path.join(RACINE_PROJET, 'assets');
const FOND_DEFAUT = path.join(RESSOURCES, 'bienvenue', 'fond.webp');
const DOSSIER_POLICES = path.join(RESSOURCES, 'fonts');

const POLICES: [string, string][] = [
  ['NotoSans.ttf', 'CarteTexte'],
  ['NotoSans-Bold.ttf', 'CarteTexte'],
  ['NotoSansJP.ttf', 'CarteJP'],
  ['NotoSansMath.ttf', 'CarteMath'],
  ['NotoSansSymbols2.ttf', 'CarteSymboles'],
  ['NotoColorEmoji.ttf', 'CarteEmoji'],
];
const PILE_POLICES = 'CarteTexte, CarteJP, CarteMath, CarteSymboles, CarteEmoji, sans-serif';

type BibliothequeToile = typeof import('@napi-rs/canvas');
type ImageToile = Awaited<ReturnType<BibliothequeToile['loadImage']>>;
type Contexte = ReturnType<ReturnType<BibliothequeToile['createCanvas']>['getContext']>;

let bibliotheque: BibliothequeToile | null | undefined;
let policesChargees = false;

function bibliothequeToile(): BibliothequeToile | null {
  if (bibliotheque !== undefined) return bibliotheque;
  try {
    bibliotheque = require('@napi-rs/canvas') as BibliothequeToile;
  } catch {
    registre.avertir('@napi-rs/canvas absent — les accueils partent sans carte (npm install sur l’hébergeur).');
    bibliotheque = null;
  }
  return bibliotheque;
}

function chargerPolices(l: BibliothequeToile): void {
  if (policesChargees) return;
  policesChargees = true;
  for (const [fichier, famille] of POLICES) {
    const complet = path.join(DOSSIER_POLICES, fichier);
    try {
      if (fs.existsSync(complet)) l.GlobalFonts.registerFromPath(complet, famille);
    } catch (echec) {
      registre.avertir(`Police ${fichier} non chargée : ${(echec as Error).message}`);
    }
  }
}

function nettoyer(texte: string): string {
  return texte.toWellFormed().replace(/\s{2,}/g, ' ').trim();
}

function rectangleArrondi(contexte: Contexte, w: number, h: number, r: number): void {
  contexte.beginPath();
  contexte.moveTo(r, 0);
  contexte.lineTo(w - r, 0);
  contexte.quadraticCurveTo(w, 0, w, r);
  contexte.lineTo(w, h - r);
  contexte.quadraticCurveTo(w, h, w - r, h);
  contexte.lineTo(r, h);
  contexte.quadraticCurveTo(0, h, 0, h - r);
  contexte.lineTo(0, r);
  contexte.quadraticCurveTo(0, 0, r, 0);
  contexte.closePath();
}

function ajusterTexte(contexte: Contexte, texte: string, max: number, largeur: number, poids = '700', min = 16): number {
  let taille = max;
  do {
    contexte.font = `${poids} ${taille}px ${PILE_POLICES}`;
    if (contexte.measureText(texte).width <= largeur) return taille;
    taille -= 1;
  } while (taille > min);
  return taille;
}

const fonds = new Map<string, ImageToile>();

async function imageDistante(source: string, l: BibliothequeToile): Promise<ImageToile | null> {
  const enCache = fonds.get(source);
  if (enCache) return enCache;
  try {
    const reponse = await fetch(source, { signal: AbortSignal.timeout(8000) });
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const image = await l.loadImage(Buffer.from(await reponse.arrayBuffer()));
    fonds.set(source, image);
    if (fonds.size > 20) fonds.delete(fonds.keys().next().value!);
    return image;
  } catch (echec) {
    registre.avertir(`Fond illisible (${(echec as Error).message}) : ${source}`);
    return null;
  }
}

// - Fond de la carte -
// Le fond choisi pour l’enseigne, sinon la bannière Twitch du streamer, sinon celui du bot.
export async function sourceFond(serveurId: string): Promise<string | null> {
  const enseigne = enseigneDe(serveurId);
  if (enseigne.fond) return enseigne.fond;
  const pseudo = enseigne.pseudoTwitch ?? listerChaines(serveurId)[0]?.pseudo;
  return pseudo ? banniereTwitch(pseudo) : null;
}

async function fondDe(serveurId: string, l: BibliothequeToile): Promise<ImageToile | null> {
  const source = await sourceFond(serveurId).catch(() => null);
  const image = source ? await imageDistante(source, l) : null;
  if (image) return image;
  return fs.existsSync(FOND_DEFAUT) ? l.loadImage(FOND_DEFAUT).catch(() => null) : null;
}

function dessinerCouvrant(contexte: Contexte, image: ImageToile, largeur: number, hauteur: number): void {
  const echelle = Math.max(largeur / image.width, hauteur / image.height);
  const w = image.width * echelle;
  const h = image.height * echelle;
  contexte.drawImage(image, (largeur - w) / 2, (hauteur - h) / 2, w, h);
}

export interface OptionsCarte {
  titre?: string;
  sousTitre?: string;
}

export async function construireCarteBienvenue(membre: GuildMember, options: OptionsCarte = {}): Promise<Buffer | null> {
  const l = bibliothequeToile();
  if (!l) return null;
  try {
    chargerPolices(l);
    const enseigne = enseigneDe(membre.guild.id);
    const accent = `#${enseigne.couleur.toString(16).padStart(6, '0')}`;
    const toile = l.createCanvas(LARGEUR, HAUTEUR);
    const contexte = toile.getContext('2d');

    contexte.save();
    rectangleArrondi(contexte, LARGEUR, HAUTEUR, 28);
    contexte.clip();

    const fondCarte = await fondDe(membre.guild.id, l);
    if (fondCarte) dessinerCouvrant(contexte, fondCarte, LARGEUR, HAUTEUR);
    else {
      contexte.fillStyle = '#1f1535';
      contexte.fillRect(0, 0, LARGEUR, HAUTEUR);
    }
    const voile = contexte.createLinearGradient(0, 0, LARGEUR, 0);
    voile.addColorStop(0, 'rgba(10, 6, 24, 0.25)');
    voile.addColorStop(0.35, 'rgba(10, 6, 24, 0.5)');
    voile.addColorStop(1, 'rgba(10, 6, 24, 0.72)');
    contexte.fillStyle = voile;
    contexte.fillRect(0, 0, LARGEUR, HAUTEUR);

    const ax = 150;
    const ay = HAUTEUR / 2;
    const avatar = await l.loadImage(membre.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
    contexte.save();
    contexte.beginPath();
    contexte.arc(ax, ay, RAYON_AVATAR, 0, Math.PI * 2);
    contexte.closePath();
    contexte.clip();
    contexte.drawImage(avatar, ax - RAYON_AVATAR, ay - RAYON_AVATAR, RAYON_AVATAR * 2, RAYON_AVATAR * 2);
    contexte.restore();
    contexte.beginPath();
    contexte.arc(ax, ay, RAYON_AVATAR + BORDURE_AVATAR / 2, 0, Math.PI * 2);
    contexte.lineWidth = BORDURE_AVATAR;
    contexte.strokeStyle = accent;
    contexte.stroke();

    const ligneX = ax + RAYON_AVATAR + 44;
    contexte.beginPath();
    contexte.moveTo(ligneX, ay - 78);
    contexte.lineTo(ligneX, ay + 78);
    contexte.lineWidth = 2;
    contexte.strokeStyle = 'rgba(226, 220, 240, 0.45)';
    contexte.stroke();

    const tx = ligneX + 34;
    const largeur = LARGEUR - tx - 44;
    contexte.textAlign = 'left';
    contexte.shadowColor = 'rgba(0, 0, 0, 0.75)';
    contexte.shadowBlur = 8;
    contexte.shadowOffsetY = 2;

    const entete = nettoyer(options.titre ?? `— Bienvenue sur le serveur "${membre.guild.name}" —`);
    const tailleEntete = ajusterTexte(contexte, entete, 19, largeur, 'italic 500', 12);
    contexte.font = `italic 500 ${tailleEntete}px ${PILE_POLICES}`;
    contexte.fillStyle = '#e6e1f2';
    contexte.fillText(entete, tx, ay - 46);

    const nom = nettoyer(membre.displayName || membre.user.username) || 'nouveau membre';
    const taille = ajusterTexte(contexte, nom, 54, largeur);
    contexte.font = `700 ${taille}px ${PILE_POLICES}`;
    contexte.fillStyle = '#ffffff';
    contexte.fillText(nom, tx, ay + 14);

    const sousCommande = nettoyer(options.sousTitre ?? `Membre #${membre.guild.memberCount}`);
    const tailleSousTitre = ajusterTexte(contexte, sousCommande, 18, largeur, '500', 12);
    contexte.font = `500 ${tailleSousTitre}px ${PILE_POLICES}`;
    contexte.fillStyle = '#b8b1cd';
    contexte.fillText(sousCommande, tx, ay + 58);

    contexte.shadowColor = 'transparent';
    contexte.restore();
    return await toile.encode('png');
  } catch (echec) {
    registre.avertir(`Carte impossible, repli sur l’embed : ${(echec as Error).message}`);
    return null;
  }
}

const registreBienvenue = creerRegistre('bienvenue');

export async function envoyerBienvenue(membre: GuildMember): Promise<string | null> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).bienvenue;
  const salon = resoudreSalonTexte(serveur, reglages.salonId);
  if (!salon) return null;

  const texte = remplirModele(reglages.message, { membre, serveur });
  const mentionsAutorisees = { users: [membre.id], roles: [] as string[] };
  let carte: Buffer | null = null;
  if (reglages.modeImage === 'card') carte = await construireCarteBienvenue(membre);
  const fichiers = carte ? [new AttachmentBuilder(carte, { name: 'bienvenue.png' })] : [];

  if (!reglages.utiliserEmbed) {
    await salon.send({ content: tronquer(texte, 2000), files: fichiers, allowedMentions: mentionsAutorisees });
    return salon.id;
  }

  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(remplirModele(reglages.titre || `${emojiPour(serveur.id, 'bienvenue')} Nouveau membre`, { membre, serveur }).slice(0, 256))
    .setDescription(tronquer(texte, 4096))
    .setFooter({ text: `${membre.user.tag} · ${serveur.memberCount}ᵉ membre`, iconURL: membre.user.displayAvatarURL({ size: 64 }) })
    .setTimestamp();
  if (carte) embed.setImage('attachment://bienvenue.png');
  else if (reglages.modeImage === 'url' && estLienHttp(reglages.urlImage)) embed.setImage(reglages.urlImage);
  else embed.setThumbnail(membre.user.displayAvatarURL({ size: 256 }));

  try {
    await salon.send({ embeds: [embed], files: fichiers, allowedMentions: mentionsAutorisees });
  } catch (echec) {
    if (!fichiers.length) throw echec;
    embed.setImage(null).setThumbnail(membre.user.displayAvatarURL({ size: 256 }));
    await salon.send({ embeds: [embed], allowedMentions: mentionsAutorisees });
  }
  return salon.id;
}

async function envoyerBienvenueMp(membre: GuildMember): Promise<void> {
  const reglages = lireConfig(membre.guild.id).bienvenue;
  if (!reglages.mpActif || !reglages.messageMp) return;
  const embed = embedEnseigne(membre.guild)
    .setTitle(`${emojiPour(membre.guild.id, 'bienvenue')} ${membre.guild.name}`)
    .setDescription(tronquer(remplirModele(reglages.messageMp, { membre, serveur: membre.guild }), 4096))
    .setThumbnail(membre.guild.iconURL({ size: 128 }));
  await membre.send({ embeds: [embed] }).catch(() => undefined);
}

const compteursEnAttente = new Set<string>();
const dernierRenommage = new Map<string, number>();
const INTERVALLE_RENOMMAGE = 5 * 60_000 + 10_000;

async function actualiserCompteur(serveur: Guild): Promise<void> {
  const reglages = lireConfig(serveur.id).bienvenue;
  if (!reglages.salonCompteurId) return;
  const salon = serveur.channels.cache.get(reglages.salonCompteurId);
  if (!salon || salon.type === ChannelType.GuildCategory || !('setName' in salon)) return;
  const nom = remplirModele(reglages.formatCompteur, { serveur }).slice(0, 100);
  if (salon.name === nom) return;
  if (Date.now() - (dernierRenommage.get(serveur.id) ?? 0) < INTERVALLE_RENOMMAGE) {
    compteursEnAttente.add(serveur.id);
    return;
  }
  dernierRenommage.set(serveur.id, Date.now());
  compteursEnAttente.delete(serveur.id);
  await salon.setName(nom, 'Compteur de membres').catch((echec: Error) => registreBienvenue.avertir(`Compteur non renommé : ${echec.message}`));
}

export function planifierCompteur(serveur: Guild): void {
  void actualiserCompteur(serveur);
}

const pageReglage: PageReglage = {
  id: 'welcome',
  section: 'welcome',
  titre: 'Bienvenue',
  emoji: '👋',
  moduleId: 'welcome',
  ordre: 1,
  description: `Le message posté à chaque arrivée, avec la carte aux couleurs de l’enseigne.\n-# Variables : ${['mention', 'user', 'username', 'server', 'membercount', 'createdat'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon de bienvenue', lire: (c) => c.bienvenue.salonId, ecrire: (c, v) => void (c.bienvenue.salonId = v) },
    {
      genre: 'channel',
      cle: 'counter',
      libelle: 'Salon compteur de membres',
      channelTypes: [ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildStageVoice],
      lire: (c) => c.bienvenue.salonCompteurId,
      ecrire: (c, v) => void (c.bienvenue.salonCompteurId = v),
    },
    {
      genre: 'choice',
      cle: 'image',
      libelle: 'Image',
      options: [
        { valeur: 'card', libelle: 'Carte de bienvenue générée', emoji: '🖼️' },
        { valeur: 'url', libelle: 'Image fixe (lien)', emoji: '🔗' },
        { valeur: 'none', libelle: 'Juste l’avatar', emoji: '👤' },
      ],
      lire: (c) => c.bienvenue.modeImage,
      ecrire: (c, v) => void (c.bienvenue.modeImage = v as 'card' | 'url' | 'none'),
    },
    { genre: 'toggle', cle: 'embed', libelle: 'Embed', lire: (c) => c.bienvenue.utiliserEmbed, ecrire: (c, v) => void (c.bienvenue.utiliserEmbed = v) },
    { genre: 'toggle', cle: 'dm', libelle: 'Message privé', lire: (c) => c.bienvenue.mpActif, ecrire: (c, v) => void (c.bienvenue.mpActif = v) },
    { genre: 'text', cle: 'title', libelle: 'Titre', longueurMax: 200, lire: (c) => c.bienvenue.titre, ecrire: (c, v) => void (c.bienvenue.titre = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 2000, obligatoire: true, lire: (c) => c.bienvenue.message, ecrire: (c, v) => void (c.bienvenue.message = v) },
    { genre: 'text', cle: 'dmmessage', libelle: 'Message privé', long: true, longueurMax: 2000, lire: (c) => c.bienvenue.messageMp, ecrire: (c, v) => void (c.bienvenue.messageMp = v) },
    {
      genre: 'text',
      cle: 'imageurl',
      libelle: 'Lien de l’image fixe',
      longueurMax: 500,
      lire: (c) => c.bienvenue.urlImage,
      ecrire: (c, v) => void (c.bienvenue.urlImage = v),
      validate: (v) => (!v || estLienHttp(v) ? null : 'Lien http(s) attendu.'),
    },
    { genre: 'text', cle: 'counterformat', libelle: 'Nom du compteur', longueurMax: 90, lire: (c) => c.bienvenue.formatCompteur, ecrire: (c, v) => void (c.bienvenue.formatCompteur = v) },
  ],
};

export const moduleBienvenue: ModuleBot = {
  id: 'welcome',
  nom: 'Bienvenue',
  emoji: '👋',
  description: 'Message, carte, message privé et compteur de membres',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglage],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      if (membre.user.bot) {
        planifierCompteur(membre.guild);
        return;
      }
      await envoyerBienvenue(membre).catch((echec: Error) => registreBienvenue.avertir(`${membre.id} non accueilli : ${echec.message}`));
      await envoyerBienvenueMp(membre);
      planifierCompteur(membre.guild);
    }, 40),
    sur('guildMemberRemove', (membre) => {
      planifierCompteur(membre.guild);
    }),
  ],
  taches: [
    {
      nom: 'welcome-counter',
      intervalleMs: 60_000,
      async executer(client) {
        for (const serveurId of [...compteursEnAttente]) {
          const serveur = client.guilds.cache.get(serveurId);
          if (!serveur || !moduleActif(serveurId, 'welcome')) {
            compteursEnAttente.delete(serveurId);
            continue;
          }
          await actualiserCompteur(serveur);
        }
      },
    },
  ],
  tests: [
    {
      id: 'message',
      libelle: 'Message de bienvenue',
      emoji: '👋',
      description: 'Poster ton propre accueil dans le salon réglé',
      async executer(interaction) {
        const salonId = await envoyerBienvenue(interaction.member);
        return salonId ? `✅ Accueil posté dans <#${salonId}>.` : '⚠️ Aucun salon de bienvenue utilisable (réglage ou permissions).';
      },
    },
    {
      id: 'variables',
      libelle: 'Variables disponibles',
      emoji: '🧩',
      description: 'La liste des variables des messages',
      async executer() {
        return aideVariables(['user', 'mention', 'username', 'userid', 'server', 'membercount', 'createdat', 'date', 'time', 'brand']);
      },
    },
  ],
};

const registreDepart = creerRegistre('depart');

export async function envoyerDepart(membre: GuildMember | PartialGuildMember): Promise<string | null> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).depart;
  const salon = resoudreSalonTexte(serveur, reglages.salonId);
  if (!salon || !membre.user) return null;
  const texte = remplirModele(reglages.message, { utilisateur: membre.user, serveur });
  if (!reglages.utiliserEmbed) {
    await salon.send({ content: tronquer(texte, 2000), allowedMentions: { parse: [] } });
    return salon.id;
  }
  const activite = activiteMembre(serveur.id, membre.id);
  const reste = membre.joinedTimestamp ? Date.now() - membre.joinedTimestamp : null;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, 'error'))
    .setTitle(`${emojiPour(serveur.id, 'depart')} Départ`)
    .setDescription(tronquer(texte, 4096))
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${membre.user.tag} · ${serveur.memberCount} membres` })
    .setTimestamp();
  const statistiques = [
    reste ? `• Resté — **${formaterDuree(reste)}**` : null,
    activite ? `• Messages — **${formaterNombre(activite.messages)}**` : null,
    activite?.secondes_vocal ? `• Vocal — **${formaterDuree(activite.secondes_vocal * 1000)}**` : null,
  ].filter(Boolean);
  if (statistiques.length) embed.addFields({ name: 'Statistiques', value: statistiques.join('\n') });
  await salon.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return salon.id;
}

const pageReglageDepart: PageReglage = {
  id: 'leave',
  section: 'welcome',
  titre: 'Départ',
  emoji: '🚪',
  moduleId: 'leave',
  ordre: 2,
  description: 'Le message posté quand quelqu’un quitte le serveur.\n-# Variables : `{user}` `{username}` `{server}` `{membercount}`',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des départs', lire: (c) => c.depart.salonId, ecrire: (c, v) => void (c.depart.salonId = v) },
    { genre: 'toggle', cle: 'embed', libelle: 'Embed + statistiques', lire: (c) => c.depart.utiliserEmbed, ecrire: (c, v) => void (c.depart.utiliserEmbed = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 2000, obligatoire: true, lire: (c) => c.depart.message, ecrire: (c, v) => void (c.depart.message = v) },
  ],
};

export const moduleDeparts: ModuleBot = {
  id: 'leave',
  nom: 'Départs',
  emoji: '🚪',
  description: 'Message de départ avec statistiques',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglageDepart],
  evenements: [
    sur('guildMemberRemove', async (membre) => {
      if (membre.user?.bot) return;
      await envoyerDepart(membre).catch((echec: Error) => registreDepart.avertir(`Départ de ${membre.id} non posté : ${echec.message}`));
    }),
  ],
  tests: [
    {
      id: 'message',
      libelle: 'Message de départ',
      emoji: '🚪',
      description: 'Poster un faux départ à ton nom',
      async executer(interaction) {
        const id = await envoyerDepart(interaction.member);
        return id ? `✅ Départ posté dans <#${id}>.` : '⚠️ Aucun salon de départ utilisable.';
      },
    },
  ],
};

const registreRolesAuto = creerRegistre('autorole');

export async function donnerRolesAuto(membre: GuildMember, genre: 'member' | 'bot', raison = 'Rôle automatique'): Promise<string[]> {
  const reglages = lireConfig(membre.guild.id).rolesAuto;
  const voulus = genre === 'bot' ? reglages.rolesBots : reglages.rolesMembres;
  if (!voulus.length) return [];
  const roles = rolesAttribuables(membre.guild, voulus).filter((r) => !membre.roles.cache.has(r.id));
  const ignores = voulus.length - rolesAttribuables(membre.guild, voulus).length;
  if (ignores > 0) registreRolesAuto.avertir(`${ignores} rôle(s) automatique(s) au-dessus du bot sur ${membre.guild.id}`);
  if (!roles.length) return [];
  try {
    await membre.roles.add(roles, raison);
  } catch (echec) {
    registreRolesAuto.avertir(`Rôles automatiques non donnés à ${membre.id} : ${(echec as Error).message}`);
    return [];
  }
  void journal(membre.guild, 'autorole', {
    titre: genre === 'bot' ? 'Rôle automatique (bot)' : 'Rôle automatique (arrivée)',
    ton: 'ok',
    lignes: [`**Membre** : <@${membre.id}> \`${membre.id}\``, `**Rôles** : ${roles.map((r) => `<@&${r.id}>`).join(' ')}`],
  });
  return roles.map((r) => r.id);
}

const pageReglageRolesAuto: PageReglage = {
  id: 'autorole',
  section: 'welcome',
  titre: 'Rôles automatiques',
  emoji: '🎭',
  moduleId: 'autorole',
  ordre: 3,
  description:
    'Rôles donnés automatiquement à l’arrivée. Les rôles placés au-dessus du bot sont ignorés.\n-# Si la vérification est active, les rôles membres sont donnés après vérification.',
  champs: [
    { genre: 'roles', cle: 'members', libelle: 'Rôles des membres', attribuable: true, max: 10, lire: (c) => c.rolesAuto.rolesMembres, ecrire: (c, v) => void (c.rolesAuto.rolesMembres = v) },
    { genre: 'roles', cle: 'bots', libelle: 'Rôles des bots', attribuable: true, max: 10, lire: (c) => c.rolesAuto.rolesBots, ecrire: (c, v) => void (c.rolesAuto.rolesBots = v) },
    { genre: 'number', cle: 'delay', libelle: 'Délai avant attribution', min: 0, max: 600, unite: 's', lire: (c) => c.rolesAuto.delaiSecondes, ecrire: (c, v) => void (c.rolesAuto.delaiSecondes = v) },
  ],
};

const rolesAuto: CommandeSlash = {
  categorie: 'roles',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('autorole').setDescription('Rôles donnés à l’arrivée'),
  async executer(interaction) {
    const page = lirePageReglage('autorole');
    if (page) return repondre(interaction, { ...afficherPage(interaction.guild, page), ephemeral: true });
    const reglages = lireConfig(interaction.guildId).rolesAuto;
    const liste = (ids: string[]) =>
      ids.map((id) => {
        const role = interaction.guild.roles.cache.get(id);
        return `• <@&${id}>${role && !botPeutGererRole(interaction.guild, role) ? ' ⚠️ au-dessus du bot' : ''}`;
      });
    return repondre(interaction, {
      embeds: [embedEnseigne(interaction.guild).setTitle('🎭 Rôles automatiques').setDescription([...liste(reglages.rolesMembres), ...liste(reglages.rolesBots)].join('\n') || '—')],
      ephemeral: true,
    });
  },
};

export const moduleRolesAuto: ModuleBot = {
  id: 'autorole',
  nom: 'Rôles automatiques',
  emoji: '🎭',
  description: 'Rôles donnés à l’arrivée (membres et bots)',
  desactivable: true,
  actifParDefaut: true,
  commandes: [rolesAuto],
  pagesReglage: [pageReglageRolesAuto],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      const serveur = membre.guild;
      const reglages = lireConfig(serveur.id);
      if (membre.user.bot) {
        await donnerRolesAuto(membre, 'bot');
        return;
      }
      if (moduleActif(serveur.id, 'verification') && reglages.verification.roleVerifieId) return;
      const delai = reglages.rolesAuto.delaiSecondes * 1000;
      if (delai > 0) {
        setTimeout(() => {
          void serveur.members
            .fetch(membre.id)
            .then((m) => donnerRolesAuto(m, 'member'))
            .catch(() => undefined);
        }, delai).unref();
        return;
      }
      await donnerRolesAuto(membre, 'member');
    }, 45),
  ],
};
