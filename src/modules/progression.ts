import { randomInt } from 'node:crypto';
import {
  type AnySelectMenuInteraction,
  AttachmentBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  type EmbedBuilder,
  type Guild,
  GuildMember,
  type Message,
  type ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type User,
} from 'discord.js';
import { emojiPour, enHexa, enseigneDe, rolesAttribuables } from '../coeur/acces';
import { bouton, construireFormulaire, embedEnseigne, info, ok, rangee, remplirModele, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout, transaction } from '../coeur/base';
import { journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type GestionnaireComposant, type ModuleBot, sur } from '../coeur/noyau';
import { cleJour, cleJourPrecedent, ErreurUtilisateur, formaterDuree, formaterNombre, heureFuseauEnUtc, joursDepuis, Niveau, partiesFuseau, tronquer } from '../coeur/outils';
import { lireConfig, moduleActif } from '../coeur/reglages';
import {
  type Apparence,
  carteAvatar,
  carteBoutique,
  carteChoix,
  carteClassement,
  carteCoffre,
  carteCommandes,
  carteInventaire,
  carteModeles,
  carteQuetes,
  carteRangs,
  carteStatut,
  carteTeintes,
  type Categorie,
  COULEURS_CHEVEUX,
  COULEURS_TENUES,
  COULEURS_YEUX,
  COUPES,
  formatCourt,
  type Genre,
  indiceRang,
  type LettreRang,
  type LigneClassement,
  type LigneQuete,
  type Modele,
  rangDuNiveau,
  RANGS,
  RARETES,
  type Rarete,
  type Teinte,
  TEINTS,
  type Teint,
  TENUES,
} from './cartes';
import {
  acheter,
  ajouterPieces,
  articleBoutique,
  articlesBoutique,
  livrer,
  montantGold,
  portefeuille,
  recupererQuotidien,
  rembourser,
  transferer,
} from './economie';
import {
  ajouterXp,
  badgesMembre,
  emettreActivite,
  lireXp,
  niveauDepuisXp,
  noterActivite,
  poserRoleNiveau,
  poserXp,
  rangDe,
  retirerRoleNiveau,
  rolesNiveau,
  surActivite,
  surTempsVocal,
  synchroniserBadgesAuto,
  synchroniserRolesNiveau,
  type TypeActivite,
  xpTotalePourNiveau,
} from './niveaux';

const accentDe = (serveurId: string) => enHexa(enseigneDe(serveurId).couleur).toLowerCase();
const fuseauDe = (serveurId: string) => lireConfig(serveurId).general.fuseau;

// - Périodes -

export type Periode = 'jour' | 'semaine' | 'mois' | 'total';
export type TypeClassement = 'messages' | 'vocal' | 'xp' | 'gold' | 'reputation';

export function debutPeriode(periode: Periode, maintenant: number, fuseau: string): string | null {
  const p = partiesFuseau(maintenant, fuseau);
  const aujourdhui = cleJour(maintenant, fuseau);
  if (periode === 'jour') return aujourdhui;
  if (periode === 'mois') return `${p.annee}-${String(p.mois).padStart(2, '0')}-01`;
  if (periode === 'semaine') {
    let cle = aujourdhui;
    for (let i = 0; i < (p.jourSemaine + 6) % 7; i++) cle = cleJourPrecedent(cle);
    return cle;
  }
  return null;
}

export function finPeriode(periode: Periode, maintenant: number, fuseau: string): number | null {
  const debut = debutPeriode(periode, maintenant, fuseau);
  if (!debut) return null;
  const [a, m, j] = debut.split('-').map(Number) as [number, number, number];
  if (periode === 'mois') return heureFuseauEnUtc(m === 12 ? a + 1 : a, m === 12 ? 1 : m + 1, 1, 0, 0, fuseau);
  const suivant = new Date(Date.UTC(a, m - 1, j + (periode === 'jour' ? 1 : 7)));
  return heureFuseauEnUtc(suivant.getUTCFullYear(), suivant.getUTCMonth() + 1, suivant.getUTCDate(), 0, 0, fuseau);
}

const COLONNES: Record<Exclude<TypeClassement, 'reputation'>, string> = { messages: 'messages', vocal: 'secondes_vocal', xp: 'xp', gold: 'gold' };

export function classementPeriode(serveurId: string, type: TypeClassement, periode: Periode, limite = 10): { utilisateur_id: string; valeur: number }[] {
  const debut = debutPeriode(periode, Date.now(), fuseauDe(serveurId));
  if (type === 'reputation') {
    return debut
      ? lireTout('SELECT receveur_id AS utilisateur_id, COUNT(*) AS valeur FROM reputations WHERE serveur_id = ? AND jour >= ? GROUP BY receveur_id ORDER BY valeur DESC LIMIT ?', serveurId, debut, limite)
      : lireTout('SELECT receveur_id AS utilisateur_id, COUNT(*) AS valeur FROM reputations WHERE serveur_id = ? GROUP BY receveur_id ORDER BY valeur DESC LIMIT ?', serveurId, limite);
  }
  if (!debut && type === 'xp') return lireTout('SELECT utilisateur_id, xp AS valeur FROM xp WHERE serveur_id = ? AND xp > 0 ORDER BY xp DESC LIMIT ?', serveurId, limite);
  if (!debut && type === 'gold') return lireTout('SELECT utilisateur_id, solde AS valeur FROM economie WHERE serveur_id = ? AND solde > 0 ORDER BY solde DESC LIMIT ?', serveurId, limite);
  const colonne = COLONNES[type];
  return lireTout(
    `SELECT utilisateur_id, SUM(${colonne}) AS valeur FROM activite_jour WHERE serveur_id = ? AND jour >= ? GROUP BY utilisateur_id HAVING valeur > 0 ORDER BY valeur DESC LIMIT ?`,
    serveurId,
    debut ?? '0000-00-00',
    limite,
  );
}

export function positionPeriode(serveurId: string, type: TypeClassement, periode: Periode, utilisateurId: string): number | null {
  const debut = debutPeriode(periode, Date.now(), fuseauDe(serveurId)) ?? '0000-00-00';
  let source: string;
  const parametres: (string | number)[] = [serveurId];
  if (type === 'reputation') {
    source = 'SELECT receveur_id AS utilisateur_id, COUNT(*) AS valeur FROM reputations WHERE serveur_id = ? AND jour >= ? GROUP BY receveur_id';
    parametres.push(debut);
  } else if (periode === 'total' && type === 'xp') source = 'SELECT utilisateur_id, xp AS valeur FROM xp WHERE serveur_id = ?';
  else if (periode === 'total' && type === 'gold') source = 'SELECT utilisateur_id, solde AS valeur FROM economie WHERE serveur_id = ?';
  else {
    source = `SELECT utilisateur_id, SUM(${COLONNES[type]}) AS valeur FROM activite_jour WHERE serveur_id = ? AND jour >= ? GROUP BY utilisateur_id`;
    parametres.push(debut);
  }
  const ligne = lire<{ valeur: number | null; devant: number }>(
    `WITH t AS (${source}) SELECT (SELECT valeur FROM t WHERE utilisateur_id = ?) AS valeur, (SELECT COUNT(*) FROM t WHERE valeur > (SELECT valeur FROM t WHERE utilisateur_id = ?)) AS devant`,
    ...parametres,
    utilisateurId,
    utilisateurId,
  );
  return ligne?.valeur ? ligne.devant + 1 : null;
}

// - Joueurs -

interface LigneJoueur {
  genre: Genre;
  teint: Teint;
  coupe: string;
  couleur_cheveux: string;
  yeux: string;
  tenue: string;
  couleur_tenue: string;
  bio: string;
  notifications: number;
}

