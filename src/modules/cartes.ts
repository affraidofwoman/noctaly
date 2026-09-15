import fs from 'node:fs';
import path from 'node:path';
import { creerRegistre, RACINE_PROJET } from '../coeur/outils';

const registre = creerRegistre('cartes');

// - Toile -

export type BibliothequeToile = typeof import('@napi-rs/canvas');
export type ImageToile = Awaited<ReturnType<BibliothequeToile['loadImage']>>;
export type Toile = import('@napi-rs/canvas').Canvas;
type Degrade = ReturnType<Contexte['createLinearGradient']>;
export type Contexte = ReturnType<Toile['getContext']>;

const DOSSIER_POLICES = path.join(RACINE_PROJET, 'assets', 'fonts');
const POLICES: [string, string][] = [
  ['NotoSans.ttf', 'CarteTexte'],
  ['NotoSans-Bold.ttf', 'CarteTexte'],
  ['NotoSansJP.ttf', 'CarteJP'],
  ['NotoSansMath.ttf', 'CarteMath'],
  ['NotoSansSymbols2.ttf', 'CarteSymboles'],
  ['NotoColorEmoji.ttf', 'CarteEmoji'],
];
export const PILE_POLICES = 'CarteTexte, CarteJP, CarteMath, CarteSymboles, CarteEmoji, sans-serif';

let bibliotheque: BibliothequeToile | null | undefined;
let policesChargees = false;

export function bibliothequeToile(): BibliothequeToile | null {
  if (bibliotheque !== undefined) return bibliotheque;
  try {
    bibliotheque = require('@napi-rs/canvas') as BibliothequeToile;
  } catch {
    registre.avertir('@napi-rs/canvas absent — les images sont remplacées par du texte (npm install sur l’hébergeur).');
    bibliotheque = null;
  }
  if (bibliotheque && !policesChargees) {
    policesChargees = true;
    for (const [fichier, famille] of POLICES) {
      const complet = path.join(DOSSIER_POLICES, fichier);
      try {
        if (fs.existsSync(complet)) bibliotheque.GlobalFonts.registerFromPath(complet, famille);
      } catch (echec) {
        registre.avertir(`Police ${fichier} non chargée : ${(echec as Error).message}`);
      }
    }
  }
  return bibliotheque;
}

export function nettoyer(texte: string): string {
  return texte.toWellFormed().replace(/\s{2,}/g, ' ').trim();
}

export function rectangleArrondi(contexte: Contexte, x: number, y: number, w: number, h: number, r: number): void {
  const rayon = Math.min(r, w / 2, h / 2);
  contexte.beginPath();
  contexte.moveTo(x + rayon, y);
  contexte.arcTo(x + w, y, x + w, y + h, rayon);
  contexte.arcTo(x + w, y + h, x, y + h, rayon);
  contexte.arcTo(x, y + h, x, y, rayon);
  contexte.arcTo(x, y, x + w, y, rayon);
  contexte.closePath();
}

export function ajusterTexte(contexte: Contexte, texte: string, max: number, largeur: number, poids = '700', min = 12): number {
  let taille = max;
  do {
    contexte.font = `${poids} ${taille}px ${PILE_POLICES}`;
    if (contexte.measureText(texte).width <= largeur) return taille;
    taille -= 1;
  } while (taille > min);
  return taille;
}

export function couper(contexte: Contexte, texte: string, largeur: number): string {
  if (contexte.measureText(texte).width <= largeur) return texte;
  let fin = texte.length;
  while (fin > 1 && contexte.measureText(`${texte.slice(0, fin)}…`).width > largeur) fin--;
  return `${texte.slice(0, fin).trimEnd()}…`;
}

export function ecrire(contexte: Contexte, texte: string, x: number, y: number, options: { taille: number; poids?: string; couleur?: string; aligner?: 'left' | 'center' | 'right'; largeur?: number }): void {
  contexte.font = `${options.poids ?? '400'} ${options.taille}px ${PILE_POLICES}`;
  contexte.fillStyle = options.couleur ?? PALETTE.texte;
  contexte.textAlign = options.aligner ?? 'left';
  contexte.textBaseline = 'alphabetic';
  contexte.fillText(options.largeur ? couper(contexte, texte, options.largeur) : texte, x, y);
}

const imagesDistantes = new Map<string, ImageToile | null>();

export async function imageDe(url: string | null | undefined): Promise<ImageToile | null> {
  const l = bibliothequeToile();
  if (!l || !url) return null;
  if (imagesDistantes.has(url)) return imagesDistantes.get(url)!;
  const image = await fetch(url, { signal: AbortSignal.timeout(4_000) })
    .then(async (r) => (r.ok ? l.loadImage(Buffer.from(await r.arrayBuffer())) : null))
    .catch(() => null);
  imagesDistantes.set(url, image);
  if (imagesDistantes.size > 300) imagesDistantes.delete(imagesDistantes.keys().next().value!);
  return image;
}

export function imageRonde(contexte: Contexte, image: ImageToile | null, x: number, y: number, rayon: number, secours: string): void {
  contexte.save();
  contexte.beginPath();
  contexte.arc(x, y, rayon, 0, Math.PI * 2);
  contexte.closePath();
  contexte.clip();
  if (image) contexte.drawImage(image, x - rayon, y - rayon, rayon * 2, rayon * 2);
  else {
    contexte.fillStyle = PALETTE.panneauClair;
    contexte.fillRect(x - rayon, y - rayon, rayon * 2, rayon * 2);
    ecrire(contexte, secours.slice(0, 1).toUpperCase(), x, y + rayon * 0.35, { taille: rayon, poids: '700', couleur: PALETTE.texteDoux, aligner: 'center' });
  }
  contexte.restore();
}

// - Direction artistique -

export const PALETTE = {
  fond: '#121317',
  fondBas: '#17181d',
  panneau: '#1c1d23',
  panneauClair: '#25262e',
  bordure: 'rgba(255, 255, 255, 0.07)',
  texte: '#f4f4f6',
  texteDoux: '#a3a6b1',
  texteFaible: '#6c6f7b',
  piste: '#2b2c35',
  succes: '#4ade80',
  gold: '#f5c542',
};

export function nouvelleToile(largeur: number, hauteur: number): { toile: Toile; contexte: Contexte } | null {
  const l = bibliothequeToile();
  if (!l) return null;
  const toile = l.createCanvas(largeur, hauteur);
  const contexte = toile.getContext('2d');
  const degrade = contexte.createLinearGradient(0, 0, 0, hauteur);
  degrade.addColorStop(0, PALETTE.fond);
  degrade.addColorStop(1, PALETTE.fondBas);
  rectangleArrondi(contexte, 0, 0, largeur, hauteur, 28);
  contexte.fillStyle = degrade;
  contexte.fill();
  return { toile, contexte };
}

export function panneau(contexte: Contexte, x: number, y: number, w: number, h: number, options: { couleur?: string; bordure?: string; rayon?: number } = {}): void {
  rectangleArrondi(contexte, x, y, w, h, options.rayon ?? 18);
  contexte.fillStyle = options.couleur ?? PALETTE.panneau;
  contexte.fill();
  contexte.lineWidth = options.bordure ? 2 : 1;
  contexte.strokeStyle = options.bordure ?? PALETTE.bordure;
  contexte.stroke();
}

export function barre(contexte: Contexte, x: number, y: number, w: number, h: number, taux: number, couleur: string): void {
  rectangleArrondi(contexte, x, y, w, h, h / 2);
  contexte.fillStyle = PALETTE.piste;
  contexte.fill();
  const r = Math.min(1, Math.max(0, Number.isFinite(taux) ? taux : 0));
  if (r <= 0) return;
  rectangleArrondi(contexte, x, y, Math.max(h, w * r), h, h / 2);
  contexte.fillStyle = couleur;
  contexte.fill();
}

export function pastille(contexte: Contexte, texte: string, x: number, y: number, couleur: string, options: { taille?: number; plein?: boolean } = {}): number {
  const taille = options.taille ?? 16;
  contexte.font = `700 ${taille}px ${PILE_POLICES}`;
  const w = contexte.measureText(texte).width + taille * 1.3;
  const h = taille * 1.9;
  rectangleArrondi(contexte, x, y, w, h, h / 2);
  contexte.fillStyle = options.plein ? couleur : `${couleur}26`;
  contexte.fill();
  ecrire(contexte, texte, x + w / 2, y + h * 0.68, { taille, poids: '700', couleur: options.plein ? PALETTE.fond : couleur, aligner: 'center' });
  return w;
}

export function entete(contexte: Contexte, titre: string, sousTitre: string | null, largeur: number, accent: string): void {
  rectangleArrondi(contexte, 40, 40, 8, 40, 4);
  contexte.fillStyle = accent;
  contexte.fill();
  ecrire(contexte, titre, 62, 74, { taille: 34, poids: '700', largeur: largeur - 400 });
  if (sousTitre) ecrire(contexte, sousTitre, 62, 104, { taille: 18, couleur: PALETTE.texteDoux, largeur: largeur - 124 });
}

