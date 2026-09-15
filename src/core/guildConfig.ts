import { lire, executer } from '../database/db';
import { environnement } from './env';
import type { TypeJournal } from './logService';
import { THEMES, type CouleursTheme, type ThemeId } from './themes';
import type { DomainePrefixe } from './types';

export type ActionAutomod = 'delete' | 'warn' | 'timeout';

export type StyleBoutonTicket = 'Primary' | 'Secondary' | 'Success' | 'Danger';

export interface MotifTicket {
  /** Identifiant stable, aussi utilisé comme préfixe du salon (ex : support-pseudo). */
  id: string;
  libelle: string;
  emoji: string;
  description: string;
  style: StyleBoutonTicket;
  /** Rôles qui voient ce type de ticket et sont mentionnés à l'ouverture. */
  roles: string[];
}

export interface ActionAutoAvertissement {
  avertissements: number;
  action: 'timeout' | 'kick' | 'ban';
  dureeMinutes: number;
}

export interface DefinitionQuete {
  id: string;
  libelle: string;
  type: 'messages' | 'voice_minutes' | 'giveaways' | 'daily';
  cible: number;
  recompenseXp: number;
  recompensePieces: number;
}

export interface ConfigServeur {
  general: {
    fuseau: string;
    /** "brand" = couleurs de l'enseigne du streamer. */
    theme: ThemeId | 'brand';
    colors: CouleursTheme;
    footer: string;
    salonStaffId: string | null;
    rotationStatut: boolean;
  };
  prefixes: Record<DomainePrefixe, string>;
  commandes: {
    /** Salons où les commandes à préfixe marchent (vide = partout). */
    salonsAutorises: string[];
    /** Supprimer le message de commande après exécution. */
    effacerCommande: boolean;
  };
  permissions: {
    streamer: string[];
    admin: string[];
    moderateur: string[];
    staff: string[];
    support: string[];
    member: string[];
  };
  bienvenue: {
    channelId: string | null;
    message: string;
    utiliserEmbed: boolean;
    title: string;
    modeImage: 'none' | 'card' | 'url';
    urlImage: string;
    mpActif: boolean;
    messageMp: string;
    salonCompteurId: string | null;
    formatCompteur: string;
  };
  depart: {
    channelId: string | null;
    message: string;
    utiliserEmbed: boolean;
  };
  rolesAuto: {
    rolesMembres: string[];
    rolesBots: string[];
    delaiSecondes: number;
  };
  journaux: {
    /** Salon utilisé pour les types sans salon dédié. */
    salonSecoursId: string | null;
    channels: Partial<Record<TypeJournal, string>>;
    disabled: TypeJournal[];
    salonsIgnores: string[];
  };
  tickets: {
    salonPanneauId: string | null;
    categorieParenteId: string | null;
    /** Rôles qui voient tous les tickets (en plus des rôles par catégorie). */
    rolesStaff: string[];
    ouvertsMaxParMembre: number;
    categories: MotifTicket[];
    titrePanneau: string;
    introPanneau: string;
    piedPanneau: string;
    /** buttons = un bouton par motif (Airline v1) ; v2 = sections avec bouton ; menu = un bouton puis « Quel est le sujet ? ». */
    stylePanneau: 'buttons' | 'v2' | 'menu';
    titreBienvenue: string;
    messageBienvenue: string;
    piedBienvenue: string;
    /** delete = transcript puis suppression (comme Airline) ; archive = salon verrouillé, suppression manuelle. */
    modeFermeture: 'delete' | 'archive';
    transcriptAuMembre: boolean;
    counter: number;
  };
  tirages: {
    salonDefautId: string | null;
    roleMentionId: string | null;
    mpGagnants: boolean;
    journaliserParticipations: boolean;
  };
  twitch: {
    salonDefautId: string | null;
    roleDefautId: string | null;
    messageLive: string;
    messageFin: string;
    color: string;
  };
  musique: {
    rolesDj: string[];
    volumeParDefaut: number;
    maxQueue: number;
    quitterSiVideMinutes: number;
    annoncerLecture: boolean;
  };
  moderation: {
    mpSanction: boolean;
    /** Phrase ajoutée aux messages privés de sanction (comment contester). */
    texteContact: string;
    actionsAuto: ActionAutoAvertissement[];
    minutesTimeoutDefaut: number;
    /** Supprimer les messages des dernières X heures lors d'un ban (0 à 168). */
    heuresEffaceesBan: number;
  };
  automod: {
    spam: { enabled: boolean; messages: number; seconds: number };
    repetitions: { enabled: boolean; count: number };
    liens: { enabled: boolean; whitelist: string[] };
    invites: { enabled: boolean };
    motsInterdits: { enabled: boolean; mots: string[] };
    mentions: { enabled: boolean; max: number };
    majuscules: { enabled: boolean; percent: number; minLength: number };
    action: ActionAutomod;
    minutesTimeout: number;
    ignorerStaff: boolean;
    membresExemptes: string[];
    rolesExemptes: string[];
    salonsExemptes: string[];
  };
  xp: {
    min: number;
    max: number;
    delaiSecondes: number;
    xpVocalParMinute: number;
    annonce: 'off' | 'same' | 'channel' | 'dm';
    salonAnnonceId: string | null;
    messageNiveau: string;
    salonsSansXp: string[];
    rolesSansXp: string[];
    cumulerRoles: boolean;
  };
  anciennete: {
    paliers: { days: number; roleId: string }[];
    stack: boolean;
  };
  suggestions: {
    channelId: string | null;
    creerFil: boolean;
    counter: number;
  };
  anniversaires: {
    channelId: string | null;
    roleId: string | null;
    message: string;
    hour: number;
  };
  rappels: {
    maxParMembre: number;
  };
  annonces: {
    salonDefautId: string | null;
  };
  commandesPerso: {
    prefixe: string;
  };
  invitations: {
    channelId: string | null;
    joursCompteFaux: number;
  };
  boosts: {
    channelId: string | null;
    message: string;
    roleBoosterId: string | null;
    recompenses: { count: number; roleId: string | null; badgeId: string | null; pieces: number }[];
  };
  evenements: {
    salonDefautId: string | null;
    roleMentionId: string | null;
    rappelMinutes: number;
  };
  jeux: {
    bouleMagique: boolean;
    pileOuFace: boolean;
    des: boolean;
    pierreFeuilleCiseaux: boolean;
  };
  economie: {
    nomMonnaie: string;
    emojiMonnaie: string;
    montantQuotidien: number;
    bonusSerie: number;
    parMessage: number;
    delaiMessageSecondes: number;
  };
  quetes: {
    list: DefinitionQuete[];
    paliersSerie: { days: number; pieces: number; xp: number }[];
    annonce: boolean;
  };
  profils: {
    badgesAuto: boolean;
  };
  reglement: {
    channelId: string | null;
    title: string;
    sections: { title: string; content: string }[];
    roleAcceptationId: string | null;
    roleRetireId: string | null;
  };
  verification: {
    channelId: string | null;
    roleVerifieId: string | null;
    roleNonVerifieId: string | null;
    method: 'button' | 'captcha';
    ageCompteMinJours: number;
  };
  antiraid: {
    seuilArrivees: number;
    fenetreArriveesSecondes: number;
    ageCompteMinJours: number;
    actionSuspects: 'none' | 'timeout' | 'kick';
    verrouillageAuto: boolean;
    seuilMentions: number;
    salonAlerteId: string | null;
  };
  antinuke: {
    fenetreSecondes: number;
    thresholds: {
      channelDelete: number;
      channelCreate: number;
      roleDelete: number;
      roleCreate: number;
      ban: number;
      kick: number;
      creationWebhook: number;
    };
    action: 'alert' | 'strip' | 'kick' | 'ban';
    membresDeConfiance: string[];
  };
  signalements: {
    channelId: string | null;
    mode: 'channel' | 'ticket';
  };
  avis: {
    channelId: string | null;
  };
  formulaires: {
    salonPartenariatsId: string | null;
    salonCandidaturesId: string | null;
  };
  statistiques: {
    suivreVocal: boolean;
  };
  concours: {
    salonDefautId: string | null;
  };
  assistant: {
    termineLe: number | null;
  };
}