export function lireJoueur(serveurId: string, utilisateurId: string): LigneJoueur | undefined {
  return lire<LigneJoueur>('SELECT genre, teint, coupe, couleur_cheveux, yeux, tenue, couleur_tenue, bio, notifications FROM joueurs WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId);
}

export function apparenceDe(j: LigneJoueur): Apparence {
  return { genre: j.genre, teint: j.teint, coupe: j.coupe, couleurCheveux: j.couleur_cheveux, yeux: j.yeux, tenue: j.tenue, couleurTenue: j.couleur_tenue };
}

export function genreImpose(membre: GuildMember): Genre | null {
  const reglages = lireConfig(membre.guild.id).progression;
  if (reglages.roleFemmeId && membre.roles.cache.has(reglages.roleFemmeId)) return 'femme';
  if (reglages.roleHommeId && membre.roles.cache.has(reglages.roleHommeId)) return 'homme';
  return null;
}

// - Objets -

export interface Objet {
  cle: string;
  categorie: Categorie;
  nom: string;
  rarete: Rarete;
  grade: LettreRang;
  modele: string | null;
  teinte: string;
}

export function catalogue(genre: Genre): Objet[] {
  const objets: Objet[] = [];
  const pourGenre = (m: Modele) => m.genres.includes(genre);
  for (const coupe of COUPES.filter(pourGenre)) {
    for (const t of COULEURS_CHEVEUX) objets.push({ cle: `cheveux:${coupe.id}:${t.id}`, categorie: 'cheveux', nom: `${coupe.nom} · ${t.nom}`, rarete: t.rarete, grade: coupe.grade, modele: coupe.id, teinte: t.id });
  }
  for (const t of COULEURS_YEUX) objets.push({ cle: `yeux:${t.id}`, categorie: 'yeux', nom: t.nom, rarete: t.rarete, grade: 'E', modele: null, teinte: t.id });
  for (const tenue of TENUES.filter(pourGenre)) {
    for (const t of COULEURS_TENUES) objets.push({ cle: `tenues:${tenue.id}:${t.id}`, categorie: 'tenues', nom: `${tenue.nom} · ${t.nom}`, rarete: t.rarete, grade: tenue.grade, modele: tenue.id, teinte: t.id });
  }
  return objets;
}

export function objetsDe(serveurId: string, utilisateurId: string): Set<string> {
  return new Set(lireTout<{ objet: string }>('SELECT objet FROM objets WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId).map((r) => r.objet));
}

function donnerObjet(serveurId: string, utilisateurId: string, cle: string): boolean {
  return executer('INSERT OR IGNORE INTO objets (serveur_id, utilisateur_id, objet, obtenu_le) VALUES (?, ?, ?, ?)', serveurId, utilisateurId, cle, Date.now()).changes > 0;
}

const DEPART: Record<Genre, { coupe: string; tenue: string }> = { femme: { coupe: 'lisse', tenue: 'tshirt' }, homme: { coupe: 'court', tenue: 'tshirt' } };

export function creerJoueur(serveurId: string, utilisateurId: string, genre: Genre, teint: Teint): void {
  const depart = DEPART[genre];
  transaction(() => {
    executer(
      'INSERT OR IGNORE INTO joueurs (serveur_id, utilisateur_id, genre, teint, coupe, couleur_cheveux, yeux, tenue, couleur_tenue, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serveurId,
      utilisateurId,
      genre,
      teint,
      depart.coupe,
      'noir',
      'marron',
      depart.tenue,
      'noir',
      Date.now(),
    );
    for (const cle of [`cheveux:${depart.coupe}:noir`, 'yeux:marron', `tenues:${depart.tenue}:noir`]) donnerObjet(serveurId, utilisateurId, cle);
  });
}

// - Coffres -

export function tirerRarete(tirage: number): Rarete {
  let cumul = 0;
  for (const r of RARETES) {
    cumul += r.chance;
    if (tirage < cumul) return r.id;
  }
  return 'commun';
}

export function choisirObjet(candidats: Objet[], possedes: Set<string>, rang: LettreRang, rarete: Rarete, hasard: (n: number) => number): Objet | null {
  const accessibles = candidats.filter((o) => !possedes.has(o.cle) && indiceRang(o.grade) <= indiceRang(rang));
  if (!accessibles.length) return null;
  const ordre = RARETES.map((r) => r.id);
  const depart = ordre.indexOf(rarete);
  const essais = [depart, ...Array.from({ length: ordre.length }, (_, i) => depart - i - 1).filter((i) => i >= 0), ...Array.from({ length: ordre.length }, (_, i) => depart + i + 1).filter((i) => i < ordre.length)];
  for (const i of essais) {
    const lot = accessibles.filter((o) => o.rarete === ordre[i]);
    if (lot.length) return lot[hasard(lot.length)]!;
  }
  return null;
}

const NOMS_CATEGORIES: Record<Categorie, string> = { cheveux: 'Cheveux', yeux: 'Yeux', tenues: 'Tenues' };
const COULEURS_CATEGORIES: Record<Categorie, string> = { cheveux: '#a78bfa', yeux: '#38bdf8', tenues: '#fbbf24' };

export function ouvrirCoffre(membre: GuildMember, categorie: Categorie): { objet: Objet | null; solde: number; rembourse: number } {
  const serveurId = membre.guild.id;
  const joueur = lireJoueur(serveurId, membre.id);
  if (!joueur) throw new ErreurUtilisateur('Crée d’abord ton avatar avec `=avatar`.');
  const prix = lireConfig(serveurId).progression.prixCoffre;
  const resultat = transaction(() => {
    try {
      ajouterPieces(serveurId, membre.id, -prix, 'coffre');
    } catch {
      throw new ErreurUtilisateur(`Il te faut ${montantGold(serveurId, prix)} pour ouvrir ce coffre.`);
    }
    const rang = rangDuNiveau(lireXp(serveurId, membre.id).niveau).lettre;
    const objet = choisirObjet(catalogue(joueur.genre).filter((o) => o.categorie === categorie), objetsDe(serveurId, membre.id), rang, tirerRarete(randomInt(100)), (n) => randomInt(n));
    if (!objet) {
      const rembourse = Math.floor(prix / 2);
      return { objet, rembourse, solde: ajouterPieces(serveurId, membre.id, rembourse, 'refund') };
    }
    donnerObjet(serveurId, membre.id, objet.cle);
    return { objet, rembourse: 0, solde: portefeuille(serveurId, membre.id).solde };
  });
  emettreActivite({ serveurId, utilisateurId: membre.id, type: 'coffres', montant: 1 });
  return resultat;
}

export function equiper(serveurId: string, utilisateurId: string, cle: string): void {
  const joueur = lireJoueur(serveurId, utilisateurId);
  if (!joueur) throw new ErreurUtilisateur('Crée d’abord ton avatar avec `=avatar`.');
  if (!objetsDe(serveurId, utilisateurId).has(cle)) throw new ErreurUtilisateur('Tu ne possèdes pas cet objet.');
  const objet = catalogue(joueur.genre).find((o) => o.cle === cle);
  if (!objet) throw new ErreurUtilisateur('Cet objet ne va pas à ton personnage.');
  if (objet.categorie === 'cheveux') executer('UPDATE joueurs SET coupe = ?, couleur_cheveux = ? WHERE serveur_id = ? AND utilisateur_id = ?', objet.modele, objet.teinte, serveurId, utilisateurId);
  else if (objet.categorie === 'yeux') executer('UPDATE joueurs SET yeux = ? WHERE serveur_id = ? AND utilisateur_id = ?', objet.teinte, serveurId, utilisateurId);
  else executer('UPDATE joueurs SET tenue = ?, couleur_tenue = ? WHERE serveur_id = ? AND utilisateur_id = ?', objet.modele, objet.teinte, serveurId, utilisateurId);
  avancerQuetes(null, serveurId, utilisateurId, 'assorti', 0);
}

// - Quêtes -

type Suivi = 'messages' | 'vocal' | 'salons' | 'reputation' | 'coffres' | 'quotidien' | 'assorti';

interface DefinitionQuete {
  id: string;
  libelle: string;
  cible: number;
  xp: number;
  gold: number;
  suivi: Suivi;
}

export const QUETES_JOUR: DefinitionQuete[] = [
  { id: 'j-messages', libelle: 'Envoyer 25 messages', cible: 25, xp: 50, gold: 10, suivi: 'messages' },
  { id: 'j-vocal', libelle: 'Passer 30 min en vocal', cible: 30, xp: 130, gold: 20, suivi: 'vocal' },
  { id: 'j-salons', libelle: 'Parler dans 5 salons différents', cible: 5, xp: 100, gold: 15, suivi: 'salons' },
  { id: 'j-quotidien', libelle: 'Récupérer ton bonus quotidien', cible: 1, xp: 40, gold: 0, suivi: 'quotidien' },
];

export const QUETES_SEMAINE: DefinitionQuete[] = [
  { id: 's-messages', libelle: 'Envoyer 300 messages', cible: 300, xp: 1500, gold: 150, suivi: 'messages' },
  { id: 's-vocal', libelle: 'Passer 5 h en vocal', cible: 300, xp: 2500, gold: 200, suivi: 'vocal' },
  { id: 's-coffres', libelle: 'Ouvrir 3 coffres', cible: 3, xp: 1000, gold: 100, suivi: 'coffres' },
  { id: 's-reputation', libelle: 'Donner 3 réputations', cible: 3, xp: 800, gold: 80, suivi: 'reputation' },
  { id: 's-assorti', libelle: 'Assortir cheveux et tenue', cible: 1, xp: 2000, gold: 200, suivi: 'assorti' },
];

const FAMILLES: Record<string, string> = {
  'cheveux:noir': 'noir', 'cheveux:chatain': 'brun', 'cheveux:blond': 'or', 'cheveux:roux': 'rouge', 'cheveux:bleu': 'bleu', 'cheveux:rose': 'rose', 'cheveux:blanc': 'blanc', 'cheveux:aurore': 'violet',
  'tenues:noir': 'noir', 'tenues:blanc': 'blanc', 'tenues:marine': 'bleu', 'tenues:rouge': 'rouge', 'tenues:sapin': 'vert', 'tenues:violet': 'violet', 'tenues:or': 'or', 'tenues:sakura': 'rose',
};

export function estAssorti(couleurCheveux: string, couleurTenue: string): boolean {
  const cheveux = FAMILLES[`cheveux:${couleurCheveux}`];
  return !!cheveux && cheveux === FAMILLES[`tenues:${couleurTenue}`];
}

function periodes(serveurId: string): { jour: string; semaine: string } {
  const fuseau = fuseauDe(serveurId);
  return { jour: `j:${debutPeriode('jour', Date.now(), fuseau)}`, semaine: `s:${debutPeriode('semaine', Date.now(), fuseau)}` };
}

interface LigneProgression {
  quete_id: string;
  progression: number;
  terminee: number;
  reclamee: number;
  donnees: string;
}

function lignesQuetes(serveurId: string, utilisateurId: string, periode: string): Map<string, LigneProgression> {
  return new Map(lireTout<LigneProgression>('SELECT quete_id, progression, terminee, reclamee, donnees FROM quetes WHERE serveur_id = ? AND utilisateur_id = ? AND periode = ?', serveurId, utilisateurId, periode).map((r) => [r.quete_id, r]));
}

async function prevenir(client: Client | null, serveurId: string, utilisateurId: string, texte: string): Promise<void> {
  if (!client || !lireJoueur(serveurId, utilisateurId)?.notifications) return;
  const serveur = client.guilds.cache.get(serveurId);
  const utilisateur = await client.users.fetch(utilisateurId).catch(() => null);
  if (!serveur || !utilisateur) return;
  await utilisateur.send({ embeds: [embedEnseigne(serveur, 'succes').setAuthor({ name: serveur.name, iconURL: serveur.iconURL() ?? undefined }).setDescription(texte)] }).catch(() => undefined);
}

export function avancerQuetes(client: Client | null, serveurId: string, utilisateurId: string, suivi: Suivi, montant: number, salonId?: string): void {
  if (!moduleActif(serveurId, 'progression')) return;
  const { jour, semaine } = periodes(serveurId);
  for (const [periode, liste] of [[jour, QUETES_JOUR], [semaine, QUETES_SEMAINE]] as const) {
    const quetes = liste.filter((q) => q.suivi === suivi);
    if (!quetes.length) continue;
    const lignes = lignesQuetes(serveurId, utilisateurId, periode);
    for (const q of quetes) {
      const ligne = lignes.get(q.id);
      if (ligne?.terminee) continue;
      let donnees = ligne?.donnees ?? '';
      let valeur: number;
      if (suivi === 'salons') {
        const salons = new Set(donnees ? donnees.split(',') : []);
        if (salonId) salons.add(salonId);
        donnees = [...salons].slice(0, 50).join(',');
        valeur = salons.size;
      } else if (suivi === 'assorti') {
        const joueur = lireJoueur(serveurId, utilisateurId);
        valeur = joueur && estAssorti(joueur.couleur_cheveux, joueur.couleur_tenue) ? 1 : 0;
      } else valeur = (ligne?.progression ?? 0) + montant;
      valeur = Math.min(q.cible, valeur);
      const fait = valeur >= q.cible;
      executer(
        `INSERT INTO quetes (serveur_id, utilisateur_id, periode, quete_id, progression, terminee, donnees) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(serveur_id, utilisateur_id, periode, quete_id) DO UPDATE SET progression = excluded.progression, terminee = excluded.terminee, donnees = excluded.donnees`,
        serveurId,
        utilisateurId,
        periode,
        q.id,
        valeur,
        fait ? 1 : 0,
        donnees,
      );
      if (!fait) continue;
      if (periode === jour) {
        executer('UPDATE quetes SET reclamee = 1 WHERE serveur_id = ? AND utilisateur_id = ? AND periode = ? AND quete_id = ?', serveurId, utilisateurId, periode, q.id);
        const gains = recompenser(client, serveurId, utilisateurId, q.xp, q.gold);
        void prevenir(client, serveurId, utilisateurId, `🎯 **Quête du jour accomplie !**\n${q.libelle}\n\nRécompense : **${gains}**`);
      } else void prevenir(client, serveurId, utilisateurId, `🏅 **Quête de la semaine accomplie !**\n${q.libelle}\n\nValide-la avec \`=quest\` pour récupérer ta récompense.`);
    }
  }
}

function recompenser(client: Client | null, serveurId: string, utilisateurId: string, xp: number, gold: number): string {
  const parties: string[] = [];
  if (xp > 0) {
    gagnerXp(client, serveurId, utilisateurId, xp, null);
    parties.push(`+${formaterNombre(xp)} XP`);
  }
  if (gold > 0) {
    ajouterPieces(serveurId, utilisateurId, gold, 'quest');
    parties.push(`+${formaterNombre(gold)} gold`);
  }
  return parties.join(' · ');
}

export function validerHebdo(client: Client | null, serveurId: string, utilisateurId: string): string | null {
  const { semaine } = periodes(serveurId);
  const lignes = lignesQuetes(serveurId, utilisateurId, semaine);
  const aValider = QUETES_SEMAINE.filter((q) => lignes.get(q.id)?.terminee && !lignes.get(q.id)?.reclamee);
  if (!aValider.length) return null;
  executer(`UPDATE quetes SET reclamee = 1 WHERE serveur_id = ? AND utilisateur_id = ? AND periode = ? AND terminee = 1`, serveurId, utilisateurId, semaine);
  return recompenser(client, serveurId, utilisateurId, aValider.reduce((s, q) => s + q.xp, 0), aValider.reduce((s, q) => s + q.gold, 0));
}

// - Gains -

export function bonusXp(membre: GuildMember): { total: number; sources: { libelle: string; valeur: number }[] } {
  const sources: { libelle: string; valeur: number }[] = [];
  if (membre.premiumSinceTimestamp) sources.push({ libelle: 'Booster du serveur', valeur: lireConfig(membre.guild.id).progression.bonusBooster });
  const w = portefeuille(membre.guild.id, membre.id);
  if (w.serie_quotidien >= 7 && Date.now() - w.dernier_quotidien < 2 * 86_400_000) sources.push({ libelle: `Série de ${w.serie_quotidien} jours`, valeur: 1.1 });
  return { total: sources.reduce((t, s) => t * s.valeur, 1), sources };
}

function gagnerXp(client: Client | null, serveurId: string, utilisateurId: string, montant: number, source: Message | null): void {
  const { ancienNiveau, nouveauNiveau } = ajouterXp(serveurId, utilisateurId, montant, !!source);
  if (nouveauNiveau <= ancienNiveau) return;
  const economie = lireConfig(serveurId).economie;
  let bonus = 0;
  for (let n = ancienNiveau + 1; n <= nouveauNiveau; n++) bonus += n * economie.parNiveau;
  if (bonus > 0) ajouterPieces(serveurId, utilisateurId, bonus, 'niveau');
  const membre = (source?.member ?? client?.guilds.cache.get(serveurId)?.members.cache.get(utilisateurId)) || null;
  if (membre) void annoncerNiveau(membre, ancienNiveau, nouveauNiveau, bonus, source);
}

async function annoncerNiveau(membre: GuildMember, ancien: number, niveau: number, bonus: number, source: Message | null): Promise<void> {
  const reglages = lireConfig(membre.guild.id).xp;
  await synchroniserRolesNiveau(membre, niveau);
  if (reglages.annonce === 'off' || lireJoueur(membre.guild.id, membre.id)?.notifications === 0) return;
  const avant = rangDuNiveau(ancien);
  const apres = rangDuNiveau(niveau);
  const lignes = [remplirModele(reglages.messageNiveau, { membre, serveur: membre.guild, extra: { level: niveau } })];
  if (bonus) lignes.push(`-# +${formaterNombre(bonus)} gold pour te remercier de ton activité`);
  if (apres.lettre !== avant.lettre) lignes.push(`\n**Nouveau rang : ${apres.lettre}** — de nouveaux objets t’attendent dans les coffres.`);
  const embed = embedEnseigne(membre.guild).setDescription(`${emojiPour(membre.guild.id, 'niveau')} ${lignes.join('\n')}`).setThumbnail(membre.user.displayAvatarURL({ size: 128 }));
  if (reglages.annonce === 'dm') {
    await membre.send({ embeds: [embed] }).catch(() => undefined);
    return;
  }
  const salon = reglages.annonce === 'channel' ? resoudreSalonTexte(membre.guild, reglages.salonAnnonceId) : source?.channel;
  if (salon && 'send' in salon) await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
}

const delaisXp = new Map<string, number>();
const delaisGold = new Map<string, number>();

function delaiEcoule(carte: Map<string, number>, cle: string, secondes: number): boolean {
  const maintenant = Date.now();
  if ((carte.get(cle) ?? 0) > maintenant) return false;
  carte.set(cle, maintenant + secondes * 1000);
  if (carte.size > 20_000) for (const [k, v] of carte) if (v < maintenant) carte.delete(k);
  return true;
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const serveurId = message.guildId;
  noterActivite(serveurId, message.author.id, { messages: 1 });
  avancerQuetes(message.client, serveurId, message.author.id, 'messages', 1);
  avancerQuetes(message.client, serveurId, message.author.id, 'salons', 0, message.channel.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId);
  const reglages = lireConfig(serveurId);
  const cle = `${serveurId}:${message.author.id}`;
  if (reglages.economie.parMessage > 0 && delaiEcoule(delaisGold, cle, reglages.economie.delaiMessageSecondes)) ajouterPieces(serveurId, message.author.id, reglages.economie.parMessage, 'message');
  const xp = reglages.xp;
  if (xp.salonsSansXp.includes(message.channelId) || (message.channel.isThread() && message.channel.parentId && xp.salonsSansXp.includes(message.channel.parentId))) return;
  if (message.member.roles.cache.some((r) => xp.rolesSansXp.includes(r.id))) return;
  if (!delaiEcoule(delaisXp, cle, xp.delaiSecondes)) return;
  const gain = Math.round(randomInt(Math.min(xp.min, xp.max), Math.max(xp.min, xp.max) + 1) * bonusXp(message.member).total);
  gagnerXp(message.client, serveurId, message.author.id, gain, message);
}

surTempsVocal((credit, client) => {
  if (!moduleActif(credit.serveurId, 'progression')) return;
  if (credit.inactif) return;
  noterActivite(credit.serveurId, credit.utilisateurId, { secondes_vocal: credit.secondes });
  const reglages = lireConfig(credit.serveurId);
  const minutes = credit.secondes / 60;
  avancerQuetes(client, credit.serveurId, credit.utilisateurId, 'vocal', Math.floor(minutes));
  const membre = client.guilds.cache.get(credit.serveurId)?.members.cache.get(credit.utilisateurId);
  const gain = Math.floor(minutes * reglages.xp.xpVocalParMinute * (membre ? bonusXp(membre).total : 1));
  if (gain > 0) gagnerXp(client, credit.serveurId, credit.utilisateurId, gain, null);
  const gold = Math.floor(minutes * reglages.economie.parMinuteVocal);
  if (gold > 0) ajouterPieces(credit.serveurId, credit.utilisateurId, gold, 'vocal');
});

const SUIVIS: Partial<Record<TypeActivite, Suivi>> = { quotidien: 'quotidien', reputation: 'reputation', coffres: 'coffres' };
surActivite((evenement, client) => {
  const suivi = SUIVIS[evenement.type];
  if (suivi) avancerQuetes(client, evenement.serveurId, evenement.utilisateurId, suivi, evenement.montant);
});

// - Réputation -

export function donnerReputation(serveurId: string, donneurId: string, receveurId: string): void {
  if (donneurId === receveurId) throw new ErreurUtilisateur('Tu ne peux pas te donner de réputation.');
  const jour = cleJour(Date.now(), fuseauDe(serveurId));
  const r = executer('INSERT OR IGNORE INTO reputations (serveur_id, donneur_id, receveur_id, jour, donne_le) VALUES (?, ?, ?, ?, ?)', serveurId, donneurId, receveurId, jour, Date.now());
  if (!r.changes) throw new ErreurUtilisateur('Tu as déjà donné ta réputation aujourd’hui. Reviens demain !');
  emettreActivite({ serveurId, utilisateurId: donneurId, type: 'reputation', montant: 1 });
}

const reputationDe = (serveurId: string, utilisateurId: string) => lire<{ n: number }>('SELECT COUNT(*) AS n FROM reputations WHERE serveur_id = ? AND receveur_id = ?', serveurId, utilisateurId)?.n ?? 0;

// - Écrans -

interface Ecran {
  files?: AttachmentBuilder[];
  embeds?: EmbedBuilder[];
  components?: ReturnType<typeof rangee>[];
  content?: string;
}

function ecranImage(image: Buffer | null, secours: () => EmbedBuilder, composants: ReturnType<typeof rangee>[] = []): Ecran {
  if (image) return { files: [new AttachmentBuilder(image, { name: 'carte.png' })], embeds: [], components: composants };
  return { embeds: [secours()], components: composants };
}

const id = (action: string, proprietaire: string, ...arguments_: string[]) => ['prg', action, proprietaire, ...arguments_].join(':');

function navigation(proprietaire: string, ...boutons: ('avatar' | 'inventaire' | 'boutique' | 'quetes' | 'classement' | 'statut')[]) {
  const libelles = { avatar: ['Mon avatar', '🧍'], inventaire: ['Inventaire', '🎒'], boutique: ['Boutique', '🛒'], quetes: ['Quêtes', '🎯'], classement: ['Classement', '🏆'], statut: ['Statut', '📊'] } as const;
  return rangee(...boutons.map((b) => bouton(id(b, proprietaire), libelles[b][0], b === 'avatar' ? ButtonStyle.Primary : ButtonStyle.Secondary, libelles[b][1])));
}

export async function ecranStatut(serveur: Guild, utilisateur: User, membre: GuildMember | null, spectateurId: string): Promise<Ecran> {
  if (membre) synchroniserBadgesAuto(membre);
  const g = serveur.id;
  const fuseau = fuseauDe(g);
  const xp = lireXp(g, utilisateur.id);
  const p = niveauDepuisXp(xp.xp);
  const joueur = lireJoueur(g, utilisateur.id);
  const debutMois = debutPeriode('mois', Date.now(), fuseau)!;
  const jours: string[] = [cleJour(Date.now(), fuseau)];
  for (let i = 0; i < 6; i++) jours.push(cleJourPrecedent(jours.at(-1)!));
  const depuis = [debutMois, jours.at(-1)!].sort()[0]!;
  const lignes = lireTout<{ jour: string; messages: number; secondes_vocal: number }>('SELECT jour, messages, secondes_vocal FROM activite_jour WHERE serveur_id = ? AND utilisateur_id = ? AND jour >= ?', g, utilisateur.id, depuis);
  const somme = (champ: 'messages' | 'secondes_vocal', filtre: (jour: string) => boolean) => lignes.filter((l) => filtre(l.jour)).reduce((s, l) => s + l[champ], 0);
  const serie = (champ: 'messages' | 'secondes_vocal') => [...jours].reverse().map((j) => lignes.find((l) => l.jour === j)?.[champ] ?? 0);
  const pastilles: { texte: string; couleur: string }[] = [];
  if (membre?.premiumSinceTimestamp) pastilles.push({ texte: 'Booster', couleur: '#f472b6' });
  if (membre?.joinedTimestamp && joursDepuis(membre.joinedTimestamp) >= 180) pastilles.push({ texte: 'Fidèle', couleur: '#38bdf8' });
  const bonus = membre ? bonusXp(membre).total : 1;
  if (bonus > 1) pastilles.push({ texte: `×${bonus.toFixed(2).replace('.', ',')} XP`, couleur: '#4ade80' });
  const rep = reputationDe(g, utilisateur.id);
  if (rep) pastilles.push({ texte: `${rep} rép`, couleur: '#fbbf24' });
  const badge = badgesMembre(g, utilisateur.id)[0];
  if (badge) pastilles.push({ texte: badge.nom, couleur: '#a78bfa' });
  const mois = new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: fuseau }).format(new Date());
  const image = await carteStatut({
    nom: membre?.displayName ?? utilisateur.displayName,
    bio: joueur?.bio ?? '',
    avatarUrl: (membre ?? utilisateur).displayAvatarURL({ extension: 'png', size: 256 }),
    apparence: joueur ? apparenceDe(joueur) : null,
    niveau: p.niveau,
    xpActuel: p.actuel,
    xpRequis: p.requis,
    xpTotal: xp.xp,
    position: rangDe(g, utilisateur.id),
    pastilles,
    mois: mois.charAt(0).toUpperCase() + mois.slice(1),
    classementMois: [
      { libelle: 'Messages', position: positionPeriode(g, 'messages', 'mois', utilisateur.id) },
      { libelle: 'Vocal', position: positionPeriode(g, 'vocal', 'mois', utilisateur.id) },
      { libelle: 'XP', position: positionPeriode(g, 'xp', 'mois', utilisateur.id) },
    ],
    messages: { jour: somme('messages', (j) => j === jours[0]), semaine: somme('messages', (j) => jours.includes(j)), mois: somme('messages', (j) => j >= debutMois), courbe: serie('messages') },
    vocal: { jour: somme('secondes_vocal', (j) => j === jours[0]), semaine: somme('secondes_vocal', (j) => jours.includes(j)), mois: somme('secondes_vocal', (j) => j >= debutMois), courbe: serie('secondes_vocal') },
    gold: portefeuille(g, utilisateur.id).solde,
    accent: accentDe(g),
  });
  const rang = rangDuNiveau(p.niveau);
  return ecranImage(
    image,
    () => embedEnseigne(serveur).setTitle(`📊 ${utilisateur.displayName}`).setDescription(`Rang **${rang.lettre}** · Niveau **${p.niveau}**\n${formaterNombre(p.actuel)} / ${formaterNombre(p.requis)} XP · #${rangDe(g, utilisateur.id) || '—'}`),
    [navigation(spectateurId, 'avatar', 'quetes', 'classement', 'boutique'), rangee(bouton(id('quotidien', spectateurId), 'Bonus du jour', ButtonStyle.Success, '🎁'), bouton(id('parametres', spectateurId), 'Paramètres', ButtonStyle.Secondary, '⚙️'))],
  );
}

function equipementDe(joueur: LigneJoueur) {
  const trouver = (liste: Teinte[], teinte: string) => liste.find((t) => t.id === teinte) ?? liste[0]!;
  const coupe = COUPES.find((c) => c.id === joueur.coupe);
  const tenue = TENUES.find((t) => t.id === joueur.tenue);
  const cheveux = trouver(COULEURS_CHEVEUX, joueur.couleur_cheveux);
  const yeux = trouver(COULEURS_YEUX, joueur.yeux);
  const habit = trouver(COULEURS_TENUES, joueur.couleur_tenue);
  return [
    { emplacement: 'Cheveux', nom: `${coupe?.nom ?? '—'} · ${cheveux.nom}`, rarete: cheveux.rarete },
    { emplacement: 'Yeux', nom: yeux.nom, rarete: yeux.rarete },
    { emplacement: 'Tenue', nom: `${tenue?.nom ?? '—'} · ${habit.nom}`, rarete: habit.rarete },
  ];
}

async function ecranCreation(membre: GuildMember, genre: Genre | null): Promise<Ecran> {
  const accent = accentDe(membre.guild.id);
  const choix = genre ?? genreImpose(membre);
  if (!choix) {
    const image = await carteChoix('Crée ton avatar', 'Choisis ton personnage — ce choix est définitif', (['femme', 'homme'] as const).map((g) => ({ nom: g === 'femme' ? 'Femme' : 'Homme', apercu: { genre: g, teint: 'dore', ...DEPART[g], couleurCheveux: 'chatain', yeux: 'marron', couleurTenue: 'noir' } })), accent);
    return ecranImage(image, () => info(membre.guild, 'Choisis ton personnage. Ce choix est définitif.', { titre: 'Crée ton avatar' }), [
      rangee(bouton(id('genre', membre.id, 'femme'), 'Femme', ButtonStyle.Primary, '👩'), bouton(id('genre', membre.id, 'homme'), 'Homme', ButtonStyle.Primary, '👨')),
    ]);
  }
  const image = await carteChoix('Crée ton avatar', genreImpose(membre) ? 'Ton personnage suit ton rôle — choisis ton teint' : 'Choisis ton teint', TEINTS.map((t) => ({ nom: t.nom, apercu: { genre: choix, teint: t.id, ...DEPART[choix], couleurCheveux: 'noir', yeux: 'marron', couleurTenue: 'noir' } })), accent);
  return ecranImage(image, () => info(membre.guild, 'Choisis ton teint.', { titre: 'Crée ton avatar' }), [rangee(...TEINTS.map((t) => bouton(id('teint', membre.id, choix, t.id), t.nom, ButtonStyle.Secondary)))]);
}

export async function ecranAvatar(membre: GuildMember): Promise<Ecran> {
  const joueur = lireJoueur(membre.guild.id, membre.id);
  if (!joueur) return ecranCreation(membre, null);
  const xp = lireXp(membre.guild.id, membre.id);
  const image = await carteAvatar({ nom: membre.displayName, apparence: apparenceDe(joueur), niveau: xp.niveau, position: rangDe(membre.guild.id, membre.id), equipement: equipementDe(joueur), accent: accentDe(membre.guild.id) });
  return ecranImage(image, () => info(membre.guild, equipementDe(joueur).map((e) => `**${e.emplacement}** — ${e.nom}`).join('\n'), { titre: 'Avatar' }), [navigation(membre.id, 'inventaire', 'boutique', 'statut')]);
}

export async function ecranInventaire(membre: GuildMember): Promise<Ecran> {
  const joueur = exigerJoueur(membre);
  const possedes = objetsDe(membre.guild.id, membre.id);
  const tout = catalogue(joueur.genre);
  const apparence = apparenceDe(joueur);
  const categories = (['cheveux', 'yeux', 'tenues'] as const).map((c) => ({
    nom: NOMS_CATEGORIES[c],
    possedes: tout.filter((o) => o.categorie === c && possedes.has(o.cle)).length,
    total: tout.filter((o) => o.categorie === c).length,
    couleur: COULEURS_CATEGORIES[c],
    apercu: apparence,
    cadrage: c === 'yeux' ? ('visage' as const) : ('portrait' as const),
  }));
  const image = await carteInventaire({ total: possedes.size, categories, accent: accentDe(membre.guild.id) });
  return ecranImage(image, () => info(membre.guild, categories.map((c) => `**${c.nom}** — ${c.possedes}/${c.total}`).join('\n'), { titre: 'Inventaire' }), [
    rangee(...(['cheveux', 'yeux', 'tenues'] as const).map((c) => bouton(id('categorie', membre.id, c), NOMS_CATEGORIES[c], ButtonStyle.Primary))),
    navigation(membre.id, 'boutique', 'avatar'),
  ]);
}

function exigerJoueur(membre: GuildMember): LigneJoueur {
  const joueur = lireJoueur(membre.guild.id, membre.id);
  if (!joueur) throw new ErreurUtilisateur('Crée d’abord ton avatar avec `=avatar`.');
  return joueur;
}

export async function ecranModeles(membre: GuildMember, categorie: 'cheveux' | 'tenues'): Promise<Ecran> {
  const joueur = exigerJoueur(membre);
  const possedes = objetsDe(membre.guild.id, membre.id);
  const rang = rangDuNiveau(lireXp(membre.guild.id, membre.id).niveau).lettre;
  const modeles = (categorie === 'cheveux' ? COUPES : TENUES).filter((m) => m.genres.includes(joueur.genre));
  const teintes = categorie === 'cheveux' ? COULEURS_CHEVEUX : COULEURS_TENUES;
  const apparence = apparenceDe(joueur);
  const vignettes = modeles.map((m) => {
    const miennes = teintes.filter((t) => possedes.has(`${categorie}:${m.id}:${t.id}`));
    const equipe = categorie === 'cheveux' ? joueur.coupe === m.id : joueur.tenue === m.id;
    const teinteApercu = equipe ? (categorie === 'cheveux' ? joueur.couleur_cheveux : joueur.couleur_tenue) : (miennes[0]?.id ?? 'noir');
    return {
      modele: m,
      nombre: miennes.length,
      vignette: {
        nom: m.nom,
        grade: m.grade,
        possedes: miennes.map((t) => t.rarete),
        total: teintes.length,
        equipe,
        verrouille: indiceRang(m.grade) > indiceRang(rang),
        apercu: categorie === 'cheveux' ? { ...apparence, coupe: m.id, couleurCheveux: teinteApercu } : { ...apparence, tenue: m.id, couleurTenue: teinteApercu },
      },
    };
  });
  const image = await carteModeles(`Inventaire — ${NOMS_CATEGORIES[categorie]}`, vignettes.map((v) => v.vignette), accentDe(membre.guild.id));
  const boutons = vignettes.map((v) => bouton(id('modele', membre.id, categorie, v.modele.id), `${v.modele.nom} (${v.nombre}/${teintes.length})`, v.vignette.equipe ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!v.nombre));
  const rangees = [];
  for (let i = 0; i < boutons.length && rangees.length < 3; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  return ecranImage(image, () => info(membre.guild, vignettes.map((v) => `**${v.modele.nom}** — ${v.nombre}/${teintes.length}`).join('\n'), { titre: NOMS_CATEGORIES[categorie] }), [
    ...rangees,
    rangee(bouton(id('inventaire', membre.id), 'Catégories', ButtonStyle.Secondary, '⬅️'), bouton(id('boutique', membre.id), 'Boutique', ButtonStyle.Success, '🛒'), bouton(id('avatar', membre.id), 'Mon avatar', ButtonStyle.Primary)),
  ]);
}

export async function ecranTeintes(membre: GuildMember, categorie: Categorie, modele: string | null): Promise<Ecran> {
  const joueur = exigerJoueur(membre);
  const possedes = objetsDe(membre.guild.id, membre.id);
  const apparence = apparenceDe(joueur);
  const teintes = categorie === 'cheveux' ? COULEURS_CHEVEUX : categorie === 'yeux' ? COULEURS_YEUX : COULEURS_TENUES;
  const nomModele = modele ? ((categorie === 'cheveux' ? COUPES : TENUES).find((m) => m.id === modele)?.nom ?? modele) : 'Yeux';
  const cle = (t: Teinte) => (categorie === 'yeux' ? `yeux:${t.id}` : `${categorie}:${modele}:${t.id}`);
  const equipee = (t: Teinte) => (categorie === 'cheveux' ? joueur.coupe === modele && joueur.couleur_cheveux === t.id : categorie === 'yeux' ? joueur.yeux === t.id : joueur.tenue === modele && joueur.couleur_tenue === t.id);
  const vignettes = teintes.map((t) => ({
    nom: t.nom,
    rarete: t.rarete,
    possede: possedes.has(cle(t)),
    equipee: equipee(t),
    apercu: categorie === 'cheveux' ? { ...apparence, coupe: modele!, couleurCheveux: t.id } : categorie === 'yeux' ? { ...apparence, yeux: t.id } : { ...apparence, tenue: modele!, couleurTenue: t.id },
    cadrage: categorie === 'yeux' ? ('visage' as const) : ('portrait' as const),
  }));
  const image = await carteTeintes(`${nomModele} — Couleurs`, vignettes, accentDe(membre.guild.id));
  const miennes = teintes.filter((t) => possedes.has(cle(t)));
  const boutons = miennes.map((t) => bouton(id('equiper', membre.id, cle(t)), t.nom, equipee(t) ? ButtonStyle.Success : ButtonStyle.Secondary));
  const rangees = [];
  for (let i = 0; i < boutons.length && rangees.length < 2; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  const retour = categorie === 'yeux' ? bouton(id('inventaire', membre.id), 'Inventaire', ButtonStyle.Secondary, '⬅️') : bouton(id('categorie', membre.id, categorie), NOMS_CATEGORIES[categorie], ButtonStyle.Secondary, '⬅️');
  return ecranImage(image, () => info(membre.guild, vignettes.map((v) => `${v.possede ? '✅' : '🔒'} **${v.nom}**`).join('\n'), { titre: nomModele }), [...rangees, rangee(retour, bouton(id('avatar', membre.id), 'Mon avatar', ButtonStyle.Primary))]);
}

export async function ecranBoutique(membre: GuildMember, note?: string): Promise<Ecran> {
  const g = membre.guild.id;
  const prix = lireConfig(g).progression.prixCoffre;
  const image = await carteBoutique({ solde: portefeuille(g, membre.id).solde, prix, coffres: (['cheveux', 'yeux', 'tenues'] as const).map((c) => ({ nom: `Coffre ${NOMS_CATEGORIES[c]}`, couleur: COULEURS_CATEGORIES[c] })), accent: accentDe(g) });
  const articles = articlesBoutique(g);
  const ecran = ecranImage(image, () => info(membre.guild, `Coffres à ${prix} gold — solde : ${formaterNombre(portefeuille(g, membre.id).solde)}`, { titre: 'Boutique' }), [
    rangee(...(['cheveux', 'yeux', 'tenues'] as const).map((c) => bouton(id('coffre', membre.id, c), `Coffre ${NOMS_CATEGORIES[c]}`, ButtonStyle.Primary))),
    rangee(
      ...[bouton(id('inventaire', membre.id), 'Inventaire', ButtonStyle.Secondary, '🎒'), bouton(id('avatar', membre.id), 'Mon avatar', ButtonStyle.Primary)],
      ...(articles.length ? [bouton(id('articles', membre.id), 'Articles du serveur', ButtonStyle.Secondary, '🏷️')] : []),
    ),
  ]);
  if (note) ecran.content = note;
  return ecran;
}

async function ecranCoffre(membre: GuildMember, categorie: Categorie): Promise<Ecran> {
  const { objet, solde, rembourse } = ouvrirCoffre(membre, categorie);
  const g = membre.guild.id;
  const joueur = exigerJoueur(membre);
  const apparence = apparenceDe(joueur);
  const composants = [
    rangee(
      bouton(id('coffre', membre.id, categorie), 'Rouvrir', ButtonStyle.Primary, '🎁'),
      ...(objet ? [bouton(id('equiper', membre.id, objet.cle), 'Équiper', ButtonStyle.Success)] : []),
      bouton(id('boutique', membre.id), 'Boutique', ButtonStyle.Secondary),
      bouton(id('avatar', membre.id), 'Mon avatar', ButtonStyle.Secondary),
    ),
  ];
  if (!objet) {
    return { content: `Tu as déjà tout ce que ton rang permet dans ce coffre. **${rembourse} gold** remboursés (solde : ${formaterNombre(solde)}).`, embeds: [], files: [], components: composants };
  }
  const apercu: Apparence = objet.categorie === 'cheveux' ? { ...apparence, coupe: objet.modele!, couleurCheveux: objet.teinte } : objet.categorie === 'yeux' ? { ...apparence, yeux: objet.teinte } : { ...apparence, tenue: objet.modele!, couleurTenue: objet.teinte };
  const image = await carteCoffre({ titre: `Coffre ${NOMS_CATEGORIES[categorie]}`, objet: objet.nom, rarete: objet.rarete, apercu, cadrage: objet.categorie === 'yeux' ? 'visage' : 'portrait', note: `Nouvel objet ! Solde : ${formatCourt(solde)} gold`, accent: accentDe(g) });
  return ecranImage(image, () => ok(membre.guild, `Tu obtiens **${objet.nom}** (${RARETES.find((r) => r.id === objet.rarete)!.nom}).`), composants);
}

function lignesQuetesPour(serveurId: string, utilisateurId: string): { jour: LigneQuete[]; semaine: LigneQuete[]; aValider: boolean } {
  avancerQuetes(null, serveurId, utilisateurId, 'assorti', 0);
  const { jour, semaine } = periodes(serveurId);
  const lignesJour = lignesQuetes(serveurId, utilisateurId, jour);
  const lignesSemaine = lignesQuetes(serveurId, utilisateurId, semaine);
  const conv = (q: DefinitionQuete, l: LigneProgression | undefined, hebdo: boolean): LigneQuete => ({ libelle: q.libelle, progression: l?.progression ?? 0, cible: q.cible, xp: q.xp, gold: q.gold, terminee: !!l?.terminee, reclamee: hebdo ? !!l?.reclamee : undefined });
  const semaineLignes = QUETES_SEMAINE.map((q) => conv(q, lignesSemaine.get(q.id), true));
  return { jour: QUETES_JOUR.map((q) => conv(q, lignesJour.get(q.id), false)), semaine: semaineLignes, aValider: semaineLignes.some((q) => q.terminee && !q.reclamee) };
}

export async function ecranQuetes(membre: GuildMember, note?: string): Promise<Ecran> {
  const { jour, semaine, aValider } = lignesQuetesPour(membre.guild.id, membre.id);
  const image = await carteQuetes(jour, semaine, accentDe(membre.guild.id));
  const ecran = ecranImage(image, () => info(membre.guild, [...jour, ...semaine].map((q) => `${q.terminee ? '✅' : '🎯'} **${q.libelle}** — ${q.progression}/${q.cible}`).join('\n'), { titre: 'Quêtes' }), [
    rangee(bouton(id('valider', membre.id), 'Valider quête hebdo', ButtonStyle.Success, '🏅').setDisabled(!aValider), bouton(id('statut', membre.id), 'Statut', ButtonStyle.Secondary)),
  ]);
  if (note) ecran.content = note;
  return ecran;
}

const TITRES_TYPES: Record<TypeClassement, string> = { messages: 'Messages', vocal: 'Vocal', xp: 'XP', gold: 'Gold', reputation: 'Réputation' };
const TITRES_PERIODES: Record<Periode, string> = { jour: 'Jour', semaine: 'Hebdo', mois: 'Mensuel', total: 'Total' };

function valeurClassement(type: TypeClassement, valeur: number): string {
  if (type === 'vocal') return `${(valeur / 3600).toFixed(1).replace('.', ',')} h`;
  if (type === 'xp') return `${formatCourt(valeur)} XP`;
  if (type === 'gold') return `${formatCourt(valeur)} gold`;
  if (type === 'reputation') return `${valeur} rép`;
  return `${formatCourt(valeur)} msg`;
}

export async function ecranClassement(serveur: Guild, spectateurId: string, type: TypeClassement, periode: Periode): Promise<Ecran> {
  const g = serveur.id;
  const rangees = classementPeriode(g, type, periode, 10);
  const max = rangees[0]?.valeur ?? 1;
  await serveur.members.fetch({ user: rangees.map((r) => r.utilisateur_id) }).catch(() => undefined);
  const lignes: LigneClassement[] = [];
  for (const [i, r] of rangees.entries()) {
    const membre = serveur.members.cache.get(r.utilisateur_id);
    const utilisateur = membre?.user ?? (await serveur.client.users.fetch(r.utilisateur_id).catch(() => null));
    lignes.push({ position: i + 1, nom: membre?.displayName ?? utilisateur?.displayName ?? 'Ancien membre', avatarUrl: (membre ?? utilisateur)?.displayAvatarURL({ extension: 'png', size: 128 }) ?? '', niveau: lireXp(g, r.utilisateur_id).niveau, valeur: valeurClassement(type, r.valeur), taux: r.valeur / max, moi: r.utilisateur_id === spectateurId });
  }
  const fin = finPeriode(periode, Date.now(), fuseauDe(g));
  const reinitialisation = fin ? `Remise à zéro dans ${formaterDuree(Math.max(60_000, fin - Date.now())).split(' ').slice(0, 4).join(' ')}` : null;
  const image = await carteClassement(`${TITRES_TYPES[type]} — ${TITRES_PERIODES[periode]}`, reinitialisation, lignes, accentDe(g));
  return ecranImage(image, () => info(serveur, lignes.map((l) => `**${l.position}.** ${l.nom} — ${l.valeur}`).join('\n') || 'Personne pour l’instant.', { titre: `${TITRES_TYPES[type]} — ${TITRES_PERIODES[periode]}` }), [
    rangee(...(Object.keys(TITRES_TYPES) as TypeClassement[]).map((t) => bouton(id('classement', spectateurId, t, periode), TITRES_TYPES[t], t === type ? ButtonStyle.Primary : ButtonStyle.Secondary))),
    rangee(...(Object.keys(TITRES_PERIODES) as Periode[]).map((p) => bouton(id('classement', spectateurId, type, p), TITRES_PERIODES[p], p === periode ? ButtonStyle.Success : ButtonStyle.Secondary))),
  ]);
}

export async function ecranRangs(membre: GuildMember): Promise<Ecran> {
  const niveau = lireXp(membre.guild.id, membre.id).niveau;
  const joueur = lireJoueur(membre.guild.id, membre.id);
  const genre = joueur?.genre ?? genreImpose(membre);
  const deblocages: Record<string, string[]> = {};
  for (const m of [...COUPES, ...TENUES].filter((x) => !genre || x.genres.includes(genre))) (deblocages[m.grade] ??= []).push(m.nom);
  const image = await carteRangs(niveau, deblocages, accentDe(membre.guild.id));
  return ecranImage(image, () => info(membre.guild, RANGS.map((r) => `**${r.lettre}** — niveau ${r.niveau}`).join('\n'), { titre: 'Rangs' }));
}

export async function ecranCommandes(membre: GuildMember): Promise<Ecran> {
  const prefixe = lireConfig(membre.guild.id).prefixes.general;
  const image = await carteCommandes(membre.displayName, lireXp(membre.guild.id, membre.id).niveau, prefixe, [
    { titre: 'Progression', couleur: '#4ade80', commandes: [{ nom: 'lvl', description: 'Ton statut' }, { nom: 'lb', description: 'Classements' }, { nom: 'rangs', description: 'Paliers et déblocages' }, { nom: 'quest', description: 'Quêtes du jour et de la semaine' }] },
    { titre: 'Économie', couleur: '#fbbf24', commandes: [{ nom: 'daily', description: 'Bonus quotidien' }, { nom: 'gold', description: 'Ton solde' }, { nom: 'rep @membre', description: 'Donner de la réputation' }, { nom: 'shop', description: 'Coffres et articles' }] },
    { titre: 'Personnalisation', couleur: '#a78bfa', commandes: [{ nom: 'avatar', description: 'Ton personnage' }, { nom: 'inv', description: 'Ton inventaire' }, { nom: 'bio <texte>', description: 'Modifier ta bio' }, { nom: 'settings', description: 'Paramètres et bonus XP' }] },
  ], accentDe(membre.guild.id));
  return ecranImage(image, () => info(membre.guild, 'Progression : lvl, lb, rangs, quest · Économie : daily, gold, rep, shop · Personnalisation : avatar, inv, bio, settings', { titre: 'Centre de commandes' }));
}

function ecranParametres(membre: GuildMember): Ecran {
  const joueur = lireJoueur(membre.guild.id, membre.id);
  const bonus = bonusXp(membre);
  const embed = embedEnseigne(membre.guild)
    .setTitle('⚙️ Paramètres')
    .setDescription(
      [
        `**Bio** — ${joueur?.bio ? `« ${joueur.bio} »` : '*aucune* (`=bio <texte>`)'}`,
        `**Notifications d’activité** — ${joueur ? (joueur.notifications ? 'activées' : 'coupées') : '*crée ton avatar d’abord*'}`,
        '',
        `**Bonus XP actif : ×${bonus.total.toFixed(2).replace('.', ',')}**`,
        ...(bonus.sources.length ? bonus.sources.map((s) => `• ${s.libelle} — ×${s.valeur.toFixed(2).replace('.', ',')}`) : ['-# Booste le serveur ou garde une série de 7 jours de bonus quotidien pour en gagner.']),
      ].join('\n'),
    );
  return { embeds: [embed], files: [], components: joueur ? [rangee(bouton(id('notifications', membre.id), joueur.notifications ? 'Couper les notifications' : 'Activer les notifications', joueur.notifications ? ButtonStyle.Secondary : ButtonStyle.Success, '🔔'))] : [] };
}

function ecranArticles(membre: GuildMember, note?: string): Ecran {
  const g = membre.guild.id;
  const articles = articlesBoutique(g);
  const embed = embedEnseigne(membre.guild)
    .setTitle('🏷️ Articles du serveur')
    .setDescription([note, `Ton solde : ${montantGold(g, portefeuille(g, membre.id).solde)}`, '', ...articles.map((a) => `${a.emoji} **${a.nom}** — ${montantGold(g, a.prix)}${a.stock !== null ? ` · stock ${a.stock}` : ''}${a.description ? `\n-# ${tronquer(a.description, 80)}` : ''}`)].filter((l) => l !== undefined).join('\n'));
  const boutons = articles.slice(0, 10).map((a) => bouton(id('acheter', membre.id, String(a.id)), tronquer(`${a.nom} (${a.prix})`, 80), ButtonStyle.Secondary));
  const rangees = [];
  for (let i = 0; i < boutons.length; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  return { embeds: [embed], files: [], components: [...rangees, rangee(bouton(id('boutique', membre.id), 'Coffres', ButtonStyle.Primary, '🛒'))] };
}

// - Commandes -

const optionMembre = (o: import('discord.js').SlashCommandUserOption) => o.setName('membre').setDescription('Qui (toi par défaut)');

async function membreVise(message: Message<true>, argument: string | undefined): Promise<{ utilisateur: User; membre: GuildMember | null }> {
  const cibleId = argument?.replace(/\D/g, '');
  if (!cibleId) return { utilisateur: message.author, membre: message.member };
  const membre = await message.guild.members.fetch(cibleId).catch(() => null);
  const utilisateur = membre?.user ?? (await message.client.users.fetch(cibleId).catch(() => null));
  if (!utilisateur) throw new ErreurUtilisateur('Membre introuvable.');
  return { utilisateur, membre };
}

// - Rythme des rendus -
// Une image par membre toutes les deux secondes : les cartes coûtent du calcul.
const derniersRendus = new Map<string, number>();

function limiterRendu(serveurId: string, utilisateurId: string): void {
  const cle = `${serveurId}:${utilisateurId}`;
  const maintenant = Date.now();
  if ((derniersRendus.get(cle) ?? 0) > maintenant) throw new ErreurUtilisateur('Doucement, une carte à la fois !');
  derniersRendus.set(cle, maintenant + 2_000);
  if (derniersRendus.size > 5_000) for (const [k, v] of derniersRendus) if (v < maintenant) derniersRendus.delete(k);
}

const repondreMessage = async (message: Message<true>, construire: () => Ecran | Promise<Ecran>) => {
  limiterRendu(message.guildId, message.author.id);
  await message.channel.sendTyping().catch(() => undefined);
  return message.reply({ ...(await construire()), allowedMentions: { repliedUser: false } });
};

const commandes: CommandeSlash[] = [
  {
    categorie: 'progression',
    delaiSecondes: 3,
    donnees: new SlashCommandBuilder().setName('profil').setDescription('Niveau, avatar, quêtes').addUserOption(optionMembre),
    async executer(i) {
      await i.deferReply();
      const utilisateur = i.options.getUser('membre') ?? i.user;
      const membre = i.options.getMember('membre') ?? (utilisateur.id === i.user.id ? i.member : null);
      await i.editReply(await ecranStatut(i.guild, utilisateur, membre instanceof GuildMember ? membre : null, i.user.id));
    },
  },
  {
    categorie: 'admin',
    niveau: Niveau.ADMIN,
    donnees: new SlashCommandBuilder()
      .setName('progression')
      .setDescription('Gérer la progression')
      .addUserOption((o) => o.setName('membre').setDescription('Un membre à ajuster')),
    async executer(i) {
      const cible = i.options.getUser('membre');
      await repondre(i, { ...(cible ? panneauMembreProgression(i.guild, cible.id) : panneauProgression(i.guild)), ephemeral: true });
    },
  },
];

// - /progression : tout au clic -
function panneauProgression(serveur: Guild, note?: string) {
  const roles = rolesNiveau(serveur.id);
  const articles = articlesBoutique(serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🌟 Progression')
    .setDescription(note ?? 'Les rôles gagnés en montant de niveau et les articles de la boutique.\n-# Pour ajuster un membre : `/progression membre:@quelqu’un`.')
    .addFields(
      { name: `🏅 Rôles de niveau (${roles.length})`, value: roles.map((r) => `Niveau **${r.niveau}** → <@&${r.role_id}>`).join('\n') || '—', inline: true },
      { name: `🛍️ Articles (${articles.length}/25)`, value: tronquer(articles.map((a) => `${a.emoji} ${a.nom} — ${formaterNombre(a.prix)}`).join('\n') || '—', 1024), inline: true },
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton('prga:rajout', 'Rôle de niveau', ButtonStyle.Success, '➕'),
        bouton('prga:rretrait', 'Retirer un rôle', ButtonStyle.Secondary, '➖').setDisabled(!roles.length),
        bouton('prga:aajout', 'Article', ButtonStyle.Success, '➕').setDisabled(articles.length >= 25),
        bouton('prga:aretrait', 'Retirer un article', ButtonStyle.Secondary, '➖').setDisabled(!articles.length),
      ),
    ],
  };
}

function panneauMembreProgression(serveur: Guild, utilisateurId: string, note?: string) {
  const xp = lireXp(serveur.id, utilisateurId);
  const p = niveauDepuisXp(xp.xp);
  const embed = embedEnseigne(serveur)
    .setTitle('🌟 Ajuster un membre')
    .setDescription([note, `<@${utilisateurId}>`].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Niveau', value: `**${p.niveau}** · rang ${rangDuNiveau(p.niveau).lettre}`, inline: true },
      { name: 'XP', value: formaterNombre(xp.xp), inline: true },
      { name: 'Gold', value: montantGold(serveur.id, portefeuille(serveur.id, utilisateurId).solde), inline: true },
      { name: 'Avatar', value: lireJoueur(serveur.id, utilisateurId) ? 'Créé' : '—', inline: true },
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton(`prga:xp:${utilisateurId}`, 'XP', ButtonStyle.Primary, '✨'),
        bouton(`prga:niv:${utilisateurId}`, 'Niveau', ButtonStyle.Primary, '🎯'),
        bouton(`prga:gold:${utilisateurId}`, 'Gold', ButtonStyle.Primary, '🪙'),
      ),
      rangee(bouton(`prga:avatar:${utilisateurId}`, 'Effacer l’avatar', ButtonStyle.Secondary, '🧍'), bouton(`prga:reset:${utilisateurId}`, 'Tout remettre à zéro', ButtonStyle.Danger, '🧹')),
    ],
  };
}

async function ajusterMembre(serveur: Guild, auteur: User, utilisateurId: string, action: string, valeur: number): Promise<string> {
  if (action === 'gold') {
    let solde: number;
    try {
      solde = ajouterPieces(serveur.id, utilisateurId, valeur, 'admin');
    } catch {
      throw new ErreurUtilisateur('Le solde ne peut pas devenir négatif.');
    }
    void journal(serveur, 'community', { titre: 'Gold modifié', ton: 'info', lignes: [`**Membre** : <@${utilisateurId}>`, `**Montant** : ${valeur}`, `**Nouveau solde** : ${solde}`], par: auteur });
    return `🪙 ${valeur >= 0 ? '+' : ''}${formaterNombre(valeur)} → ${montantGold(serveur.id, solde)}`;
  }
  if (action === 'avatar') {
    transaction(() => {
      executer('DELETE FROM joueurs WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, utilisateurId);
      executer('DELETE FROM objets WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, utilisateurId);
    });
    return '🧍 Avatar effacé : il sera recréé à la prochaine ouverture.';
  }
  const niveau = action === 'xp' ? ajouterXp(serveur.id, utilisateurId, valeur).nouveauNiveau : poserXp(serveur.id, utilisateurId, action === 'niv' ? xpTotalePourNiveau(valeur) : 0);
  const membre = await serveur.members.fetch(utilisateurId).catch(() => null);
  if (membre) await synchroniserRolesNiveau(membre, niveau);
  return `🎯 Niveau **${niveau}** (${formaterNombre(lireXp(serveur.id, utilisateurId).xp)} XP)`;
}

const TYPES_ARTICLE = { role: { libelle: 'Un rôle', emoji: '🎨' }, badge: { libelle: 'Un badge', emoji: '💎' }, item: { libelle: 'À livrer par le staff', emoji: '🎟️' } } as const;

const composantAdmin: GestionnaireComposant = {
  prefixe: 'prga',
  niveau: Niveau.ADMIN,
  async bouton(interaction: ButtonInteraction<'cached'>, [action, cible]) {
    const serveur = interaction.guild;
    switch (action) {
      case 'rajout':
        return void (await interaction.update({ embeds: [info(serveur, 'Quel rôle donner en montant de niveau ?', { titre: 'Rôle de niveau' })], components: [rangee(new RoleSelectMenuBuilder().setCustomId('prga:rsel').setPlaceholder('Le rôle'))] }));
      case 'rretrait':
        return void (await interaction.update({
          embeds: [info(serveur, 'Quel rôle ne plus donner ?', { titre: 'Rôle de niveau' })],
          components: [rangee(new StringSelectMenuBuilder().setCustomId('prga:rdel').setPlaceholder('Le rôle').addOptions(rolesNiveau(serveur.id).slice(0, 25).map((r) => ({ label: `Niveau ${r.niveau} · ${tronquer(serveur.roles.cache.get(r.role_id)?.name ?? r.role_id, 80)}`, value: r.role_id }))))],
        }));
      case 'aajout':
        return void (await interaction.update({
          embeds: [info(serveur, 'Qu’est-ce que l’article donne ?', { titre: 'Nouvel article' })],
          components: [rangee(new StringSelectMenuBuilder().setCustomId('prga:atype').setPlaceholder('Ce que ça donne').addOptions(Object.entries(TYPES_ARTICLE).map(([value, t]) => ({ label: t.libelle, value, emoji: t.emoji }))))],
        }));
      case 'aretrait':
        return void (await interaction.update({
          embeds: [info(serveur, 'Quel article retirer ?', { titre: 'Boutique' })],
          components: [rangee(new StringSelectMenuBuilder().setCustomId('prga:adel').setPlaceholder('L’article').addOptions(articlesBoutique(serveur.id).slice(0, 25).map((a) => ({ label: tronquer(`${a.nom} — ${a.prix}`, 100), value: String(a.id) }))))],
        }));
      case 'xp':
      case 'niv':
      case 'gold': {
        const libelle = action === 'xp' ? 'XP à ajouter (négatif = retirer)' : action === 'niv' ? 'Nouveau niveau (0 à 500)' : 'Gold à ajouter (négatif = retirer)';
        return void (await interaction.showModal(construireFormulaire(`prga:m:${action}:${cible}`, 'Ajuster', [{ id: 'valeur', libelle, indication: action === 'niv' ? '10' : '500', longueurMax: 9 }])));
      }
      case 'avatar':
      case 'reset':
        return void (await interaction.update(panneauMembreProgression(serveur, cible!, await ajusterMembre(serveur, interaction.user, cible!, action, 0))));
    }
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action]) {
    const serveur = interaction.guild;
    const valeur = interaction.values[0] ?? '';
    if (action === 'rsel') {
      if (!rolesAttribuables(serveur, [valeur]).length) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle (au-dessus du mien ou géré par une intégration).');
      return void (await interaction.showModal(construireFormulaire(`prga:m:rniv:${valeur}`, 'Rôle de niveau', [{ id: 'valeur', libelle: 'À partir de quel niveau ?', indication: '10', longueurMax: 3 }])));
    }
    if (action === 'rdel') {
      retirerRoleNiveau(serveur.id, valeur);
      return void (await interaction.update(panneauProgression(serveur, `➖ <@&${valeur}> n’est plus un rôle de niveau.`)));
    }
    if (action === 'adel') {
      executer('DELETE FROM articles_boutique WHERE serveur_id = ? AND id = ?', serveur.id, Number(valeur));
      return void (await interaction.update(panneauProgression(serveur, '➖ Article retiré.')));
    }
    if (action === 'atype' && valeur === 'role') {
      return void (await interaction.update({ embeds: [info(serveur, 'Quel rôle vendre ?', { titre: 'Nouvel article' })], components: [rangee(new RoleSelectMenuBuilder().setCustomId('prga:arole').setPlaceholder('Le rôle'))] }));
    }
    if (action === 'arole' && !rolesAttribuables(serveur, [valeur]).length) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle (au-dessus du mien ou géré par une intégration).');
    const type = action === 'arole' ? 'role' : valeur;
    if (!(type in TYPES_ARTICLE)) return;
    await interaction.showModal(
      construireFormulaire(`prga:m:article:${type}:${action === 'arole' ? valeur : ''}`, 'Nouvel article', [
        { id: 'nom', libelle: 'Nom', indication: type === 'role' ? 'Couleur VIP' : 'Mention sur le live', longueurMax: 60 },
        { id: 'prix', libelle: 'Prix en gold', indication: '5000', longueurMax: 9 },
        ...(type === 'badge' ? [{ id: 'badge', libelle: 'Identifiant du badge', longueurMax: 32 }] : []),
        { id: 'emoji', libelle: 'Émoji', obligatoire: false, valeur: TYPES_ARTICLE[type as keyof typeof TYPES_ARTICLE].emoji, longueurMax: 64 },
        { id: 'stock', libelle: 'Stock (vide = illimité)', obligatoire: false, longueurMax: 6 },
      ]),
    );
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>, [, action, a, b]) {
    const serveur = interaction.guild;
    const champ = (id: string) => {
      try {
        return interaction.fields.getTextInputValue(id).trim();
      } catch {
        return '';
      }
    };
    const nombre = (id: string, min: number, max: number) => {
      const n = Number(champ(id).replace(/\s/g, ''));
      if (!Number.isInteger(n) || n < min || n > max) throw new ErreurUtilisateur(`Un nombre entier entre ${formaterNombre(min)} et ${formaterNombre(max)}.`);
      return n;
    };
    const afficher = async (charge: object) => {
      if (interaction.isFromMessage()) await interaction.update(charge);
      else await interaction.reply({ ...charge, flags: 64 });
    };
    if (action === 'xp' || action === 'niv' || action === 'gold') {
      const valeur = action === 'niv' ? nombre('valeur', 0, 500) : nombre('valeur', -10_000_000, 10_000_000);
      return afficher(panneauMembreProgression(serveur, a!, await ajusterMembre(serveur, interaction.user, a!, action, valeur)));
    }
    if (action === 'rniv') {
      const niveau = nombre('valeur', 1, 500);
      poserRoleNiveau(serveur.id, niveau, a!);
      return afficher(panneauProgression(serveur, `➕ Niveau **${niveau}** → <@&${a}>`));
    }
    if (action === 'article') {
      if (articlesBoutique(serveur.id).length >= 25) throw new ErreurUtilisateur('25 articles maximum.');
      const type = a as keyof typeof TYPES_ARTICLE;
      const badge = champ('badge');
      if (type === 'badge' && !badge) throw new ErreurUtilisateur('Indique l’identifiant du badge.');
      const stock = champ('stock') ? nombre('stock', 1, 100_000) : null;
      executer(
        'INSERT INTO articles_boutique (serveur_id, nom, description, emoji, prix, type, valeur, stock, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        serveur.id,
        champ('nom'),
        '',
        champ('emoji') || TYPES_ARTICLE[type].emoji,
        nombre('prix', 1, 10_000_000),
        type,
        type === 'role' ? b : type === 'badge' ? badge : null,
        stock,
        Date.now(),
      );
      return afficher(panneauProgression(serveur, `➕ **${champ('nom')}** est en vente.`));
    }
  },
};

function embedGold(serveur: Guild, utilisateur: User): EmbedBuilder {
  const w = portefeuille(serveur.id, utilisateur.id);
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle('🪙 Gold')
    .setDescription([`• Solde — ${montantGold(serveur.id, w.solde)}`, `• Gagné au total — **${formaterNombre(w.total_gagne)}**`, `• Série de bonus quotidien — **${w.serie_quotidien}** jour${w.serie_quotidien > 1 ? 's' : ''}`, '', '-# Monnaie purement virtuelle, sans valeur réelle.'].join('\n'));
}

function donnerGold(serveurId: string, donneurId: string, cible: User, montant: number): string {
  if (cible.bot || cible.id === donneurId) throw new ErreurUtilisateur('Choisis un autre membre (pas toi, pas un bot).');
  try {
    transferer(serveurId, donneurId, cible.id, montant);
  } catch {
    throw new ErreurUtilisateur('Solde insuffisant.');
  }
  return `<@${donneurId}> donne ${montantGold(serveurId, montant)} à <@${cible.id}>.`;
}

function poserBio(membre: GuildMember, bio: string): void {
  exigerJoueur(membre);
  executer('UPDATE joueurs SET bio = ? WHERE serveur_id = ? AND utilisateur_id = ?', bio.replace(/\s+/g, ' ').trim().slice(0, 60), membre.guild.id, membre.id);
}

const commandesPrefixe: CommandePrefixe[] = [
  { nom: 'lvl', alias: ['rank', 'niveau', 'statut', 'profil'], domaine: 'general', categorie: 'progression', description: 'Ton statut', usage: '[membre]', async executer(message, parametres) {
    const { utilisateur, membre } = await membreVise(message, parametres[0]);
    await repondreMessage(message, () => ecranStatut(message.guild, utilisateur, membre, message.author.id));
  } },
  { nom: 'lb', alias: ['top', 'classement'], domaine: 'general', categorie: 'progression', description: 'Classements', async executer(message) {
    await repondreMessage(message, () => ecranClassement(message.guild, message.author.id, 'xp', 'semaine'));
  } },
  { nom: 'rangs', alias: ['paliers'], domaine: 'general', categorie: 'progression', description: 'Paliers de rang', async executer(message) {
    await repondreMessage(message, () => ecranRangs(message.member!));
  } },
  { nom: 'quest', alias: ['quetes', 'quests'], domaine: 'general', categorie: 'progression', description: 'Tes quêtes', async executer(message) {
    await repondreMessage(message, () => ecranQuetes(message.member!));
  } },
  { nom: 'avatar', alias: ['perso'], domaine: 'general', categorie: 'progression', description: 'Ton personnage', async executer(message) {
    await repondreMessage(message, () => ecranAvatar(message.member!));
  } },
  { nom: 'inv', alias: ['inventaire'], domaine: 'general', categorie: 'progression', description: 'Ton inventaire', async executer(message) {
    await repondreMessage(message, () => ecranInventaire(message.member!));
  } },
  { nom: 'shop', alias: ['boutique', 'coffres'], domaine: 'general', categorie: 'progression', description: 'Coffres et articles', async executer(message) {
    await repondreMessage(message, () => ecranBoutique(message.member!));
  } },
  { nom: 'daily', alias: ['quotidien'], domaine: 'general', categorie: 'progression', description: 'Bonus quotidien', async executer(message) {
    await message.reply({ embeds: [ok(message.guild, recupererQuotidien(message.member!), { titre: 'Bonus du jour' })], allowedMentions: { repliedUser: false } });
  } },
  { nom: 'gold', alias: ['bal', 'solde'], domaine: 'general', categorie: 'progression', description: 'Ton solde', usage: '[membre]', async executer(message, parametres) {
    const { utilisateur } = await membreVise(message, parametres[0]);
    await message.reply({ embeds: [embedGold(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
  } },
  { nom: 'give', alias: ['donner'], domaine: 'general', categorie: 'progression', description: 'Donner du gold', usage: '<membre> <montant>', async executer(message, parametres) {
    const { utilisateur } = await membreVise(message, parametres[0]);
    const montant = Number(parametres[1]);
    if (!parametres[0] || !Number.isInteger(montant) || montant <= 0) throw new ErreurUtilisateur('Usage : `give @membre 100`.');
    await message.reply({ embeds: [ok(message.guild, donnerGold(message.guildId, message.author.id, utilisateur, montant))], allowedMentions: { users: [utilisateur.id], repliedUser: false } });
  } },
  { nom: 'rep', alias: ['reputation'], domaine: 'general', categorie: 'progression', description: 'Donner de la réputation', usage: '<membre>', async executer(message, parametres) {
    if (!parametres[0]) throw new ErreurUtilisateur('Usage : `rep @membre`.');
    const { utilisateur } = await membreVise(message, parametres[0]);
    if (utilisateur.bot) throw new ErreurUtilisateur('Choisis un membre, pas un bot.');
    donnerReputation(message.guildId, message.author.id, utilisateur.id);
    await message.reply({ embeds: [ok(message.guild, `Un point de réputation pour <@${utilisateur.id}> ⭐ (${reputationDe(message.guildId, utilisateur.id)} au total).`)], allowedMentions: { users: [utilisateur.id], repliedUser: false } });
  } },
  { nom: 'bio', domaine: 'general', categorie: 'progression', description: 'Modifier ta bio', usage: '<texte>', async executer(message, parametres) {
    poserBio(message.member!, parametres.join(' '));
    await message.reply({ embeds: [ok(message.guild, parametres.length ? 'Bio mise à jour.' : 'Bio effacée.')], allowedMentions: { repliedUser: false } });
  } },
  { nom: 'settings', alias: ['parametres', 'bonus'], domaine: 'general', categorie: 'progression', description: 'Paramètres et bonus', async executer(message) {
    await repondreMessage(message, () => ecranParametres(message.member!));
  } },
  { nom: 'jeu', alias: ['commandes', 'cmds'], domaine: 'general', categorie: 'progression', description: 'Centre de commandes', async executer(message) {
    await repondreMessage(message, () => ecranCommandes(message.member!));
  } },
];

// - Boutons -

const composant: GestionnaireComposant = {
  prefixe: 'prg',
  async bouton(interaction: ButtonInteraction<'cached'>, [action, proprietaire, a, b]) {
    const membre = interaction.member;
    if (action !== 'classement' && proprietaire !== interaction.user.id) {
      await interaction.reply({ content: 'Ces boutons ne sont pas à toi : lance `=avatar` ou `=lvl` pour les tiens.', flags: 64 });
      return;
    }
    const mettreAJour = async (construire: () => Ecran | Promise<Ecran>) => {
      limiterRendu(interaction.guildId, interaction.user.id);
      await interaction.deferUpdate();
      const e = await construire();
      await interaction.editReply({ content: e.content ?? null, embeds: e.embeds ?? [], files: e.files ?? [], attachments: [], components: e.components ?? [] });
    };
    switch (action) {
      case 'statut':
        return mettreAJour(() => ecranStatut(interaction.guild, interaction.user, membre, interaction.user.id));
      case 'avatar':
        return mettreAJour(() => ecranAvatar(membre));
      case 'inventaire':
        return mettreAJour(() => ecranInventaire(membre));
      case 'boutique':
        return mettreAJour(() => ecranBoutique(membre));
      case 'quetes':
        return mettreAJour(() => ecranQuetes(membre));
      case 'classement':
        if (proprietaire !== interaction.user.id) {
          await interaction.deferReply({ flags: 64 });
          const e = await ecranClassement(interaction.guild, interaction.user.id, (a ?? 'xp') as TypeClassement, (b ?? 'semaine') as Periode);
          await interaction.editReply({ embeds: e.embeds ?? [], files: e.files ?? [], components: e.components ?? [] });
          return;
        }
        return mettreAJour(() => ecranClassement(interaction.guild, interaction.user.id, (a ?? 'xp') as TypeClassement, (b ?? 'semaine') as Periode));
      case 'categorie':
        return mettreAJour(() => a === 'yeux' ? ecranTeintes(membre, 'yeux', null) : ecranModeles(membre, a as 'cheveux' | 'tenues'));
      case 'modele':
        return mettreAJour(() => ecranTeintes(membre, a as Categorie, b ?? null));
      case 'equiper': {
        const cle = [a, b, interaction.customId.split(':')[5]].filter(Boolean).join(':');
        return mettreAJour(() => {
          equiper(interaction.guildId, interaction.user.id, cle);
          return ecranAvatar(membre);
        });
      }
      case 'coffre':
        return mettreAJour(() => ecranCoffre(membre, a as Categorie));
      case 'valider': {
        return mettreAJour(() => {
          const gains = validerHebdo(interaction.client, interaction.guildId, interaction.user.id);
          return ecranQuetes(membre, gains ? `🏅 Récompense récupérée : **${gains}**` : 'Aucune quête hebdo à valider pour l’instant.');
        });
      }
      case 'genre': {
        if (lireJoueur(interaction.guildId, interaction.user.id)) return mettreAJour(() => ecranAvatar(membre));
        const impose = genreImpose(membre);
        return mettreAJour(() => ecranCreation(membre, impose ?? (a as Genre)));
      }
      case 'teint': {
        const genre = genreImpose(membre) ?? (a as Genre);
        if (!TEINTS.some((t) => t.id === b) || (genre !== 'homme' && genre !== 'femme')) return;
        return mettreAJour(() => {
          creerJoueur(interaction.guildId, interaction.user.id, genre, b as Teint);
          return ecranAvatar(membre);
        });
      }
      case 'quotidien':
        await interaction.reply({ embeds: [ok(interaction.guild, recupererQuotidien(membre), { titre: 'Bonus du jour', sujet: '🎁' })], flags: 64 });
        return;
      case 'parametres':
        await interaction.reply({ ...ecranParametres(membre), flags: 64 });
        return;
      case 'notifications':
        executer('UPDATE joueurs SET notifications = 1 - notifications WHERE serveur_id = ? AND utilisateur_id = ?', interaction.guildId, interaction.user.id);
        await interaction.update({ ...ecranParametres(membre), attachments: [] });
        return;
      case 'articles':
        return mettreAJour(() => ecranArticles(membre));
      case 'acheter': {
        const article = articleBoutique(interaction.guildId, Number(a));
        if (!article) throw new ErreurUtilisateur('Cet article n’existe plus.');
        let solde: number;
        try {
          solde = acheter(interaction.guildId, interaction.user.id, article);
        } catch (echec) {
          throw new ErreurUtilisateur((echec as Error).message === 'rupture de stock' ? 'Rupture de stock.' : 'Solde insuffisant.');
        }
        try {
          const texte = await livrer(membre, article);
          return mettreAJour(() => ecranArticles(membre, `✅ ${article.emoji} **${article.nom}** acheté. ${texte}\n-# Nouveau solde : ${formaterNombre(solde)}`));
        } catch (echec) {
          rembourser(interaction.guildId, interaction.user.id, article);
          return mettreAJour(() => ecranArticles(membre, `⚠️ ${(echec as Error).message} Tu as été remboursé.`));
        }
      }
    }
  },
};

// - Réglages -

const pageReglage: PageReglage = {
  id: 'progression',
  section: 'community',
  titre: 'Progression',
  emoji: '🌟',
  moduleId: 'progression',
  ordre: 1,
  description: 'XP et gold par message et en vocal, rangs E à S, avatars à débloquer dans les coffres, quêtes et classements.\n-# Rôles de niveau et boutique : `/progression`. Variables du message : `{mention}` `{user}` `{level}`',
  champs: [
    {
      genre: 'choice',
      cle: 'announce',
      libelle: 'Annonce des niveaux',
      options: [
        { valeur: 'same', libelle: 'Dans le salon du message', emoji: '💬' },
        { valeur: 'channel', libelle: 'Dans un salon dédié', emoji: '📢' },
        { valeur: 'dm', libelle: 'En message privé', emoji: '✉️' },
        { valeur: 'off', libelle: 'Aucune annonce', emoji: '🔕' },
      ],
      lire: (c) => c.xp.annonce,
      ecrire: (c, v) => void (c.xp.annonce = v as 'off' | 'same' | 'channel' | 'dm'),
    },
    { genre: 'channel', cle: 'channel', libelle: 'Salon des annonces de niveau', lire: (c) => c.xp.salonAnnonceId, ecrire: (c, v) => void (c.xp.salonAnnonceId = v) },
    { genre: 'channels', cle: 'noxp', libelle: 'Salons sans XP', channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum], lire: (c) => c.xp.salonsSansXp, ecrire: (c, v) => void (c.xp.salonsSansXp = v) },
  ],
};

const pageAvatars: PageReglage = {
  id: 'progression-avatars',
  section: 'community',
  titre: 'Avatars et gold',
  emoji: '🧍',
  moduleId: 'progression',
  ordre: 2,
  description: 'Un rôle peut imposer le personnage (sinon chacun choisit une fois pour toutes). Le gold se gagne en parlant, en vocal et en montant de niveau.',
  champs: [
    { genre: 'role', cle: 'femme', libelle: 'Rôle qui impose « Femme »', lire: (c) => c.progression.roleFemmeId, ecrire: (c, v) => void (c.progression.roleFemmeId = v) },
    { genre: 'role', cle: 'homme', libelle: 'Rôle qui impose « Homme »', lire: (c) => c.progression.roleHommeId, ecrire: (c, v) => void (c.progression.roleHommeId = v) },
    { genre: 'number', cle: 'coffre', libelle: 'Prix d’un coffre', min: 1, max: 100_000, unite: 'gold', lire: (c) => c.progression.prixCoffre, ecrire: (c, v) => void (c.progression.prixCoffre = v) },
    { genre: 'number', cle: 'message', libelle: 'Gold par message', min: 0, max: 1000, lire: (c) => c.economie.parMessage, ecrire: (c, v) => void (c.economie.parMessage = v) },
    { genre: 'number', cle: 'daily', libelle: 'Bonus quotidien', min: 0, max: 1_000_000, lire: (c) => c.economie.montantQuotidien, ecrire: (c, v) => void (c.economie.montantQuotidien = v) },
  ],
};

export const moduleProgression: ModuleBot = {
  id: 'progression',
  nom: 'Progression',
  emoji: '🌟',
  description: 'Niveaux, gold, avatars, coffres, quêtes et classements',
  desactivable: true,
  actifParDefaut: true,
  commandes,
  commandesPrefixe,
  composants: [composant, composantAdmin],
  pagesReglage: [pageReglage, pageAvatars],
  evenements: [sur('messageCreate', (m: Message) => surMessage(m), 150)],
  taches: [
    {
      nom: 'quetes-nettoyage',
      intervalleMs: 12 * 3_600_000,
      async executer() {
        const limite = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
        executer("DELETE FROM quetes WHERE substr(periode, 3) < ?", limite);
      },
    },
  ],
};
