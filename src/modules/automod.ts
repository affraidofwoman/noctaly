import { ChannelType, type Message } from 'discord.js';
import { emojiPour, estExempte } from '../coeur/acces';
import { info, ok, refus } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { historiser, journal } from '../coeur/journaux';
import { type CommandePrefixe, type ModuleBot, Niveau, sur } from '../coeur/noyau';
import { creerRegistre, Delais, LimiteurFenetre, tronquer } from '../coeur/outils';
import { type ConfigServeur, lireConfig, modifierConfig } from '../coeur/reglages';
import { appliquerSanction } from './moderation';

/**
 * Filtre de mots interdits repris du bot Airline : résiste aux substitutions (0→o, 3→e, @→a…),
 * aux séparateurs (n.e.g.r.e) et aux lettres répétées, sans toucher aux mots sûrs (violet, violon…).
 */

export const MOTS_DEFAUT = [
  'negre', 'negro', 'nigger', 'nigga', 'bougnoule', 'bicot', 'youpin', 'chintok', 'niakoue',
  'nazi', 'heilhitler', 'siegheil',
  'pede', 'tapette', 'tarlouze', 'faggot',
  'pedophile', 'pedo', 'zoophile',
  'pute', 'salope', 'connasse',
];

export const MOTS_SURS = [
  'violet', 'violette', 'violon', 'violoncelle', 'violoniste',
  'violence', 'violent', 'violente', 'violemment', 'violace',
  'negroni', 'computer', 'reputation', 'deputes', 'depute',
  'pedestre', 'pedopsychiatre', 'pedopsychiatrie', 'pedologie', 'pedoncule', 'pedale', 'pedagogie', 'pedagogique',
];

const SOSIES: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', ')': 'c', '[': 'c', '{': 'c', '<': 'c',
  '£': 'l', '€': 'e', '¥': 'y', '°': 'o', 'µ': 'u', '×': 'x',
};

const VARIANTES: Record<string, string> = {
  a: 'a4@àáâãäå', b: 'b8ß', c: 'c(<[{ç¢', d: 'd', e: 'e3€èéêë', f: 'f', g: 'g69', h: 'h', i: 'i1!|ìíîï', j: 'j',
  k: 'k', l: 'l1|£', m: 'm', n: 'nñ', o: 'o0@°øòóôõö', p: 'p', q: 'q', r: 'r', s: 's5$§', t: 't7+', u: 'uvµùúûü',
  v: 'v', w: 'w', x: 'x×', y: 'y¥ÿ', z: 'z2',
};

/** Forme de base d'un mot : minuscules, sans accents, sosies remplacés, lettres seulement. */
export function formeDeBase(mot: string): string {
  const epure = mot.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return [...epure].map((c) => SOSIES[c] ?? c).join('').replace(/[^a-z]/g, '');
}

const motifs = new Map<string, RegExp>();

function echapperClasse(caracteres: string): string {
  return caracteres.replace(/[\\\]^-]/g, '\\$&');
}

function motif(mot: string): RegExp {
  let p = motifs.get(mot);
  if (!p) {
    const corps = [...mot].map((l) => `[${echapperClasse(VARIANTES[l] ?? l)}]+`).join('[^a-z0-9]{0,3}');
    p = new RegExp(`(?<![a-z0-9])${corps}`, 'gi');
    motifs.set(mot, p);
    if (motifs.size > 2000) motifs.delete(motifs.keys().next().value!);
  }
  return p;
}

function plages(mot: string, botte: string): [number, number][] {
  const sortie: [number, number][] = [];
  const p = motif(mot);
  p.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = p.exec(botte)) !== null) {
    sortie.push([m.index, m.index + m[0].length]);
    if (m.index === p.lastIndex) p.lastIndex++;
  }
  return sortie;
}

/** Retourne le mot interdit trouvé dans le texte, ou null. */
export function trouverMotInterdit(mots: string[], texte: string): string | null {
  if (!mots.length || !texte) return null;
  const botte = texte.slice(0, 4000).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Les mots sûrs ne comptent qu'écrits tels quels : sinon « de p.u.t.e » passerait pour « député ».
  const surs: [number, number][] = [];
  for (const mot of MOTS_SURS) {
    for (let i = botte.indexOf(mot); i !== -1; i = botte.indexOf(mot, i + 1)) surs.push([i, i + mot.length]);
  }
  for (const mot of mots) {
    const base = formeDeBase(mot);
    if (!base) continue;
    for (const [demarrer, fin] of plages(base, botte)) {
      if (!surs.some(([s, e]) => demarrer >= s && fin <= e)) return base;
    }
  }
  return null;
}