export async function encoder(toile: Toile): Promise<Buffer> {
  return toile.encode('png');
}

// - Rangs -

export const RANGS = [
  { lettre: 'E', niveau: 0, couleur: '#a1a1aa' },
  { lettre: 'D', niveau: 10, couleur: '#4ade80' },
  { lettre: 'C', niveau: 25, couleur: '#38bdf8' },
  { lettre: 'B', niveau: 45, couleur: '#a78bfa' },
  { lettre: 'A', niveau: 75, couleur: '#fbbf24' },
  { lettre: 'S', niveau: 150, couleur: '#f87171' },
] as const;

export type LettreRang = (typeof RANGS)[number]['lettre'];

export function rangDuNiveau(niveau: number): (typeof RANGS)[number] {
  return [...RANGS].reverse().find((r) => niveau >= r.niveau) ?? RANGS[0];
}

export function indiceRang(lettre: LettreRang): number {
  return RANGS.findIndex((r) => r.lettre === lettre);
}

// - Raretés -

export const RARETES = [
  { id: 'commun', nom: 'Commun', couleur: '#a1a1aa', chance: 45 },
  { id: 'peu-commun', nom: 'Peu commun', couleur: '#4ade80', chance: 25 },
  { id: 'rare', nom: 'Rare', couleur: '#38bdf8', chance: 15 },
  { id: 'epique', nom: 'Épique', couleur: '#a78bfa', chance: 10 },
  { id: 'legendaire', nom: 'Légendaire', couleur: '#fbbf24', chance: 4 },
  { id: 'mythique', nom: 'Mythique', couleur: '#f87171', chance: 1 },
] as const;

export type Rarete = (typeof RARETES)[number]['id'];

export function rarete(id: Rarete): (typeof RARETES)[number] {
  return RARETES.find((r) => r.id === id)!;
}

// - Catalogue -

export type Genre = 'homme' | 'femme';
export type Categorie = 'cheveux' | 'yeux' | 'tenues';

export interface Teinte {
  id: string;
  nom: string;
  rarete: Rarete;
  couleurs: string[];
}

export interface Modele {
  id: string;
  nom: string;
  grade: LettreRang;
  genres: Genre[];
}

export const TEINTS = [
  { id: 'clair', nom: 'Clair', peau: '#f5d5bf', ombre: '#e2b59c' },
  { id: 'dore', nom: 'Doré', peau: '#e6b48f', ombre: '#cf9772' },
  { id: 'mat', nom: 'Mat', peau: '#c28457', ombre: '#a86b42' },
  { id: 'fonce', nom: 'Foncé', peau: '#87573a', ombre: '#6e452c' },
] as const;

export type Teint = (typeof TEINTS)[number]['id'];

export const COULEURS_CHEVEUX: Teinte[] = [
  { id: 'noir', nom: 'Noir', rarete: 'commun', couleurs: ['#23201f'] },
  { id: 'chatain', nom: 'Châtain', rarete: 'commun', couleurs: ['#5a3a26'] },
  { id: 'blond', nom: 'Blond', rarete: 'peu-commun', couleurs: ['#d9b36c'] },
  { id: 'roux', nom: 'Roux', rarete: 'peu-commun', couleurs: ['#b5532c'] },
  { id: 'bleu', nom: 'Bleu nuit', rarete: 'rare', couleurs: ['#2f4f9e'] },
  { id: 'rose', nom: 'Rose', rarete: 'epique', couleurs: ['#e58bb0'] },
  { id: 'blanc', nom: 'Blanc', rarete: 'legendaire', couleurs: ['#e9e6e1'] },
  { id: 'aurore', nom: 'Aurore', rarete: 'mythique', couleurs: ['#ff8fb1', '#8a6bff'] },
];

export const COULEURS_YEUX: Teinte[] = [
  { id: 'marron', nom: 'Marron', rarete: 'commun', couleurs: ['#6b4226'] },
  { id: 'noisette', nom: 'Noisette', rarete: 'commun', couleurs: ['#8f6a2f'] },
  { id: 'bleu', nom: 'Bleu', rarete: 'peu-commun', couleurs: ['#3b82c4'] },
  { id: 'vert', nom: 'Vert', rarete: 'peu-commun', couleurs: ['#3f8f5a'] },
  { id: 'gris', nom: 'Gris', rarete: 'rare', couleurs: ['#8a97a6'] },
  { id: 'violet', nom: 'Violet', rarete: 'epique', couleurs: ['#8b5cf6'] },
  { id: 'dore', nom: 'Doré', rarete: 'legendaire', couleurs: ['#e0a526'] },
  { id: 'rouge', nom: 'Rouge', rarete: 'mythique', couleurs: ['#d62f3a'] },
];

export const COULEURS_TENUES: Teinte[] = [
  { id: 'noir', nom: 'Noir', rarete: 'commun', couleurs: ['#26272d'] },
  { id: 'blanc', nom: 'Blanc', rarete: 'commun', couleurs: ['#e9e9ec'] },
  { id: 'marine', nom: 'Bleu marine', rarete: 'peu-commun', couleurs: ['#27406e'] },
  { id: 'rouge', nom: 'Rouge', rarete: 'peu-commun', couleurs: ['#b8323c'] },
  { id: 'sapin', nom: 'Vert sapin', rarete: 'rare', couleurs: ['#2f5e47'] },
  { id: 'violet', nom: 'Violet', rarete: 'epique', couleurs: ['#6d4bb8'] },
  { id: 'or', nom: 'Or', rarete: 'legendaire', couleurs: ['#e8c05a', '#b8862b'] },
  { id: 'sakura', nom: 'Sakura', rarete: 'mythique', couleurs: ['#1e1b22', '#f4b6c8'] },
];

export const COUPES: Modele[] = [
  { id: 'lisse', nom: 'Lisse', grade: 'E', genres: ['femme'] },
  { id: 'carre', nom: 'Carré', grade: 'E', genres: ['femme'] },
  { id: 'queue', nom: 'Queue de cheval', grade: 'D', genres: ['femme'] },
  { id: 'chignon', nom: 'Chignon', grade: 'D', genres: ['femme'] },
  { id: 'boucles', nom: 'Bouclé', grade: 'C', genres: ['femme', 'homme'] },
  { id: 'couettes', nom: 'Couettes', grade: 'C', genres: ['femme'] },
  { id: 'tresse', nom: 'Tresse', grade: 'B', genres: ['femme'] },
  { id: 'ondules', nom: 'Ondulés', grade: 'S', genres: ['femme'] },
  { id: 'court', nom: 'Court', grade: 'E', genres: ['homme'] },
  { id: 'degrade', nom: 'Dégradé', grade: 'E', genres: ['homme'] },
  { id: 'meche', nom: 'Mèche', grade: 'D', genres: ['homme'] },
  { id: 'plaque', nom: 'Plaqué', grade: 'C', genres: ['homme'] },
  { id: 'mi-long', nom: 'Mi-long', grade: 'B', genres: ['homme', 'femme'] },
  { id: 'ebouriffe', nom: 'Ébouriffé', grade: 'A', genres: ['homme', 'femme'] },
  { id: 'crete', nom: 'Crête', grade: 'S', genres: ['homme'] },
];

export const TENUES: Modele[] = [
  { id: 'tshirt', nom: 'T-shirt', grade: 'E', genres: ['homme', 'femme'] },
  { id: 'debardeur', nom: 'Débardeur', grade: 'E', genres: ['homme', 'femme'] },
  { id: 'pull', nom: 'Col roulé', grade: 'D', genres: ['homme', 'femme'] },
  { id: 'chemise', nom: 'Chemise', grade: 'D', genres: ['homme', 'femme'] },
  { id: 'sweat', nom: 'Sweat à capuche', grade: 'C', genres: ['homme', 'femme'] },
  { id: 'veste', nom: 'Veste', grade: 'B', genres: ['homme', 'femme'] },
  { id: 'kimono', nom: 'Kimono', grade: 'A', genres: ['homme', 'femme'] },
  { id: 'costume', nom: 'Costume', grade: 'S', genres: ['homme'] },
  { id: 'robe', nom: 'Robe', grade: 'S', genres: ['femme'] },
];

export interface Apparence {
  genre: Genre;
  teint: Teint;
  coupe: string;
  couleurCheveux: string;
  yeux: string;
  tenue: string;
  couleurTenue: string;
}

// - Dessin de l’avatar -

type Point = [number, number];