export const MOTIFS_TICKETS_DEFAUT: MotifTicket[] = [
  { id: 'support', libelle: 'Support', emoji: '🎫', description: 'Une question ou un souci ? On t’aide.', style: 'Primary', roles: [] },
  { id: 'sanction', libelle: 'Sanction', emoji: '🛡️', description: 'Sanctionné et tu penses que c’est injuste ? Explique-toi ici.', style: 'Danger', roles: [] },
  { id: 'partenariat', libelle: 'Partenariat', emoji: '🤝', description: 'Proposer un partenariat ou une collaboration.', style: 'Success', roles: [] },
  { id: 'giveaway', libelle: 'Giveaway', emoji: '🎁', description: 'Réclamer un gain de giveaway.', style: 'Success', roles: [] },
  { id: 'autre', libelle: 'Autre', emoji: '📢', description: 'Tout le reste. Si tu hésites, prends celui-là.', style: 'Secondary', roles: [] },
];

export const PREFIXES_DEFAUT: Record<DomainePrefixe, string> = {
  sanction: '+',
  salon: '&',
  general: '=',
  owner: '.',
  music: 'm!',
};

export function configParDefaut(): ConfigServeur {
  return {
    general: {
      fuseau: environnement.fuseauParDefaut,
      theme: 'brand',
      colors: { ...THEMES.twitch.colors },
      footer: '',
      salonStaffId: null,
      rotationStatut: true,
    },
    prefixes: { ...PREFIXES_DEFAUT },
    commandes: { salonsAutorises: [], effacerCommande: false },
    permissions: { streamer: [], admin: [], moderateur: [], staff: [], support: [], member: [] },
    bienvenue: {
      channelId: null,
      message: '🎉 Bienvenue {mention} !\n\nTu es maintenant membre de **{server}**.\n\nNous sommes désormais **{membercount} membres** !',
      utiliserEmbed: true,
      title: '👋 BIENVENUE',
      modeImage: 'card',
      urlImage: '',
      mpActif: false,
      messageMp: 'Bienvenue sur **{server}**, {username} ! Pense à lire le règlement 📜',
      salonCompteurId: null,
      formatCompteur: '👥 Membres : {membercount}',
    },
    depart: {
      channelId: null,
      message: '👋 **{username}** a quitté le serveur.\nNous sommes maintenant **{membercount} membres**.',
      utiliserEmbed: true,
    },
    rolesAuto: { rolesMembres: [], rolesBots: [], delaiSecondes: 0 },
    journaux: { salonSecoursId: null, channels: {}, disabled: [], salonsIgnores: [] },
    tickets: {
      salonPanneauId: null,
      categorieParenteId: null,
      rolesStaff: [],
      ouvertsMaxParMembre: 2,
      categories: MOTIFS_TICKETS_DEFAUT.map((c) => ({ ...c, roles: [] })),
      titrePanneau: '🎫 Support {brand}',
      introPanneau: 'Une question, un souci, une demande ? Choisis le motif, on prend le relais.',
      piedPanneau: 'Support • {brand} • un ticket par demande',
      stylePanneau: 'buttons',
      titreBienvenue: '🎫 Ticket ouvert',
      messageBienvenue: 'Bienvenue {mention}.\n\nExplique ta demande ici, le plus clairement possible — ça nous fait gagner du temps à tous les deux.\nLe staff te répond dès qu’il passe.',
      piedBienvenue: 'Ferme le ticket une fois réglé — tu recevras la conversation en MP.',
      modeFermeture: 'delete',
      transcriptAuMembre: true,
      counter: 0,
    },
    tirages: { salonDefautId: null, roleMentionId: null, mpGagnants: true, journaliserParticipations: false },
    twitch: {
      salonDefautId: null,
      roleDefautId: null,
      messageLive: '🔴 **{streamer}** est en LIVE ! {role}',
      messageFin: '⚫ Le live de **{streamer}** est terminé. Merci à tous d\'être passés !',
      color: '#9146FF',
    },
    musique: { rolesDj: [], volumeParDefaut: 60, maxQueue: 200, quitterSiVideMinutes: 2, annoncerLecture: true },
    moderation: {
      mpSanction: true,
      texteContact: 'Si tu souhaites discuter de ta sanction, ouvre un ticket sur le serveur.',
      heuresEffaceesBan: 0,
      actionsAuto: [
        { avertissements: 3, action: 'timeout', dureeMinutes: 60 },
        { avertissements: 5, action: 'kick', dureeMinutes: 0 },
        { avertissements: 7, action: 'ban', dureeMinutes: 0 },
      ],
      minutesTimeoutDefaut: 10,
    },
    automod: {
      spam: { enabled: true, messages: 6, seconds: 5 },
      repetitions: { enabled: true, count: 4 },
      liens: {
        enabled: false,
        whitelist: ['youtube.com', 'youtu.be', 'twitch.tv', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'discord.com', 'tenor.com', 'giphy.com'],
      },
      invites: { enabled: true },
      motsInterdits: { enabled: false, mots: [] },
      mentions: { enabled: true, max: 6 },
      majuscules: { enabled: false, percent: 75, minLength: 12 },
      action: 'delete',
      minutesTimeout: 5,
      ignorerStaff: true,
      membresExemptes: [],
      rolesExemptes: [],
      salonsExemptes: [],
    },
    xp: {
      min: 15,
      max: 25,
      delaiSecondes: 60,
      xpVocalParMinute: 2,
      annonce: 'same',
      salonAnnonceId: null,
      messageNiveau: '🎉 Bravo {mention}, tu passes **niveau {level}** !',
      salonsSansXp: [],
      rolesSansXp: [],
      cumulerRoles: true,
    },
    anciennete: { paliers: [], stack: false },
    suggestions: { channelId: null, creerFil: false, counter: 0 },
    anniversaires: {
      channelId: null,
      roleId: null,
      message: '🎂 Joyeux anniversaire {mention} ! 🎉\n\nToute la communauté te souhaite une excellente journée !',
      hour: 9,
    },
    rappels: { maxParMembre: 25 },
    annonces: { salonDefautId: null },
    commandesPerso: { prefixe: '!' },
    invitations: { channelId: null, joursCompteFaux: 7 },
    boosts: {
      channelId: null,
      message: '🚀 Merci {mention} pour le boost ! Le serveur compte maintenant **{boosts} boosts** 💜',
      roleBoosterId: null,
      recompenses: [],
    },
    evenements: { salonDefautId: null, roleMentionId: null, rappelMinutes: 30 },
    jeux: { bouleMagique: true, pileOuFace: true, des: true, pierreFeuilleCiseaux: true },
    economie: {
      nomMonnaie: 'Coins',
      emojiMonnaie: '💰',
      montantQuotidien: 100,
      bonusSerie: 10,
      parMessage: 1,
      delaiMessageSecondes: 60,
    },
    quetes: {
      list: [
        { id: 'messages20', libelle: 'Envoyer 20 messages', type: 'messages', cible: 20, recompenseXp: 100, recompensePieces: 50 },
        { id: 'voice30', libelle: 'Passer 30 minutes en vocal', type: 'voice_minutes', cible: 30, recompenseXp: 150, recompensePieces: 50 },
        { id: 'daily', libelle: 'Récupérer ta récompense /daily', type: 'daily', cible: 1, recompenseXp: 50, recompensePieces: 0 },
      ],
      paliersSerie: [
        { days: 7, pieces: 200, xp: 200 },
        { days: 30, pieces: 1000, xp: 1000 },
      ],
      annonce: true,
    },
    profils: { badgesAuto: true },
    reglement: {
      channelId: null,
      title: '📜 RÈGLEMENT',
      sections: [
        { title: '🤝 Respect', content: 'Sois respectueux envers tous les membres. Aucune insulte, discrimination ou harcèlement.' },
        { title: '💬 Salons', content: 'Utilise les salons pour leur usage prévu. Pas de spam ni de flood.' },
        { title: '📢 Publicité', content: "La publicité non autorisée est interdite, y compris en message privé." },
        { title: '🔞 Contenu', content: 'Aucun contenu NSFW, choquant ou illégal.' },
        { title: '🛡️ Staff', content: "Les décisions du staff doivent être respectées. En cas de désaccord, ouvre un ticket." },
      ],
      roleAcceptationId: null,
      roleRetireId: null,
    },
    verification: {
      channelId: null,
      roleVerifieId: null,
      roleNonVerifieId: null,
      method: 'button',
      ageCompteMinJours: 0,
    },
    antiraid: {
      seuilArrivees: 10,
      fenetreArriveesSecondes: 15,
      ageCompteMinJours: 3,
      actionSuspects: 'none',
      verrouillageAuto: false,
      seuilMentions: 15,
      salonAlerteId: null,
    },
    antinuke: {
      fenetreSecondes: 30,
      thresholds: { channelDelete: 3, channelCreate: 8, roleDelete: 3, roleCreate: 8, ban: 4, kick: 5, creationWebhook: 4 },
      action: 'alert',
      membresDeConfiance: [],
    },
    signalements: { channelId: null, mode: 'channel' },
    avis: { channelId: null },
    formulaires: { salonPartenariatsId: null, salonCandidaturesId: null },
    statistiques: { suivreVocal: true },
    concours: { salonDefautId: null },
    assistant: { termineLe: null },
  };
}