export type RegleAutomod = 'invites' | 'links' | 'badWords' | 'mentions' | 'caps' | 'spam' | 'duplicates';

export const LIBELLES_REGLES: Record<RegleAutomod, { label: string; avertissement: string }> = {
  invites: { label: 'Invitation Discord', avertissement: 'les invitations Discord ne sont pas autorisées ici' },
  links: { label: 'Lien non autorisé', avertissement: 'ce lien n’est pas autorisé ici' },
  badWords: { label: 'Mot interdit', avertissement: 'ce message contient un mot interdit' },
  mentions: { label: 'Mentions excessives', avertissement: 'trop de mentions dans un seul message' },
  caps: { label: 'Majuscules excessives', avertissement: 'merci d’éviter d’écrire tout en majuscules' },
  spam: { label: 'Spam', avertissement: 'tu envoies des messages trop vite' },
  duplicates: { label: 'Répétition', avertissement: 'merci de ne pas répéter le même message' },
};

const INVITATION = /(?:discord(?:app)?\.(?:gg|com\/invite|io|me|li)|dsc\.gg|invite\.gg)\/[\w-]+/i;
const LIEN = /\bhttps?:\/\/([^\s/$.?#][^\s/]*)/gi;

export function contientInvitation(contenu: string): boolean {
  return INVITATION.test(contenu);
}

/** Domaine autorisé si identique ou sous-domaine d'une entrée de la whitelist. */
export function domaineAutorise(organisateur: string, whitelist: string[]): boolean {
  const h = organisateur.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  return whitelist.some((d) => {
    const domaine = d.toLowerCase().trim().replace(/^www\./, '');
    return domaine && (h === domaine || h.endsWith(`.${domaine}`));
  });
}

export function lienInterdit(contenu: string, whitelist: string[]): string | null {
  LIEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIEN.exec(contenu)) !== null) {
    if (!domaineAutorise(m[1]!, whitelist)) return m[1]!;
  }
  return null;
}

export function tauxMajuscules(contenu: string): { lettres: number; taux: number } {
  const lettres = contenu.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (!lettres.length) return { lettres: 0, taux: 0 };
  const majuscule = lettres.filter((l) => l !== l.toLowerCase() && l === l.toUpperCase()).length;
  return { lettres: lettres.length, taux: majuscule / lettres.length };
}

export interface VerdictContenu {
  regle: RegleAutomod;
  detail: string;
}

/** Règles sans état (évaluées sur un seul message). */
export function verifierContenu(reglages: ConfigServeur['automod'], contenu: string, nombreMentions: number, mentionneTous: boolean): VerdictContenu | null {
  if (reglages.invites.enabled && contientInvitation(contenu)) return { regle: 'invites', detail: contenu.match(INVITATION)?.[0] ?? '' };
  if (reglages.liens.enabled) {
    const lien = lienInterdit(contenu, reglages.liens.whitelist);
    if (lien) return { regle: 'links', detail: lien };
  }
  if (reglages.motsInterdits.enabled) {
    const mot = trouverMotInterdit(reglages.motsInterdits.mots, contenu);
    if (mot) return { regle: 'badWords', detail: mot };
  }
  if (reglages.mentions.enabled && (nombreMentions > reglages.mentions.max || mentionneTous)) {
    return { regle: 'mentions', detail: mentionneTous ? '@everyone/@here' : `${nombreMentions} mentions` };
  }
  if (reglages.majuscules.enabled) {
    const { lettres, taux } = tauxMajuscules(contenu);
    if (lettres >= reglages.majuscules.minLength && taux * 100 >= reglages.majuscules.percent) return { regle: 'caps', detail: `${Math.round(taux * 100)} %` };
  }
  return null;
}

export function normaliserPourRepetition(contenu: string): string {
  return contenu.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}

const registre = creerRegistre('automod');

const limiteursSpam = new Map<string, LimiteurFenetre>();
const contenusRecents = new Map<string, { text: string; at: number }[]>();
const delaiActions = new Delais();

function spamDetecte(serveurId: string, utilisateurId: string, messages: number, secondes: number): boolean {
  const cle = `${serveurId}:${messages}:${secondes}`;
  let limiteur = limiteursSpam.get(cle);
  if (!limiteur) limiteursSpam.set(cle, (limiteur = new LimiteurFenetre(messages, secondes * 1000)));
  return !limiteur.compter(`${serveurId}:${utilisateurId}`);
}