function eclaircir(hexa: string, montant: number): string {
  const n = Number.parseInt(hexa.slice(1), 16);
  const canal = (decalage: number) => {
    const v = (n >> decalage) & 255;
    return Math.round(montant >= 0 ? v + (255 - v) * montant : v * (1 + montant));
  };
  return `#${((canal(16) << 16) | (canal(8) << 8) | canal(0)).toString(16).padStart(6, '0')}`;
}

function remplirTeinte(contexte: Contexte, teinte: Teinte, x0: number, y0: number, x1: number, y1: number): string | Degrade {
  if (teinte.couleurs.length === 1) return teinte.couleurs[0]!;
  const degrade = contexte.createLinearGradient(x0, y0, x1, y1);
  teinte.couleurs.forEach((c, i) => degrade.addColorStop(i / (teinte.couleurs.length - 1), c));
  return degrade as unknown as Degrade;
}

function trace(contexte: Contexte, points: Point[]): void {
  contexte.beginPath();
  contexte.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]!;
    const [px, py] = points[i - 1]!;
    contexte.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
  }
  contexte.lineTo(points.at(-1)![0], points.at(-1)![1]);
  contexte.closePath();
}

// - Masse de cheveux -
// Un arc d’ellipse texturé.
function arcTexture(cx: number, cy: number, rx: number, ry: number, debut: number, fin: number, texture: 'lisse' | 'boucle' | 'pointes', pas = 60): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= pas; i++) {
    const t = debut + ((fin - debut) * i) / pas;
    let relief = 0;
    if (texture === 'boucle') relief = 7 * Math.abs(Math.sin(t * 9));
    if (texture === 'pointes') relief = i % 6 === 3 ? 16 : 0;
    points.push([cx + (rx + relief) * Math.cos(t), cy + (ry + relief) * Math.sin(t)]);
  }
  return points;
}

const TETE = { x: 256, y: 222, rx: 76, ry: 94 };

function dessinerCheveuxArriere(contexte: Contexte, coupe: string, genre: Genre, style: string | Degrade, ombre: string): void {
  contexte.fillStyle = ombre;
  const { x, y, rx } = TETE;
  const masse = (bas: number, largeur: number, texture: 'lisse' | 'boucle' | 'pointes') => {
    const points: Point[] = [[x - largeur, y - 20]];
    const segments = 10;
    for (let i = 0; i <= segments; i++) {
      const px = x - largeur + ((largeur * 2) * i) / segments;
      const relief = texture === 'boucle' ? (i % 2 ? 14 : -4) : texture === 'pointes' ? (i % 2 ? 22 : 0) : 0;
      points.push([px, bas + relief]);
    }
    points.push([x + largeur, y - 20]);
    trace(contexte, [...arcTexture(x, y - 10, largeur, 112, Math.PI, Math.PI * 2, texture), ...points.reverse()]);
    contexte.fill();
  };
  if (coupe === 'lisse') masse(470, rx + 34, 'lisse');
  else if (coupe === 'ondules') masse(500, rx + 46, 'boucle');
  else if (coupe === 'boucles') masse(genre === 'femme' ? 380 : 300, rx + 40, 'boucle');
  else if (coupe === 'carre') masse(318, rx + 30, 'lisse');
  else if (coupe === 'mi-long') masse(330, rx + 26, 'lisse');
  else if (coupe === 'ebouriffe') masse(genre === 'femme' ? 360 : 300, rx + 34, 'pointes');
  if (coupe === 'chignon') {
    contexte.beginPath();
    contexte.arc(x, y - 104, 40, 0, Math.PI * 2);
    contexte.fill();
  }
  if (coupe === 'queue') {
    trace(contexte, [[x + 60, y - 40], [x + 118, y + 10], [x + 124, y + 120], [x + 104, y + 230], [x + 84, y + 150], [x + 74, y + 40]]);
    contexte.fill();
  }
  if (coupe === 'couettes') {
    for (const sens of [-1, 1]) {
      trace(contexte, [[x + sens * 70, y - 20], [x + sens * 132, y + 20], [x + sens * 142, y + 140], [x + sens * 118, y + 230], [x + sens * 100, y + 130], [x + sens * 84, y + 30]]);
      contexte.fill();
    }
  }
  void style;
}

function dessinerCheveuxAvant(contexte: Contexte, coupe: string, genre: Genre, style: string | Degrade, reflet: string): void {
  const { x, y, rx, ry } = TETE;
  contexte.fillStyle = style;
  const calotte = (volume: number, texture: 'lisse' | 'boucle' | 'pointes', frange: Point[], debut = Math.PI * 0.92, fin = Math.PI * 2.08) => {
    trace(contexte, [...arcTexture(x, y - 8, rx + volume, ry + volume, debut, fin, texture), ...frange]);
    contexte.fill();
  };
  switch (coupe) {
    case 'lisse':
    case 'ondules':
      calotte(12, coupe === 'ondules' ? 'boucle' : 'lisse', [[x + rx + 14, y + 150], [x + rx - 6, y + 40], [x + 36, y - 70], [x, y - 88], [x - 36, y - 70], [x - rx + 6, y + 40], [x - rx - 14, y + 150]]);
      break;
    case 'carre':
      calotte(12, 'lisse', [[x + rx + 12, y + 92], [x + rx - 4, y + 20], [x + 50, y - 38], [x - 50, y - 38], [x - rx + 4, y + 20], [x - rx - 12, y + 92]]);
      break;
    case 'queue':
    case 'chignon':
    case 'couettes':
      calotte(6, 'lisse', [[x + rx + 4, y + 10], [x + 56, y - 56], [x + 10, y - 74], [x - 56, y - 60], [x - rx - 4, y + 10]]);
      break;
    case 'tresse': {
      calotte(8, 'lisse', [[x + rx + 6, y + 20], [x + 60, y - 50], [x - 20, y - 78], [x - rx - 6, y + 30]]);
      contexte.fillStyle = style;
      for (let i = 0; i < 7; i++) {
        contexte.beginPath();
        contexte.ellipse(x + rx - 2 - i * 2, y + 40 + i * 34, 20 - i, 22, 0.25, 0, Math.PI * 2);
        contexte.fill();
      }
      break;
    }
    case 'boucles':
      calotte(24, 'boucle', genre === 'femme' ? [[x + rx + 30, y + 120], [x + rx, y + 10], [x + 30, y - 58], [x - 30, y - 58], [x - rx, y + 10], [x - rx - 30, y + 120]] : [[x + rx + 16, y + 10], [x + 40, y - 52], [x - 40, y - 52], [x - rx - 16, y + 10]]);
      break;
    case 'mi-long':
      calotte(12, 'lisse', [[x + rx + 16, y + 100], [x + rx - 6, y + 10], [x + 18, y - 72], [x, y - 60], [x - 18, y - 72], [x - rx + 6, y + 10], [x - rx - 16, y + 100]]);
      break;
    case 'ebouriffe':
      calotte(18, 'pointes', [[x + rx + 14, y + (genre === 'femme' ? 90 : 20)], [x + 54, y - 34], [x + 20, y - 58], [x - 10, y - 30], [x - 40, y - 60], [x - rx - 14, y + (genre === 'femme' ? 90 : 20)]]);
      break;
    case 'court':
      calotte(8, 'lisse', [[x + rx + 2, y - 4], [x + 46, y - 62], [x - 46, y - 62], [x - rx - 2, y - 4]], Math.PI * 0.97, Math.PI * 2.03);
      break;
    case 'degrade':
      calotte(4, 'lisse', [[x + rx, y - 20], [x + 40, y - 70], [x - 40, y - 70], [x - rx, y - 20]], Math.PI * 1.02, Math.PI * 1.98);
      break;
    case 'meche':
      calotte(10, 'lisse', [[x + rx + 4, y - 6], [x + 40, y - 70], [x - 20, y - 50], [x - 66, y - 12], [x - rx - 4, y - 20]], Math.PI * 0.96, Math.PI * 2.04);
      break;
    case 'plaque':
      calotte(16, 'lisse', [[x + rx + 2, y - 10], [x + 30, y - 84], [x - 30, y - 84], [x - rx - 2, y - 10]], Math.PI * 0.98, Math.PI * 2.02);
      break;
    case 'crete':
      contexte.beginPath();
      contexte.ellipse(x, y - 40, rx - 4, ry - 6, 0, Math.PI, Math.PI * 2);
      contexte.fillStyle = `${reflet}55`;
      contexte.fill();
      contexte.fillStyle = style;
      trace(contexte, [[x - 22, y - 60], [x - 26, y - 120], [x - 10, y - 150], [x, y - 130], [x + 12, y - 158], [x + 26, y - 118], [x + 22, y - 60]]);
      contexte.fill();
      break;
  }
  // - Reflet -
  contexte.save();
  contexte.globalAlpha = 0.18;
  contexte.strokeStyle = reflet;
  contexte.lineWidth = 6;
  contexte.lineCap = 'round';
  contexte.beginPath();
  contexte.arc(x - 10, y - 30, rx - 10, Math.PI * 1.2, Math.PI * 1.45);
  contexte.stroke();
  contexte.restore();
}