type Simple = Record<string, unknown>;

function estObjetSimple(v: unknown): v is Simple {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fusion profonde : les objets sont fusionnés, les tableaux et scalaires stockés remplacent les défauts. */
export function fusionProfonde<T>(defauts: T, stocke: unknown): T {
  if (!estObjetSimple(defauts) || !estObjetSimple(stocke)) {
    if (stocke === undefined) return defauts;
    if (Array.isArray(defauts)) return (Array.isArray(stocke) ? stocke : defauts) as T;
    if (defauts !== null && stocke !== null && typeof defauts !== typeof stocke) return defauts;
    return stocke as T;
  }
  const sortie: Simple = { ...defauts };
  for (const [cle, valeur] of Object.entries(stocke)) {
    if (!(cle in defauts)) {
      // Clés libres (ex : overrides de logs) : on garde les objets ouverts
      if (Object.keys(defauts).length === 0) sortie[cle] = valeur;
      continue;
    }
    sortie[cle] = fusionProfonde((defauts as Simple)[cle], valeur);
  }
  return sortie as T;
}

const cache = new Map<string, ConfigServeur>();

export function lireConfig(serveurId: string): ConfigServeur {
  const enCache = cache.get(serveurId);
  if (enCache) return enCache;
  const rangee = lire<{ donnees: string }>('SELECT donnees FROM reglages_serveurs WHERE serveur_id = ?', serveurId);
  let stocke: unknown = {};
  if (rangee) {
    try {
      stocke = JSON.parse(rangee.donnees);
    } catch {
      stocke = {};
    }
  }
  const config = fusionProfonde(configParDefaut(), stocke);
  cache.set(serveurId, config);
  return config;
}

/** Modifie la configuration d'un serveur via une fonction et la persiste. */
export function modifierConfig(serveurId: string, modifier: (config: ConfigServeur) => void): ConfigServeur {
  const brouillon = structuredClone(lireConfig(serveurId));
  modifier(brouillon);
  enregistrerConfig(serveurId, brouillon);
  return brouillon;
}

export function enregistrerConfig(serveurId: string, config: ConfigServeur): void {
  const normalise = fusionProfonde(configParDefaut(), config);
  executer(
    `INSERT INTO reglages_serveurs (serveur_id, donnees, modifie_le) VALUES (?, ?, ?)
     ON CONFLICT(serveur_id) DO UPDATE SET donnees = excluded.donnees, modifie_le = excluded.modifie_le`,
    serveurId,
    JSON.stringify(normalise),
    Date.now(),
  );
  cache.set(serveurId, normalise);
}

export function viderCacheConfig(serveurId?: string): void {
  if (serveurId) cache.delete(serveurId);
  else cache.clear();
}