function repetitionDetectee(serveurId: string, utilisateurId: string, contenu: string, nombre: number): boolean {
  const texte = normaliserPourRepetition(contenu);
  if (texte.length < 3) return false;
  const cle = `${serveurId}:${utilisateurId}`;
  const maintenant = Date.now();
  const liste = (contenusRecents.get(cle) ?? []).filter((e) => maintenant - e.at < 60_000);
  liste.push({ text: texte, at: maintenant });
  contenusRecents.set(cle, liste.slice(-20));
  if (contenusRecents.size > 5000) contenusRecents.delete(contenusRecents.keys().next().value!);
  return liste.filter((e) => e.text === texte).length >= nombre;
}

async function sanctionner(message: Message<true>, regle: RegleAutomod, detail: string): Promise<void> {
  const serveur = message.guild;
  const reglages = lireConfig(serveur.id).automod;
  await message.delete().catch(() => undefined);

  // Une seule réaction par personne toutes les 10 secondes : pas de cascade de sanctions sur un spam.
  if (delaiActions.prendre(`${serveur.id}:${message.author.id}`, 10_000) > 0) return;

  const libelle = LIBELLES_REGLES[regle];
  const avertissement = await message.channel
    .send({ embeds: [refus(serveur, `<@${message.author.id}>, ${libelle.avertissement}.`)], allowedMentions: { users: [message.author.id] } })
    .catch(() => null);
  if (avertissement) setTimeout(() => void avertissement.delete().catch(() => undefined), 6_000).unref();

  let sanction = 'message supprimé';
  const moi = serveur.members.me;
  if (moi && reglages.action !== 'delete') {
    try {
      await appliquerSanction({
        serveur,
        auteur: moi,
        cible: message.author,
        type: reglages.action === 'warn' ? 'warn' : 'timeout',
        raison: `AutoMod — ${libelle.label}`,
        dureeMs: reglages.action === 'timeout' ? reglages.minutesTimeout * 60_000 : undefined,
        auto: reglages.action === 'timeout',
      });
      sanction = reglages.action === 'warn' ? 'avertissement' : `timeout ${reglages.minutesTimeout} min`;
    } catch (echec) {
      registre.avertir(`Sanction AutoMod impossible : ${(echec as Error).message}`);
    }
  }

  historiser(serveur.id, 'automod', regle, message.author.id, null, { detail, channelId: message.channelId });
  void journal(serveur, 'automod', {
    titre: `AutoMod — ${libelle.label}`,
    ton: 'alerte',
    lignes: [
      `**Membre** : <@${message.author.id}> \`${message.author.tag}\``,
      `**Salon** : <#${message.channelId}>`,
      `**Détecté** : \`${tronquer(detail, 100)}\``,
      `**Action** : ${sanction}`,
      '',
      tronquer(message.content, 1500),
    ],
  });
}

async function surMessage(message: Message): Promise<'stop' | void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const reglages = lireConfig(message.guildId).automod;
  if (reglages.salonsExemptes.includes(message.channelId) || reglages.membresExemptes.includes(message.author.id)) return;
  if (message.member.roles.cache.some((r) => reglages.rolesExemptes.includes(r.id))) return;
  if (reglages.ignorerStaff && estExempte(message.member)) return;

  const contenu = message.content ?? '';
  const mentions = new Set([...message.mentions.users.keys(), ...message.mentions.roles.keys()]).size;
  const verdict = verifierContenu(reglages, contenu, mentions, message.mentions.everyone && !message.member.permissions.has('MentionEveryone'));
  if (verdict) {
    await sanctionner(message, verdict.regle, verdict.detail);
    return 'stop';
  }
  if (reglages.spam.enabled && spamDetecte(message.guildId, message.author.id, reglages.spam.messages, reglages.spam.seconds)) {
    await sanctionner(message, 'spam', `${reglages.spam.messages} messages / ${reglages.spam.seconds} s`);
    return 'stop';
  }
  if (reglages.repetitions.enabled && contenu && repetitionDetectee(message.guildId, message.author.id, contenu, reglages.repetitions.count)) {
    await sanctionner(message, 'duplicates', tronquer(contenu, 80));
    return 'stop';
  }
}