function contourBuste(genre: Genre): Point[] {
  const large = genre === 'homme' ? 222 : 186;
  const epaule = genre === 'homme' ? 412 : 420;
  return [
    [256 - large - 20, 512],
    [256 - large, epaule + 22],
    [256 - large + 40, epaule - 8],
    [256 - 56, 372],
    [256 + 56, 372],
    [256 + large - 40, epaule - 8],
    [256 + large, epaule + 22],
    [256 + large + 20, 512],
  ];
}

function motifSakura(contexte: Contexte, rose: string): void {
  contexte.fillStyle = rose;
  for (let i = 0; i < 26; i++) {
    const fx = 70 + ((i * 97) % 380);
    const fy = 390 + ((i * 53) % 120);
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      contexte.beginPath();
      contexte.ellipse(fx + Math.cos(a) * 5, fy + Math.sin(a) * 5, 4.2, 2.6, a, 0, Math.PI * 2);
      contexte.fill();
    }
  }
}

function dessinerTenue(contexte: Contexte, tenue: string, genre: Genre, teinte: Teinte, peau: { peau: string; ombre: string }): void {
  const principale = teinte.id === 'sakura' ? teinte.couleurs[0]! : teinte.couleurs[0]!;
  const fonce = eclaircir(principale, -0.22);
  const clair = eclaircir(principale, 0.18);
  const style = teinte.id === 'or' ? remplirTeinte(contexte, teinte, 100, 380, 420, 512) : principale;
  const buste = contourBuste(genre);

  const remplirBuste = (couleur: string | Degrade) => {
    trace(contexte, buste);
    contexte.fillStyle = couleur;
    contexte.fill();
    if (teinte.id === 'sakura') {
      contexte.save();
      trace(contexte, buste);
      contexte.clip();
      motifSakura(contexte, teinte.couleurs[1]!);
      contexte.restore();
    }
  };

  if (tenue === 'debardeur' || tenue === 'robe') {
    trace(contexte, buste);
    contexte.fillStyle = peau.peau;
    contexte.fill();
    contexte.save();
    trace(contexte, buste);
    contexte.clip();
    const haut = tenue === 'robe' ? 440 : 410;
    const demi = genre === 'homme' ? 118 : 104;
    contexte.beginPath();
    contexte.moveTo(256 - demi - 30, 512);
    contexte.lineTo(256 - demi, haut);
    contexte.quadraticCurveTo(256, tenue === 'robe' ? haut + 30 : haut + 44, 256 + demi, haut);
    contexte.lineTo(256 + demi + 30, 512);
    contexte.closePath();
    contexte.fillStyle = style;
    contexte.fill();
    if (teinte.id === 'sakura') motifSakura(contexte, teinte.couleurs[1]!);
    contexte.strokeStyle = style;
    contexte.lineWidth = 9;
    contexte.lineCap = 'round';
    for (const sens of [-1, 1]) {
      contexte.beginPath();
      contexte.moveTo(256 + sens * (demi - 12), haut + 6);
      contexte.lineTo(256 + sens * 70, 380);
      contexte.stroke();
    }
    contexte.restore();
    return;
  }

  if (tenue === 'sweat') {
    contexte.fillStyle = fonce;
    trace(contexte, [[150, 420], [176, 350], [256, 330], [336, 350], [362, 420]]);
    contexte.fill();
  }

  remplirBuste(style);

  contexte.save();
  trace(contexte, buste);
  contexte.clip();
  contexte.lineCap = 'round';
  switch (tenue) {
    case 'tshirt':
      contexte.fillStyle = peau.ombre;
      contexte.beginPath();
      contexte.ellipse(256, 372, 56, 26, 0, 0, Math.PI);
      contexte.fill();
      contexte.strokeStyle = fonce;
      contexte.lineWidth = 7;
      contexte.beginPath();
      contexte.ellipse(256, 372, 58, 28, 0, 0, Math.PI);
      contexte.stroke();
      break;
    case 'pull':
      contexte.fillStyle = clair;
      rectangleArrondi(contexte, 200, 326, 112, 66, 22);
      contexte.fill();
      contexte.strokeStyle = fonce;
      contexte.lineWidth = 2;
      for (let lx = 212; lx < 304; lx += 12) {
        contexte.beginPath();
        contexte.moveTo(lx, 334);
        contexte.lineTo(lx, 386);
        contexte.stroke();
      }
      break;
    case 'chemise':
      contexte.fillStyle = peau.ombre;
      trace(contexte, [[222, 372], [256, 440], [290, 372]]);
      contexte.fill();
      contexte.fillStyle = clair;
      trace(contexte, [[206, 366], [256, 430], [232, 448], [196, 392]]);
      contexte.fill();
      trace(contexte, [[306, 366], [256, 430], [280, 448], [316, 392]]);
      contexte.fill();
      contexte.fillStyle = fonce;
      for (let by = 460; by < 512; by += 24) {
        contexte.beginPath();
        contexte.arc(256, by, 4, 0, Math.PI * 2);
        contexte.fill();
      }
      break;
    case 'sweat':
      contexte.fillStyle = peau.ombre;
      contexte.beginPath();
      contexte.ellipse(256, 374, 50, 22, 0, 0, Math.PI);
      contexte.fill();
      contexte.strokeStyle = clair;
      contexte.lineWidth = 5;
      for (const sens of [-1, 1]) {
        contexte.beginPath();
        contexte.moveTo(256 + sens * 28, 396);
        contexte.lineTo(256 + sens * 32, 470);
        contexte.stroke();
      }
      break;
    case 'veste':
    case 'costume':
      contexte.fillStyle = tenue === 'costume' ? '#f2f2f4' : peau.ombre;
      trace(contexte, [[214, 368], [256, 470], [298, 368]]);
      contexte.fill();
      contexte.fillStyle = fonce;
      trace(contexte, [[204, 366], [256, 480], [226, 512], [170, 420]]);
      contexte.fill();
      trace(contexte, [[308, 366], [256, 480], [286, 512], [342, 420]]);
      contexte.fill();
      if (tenue === 'costume') {
        contexte.fillStyle = '#8f1d2c';
        trace(contexte, [[248, 380], [264, 380], [270, 460], [256, 478], [242, 460]]);
        contexte.fill();
      }
      break;
    case 'kimono':
      contexte.fillStyle = peau.ombre;
      trace(contexte, [[222, 370], [256, 430], [290, 370]]);
      contexte.fill();
      contexte.fillStyle = clair;
      trace(contexte, [[196, 366], [236, 366], [330, 512], [284, 512]]);
      contexte.fill();
      contexte.fillStyle = fonce;
      trace(contexte, [[316, 366], [276, 366], [182, 512], [228, 512]]);
      contexte.fill();
      break;
  }
  contexte.restore();
}

