import type { ModuleBot } from '../coeur/noyau';
import { moduleAdministration } from './administration';
import { moduleAnniversaires, moduleEvenements, moduleRappels } from './agenda';
import { moduleBienvenue, moduleDeparts, moduleRolesAuto } from './arrivees';
import { moduleAutomod } from './automod';
import { moduleAfk, moduleInvitations, moduleReglement, moduleSignalements, moduleSondages, moduleSuggestions } from './communaute';
import { moduleBoosts, moduleEconomie, moduleQuetes } from './economie';
import { moduleGeneral } from './general';
import { moduleJeux } from './jeux';
import { moduleJournaux } from './journaux';
import { moduleAnnonces, moduleCommandesPerso, moduleRedaction, moduleReponsesAuto, moduleRolesAChoisir } from './messages';
import { moduleModeration } from './moderation';
import { moduleMusique } from './musique';
import { moduleAnciennete, moduleNiveaux, moduleProfils, moduleStatistiques } from './niveaux';
import { moduleConcours, moduleFormulaires } from './participations';
import { moduleSauvegardes } from './sauvegardes';
import { moduleAntinuke, moduleAntiraid, moduleVerification } from './securite';
import { moduleTickets } from './tickets';
import { moduleTirages } from './tirages';
import { moduleTwitch } from './twitch';

/**
 * REGISTRE DES MODULES
 * Pour supprimer un module : retirer sa ligne ici (et son dossier si souhaité).
 * Pour ajouter un module : créer src/modules/<nom>/index.ts puis l'ajouter à cette liste.
 * L'ordre influence l'affichage de /modules et de /setup.
 */
export const modules: ModuleBot[] = [
  // Cœur (toujours actifs)
  moduleGeneral,
  moduleAdministration,
  // Accueil
  moduleBienvenue,
  moduleDeparts,
  moduleRolesAuto,
  // Journalisation et modération
  moduleJournaux,
  moduleModeration,
  moduleAutomod,
  // Support et animation
  moduleTickets,
  moduleTirages,
  moduleTwitch,
  moduleMusique,
  // Communauté
  moduleNiveaux,
  moduleAnciennete,
  moduleSuggestions,
  moduleSondages,
  moduleRolesAChoisir,
  moduleAfk,
  moduleSignalements,
  moduleStatistiques,
  moduleProfils,
  // Agenda et publication
  moduleAnniversaires,
  moduleRappels,
  moduleEvenements,
  moduleAnnonces,
  moduleRedaction,
  moduleCommandesPerso,
  moduleReponsesAuto,
  // Engagement
  moduleInvitations,
  moduleBoosts,
  moduleEconomie,
  moduleQuetes,
  moduleJeux,
  moduleConcours,
  // Sécurité et accès
  moduleReglement,
  moduleVerification,
  moduleAntiraid,
  moduleAntinuke,
  moduleFormulaires,
  moduleSauvegardes,
];
