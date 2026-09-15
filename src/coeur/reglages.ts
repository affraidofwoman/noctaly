import { executer, lire, lireTout } from './base';
import type { TypeJournal } from './journaux';
import { type ModuleBot } from './noyau';
import { environnement, type DomainePrefixe } from './outils';

export interface CouleursTheme {
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export type ThemeId = 'discord' | 'twitch' | 'gaming' | 'dark' | 'neon' | 'minimal' | 'custom';

export const THEMES: Record<Exclude<ThemeId, 'custom'>, { label: string; emoji: string; colors: CouleursTheme }> = {
  discord: {
    label: 'Discord',
    emoji: '💙',
    colors: { primary: '#5865F2', success: '#57F287', error: '#ED4245', warning: '#FEE75C', info: '#5865F2' },
  },
  twitch: {
    label: 'Twitch',
    emoji: '💜',
    colors: { primary: '#9146FF', success: '#00F593', error: '#EB0400', warning: '#FFCA5F', info: '#BF94FF' },
  },
  gaming: {
    label: 'Gaming',
    emoji: '🎮',
    colors: { primary: '#FF4655', success: '#3BD16F', error: '#FF1F3D', warning: '#FFB800', info: '#00B2FF' },
  },
  dark: {
    label: 'Dark',
    emoji: '🌑',
    colors: { primary: '#2B2D31', success: '#248046', error: '#A12D2F', warning: '#B5891B', info: '#4E5058' },
  },
  neon: {
    label: 'Neon',
    emoji: '🌈',
    colors: { primary: '#00FFF7', success: '#39FF14', error: '#FF073A', warning: '#FFF01F', info: '#BC13FE' },
  },
  minimal: {
    label: 'Minimal',
    emoji: '⚪',
    colors: { primary: '#E3E5E8', success: '#A3D9A5', error: '#E8A3A3', warning: '#E8D9A3', info: '#A3BFE8' },
  },
};

const HEXA = /^#?([0-9a-f]{6})$/i;

export function estCouleurHexa(valeur: string): boolean {
  return HEXA.test(valeur.trim());
}

export function normaliserHexa(valeur: string): string | null {
  const m = HEXA.exec(valeur.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

export function hexaEnEntier(valeur: string, secours = 0x5865f2): number {
  const m = HEXA.exec(valeur.trim());
  return m ? Number.parseInt(m[1]!, 16) : secours;
}

export type ActionAutomod = 'delete' | 'warn' | 'timeout';

export type StyleBoutonTicket = 'Primary' | 'Secondary' | 'Success' | 'Danger';

export interface MotifTicket {
  id: string;
  libelle: string;
  emoji: string;
  description: string;
  style: StyleBoutonTicket;
  roles: string[];
}

export interface ActionAutoAvertissement {
  avertissements: number;
  action: 'timeout' | 'kick' | 'ban';
  dureeMinutes: number;
}

export interface ConfigServeur {
  general: {
    fuseau: string;
    theme: ThemeId | 'brand';
    couleurs: CouleursTheme;
    pied: string;
    salonStaffId: string | null;
    rotationStatut: boolean;
  };
  prefixes: Record<DomainePrefixe, string>;
  commandes: {
    salonsAutorises: string[];
    effacerCommande: boolean;
  };
  permissions: {
    streamer: string[];
    admin: string[];
    moderateur: string[];
    staff: string[];
    support: string[];
    membre: string[];
  };
  bienvenue: {
    salonId: string | null;
    message: string;
    utiliserEmbed: boolean;
    titre: string;
    modeImage: 'none' | 'card' | 'url';
    urlImage: string;
    mpActif: boolean;
    messageMp: string;
    salonCompteurId: string | null;
    formatCompteur: string;
  };
  depart: {
    salonId: string | null;
    message: string;
    utiliserEmbed: boolean;
  };
  rolesAuto: {
    rolesMembres: string[];
    rolesBots: string[];
    delaiSecondes: number;
  };
  journaux: {
    salonSecoursId: string | null;
    salons: Partial<Record<TypeJournal, string>>;
    disabled: TypeJournal[];
    salonsIgnores: string[];
  };
  tickets: {
    salonPanneauId: string | null;
    categorieParenteId: string | null;
    rolesStaff: string[];
    ouvertsMaxParMembre: number;
    categories: MotifTicket[];
    titrePanneau: string;
    introPanneau: string;
    piedPanneau: string;
    stylePanneau: 'buttons' | 'v2' | 'menu';
    titreBienvenue: string;
    messageBienvenue: string;
    piedBienvenue: string;
    modeFermeture: 'delete' | 'archive';
    transcriptAuMembre: boolean;
    compteur: number;
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
    couleur: string;
  };
  musique: {
    rolesDj: string[];
    volumeParDefaut: number;
    fileMax: number;
    quitterSiVideMinutes: number;
    annoncerLecture: boolean;
  };
  moderation: {
    mpSanction: boolean;
    texteContact: string;
    actionsAuto: ActionAutoAvertissement[];
    minutesTimeoutDefaut: number;
    heuresEffaceesBan: number;
  };
  automod: {
    spam: { actif: boolean; messages: number; secondes: number };
    repetitions: { actif: boolean; nombre: number };
    liens: { actif: boolean; whitelist: string[] };
    invitations: { actif: boolean };
    motsInterdits: { actif: boolean; mots: string[] };
    mentions: { actif: boolean; max: number };
    majuscules: { actif: boolean; pourcentage: number; longueurMin: number };
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
    paliers: { jours: number; roleId: string }[];
    cumuler: boolean;
  };
  suggestions: {
    salonId: string | null;
    creerFil: boolean;
    compteur: number;
  };
  anniversaires: {
    salonId: string | null;
    roleId: string | null;
    message: string;
    heure: number;
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
    salonId: string | null;
    joursCompteFaux: number;
  };
  boosts: {
    salonId: string | null;
    message: string;
    roleBoosterId: string | null;
    recompenses: { nombre: number; roleId: string | null; badgeId: string | null; pieces: number }[];
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
    parMinuteVocal: number;
    parNiveau: number;
  };
  progression: {
    roleHommeId: string | null;
    roleFemmeId: string | null;
    prixCoffre: number;
    bonusBooster: number;
  };
  profils: {
    badgesAuto: boolean;
  };
  reglement: {
    salonId: string | null;
    titre: string;
    sections: { titre: string; contenu: string }[];
    roleAcceptationId: string | null;
    roleRetireId: string | null;
  };
  verification: {
    salonId: string | null;
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
    seuils: {
      channelDelete: number;
      channelCreate: number;
      roleDelete: number;
      roleCreate: number;
      bannir: number;
      expulser: number;
      creationWebhook: number;
    };
    action: 'alert' | 'strip' | 'kick' | 'ban';
    membresDeConfiance: string[];
  };
  signalements: {
    salonId: string | null;
    mode: 'channel' | 'ticket';
  };
  avis: {
    salonId: string | null;
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
      couleurs: { ...THEMES.twitch.colors },
      pied: '',
      salonStaffId: null,
      rotationStatut: true,
    },
    prefixes: { ...PREFIXES_DEFAUT },
    commandes: { salonsAutorises: [], effacerCommande: false },
    permissions: { streamer: [], admin: [], moderateur: [], staff: [], support: [], membre: [] },
    bienvenue: {
      salonId: null,
      message: 'Bienvenue {mention} sur le serveur !\n\nBon courage ! 🎉',
      utiliserEmbed: true,
      titre: '',
      modeImage: 'card',
      urlImage: '',
      mpActif: false,
      messageMp: 'Bienvenue sur **{server}**, {username} ! Pense à lire le règlement 📜',
      salonCompteurId: null,
      formatCompteur: '👥 Membres : {membercount}',
    },
    depart: {
      salonId: null,
      message: '👋 **{username}** a quitté le serveur.\nNous sommes maintenant **{membercount} membres**.',
      utiliserEmbed: true,
    },
    rolesAuto: { rolesMembres: [], rolesBots: [], delaiSecondes: 0 },
    journaux: { salonSecoursId: null, salons: {}, disabled: [], salonsIgnores: [] },
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
      compteur: 0,
    },
    tirages: { salonDefautId: null, roleMentionId: null, mpGagnants: true, journaliserParticipations: false },
    twitch: {
      salonDefautId: null,
      roleDefautId: null,
      messageLive: '🔴 **{streamer}** est en LIVE ! {role}',
      messageFin: '⚫ Le live de **{streamer}** est terminé. Merci à tous d\'être passés !',
      couleur: '#9146FF',
    },
    musique: { rolesDj: [], volumeParDefaut: 60, fileMax: 200, quitterSiVideMinutes: 2, annoncerLecture: true },
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
      spam: { actif: true, messages: 6, secondes: 5 },
      repetitions: { actif: true, nombre: 4 },
      liens: {
        actif: false,
        whitelist: ['youtube.com', 'youtu.be', 'twitch.tv', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'discord.com', 'tenor.com', 'giphy.com'],
      },
      invitations: { actif: true },
      motsInterdits: { actif: false, mots: [] },
      mentions: { actif: true, max: 6 },
      majuscules: { actif: false, pourcentage: 75, longueurMin: 12 },
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
    anciennete: { paliers: [], cumuler: false },
    suggestions: { salonId: null, creerFil: false, compteur: 0 },
    anniversaires: {
      salonId: null,
      roleId: null,
      message: '🎂 Joyeux anniversaire {mention} ! 🎉\n\nToute la communauté te souhaite une excellente journée !',
      heure: 9,
    },
    rappels: { maxParMembre: 25 },
    annonces: { salonDefautId: null },
    commandesPerso: { prefixe: '!' },
    invitations: { salonId: null, joursCompteFaux: 7 },
    boosts: {
      salonId: null,
      message: '🚀 Merci {mention} pour le boost ! Le serveur compte maintenant **{boosts} boosts** 💜',
      roleBoosterId: null,
      recompenses: [],
    },
    evenements: { salonDefautId: null, roleMentionId: null, rappelMinutes: 30 },
    jeux: { bouleMagique: true, pileOuFace: true, des: true, pierreFeuilleCiseaux: true },
    economie: {
      nomMonnaie: 'Gold',
      emojiMonnaie: '🪙',
      montantQuotidien: 100,
      bonusSerie: 10,
      parMessage: 2,
      delaiMessageSecondes: 60,
      parMinuteVocal: 0.5,
      parNiveau: 10,
    },
    progression: {
      roleHommeId: null,
      roleFemmeId: null,
      prixCoffre: 50,
      bonusBooster: 1.25,
    },
    profils: { badgesAuto: true },
    reglement: {
      salonId: null,
      titre: '📜 RÈGLEMENT',
      sections: [
        { titre: '🤝 Respect', contenu: 'Sois respectueux envers tous les membres. Aucune insulte, discrimination ou harcèlement.' },
        { titre: '💬 Salons', contenu: 'Utilise les salons pour leur usage prévu. Pas de spam ni de flood.' },
        { titre: '📢 Publicité', contenu: "La publicité non autorisée est interdite, y compris en message privé." },
        { titre: '🔞 Contenu', contenu: 'Aucun contenu NSFW, choquant ou illégal.' },
        { titre: '🛡️ Staff', contenu: "Les décisions du staff doivent être respectées. En cas de désaccord, ouvre un ticket." },
      ],
      roleAcceptationId: null,
      roleRetireId: null,
    },
    verification: {
      salonId: null,
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
      seuils: { channelDelete: 3, channelCreate: 8, roleDelete: 3, roleCreate: 8, bannir: 4, expulser: 5, creationWebhook: 4 },
      action: 'alert',
      membresDeConfiance: [],
    },
    signalements: { salonId: null, mode: 'channel' },
    avis: { salonId: null },
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

const modules = new Map<string, ModuleBot>();
const cacheModules = new Map<string, Map<string, boolean>>();

export function enregistrerModules(liste: ModuleBot[]): void {
  modules.clear();
  for (const m of liste) {
    if (modules.has(m.id)) throw new Error(`Module en double : ${m.id}`);
    modules.set(m.id, m);
  }
}

export function lireModules(): ModuleBot[] {
  return [...modules.values()];
}

export function lireModule(id: string): ModuleBot | undefined {
  return modules.get(id);
}

function etatsServeur(serveurId: string): Map<string, boolean> {
  let etats = cacheModules.get(serveurId);
  if (!etats) {
    etats = new Map();
    for (const rangee of lireTout<{ module: string; actif: number }>('SELECT module, actif FROM modules_serveurs WHERE serveur_id = ?', serveurId)) {
      etats.set(rangee.module, rangee.actif === 1);
    }
    cacheModules.set(serveurId, etats);
  }
  return etats;
}

export function moduleActif(serveurId: string | null | undefined, moduleId: string): boolean {
  const module = modules.get(moduleId);
  if (!module) return false;
  if (!module.desactivable) return true;
  if (!serveurId) return module.actifParDefaut;
  const etat = etatsServeur(serveurId).get(moduleId);
  return etat ?? module.actifParDefaut;
}

export function activerModule(serveurId: string, moduleId: string, actif: boolean): void {
  const module = modules.get(moduleId);
  if (!module) throw new Error(`Module inconnu : ${moduleId}`);
  if (!module.desactivable) return;
  executer(
    `INSERT INTO modules_serveurs (serveur_id, module, actif) VALUES (?, ?, ?)
     ON CONFLICT(serveur_id, module) DO UPDATE SET actif = excluded.actif`,
    serveurId,
    moduleId,
    actif ? 1 : 0,
  );
  etatsServeur(serveurId).set(moduleId, actif);
}

export function lireEtatsModules(serveurId: string): { module: ModuleBot; enabled: boolean }[] {
  return lireModules().map((module) => ({ module, enabled: moduleActif(serveurId, module.id) }));
}

export function viderCacheModules(serveurId?: string): void {
  if (serveurId) cacheModules.delete(serveurId);
  else cacheModules.clear();
}