function dessinerVisage(contexte: Contexte, genre: Genre, yeux: Teinte, cheveux: string, peau: { peau: string; ombre: string }): void {
  const { x, y } = TETE;
  // - Oreilles -
  contexte.fillStyle = peau.peau;
  for (const sens of [-1, 1]) {
    contexte.beginPath();
    contexte.ellipse(x + sens * 76, y + 12, 13, 22, 0, 0, Math.PI * 2);
    contexte.fill();
  }
  // - Tête -
  contexte.beginPath();
  contexte.ellipse(x, y, TETE.rx, TETE.ry, 0, 0, Math.PI * 2);
  contexte.fillStyle = peau.peau;
  contexte.fill();
  // - Joues -
  if (genre === 'femme') {
    contexte.fillStyle = 'rgba(232, 120, 140, 0.18)';
    for (const sens of [-1, 1]) {
      contexte.beginPath();
      contexte.ellipse(x + sens * 44, y + 42, 16, 9, 0, 0, Math.PI * 2);
      contexte.fill();
    }
  }
  // - Sourcils -
  contexte.strokeStyle = eclaircir(cheveux, -0.1);
  contexte.lineWidth = genre === 'homme' ? 6 : 4;
  contexte.lineCap = 'round';
  for (const sens of [-1, 1]) {
    contexte.beginPath();
    contexte.moveTo(x + sens * 18, y - 22);
    contexte.quadraticCurveTo(x + sens * 34, y - 32, x + sens * 52, y - 24);
    contexte.stroke();
  }
  // - Yeux -
  for (const sens of [-1, 1]) {
    const ox = x + sens * 34;
    const oy = y + 4;
    contexte.beginPath();
    contexte.ellipse(ox, oy, 16, genre === 'femme' ? 12 : 10, 0, 0, Math.PI * 2);
    contexte.fillStyle = '#fbfbfd';
    contexte.fill();
    contexte.save();
    contexte.clip();
    contexte.beginPath();
    contexte.arc(ox, oy + 1, 9.5, 0, Math.PI * 2);
    contexte.fillStyle = remplirTeinte(contexte, yeux, ox - 9, oy - 9, ox + 9, oy + 9);
    contexte.fill();
    contexte.beginPath();
    contexte.arc(ox, oy + 1, 4.2, 0, Math.PI * 2);
    contexte.fillStyle = '#16141a';
    contexte.fill();
    contexte.beginPath();
    contexte.arc(ox + 3, oy - 3, 2.4, 0, Math.PI * 2);
    contexte.fillStyle = '#ffffff';
    contexte.fill();
    contexte.restore();
    contexte.strokeStyle = '#2a2224';
    contexte.lineWidth = genre === 'femme' ? 3.5 : 2.5;
    contexte.beginPath();
    contexte.ellipse(ox, oy, 16, genre === 'femme' ? 12 : 10, 0, Math.PI * 1.05, Math.PI * 1.95);
    contexte.stroke();
    if (genre === 'femme') {
      contexte.lineWidth = 2.5;
      contexte.beginPath();
      contexte.moveTo(ox + sens * 14, oy - 7);
      contexte.lineTo(ox + sens * 21, oy - 12);
      contexte.stroke();
    }
  }
  // - Nez et bouche -
  contexte.strokeStyle = peau.ombre;
  contexte.lineWidth = 3;
  contexte.beginPath();
  contexte.moveTo(x - 2, y + 22);
  contexte.quadraticCurveTo(x - 8, y + 40, x + 2, y + 44);
  contexte.stroke();
  contexte.strokeStyle = genre === 'femme' ? '#c2566d' : '#9a5a4e';
  contexte.lineWidth = genre === 'femme' ? 4 : 3.5;
  contexte.beginPath();
  contexte.moveTo(x - 14, y + 62);
  contexte.quadraticCurveTo(x, y + 70, x + 14, y + 62);
  contexte.stroke();
}

export function dessinerAvatar(contexte: Contexte, apparence: Apparence, x: number, y: number, taille: number, options: { cadrage?: 'buste' | 'portrait' | 'visage'; arrondi?: number } = {}): void {
  const teint = TEINTS.find((t) => t.id === apparence.teint) ?? TEINTS[0];
  const cheveux = COULEURS_CHEVEUX.find((c) => c.id === apparence.couleurCheveux) ?? COULEURS_CHEVEUX[0]!;
  const yeux = COULEURS_YEUX.find((c) => c.id === apparence.yeux) ?? COULEURS_YEUX[0]!;
  const tenue = COULEURS_TENUES.find((c) => c.id === apparence.couleurTenue) ?? COULEURS_TENUES[0]!;
  contexte.save();
  rectangleArrondi(contexte, x, y, taille, taille, options.arrondi ?? taille * 0.07);
  contexte.clip();
  if (options.cadrage === 'visage' || options.cadrage === 'portrait') {
    const [vue, centreY] = options.cadrage === 'visage' ? [250, TETE.y + 10] : [380, TETE.y + 70];
    const echelle = taille / vue;
    contexte.translate(x + taille / 2 - TETE.x * echelle, y + taille / 2 - centreY * echelle);
    contexte.scale(echelle, echelle);
  } else {
    contexte.translate(x, y);
    contexte.scale(taille / 512, taille / 512);
  }
  const styleCheveux = remplirTeinte(contexte, cheveux, 160, 80, 360, 420);
  const base = cheveux.couleurs[0]!;
  dessinerCheveuxArriere(contexte, apparence.coupe, apparence.genre, styleCheveux, cheveux.couleurs.length > 1 ? cheveux.couleurs[1]! : eclaircir(base, -0.18));
  contexte.fillStyle = teint.ombre;
  rectangleArrondi(contexte, 256 - 30, 280, 60, 110, 20);
  contexte.fill();
  dessinerTenue(contexte, apparence.tenue, apparence.genre, tenue, teint);
  dessinerVisage(contexte, apparence.genre, yeux, base, teint);
  dessinerCheveuxAvant(contexte, apparence.coupe, apparence.genre, styleCheveux, eclaircir(base, 0.5));
  contexte.restore();
}

// - Silhouette sans avatar -

function silhouette(contexte: Contexte, x: number, y: number, taille: number): void {
  contexte.save();
  contexte.translate(x, y);
  contexte.scale(taille / 512, taille / 512);
  contexte.fillStyle = PALETTE.panneauClair;
  trace(contexte, contourBuste('homme'));
  contexte.fill();
  contexte.beginPath();
  contexte.ellipse(TETE.x, TETE.y, TETE.rx, TETE.ry, 0, 0, Math.PI * 2);
  contexte.fill();
  contexte.restore();
}

// - Cartes -

export const formatCourt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')}M` : n >= 10_000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : new Intl.NumberFormat('fr-FR').format(n));

function lettreRang(contexte: Contexte, lettre: string, couleur: string, cx: number, cy: number, taille: number): void {
  rectangleArrondi(contexte, cx - taille / 2, cy - taille / 2, taille, taille, taille * 0.28);
  contexte.fillStyle = `${couleur}22`;
  contexte.fill();
  contexte.lineWidth = Math.max(2, taille / 30);
  contexte.strokeStyle = couleur;
  contexte.stroke();
  ecrire(contexte, lettre, cx, cy + taille * 0.22, { taille: taille * 0.6, poids: '700', couleur, aligner: 'center' });
}

function courbe(contexte: Contexte, valeurs: number[], x: number, y: number, w: number, h: number, couleur: string): void {
  if (valeurs.length < 2) return;
  const max = Math.max(1, ...valeurs);
  const points = valeurs.map((v, i) => [x + (w * i) / (valeurs.length - 1), y + h - (h * v) / max] as const);
  contexte.beginPath();
  contexte.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    contexte.bezierCurveTo((px + cx) / 2, py, (px + cx) / 2, cy, cx, cy);
  }
  contexte.lineWidth = 3;
  contexte.strokeStyle = couleur;
  contexte.stroke();
  for (const [px, py] of [points[0]!, points.at(-1)!]) {
    contexte.beginPath();
    contexte.arc(px, py, 4, 0, Math.PI * 2);
    contexte.fillStyle = couleur;
    contexte.fill();
  }
}

export interface DonneesStatut {
  nom: string;
  bio: string;
  avatarUrl: string;
  apparence: Apparence | null;
  niveau: number;
  xpActuel: number;
  xpRequis: number;
  xpTotal: number;
  position: number;
  pastilles: { texte: string; couleur: string }[];
  mois: string;
  classementMois: { libelle: string; position: number | null }[];
  messages: { jour: number; semaine: number; mois: number; courbe: number[] };
  vocal: { jour: number; semaine: number; mois: number; courbe: number[] };
  gold: number;
  accent: string;
}