const champListe = (cle: 'links' | 'badWords', libelle: string) => ({
  genre: 'text' as const,
  cle,
  libelle,
  long: true,
  longueurMax: 2000,
  lire: (c: import('../coeur/reglages').ConfigServeur) => (cle === 'links' ? c.automod.liens.whitelist : c.automod.motsInterdits.mots).join(', '),
  ecrire: (c: import('../coeur/reglages').ConfigServeur, v: string) => {
    const articles = [...new Set(v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 300);
    if (cle === 'links') c.automod.liens.whitelist = articles.map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    else c.automod.motsInterdits.mots = [...new Set(articles.map(formeDeBase).filter(Boolean))];
  },
});

const pages: PageReglage[] = [
  {
    id: 'automod',
    section: 'moderation',
    titre: 'AutoMod',
    emoji: '🤖',
    moduleId: 'automod',
    ordre: 2,
    description: 'Les filtres automatiques. Le staff, le bypass et les salons/rôles autorisés sont ignorés.\n-# Liste des domaines et mots : séparés par des virgules.',
    champs: [
      { genre: 'toggle', cle: 'spam', libelle: 'Spam', lire: (c) => c.automod.spam.enabled, ecrire: (c, v) => void (c.automod.spam.enabled = v) },
      { genre: 'toggle', cle: 'dup', libelle: 'Répétition', lire: (c) => c.automod.repetitions.enabled, ecrire: (c, v) => void (c.automod.repetitions.enabled = v) },
      { genre: 'toggle', cle: 'links', libelle: 'Liens', lire: (c) => c.automod.liens.enabled, ecrire: (c, v) => void (c.automod.liens.enabled = v) },
      { genre: 'toggle', cle: 'invites', libelle: 'Invitations', lire: (c) => c.automod.invites.enabled, ecrire: (c, v) => void (c.automod.invites.enabled = v) },
      { genre: 'toggle', cle: 'words', libelle: 'Mots interdits', lire: (c) => c.automod.motsInterdits.enabled, ecrire: (c, v) => void (c.automod.motsInterdits.enabled = v) },
      { genre: 'toggle', cle: 'mentions', libelle: 'Mentions', lire: (c) => c.automod.mentions.enabled, ecrire: (c, v) => void (c.automod.mentions.enabled = v) },
      { genre: 'toggle', cle: 'caps', libelle: 'Majuscules', lire: (c) => c.automod.majuscules.enabled, ecrire: (c, v) => void (c.automod.majuscules.enabled = v) },
      {
        genre: 'choice',
        cle: 'action',
        libelle: 'Action',
        options: [
          { valeur: 'delete', libelle: 'Supprimer le message', emoji: '🗑️' },
          { valeur: 'warn', libelle: 'Supprimer + avertir', emoji: '⚠️' },
          { valeur: 'timeout', libelle: 'Supprimer + timeout', emoji: '⏳' },
        ],
        lire: (c) => c.automod.action,
        ecrire: (c, v) => void (c.automod.action = v as 'delete' | 'warn' | 'timeout'),
      },
      { ...champListe('links', 'Domaines autorisés') },
      { ...champListe('badWords', 'Mots interdits') },
      { genre: 'number', cle: 'mentionsmax', libelle: 'Mentions max', min: 1, max: 50, lire: (c) => c.automod.mentions.max, ecrire: (c, v) => void (c.automod.mentions.max = v) },
      { genre: 'number', cle: 'timeout', libelle: 'Durée du timeout', min: 1, max: 1440, unite: 'min', lire: (c) => c.automod.minutesTimeout, ecrire: (c, v) => void (c.automod.minutesTimeout = v) },
    ],
  },
  {
    id: 'automod-advanced',
    section: 'moderation',
    titre: 'AutoMod — réglages fins',
    emoji: '🎚️',
    ordre: 3,
    description: 'Seuils des filtres et exceptions.',
    champs: [
      {
        genre: 'channels',
        cle: 'channels',
        libelle: 'Salons ignorés',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement],
        lire: (c) => c.automod.salonsExemptes,
        ecrire: (c, v) => void (c.automod.salonsExemptes = v),
      },
      { genre: 'roles', cle: 'roles', libelle: 'Rôles ignorés', lire: (c) => c.automod.rolesExemptes, ecrire: (c, v) => void (c.automod.rolesExemptes = v) },
      { genre: 'toggle', cle: 'staff', libelle: 'Ignorer le staff', lire: (c) => c.automod.ignorerStaff, ecrire: (c, v) => void (c.automod.ignorerStaff = v) },
      { genre: 'number', cle: 'spammsg', libelle: 'Spam : messages', min: 2, max: 30, lire: (c) => c.automod.spam.messages, ecrire: (c, v) => void (c.automod.spam.messages = v) },
      { genre: 'number', cle: 'spamsec', libelle: 'Spam : secondes', min: 1, max: 60, unite: 's', lire: (c) => c.automod.spam.seconds, ecrire: (c, v) => void (c.automod.spam.seconds = v) },
      { genre: 'number', cle: 'dup', libelle: 'Répétitions tolérées', min: 2, max: 20, lire: (c) => c.automod.repetitions.count, ecrire: (c, v) => void (c.automod.repetitions.count = v) },
      { genre: 'number', cle: 'capspct', libelle: 'Majuscules : %', min: 50, max: 100, unite: '%', lire: (c) => c.automod.majuscules.percent, ecrire: (c, v) => void (c.automod.majuscules.percent = v) },
      { genre: 'number', cle: 'capsmin', libelle: 'Majuscules : longueur min', min: 5, max: 200, lire: (c) => c.automod.majuscules.minLength, ecrire: (c, v) => void (c.automod.majuscules.minLength = v) },
    ],
  },
];

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'badword',
    domaine: 'sanction',
    categorie: 'salons',
    description: 'Mots interdits (seul : liste)',
    usage: '[mot|on|off]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const serveurId = message.guildId;
      const argument = parametres.join(' ').trim();
      const reglages = lireConfig(serveurId).automod.motsInterdits;
      const sujet = { titre: 'Mots interdits', sujet: emojiPour(serveurId, 'sanction') };
      if (!argument) {
        const texte = reglages.mots.length ? reglages.mots.map((w) => `\`${w}\``).join(' · ') : '*Aucun mot.*';
        await message.reply({ embeds: [info(message.guild, `Filtre : **${reglages.enabled ? 'actif' : 'coupé'}**\n\n${tronquer(texte, 3800)}`, sujet)], allowedMentions: { repliedUser: false } });
        return;
      }
      if (argument === 'on' || argument === 'off') {
        const initialise = argument === 'on' && reglages.mots.length === 0;
        modifierConfig(serveurId, (c) => {
          c.automod.motsInterdits.enabled = argument === 'on';
          if (initialise) c.automod.motsInterdits.mots = [...MOTS_DEFAUT];
        });
        await message.reply({ embeds: [ok(message.guild, `Filtre ${argument === 'on' ? 'activé' : 'coupé'}.${initialise ? `\n-# Liste de départ : ${MOTS_DEFAUT.length} mots.` : ''}`, sujet)], allowedMentions: { repliedUser: false } });
        return;
      }
      const mot = formeDeBase(argument);
      if (!mot) throw new Error('mot invalide');
      let ajoute = false;
      modifierConfig(serveurId, (c) => {
        const liste = c.automod.motsInterdits.mots;
        const indice = liste.indexOf(mot);
        if (indice === -1) {
          liste.push(mot);
          ajoute = true;
        } else liste.splice(indice, 1);
      });
      await message.delete().catch(() => undefined);
      await message.channel.send({ embeds: [ok(message.guild, `\`${mot}\` ${ajoute ? 'ajouté au' : 'retiré du'} filtre.`, sujet)] });
    },
  },
];

export const moduleAutomod: ModuleBot = {
  id: 'automod',
  nom: 'AutoMod',
  emoji: '🤖',
  description: 'Spam, flood, liens, invitations, mots interdits, mentions, majuscules',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: pages,
  commandesPrefixe,
  evenements: [sur('messageCreate', (m) => surMessage(m), 10), sur('messageUpdate', (_ancien, m) => (m.partial ? undefined : surMessage(m as Message)), 10)],
  tests: [
    {
      id: 'rules',
      libelle: 'État des filtres',
      emoji: '🤖',
      description: 'Les filtres actifs et l’action choisie',
      async executer(interaction) {
        const a = lireConfig(interaction.guildId).automod;
        const rangees: [string, boolean][] = [
          ['Spam', a.spam.enabled],
          ['Répétition', a.repetitions.enabled],
          ['Liens', a.liens.enabled],
          ['Invitations', a.invites.enabled],
          ['Mots interdits', a.motsInterdits.enabled],
          ['Mentions', a.mentions.enabled],
          ['Majuscules', a.majuscules.enabled],
        ];
        return `${rangees.map(([l, e]) => `${e ? '🟢' : '🔴'} ${l}`).join('\n')}\n\nAction : **${a.action}**`;
      },
    },
  ],
};
