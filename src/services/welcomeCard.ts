import fs from 'node:fs';
import path from 'node:path';
import type { GuildMember } from 'discord.js';
import { brandFor } from '../core/brand';
import { createLogger } from '../core/logger';

const log = createLogger('carte');

const WIDTH = 1024;
const HEIGHT = 362;
const AVATAR_RADIUS = 95;
const AVATAR_BORDER = 5;
const ASSETS = path.resolve(__dirname, '..', '..', '..', 'assets');
const DEFAULT_BACKGROUND = path.join(ASSETS, 'bienvenue', 'fond.webp');
const FONTS_DIR = path.join(ASSETS, 'fonts');

/** Polices chargées si présentes : les grosses (emoji, japonais) peuvent être ajoutées depuis le bot Airline. */
const FONTS: [string, string][] = [
  ['NotoSans.ttf', 'CarteTexte'],
  ['NotoSans-Bold.ttf', 'CarteTexte'],
  ['NotoSansJP.ttf', 'CarteJP'],
  ['NotoSansMath.ttf', 'CarteMath'],
  ['NotoSansSymbols2.ttf', 'CarteSymboles'],
  ['NotoColorEmoji.ttf', 'CarteEmoji'],
];
const STACK = 'CarteTexte, CarteJP, CarteMath, CarteSymboles, CarteEmoji, sans-serif';

type CanvasLib = typeof import('@napi-rs/canvas');
type Image = Awaited<ReturnType<CanvasLib['loadImage']>>;
type Ctx = ReturnType<ReturnType<CanvasLib['createCanvas']>['getContext']>;

let lib: CanvasLib | null | undefined;
let fontsLoaded = false;

function canvasLib(): CanvasLib | null {
  if (lib !== undefined) return lib;
  try {
    lib = require('@napi-rs/canvas') as CanvasLib;
  } catch {
    log.warn('@napi-rs/canvas absent — les accueils partent sans carte (npm install sur l’hébergeur).');
    lib = null;
  }
  return lib;
}

function loadFonts(l: CanvasLib): void {
  if (fontsLoaded) return;
  fontsLoaded = true;
  for (const [file, family] of FONTS) {
    const full = path.join(FONTS_DIR, file);
    try {
      if (fs.existsSync(full)) l.GlobalFonts.registerFromPath(full, family);
    } catch (err) {
      log.warn(`Police ${file} non chargée : ${(err as Error).message}`);
    }
  }
}

function clean(text: string): string {
  return text.toWellFormed().replace(/\s{2,}/g, ' ').trim();
}

function roundedRect(ctx: Ctx, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
}

function fitText(ctx: Ctx, text: string, max: number, width: number, weight = '700', min = 16): number {
  let size = max;
  do {
    ctx.font = `${weight} ${size}px ${STACK}`;
    if (ctx.measureText(text).width <= width) return size;
    size -= 1;
  } while (size > min);
  return size;
}

// Les fonds d'enseigne sont téléchargés une fois puis gardés.
const backgrounds = new Map<string, Image>();

async function backgroundFor(guildId: string, l: CanvasLib): Promise<Image | null> {
  const source = brandFor(guildId).background;
  const fallback = async () => (fs.existsSync(DEFAULT_BACKGROUND) ? l.loadImage(DEFAULT_BACKGROUND).catch(() => null) : null);
  if (!source) return fallback();
  const cached = backgrounds.get(source);
  if (cached) return cached;
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const image = await l.loadImage(Buffer.from(await res.arrayBuffer()));
    backgrounds.set(source, image);
    if (backgrounds.size > 20) backgrounds.delete(backgrounds.keys().next().value!);
    return image;
  } catch (err) {
    // Un fond injoignable ne doit pas priver la personne de son accueil.
    log.warn(`Fond de l’enseigne illisible (${(err as Error).message}) — fond par défaut.`);
    return fallback();
  }
}

export interface CardOptions {
  title?: string;
  subtitle?: string;
}

/** Carte de bienvenue (PNG) inspirée du bot Airline, aux couleurs de l'enseigne. Retourne null si impossible. */
export async function buildWelcomeCard(member: GuildMember, options: CardOptions = {}): Promise<Buffer | null> {
  const l = canvasLib();
  if (!l) return null;
  try {
    loadFonts(l);
    const brand = brandFor(member.guild.id);
    const accent = `#${brand.color.toString(16).padStart(6, '0')}`;
    const canvas = l.createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.save();
    roundedRect(ctx, WIDTH, HEIGHT, 28);
    ctx.clip();

    const bg = await backgroundFor(member.guild.id, l);
    if (bg) ctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);
    else {
      ctx.fillStyle = '#1f1535';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    const veil = ctx.createLinearGradient(0, 0, WIDTH, 0);
    veil.addColorStop(0, 'rgba(10, 6, 24, 0.45)');
    veil.addColorStop(0.35, 'rgba(10, 6, 24, 0.62)');
    veil.addColorStop(1, 'rgba(10, 6, 24, 0.82)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const ax = 150;
    const ay = HEIGHT / 2;
    const avatar = await l.loadImage(member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, AVATAR_RADIUS, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, ax - AVATAR_RADIUS, ay - AVATAR_RADIUS, AVATAR_RADIUS * 2, AVATAR_RADIUS * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ax, ay, AVATAR_RADIUS + AVATAR_BORDER / 2, 0, Math.PI * 2);
    ctx.lineWidth = AVATAR_BORDER;
    ctx.strokeStyle = accent;
    ctx.stroke();

    const lineX = ax + AVATAR_RADIUS + 44;
    ctx.beginPath();
    ctx.moveTo(lineX, ay - 78);
    ctx.lineTo(lineX, ay + 78);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(226, 220, 240, 0.45)';
    ctx.stroke();

    const tx = lineX + 34;
    const width = WIDTH - tx - 44;
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    const head = clean(options.title ?? `— Bienvenue sur "${member.guild.name}" —`);
    const headSize = fitText(ctx, head, 19, width, 'italic 500', 12);
    ctx.font = `italic 500 ${headSize}px ${STACK}`;
    ctx.fillStyle = '#e6e1f2';
    ctx.fillText(head, tx, ay - 46);

    const name = clean(member.displayName || member.user.username) || 'nouveau membre';
    const size = fitText(ctx, name, 54, width);
    ctx.font = `700 ${size}px ${STACK}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, tx, ay + 14);

    const sub = clean(options.subtitle ?? `Membre #${member.guild.memberCount}`);
    const subSize = fitText(ctx, sub, 18, width, '500', 12);
    ctx.font = `500 ${subSize}px ${STACK}`;
    ctx.fillStyle = '#b8b1cd';
    ctx.fillText(sub, tx, ay + 58);

    ctx.shadowColor = 'transparent';
    ctx.restore();
    return await canvas.encode('png');
  } catch (err) {
    log.warn(`Carte impossible, repli sur l’embed : ${(err as Error).message}`);
    return null;
  }
}