export async function carteStatut(d: DonneesStatut): Promise<Buffer | null> {
  const t = nouvelleToile(1400, 820);
  if (!t) return null;
  const { toile, contexte } = t;
  const rang = rangDuNiveau(d.niveau);
  entete(contexte, 'Statut', d.bio ? `« ${d.bio} »` : null, 1400, d.accent);

  panneau(contexte, 40, 130, 900, 330);
  imageRonde(contexte, await imageDe(d.avatarUrl), 130, 222, 62, d.nom);
  contexte.beginPath();
  contexte.arc(130, 222, 66, 0, Math.PI * 2);
  contexte.lineWidth = 4;
  contexte.strokeStyle = rang.couleur;
  contexte.stroke();
  ecrire(contexte, d.nom, 220, 212, { taille: 34, poids: '700', largeur: 420 });
  ecrire(contexte, `Rang ${rang.lettre} · Niveau ${d.niveau}`, 220, 248, { taille: 20, couleur: rang.couleur, poids: '700' });
  let px = 220;
  for (const p of d.pastilles.slice(0, 4)) px += pastille(contexte, p.texte, px, 270, p.couleur, { taille: 14 }) + 10;

  const taux = d.xpRequis ? d.xpActuel / d.xpRequis : 0;
  ecrire(contexte, `${formatCourt(d.xpActuel)} / ${formatCourt(d.xpRequis)} XP`, 80, 360, { taille: 20, poids: '700' });
  ecrire(contexte, `${Math.floor(taux * 100)} %`, 900, 360, { taille: 20, poids: '700', couleur: d.accent, aligner: 'right' });
  barre(contexte, 80, 376, 820, 16, taux, d.accent);
  ecrire(contexte, `#${d.position || '—'} du serveur`, 80, 428, { taille: 17, couleur: PALETTE.texteDoux });
  ecrire(contexte, `${formatCourt(d.xpTotal)} XP au total`, 490, 428, { taille: 17, couleur: PALETTE.texteDoux, aligner: 'center' });
  ecrire(contexte, `${formatCourt(d.gold)} gold`, 900, 428, { taille: 17, couleur: PALETTE.gold, aligner: 'right', poids: '700' });

  lettreRang(contexte, rang.lettre, rang.couleur, 820, 220, 120);

  panneau(contexte, 960, 130, 400, 330);
  if (d.apparence) dessinerAvatar(contexte, d.apparence, 1010, 146, 300, { arrondi: 18 });
  else {
    silhouette(contexte, 1040, 160, 240);
    ecrire(contexte, 'Crée ton avatar', 1160, 440, { taille: 16, couleur: PALETTE.texteDoux, aligner: 'center' });
  }

  const colonnes = [
    { titre: `Classement · ${d.mois}`, x: 40 },
    { titre: 'Messages', x: 490 },
    { titre: 'Vocal', x: 940 },
  ];
  for (const c of colonnes) {
    panneau(contexte, c.x, 480, 420, 300);
    ecrire(contexte, c.titre, c.x + 28, 522, { taille: 20, poids: '700' });
  }
  d.classementMois.forEach((ligne, i) => {
    const y = 548 + i * 72;
    panneau(contexte, 64, y, 372, 58, { couleur: PALETTE.panneauClair, rayon: 12 });
    ecrire(contexte, ligne.libelle, 88, y + 37, { taille: 20 });
    ecrire(contexte, ligne.position ? `#${ligne.position}` : '—', 412, y + 38, { taille: 24, poids: '700', couleur: i === 0 ? d.accent : PALETTE.texte, aligner: 'right' });
  });
  const blocChiffres = (x: number, donnees: DonneesStatut['messages'], unite: (n: number) => string) => {
    const lignes: [string, number][] = [['24 h', donnees.jour], ['7 jours', donnees.semaine], [d.mois, donnees.mois]];
    lignes.forEach(([libelle, valeur], i) => {
      const y = 568 + i * 50;
      ecrire(contexte, libelle, x + 28, y, { taille: 17, couleur: PALETTE.texteDoux });
      ecrire(contexte, unite(valeur), x + 392, y, { taille: 24, poids: '700', aligner: 'right' });
    });
    courbe(contexte, donnees.courbe, x + 32, 700, 356, 56, d.accent);
  };
  blocChiffres(490, d.messages, (n) => `${formatCourt(n)} msg`);
  blocChiffres(940, d.vocal, (n) => `${(n / 3600).toFixed(1).replace('.', ',')} h`);
  return encoder(toile);
}

export interface Emplacement {
  emplacement: string;
  nom: string;
  rarete: Rarete;
}

export interface DonneesAvatar {
  nom: string;
  apparence: Apparence;
  niveau: number;
  position: number;
  equipement: Emplacement[];
  accent: string;
}

export async function carteAvatar(d: DonneesAvatar): Promise<Buffer | null> {
  const t = nouvelleToile(1200, 720);
  if (!t) return null;
  const { toile, contexte } = t;
  const rang = rangDuNiveau(d.niveau);
  entete(contexte, 'Avatar', d.nom, 1200, d.accent);
  ecrire(contexte, `#${d.position || '—'} du serveur`, 1160, 78, { taille: 22, poids: '700', couleur: d.accent, aligner: 'right' });

  ecrire(contexte, 'Équipement', 40, 190, { taille: 20, poids: '700', couleur: PALETTE.texteDoux });
  d.equipement.forEach((e, i) => {
    const y = 212 + i * 132;
    const r = rarete(e.rarete);
    panneau(contexte, 40, y, 380, 112, { bordure: `${r.couleur}88` });
    rectangleArrondi(contexte, 40, y + 18, 5, 76, 3);
    contexte.fillStyle = r.couleur;
    contexte.fill();
    ecrire(contexte, e.emplacement.toUpperCase(), 68, y + 36, { taille: 14, couleur: PALETTE.texteFaible, poids: '700' });
    ecrire(contexte, e.nom, 68, y + 70, { taille: 24, poids: '700', largeur: 330 });
    ecrire(contexte, r.nom, 68, y + 96, { taille: 15, couleur: r.couleur, poids: '700' });
  });

  panneau(contexte, 450, 140, 480, 540);
  dessinerAvatar(contexte, d.apparence, 470, 160, 440, { arrondi: 20 });
  ecrire(contexte, `Rang ${rang.lettre} · Niveau ${d.niveau}`, 690, 652, { taille: 22, poids: '700', couleur: rang.couleur, aligner: 'center' });

  lettreRang(contexte, rang.lettre, rang.couleur, 1060, 400, 150);
  ecrire(contexte, d.apparence.genre === 'femme' ? 'Joueuse' : 'Joueur', 1060, 512, { taille: 18, couleur: PALETTE.texteDoux, aligner: 'center' });
  return encoder(toile);
}

export interface DonneesInventaire {
  total: number;
  categories: { nom: string; possedes: number; total: number; couleur: string; apercu: Apparence; cadrage?: 'buste' | 'portrait' | 'visage' }[];
  accent: string;
}

export async function carteInventaire(d: DonneesInventaire): Promise<Buffer | null> {
  const t = nouvelleToile(1100, 600);
  if (!t) return null;
  const { toile, contexte } = t;
  entete(contexte, 'Inventaire', 'Ta collection — choisis une catégorie', 1100, d.accent);
  ecrire(contexte, `${d.total} objets`, 1060, 78, { taille: 22, poids: '700', couleur: d.accent, aligner: 'right' });
  d.categories.forEach((c, i) => {
    const x = 40 + i * 350;
    panneau(contexte, x, 140, 320, 420, { bordure: `${c.couleur}66` });
    dessinerAvatar(contexte, c.apercu, x + 70, 164, 180, { cadrage: c.cadrage ?? 'portrait', arrondi: 90 });
    ecrire(contexte, c.nom, x + 160, 396, { taille: 28, poids: '700', aligner: 'center' });
    const taux = c.total ? c.possedes / c.total : 0;
    barre(contexte, x + 40, 420, 240, 12, taux, c.couleur);
    ecrire(contexte, `${c.possedes} / ${c.total}`, x + 160, 484, { taille: 30, poids: '700', aligner: 'center' });
    ecrire(contexte, `${Math.floor(taux * 100)} % complété`, x + 160, 520, { taille: 17, couleur: c.couleur, poids: '700', aligner: 'center' });
  });
  return encoder(toile);
}

export interface VignetteModele {
  nom: string;
  grade: LettreRang;
  possedes: Rarete[];
  total: number;
  equipe: boolean;
  verrouille: boolean;
  apercu: Apparence;
}

export async function carteModeles(titre: string, vignettes: VignetteModele[], accent: string): Promise<Buffer | null> {
  const lignes = Math.ceil(vignettes.length / 2);
  const t = nouvelleToile(1040, 150 + lignes * 196);
  if (!t) return null;
  const { toile, contexte } = t;
  const debloques = vignettes.filter((v) => v.possedes.length).length;
  entete(contexte, titre, `${debloques} sur ${vignettes.length} débloqués`, 1040, accent);
  vignettes.forEach((v, i) => {
    const x = 40 + (i % 2) * 490;
    const y = 130 + Math.floor(i / 2) * 196;
    const grade = RANGS.find((r) => r.lettre === v.grade)!;
    panneau(contexte, x, y, 470, 176, { bordure: v.equipe ? PALETTE.succes : v.possedes.length ? `${accent}55` : undefined });
    contexte.save();
    if (!v.possedes.length) contexte.globalAlpha = 0.35;
    dessinerAvatar(contexte, v.apercu, x + 16, y + 16, 144, { cadrage: 'portrait', arrondi: 14 });
    contexte.restore();
    ecrire(contexte, v.nom, x + 180, y + 48, { taille: 24, poids: '700', couleur: v.equipe ? PALETTE.succes : v.possedes.length ? PALETTE.texte : PALETTE.texteFaible, largeur: 210 });
    RARETES.forEach((r, j) => {
      rectangleArrondi(contexte, x + 180 + j * 38, y + 66, 30, 8, 4);
      contexte.fillStyle = v.possedes.includes(r.id) ? r.couleur : PALETTE.piste;
      contexte.fill();
    });
    ecrire(contexte, `${v.possedes.length}/${v.total} couleurs`, x + 180, y + 106, { taille: 16, couleur: PALETTE.texteDoux });
    if (v.verrouille) ecrire(contexte, `Rang ${v.grade} requis`, x + 180, y + 138, { taille: 15, couleur: grade.couleur, poids: '700' });
    else if (v.equipe) ecrire(contexte, 'Équipé', x + 180, y + 138, { taille: 15, couleur: PALETTE.succes, poids: '700' });
    lettreRang(contexte, v.grade, grade.couleur, x + 430, y + 40, 44);
  });
  return encoder(toile);
}

