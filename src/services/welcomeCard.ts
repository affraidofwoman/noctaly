import fs from 'node:fs';
import path from 'node:path';
import type { GuildMember } from 'discord.js';
import { enseigneDe } from '../core/brand';
import { creerRegistre } from '../core/logger';

const registre = creerRegistre('carte');

const LARGEUR = 1024;
const HAUTEUR = 362;
const RAYON_AVATAR = 95;
const BORDURE_AVATAR = 5;
const RESSOURCES = path.resolve(__dirname, '..', '..', '..', 'assets');
const FOND_DEFAUT = path.join(RESSOURCES, 'bienvenue', 'fond.webp');
const DOSSIER_POLICES = path.join(RESSOURCES, 'fonts');

/** Polices chargées si présentes : les grosses (emoji, japonais) peuvent être ajoutées depuis le bot Airline. */
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

// Les fonds d'enseigne sont téléchargés une fois puis gardés.
const fonds = new Map<string, ImageToile>();

async function fondDe(serveurId: string, l: BibliothequeToile): Promise<ImageToile | null> {
  const source = enseigneDe(serveurId).fond;
  const secours = async () => (fs.existsSync(FOND_DEFAUT) ? l.loadImage(FOND_DEFAUT).catch(() => null) : null);
  if (!source) return secours();
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
    // Un fond injoignable ne doit pas priver la personne de son accueil.
    registre.avertir(`Fond de l’enseigne illisible (${(echec as Error).message}) — fond par défaut.`);
    return secours();
  }
}

export interface OptionsCarte {
  titre?: string;
  sousTitre?: string;
}

/** Carte de bienvenue (PNG) inspirée du bot Airline, aux couleurs de l'enseigne. Retourne null si impossible. */
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
    if (fondCarte) contexte.drawImage(fondCarte, 0, 0, LARGEUR, HAUTEUR);
    else {
      contexte.fillStyle = '#1f1535';
      contexte.fillRect(0, 0, LARGEUR, HAUTEUR);
    }
    const voile = contexte.createLinearGradient(0, 0, LARGEUR, 0);
    voile.addColorStop(0, 'rgba(10, 6, 24, 0.45)');
    voile.addColorStop(0.35, 'rgba(10, 6, 24, 0.62)');
    voile.addColorStop(1, 'rgba(10, 6, 24, 0.82)');
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

    const entete = nettoyer(options.titre ?? `— Bienvenue sur "${membre.guild.name}" —`);
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
