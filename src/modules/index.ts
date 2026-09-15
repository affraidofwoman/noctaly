import type { ModuleBot } from '../core/types';
import { moduleAfk } from './afk';
import { moduleAntinuke } from './antinuke';
import { moduleAntiraid } from './antiraid';
import { moduleSauvegardes } from './backup';
import { moduleFormulaires } from './forms';
import { moduleReglement } from './rules';
import { moduleVerification } from './verification';
import { moduleAnnonces } from './announcements';
import { moduleReponsesAuto } from './autoresponses';
import { moduleAnniversaires } from './birthdays';
import { moduleBoosts } from './boosts';
import { moduleConcours } from './contests';
import { moduleEconomie } from './economy';
import { moduleJeux } from './games';
import { moduleInvitations } from './invites';
import { moduleQuetes } from './quests';
import { moduleCommandesPerso } from './customcommands';
import { moduleRedaction } from './embeds';
import { moduleEvenements } from './events';
import { moduleRappels } from './reminders';
import { moduleAutomod } from './automod';
import { moduleRolesAuto } from './autorole';
import { moduleAdministration } from './config';
import { moduleGeneral } from './general';
import { moduleTirages } from './giveaways';
import { moduleDeparts } from './leave';
import { moduleJournaux } from './logs';
import { moduleModeration } from './moderation';
import { moduleMusique } from './music';
import { moduleSondages } from './polls';
import { moduleProfils } from './profiles';
import { moduleRolesAChoisir } from './reactionroles';
import { moduleSignalements } from './reports';
import { moduleAnciennete } from './seniority';
import { moduleStatistiques } from './stats';
import { moduleSuggestions } from './suggestions';
import { moduleTickets } from './tickets';
import { moduleTwitch } from './twitch';
import { moduleBienvenue } from './welcome';
import { moduleNiveaux } from './xp';

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