export interface VignetteTeinte {
  nom: string;
  rarete: Rarete;
  possede: boolean;
  equipee: boolean;
  apercu: Apparence;
  cadrage?: 'buste' | 'portrait' | 'visage';
}

export async function carteTeintes(titre: string, vignettes: VignetteTeinte[], accent: string): Promise<Buffer | null> {
  const lignes = Math.ceil(vignettes.length / 4);
  const t = nouvelleToile(1040, 190 + lignes * 250);
  if (!t) return null;
  const { toile, contexte } = t;
  entete(contexte, titre, `${vignettes.filter((v) => v.possede).length} sur ${vignettes.length} possédées`, 1040, accent);
  vignettes.forEach((v, i) => {
    const x = 40 + (i % 4) * 245;
    const y = 130 + Math.floor(i / 4) * 250;
    const r = rarete(v.rarete);
    panneau(contexte, x, y, 225, 230, { bordure: v.equipee ? PALETTE.succes : v.possede ? `${r.couleur}99` : undefined });
    contexte.save();
    if (!v.possede) contexte.globalAlpha = 0.3;
    dessinerAvatar(contexte, v.apercu, x + 42, y + 18, 140, { cadrage: v.cadrage ?? 'portrait', arrondi: 70 });
    contexte.restore();
    if (!v.possede) {
      rectangleArrondi(contexte, x + 96, y + 78, 32, 26, 6);
      contexte.fillStyle = PALETTE.texteDoux;
      contexte.fill();
      contexte.beginPath();
      contexte.arc(x + 112, y + 78, 10, Math.PI, 0);
      contexte.lineWidth = 4;
      contexte.strokeStyle = PALETTE.texteDoux;
      contexte.stroke();
    }
    ecrire(contexte, v.nom, x + 112, y + 188, { taille: 20, poids: '700', couleur: v.possede ? PALETTE.texte : PALETTE.texteFaible, aligner: 'center', largeur: 200 });
    ecrire(contexte, v.equipee ? 'Équipée' : r.nom, x + 112, y + 214, { taille: 15, poids: '700', couleur: v.equipee ? PALETTE.succes : r.couleur, aligner: 'center' });
  });
  ecrire(contexte, 'Choisis une couleur possédée pour l’équiper', 520, 170 + lignes * 250, { taille: 15, couleur: PALETTE.texteFaible, aligner: 'center' });
  return encoder(toile);
}

function coffre(contexte: Contexte, cx: number, cy: number, couleur: string): void {
  contexte.lineWidth = 4;
  contexte.strokeStyle = couleur;
  contexte.fillStyle = `${couleur}22`;
  rectangleArrondi(contexte, cx - 70, cy - 20, 140, 72, 10);
  contexte.fill();
  contexte.stroke();
  rectangleArrondi(contexte, cx - 78, cy - 58, 156, 38, 12);
  contexte.fill();
  contexte.stroke();
  rectangleArrondi(contexte, cx - 12, cy - 32, 24, 28, 6);
  contexte.fillStyle = couleur;
  contexte.fill();
}

export interface DonneesBoutique {
  solde: number;
  prix: number;
  coffres: { nom: string; couleur: string }[];
  accent: string;
}

export async function carteBoutique(d: DonneesBoutique): Promise<Buffer | null> {
  const t = nouvelleToile(1100, 640);
  if (!t) return null;
  const { toile, contexte } = t;
  entete(contexte, 'Boutique', 'Choisis un coffre — chaque ouverture donne un objet au hasard', 1100, d.accent);
  ecrire(contexte, `${formatCourt(d.solde)} gold`, 1060, 78, { taille: 30, poids: '700', couleur: PALETTE.gold, aligner: 'right' });
  d.coffres.forEach((c, i) => {
    const x = 40 + i * 350;
    panneau(contexte, x, 150, 320, 290, { bordure: `${c.couleur}66` });
    coffre(contexte, x + 160, 260, c.couleur);
    ecrire(contexte, c.nom, x + 160, 372, { taille: 24, poids: '700', aligner: 'center' });
    rectangleArrondi(contexte, x + 85, 392, 150, 34, 17);
    contexte.fillStyle = `${PALETTE.gold}22`;
    contexte.fill();
    ecrire(contexte, `${d.prix} gold`, x + 160, 416, { taille: 18, poids: '700', couleur: PALETTE.gold, aligner: 'center' });
  });
  ecrire(contexte, 'Chances par rareté', 550, 500, { taille: 16, couleur: PALETTE.texteDoux, aligner: 'center', poids: '700' });
  const largeur = 160;
  RARETES.forEach((r, i) => {
    const x = 550 - (RARETES.length * (largeur + 12) - 12) / 2 + i * (largeur + 12);
    panneau(contexte, x, 520, largeur, 72, { bordure: `${r.couleur}77`, rayon: 14 });
    ecrire(contexte, `${r.chance} %`, x + largeur / 2, 552, { taille: 22, poids: '700', couleur: r.couleur, aligner: 'center' });
    ecrire(contexte, r.nom, x + largeur / 2, 578, { taille: 14, couleur: PALETTE.texteDoux, aligner: 'center' });
  });
  return encoder(toile);
}

export interface DonneesCoffre {
  titre: string;
  objet: string;
  rarete: Rarete;
  apercu: Apparence;
  cadrage?: 'buste' | 'portrait' | 'visage';
  note: string;
  accent: string;
}

export async function carteCoffre(d: DonneesCoffre): Promise<Buffer | null> {
  const t = nouvelleToile(900, 560);
  if (!t) return null;
  const { toile, contexte } = t;
  const r = rarete(d.rarete);
  entete(contexte, d.titre, d.note, 900, d.accent);
  const halo = contexte.createRadialGradient(270, 330, 20, 270, 330, 230);
  halo.addColorStop(0, `${r.couleur}55`);
  halo.addColorStop(1, `${r.couleur}00`);
  contexte.fillStyle = halo;
  contexte.fillRect(40, 120, 460, 420);
  dessinerAvatar(contexte, d.apercu, 110, 170, 320, { cadrage: d.cadrage ?? 'portrait', arrondi: 160 });
  ecrire(contexte, r.nom.toUpperCase(), 540, 280, { taille: 22, poids: '700', couleur: r.couleur });
  ecrire(contexte, d.objet, 540, 330, { taille: 36, poids: '700', largeur: 330 });
  rectangleArrondi(contexte, 540, 356, 300, 8, 4);
  contexte.fillStyle = r.couleur;
  contexte.fill();
  return encoder(toile);
}

export interface LigneQuete {
  libelle: string;
  progression: number;
  cible: number;
  xp: number;
  gold: number;
  terminee: boolean;
  reclamee?: boolean;
}

export async function carteQuetes(jour: LigneQuete[], semaine: LigneQuete[], accent: string): Promise<Buffer | null> {
  const hauteurLigne = 108;
  const t = nouvelleToile(1080, 260 + (jour.length + semaine.length) * hauteurLigne + 60);
  if (!t) return null;
  const { toile, contexte } = t;
  const toutes = [...jour, ...semaine];
  entete(contexte, 'Quêtes', 'Tes missions du jour et de la semaine', 1080, accent);
  ecrire(contexte, `${toutes.filter((q) => q.terminee).length}/${toutes.length} accomplies`, 1040, 78, { taille: 20, poids: '700', couleur: PALETTE.texteDoux, aligner: 'right' });
  let y = 140;
  const section = (titre: string, note: string, couleur: string, lignes: LigneQuete[]) => {
    ecrire(contexte, titre, 40, y + 20, { taille: 22, poids: '700', couleur });
    ecrire(contexte, note, 1040, y + 20, { taille: 15, couleur: PALETTE.texteFaible, aligner: 'right' });
    y += 40;
    for (const q of lignes) {
      const faite = q.terminee;
      panneau(contexte, 40, y, 1000, hauteurLigne - 12, { bordure: faite ? `${PALETTE.succes}55` : undefined });
      ecrire(contexte, q.libelle, 68, y + 36, { taille: 21, poids: '700', couleur: faite ? PALETTE.succes : PALETTE.texte, largeur: 640 });
      barre(contexte, 68, y + 52, 700, 12, q.progression / q.cible, faite ? PALETTE.succes : accent);
      ecrire(contexte, `+${formatCourt(q.xp)} XP`, 68, y + 86, { taille: 16, poids: '700', couleur: '#60a5fa' });
      ecrire(contexte, `+${formatCourt(q.gold)} gold`, 200, y + 86, { taille: 16, poids: '700', couleur: PALETTE.gold });
      const etat = q.reclamee ? 'Récupérée' : faite ? (q.reclamee === false ? 'À valider' : 'Faite') : `${formatCourt(q.progression)}/${formatCourt(q.cible)}`;
      ecrire(contexte, etat, 1012, y + 62, { taille: 24, poids: '700', couleur: faite ? PALETTE.succes : PALETTE.texte, aligner: 'right' });
      y += hauteurLigne;
    }
    y += 16;
  };
  section('Journalier', 'renouvelé à minuit', accent, jour);
  section('Hebdomadaire', 'renouvelé le lundi', PALETTE.gold, semaine);
  ecrire(contexte, 'Une quête hebdo accomplie ? Clique sur « Valider » pour récupérer la récompense.', 540, y + 14, { taille: 15, couleur: PALETTE.texteFaible, aligner: 'center' });
  return encoder(toile);
}

export interface LigneClassement {
  position: number;
  nom: string;
  avatarUrl: string;
  niveau: number;
  valeur: string;
  taux: number;
  moi: boolean;
}

export async function carteClassement(titre: string, reinitialisation: string | null, lignes: LigneClassement[], accent: string): Promise<Buffer | null> {
  const podium = lignes.slice(0, 3);
  const reste = lignes.slice(3);
  const t = nouvelleToile(1200, 520 + Math.max(1, reste.length) * 94);
  if (!t) return null;
  const { toile, contexte } = t;
  entete(contexte, titre, null, 1200, accent);
  if (reinitialisation) ecrire(contexte, reinitialisation, 1160, 78, { taille: 20, poids: '700', couleur: PALETTE.texteDoux, aligner: 'right' });
  if (!lignes.length) {
    ecrire(contexte, 'Personne pour l’instant — à toi de jouer !', 600, 320, { taille: 26, couleur: PALETTE.texteDoux, aligner: 'center' });
    return encoder(toile);
  }
  const avatars = await Promise.all(lignes.map((l) => imageDe(l.avatarUrl)));
  const places = [
    { indice: 1, x: 70, y: 170, h: 300, couleur: '#cbd5e1' },
    { indice: 0, x: 430, y: 130, h: 340, couleur: PALETTE.gold },
    { indice: 2, x: 790, y: 190, h: 280, couleur: '#d6955b' },
  ];
  for (const p of places) {
    const l = podium[p.indice];
    if (!l) continue;
    panneau(contexte, p.x, p.y, 340, p.h, { bordure: l.moi ? accent : `${p.couleur}66` });
    const cy = p.y + 92;
    imageRonde(contexte, avatars[p.indice] ?? null, p.x + 170, cy, 54, l.nom);
    contexte.beginPath();
    contexte.arc(p.x + 170, cy, 58, 0, Math.PI * 2);
    contexte.lineWidth = 4;
    contexte.strokeStyle = p.couleur;
    contexte.stroke();
    pastille(contexte, `${p.indice + 1}`, p.x + 20, p.y + 20, p.couleur, { taille: 18, plein: true });
    ecrire(contexte, l.nom, p.x + 170, cy + 96, { taille: 24, poids: '700', aligner: 'center', largeur: 300 });
    const rang = rangDuNiveau(l.niveau);
    ecrire(contexte, `Niveau ${l.niveau} · Rang ${rang.lettre}`, p.x + 170, cy + 124, { taille: 16, couleur: rang.couleur, aligner: 'center' });
    ecrire(contexte, l.valeur, p.x + 170, cy + 164, { taille: 30, poids: '700', couleur: p.couleur, aligner: 'center' });
  }
  reste.forEach((l, i) => {
    const y = 490 + i * 94;
    panneau(contexte, 40, y, 1120, 80, { couleur: l.moi ? `${accent}22` : PALETTE.panneau, bordure: l.moi ? accent : undefined });
    ecrire(contexte, `${l.position}`, 88, y + 50, { taille: 26, poids: '700', couleur: PALETTE.texteDoux, aligner: 'center' });
    imageRonde(contexte, avatars[i + 3] ?? null, 170, y + 40, 28, l.nom);
    ecrire(contexte, l.nom, 216, y + 38, { taille: 22, poids: '700', largeur: 460 });
    if (l.moi) {
      contexte.font = `700 22px ${PILE_POLICES}`;
      pastille(contexte, 'Toi', 216 + Math.min(460, contexte.measureText(l.nom).width) + 14, y + 16, accent, { taille: 13 });
    }
    const rang = rangDuNiveau(l.niveau);
    ecrire(contexte, `Niveau ${l.niveau} · Rang ${rang.lettre}`, 216, y + 64, { taille: 15, couleur: rang.couleur });
    ecrire(contexte, l.valeur, 1130, y + 42, { taille: 24, poids: '700', aligner: 'right' });
    barre(contexte, 880, y + 56, 250, 8, l.taux, accent);
  });
  return encoder(toile);
}

export async function carteRangs(niveau: number, deblocages: Record<string, string[]>, accent: string): Promise<Buffer | null> {
  const t = nouvelleToile(1100, 640);
  if (!t) return null;
  const { toile, contexte } = t;
  const actuel = rangDuNiveau(niveau);
  entete(contexte, 'Rangs', `Ton rang : ${actuel.lettre} (niveau ${niveau})`, 1100, accent);
  RANGS.forEach((r, i) => {
    const y = 130 + i * 82;
    const atteint = niveau >= r.niveau;
    panneau(contexte, 40, y, 1020, 70, { bordure: r.lettre === actuel.lettre ? r.couleur : undefined, couleur: atteint ? PALETTE.panneau : '#16171b' });
    lettreRang(contexte, r.lettre, atteint ? r.couleur : PALETTE.texteFaible, 86, y + 35, 48);
    const suivant = RANGS[i + 1];
    ecrire(contexte, suivant ? `Niveau ${r.niveau} à ${suivant.niveau - 1}` : `Niveau ${r.niveau} et plus`, 132, y + 44, { taille: 22, poids: '700', couleur: atteint ? PALETTE.texte : PALETTE.texteFaible });
    ecrire(contexte, (deblocages[r.lettre] ?? []).join(' · ') || '—', 1030, y + 44, { taille: 16, couleur: atteint ? PALETTE.texteDoux : PALETTE.texteFaible, aligner: 'right', largeur: 620 });
  });
  return encoder(toile);
}

export interface ColonneCommandes {
  titre: string;
  couleur: string;
  commandes: { nom: string; description: string }[];
}

export async function carteCommandes(nom: string, niveau: number, prefixe: string, colonnes: ColonneCommandes[], accent: string): Promise<Buffer | null> {
  const lignes = Math.max(...colonnes.map((c) => c.commandes.length));
  const t = nouvelleToile(1500, 260 + lignes * 84);
  if (!t) return null;
  const { toile, contexte } = t;
  const rang = rangDuNiveau(niveau);
  entete(contexte, 'Centre de commandes', `${nom} · Rang ${rang.lettre} · Niveau ${niveau}`, 1500, accent);
  ecrire(contexte, `Préfixe : ${prefixe}`, 1460, 78, { taille: 22, poids: '700', couleur: accent, aligner: 'right' });
  colonnes.forEach((c, i) => {
    const x = 40 + i * 480;
    panneau(contexte, x, 140, 460, 60 + lignes * 84, { bordure: `${c.couleur}44` });
    ecrire(contexte, c.titre, x + 28, 182, { taille: 22, poids: '700', couleur: c.couleur });
    c.commandes.forEach((commande, j) => {
      const y = 204 + j * 84;
      panneau(contexte, x + 16, y, 428, 72, { couleur: PALETTE.panneauClair, rayon: 12 });
      ecrire(contexte, `${prefixe}${commande.nom}`, x + 36, y + 32, { taille: 22, poids: '700' });
      ecrire(contexte, commande.description, x + 36, y + 58, { taille: 16, couleur: PALETTE.texteDoux, largeur: 390 });
    });
  });
  ecrire(contexte, 'Tape une commande pour commencer', 750, 234 + lignes * 84, { taille: 16, couleur: PALETTE.texteFaible, aligner: 'center' });
  return encoder(toile);
}

export async function carteChoix(titre: string, sousTitre: string, options: { nom: string; apercu: Apparence }[], accent: string): Promise<Buffer | null> {
  const t = nouvelleToile(Math.max(700, 80 + options.length * 290), 520);
  if (!t) return null;
  const { toile, contexte } = t;
  entete(contexte, titre, sousTitre, Math.max(700, 80 + options.length * 290), accent);
  const largeur = Math.max(700, 80 + options.length * 290);
  const depart = (largeur - (options.length * 290 - 20)) / 2;
  options.forEach((o, i) => {
    const x = depart + i * 290;
    panneau(contexte, x, 140, 270, 340);
    dessinerAvatar(contexte, o.apercu, x + 20, 160, 230, { arrondi: 16 });
    ecrire(contexte, o.nom, x + 135, 448, { taille: 24, poids: '700', aligner: 'center' });
  });
  return encoder(toile);
}
