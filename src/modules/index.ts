import type { BotModule } from '../core/types';
import { afkModule } from './afk';
import { antinukeModule } from './antinuke';
import { antiraidModule } from './antiraid';
import { backupModule } from './backup';
import { formsModule } from './forms';
import { rulesModule } from './rules';
import { verificationModule } from './verification';
import { announcementsModule } from './announcements';
import { autoResponsesModule } from './autoresponses';
import { birthdaysModule } from './birthdays';
import { boostsModule } from './boosts';
import { contestsModule } from './contests';
import { economyModule } from './economy';
import { gamesModule } from './games';
import { invitesModule } from './invites';
import { questsModule } from './quests';
import { customCommandsModule } from './customcommands';
import { embedsModule } from './embeds';
import { eventsModule } from './events';
import { remindersModule } from './reminders';
import { automodModule } from './automod';
import { autoroleModule } from './autorole';
import { configModule } from './config';
import { generalModule } from './general';
import { giveawaysModule } from './giveaways';
import { leaveModule } from './leave';
import { logsModule } from './logs';
import { moderationModule } from './moderation';
import { musicModule } from './music';
import { pollsModule } from './polls';
import { profilesModule } from './profiles';
import { reactionRolesModule } from './reactionroles';
import { reportsModule } from './reports';
import { seniorityModule } from './seniority';
import { statsModule } from './stats';
import { suggestionsModule } from './suggestions';
import { ticketsModule } from './tickets';
import { twitchModule } from './twitch';
import { welcomeModule } from './welcome';
import { xpModule } from './xp';

/**
 * REGISTRE DES MODULES
 * Pour supprimer un module : retirer sa ligne ici (et son dossier si souhaité).
 * Pour ajouter un module : créer src/modules/<nom>/index.ts puis l'ajouter à cette liste.
 * L'ordre influence l'affichage de /modules et de /setup.
 */
export const modules: BotModule[] = [
  // Cœur (toujours actifs)
  generalModule,
  configModule,
  // Accueil
  welcomeModule,
  leaveModule,
  autoroleModule,
  // Journalisation et modération
  logsModule,
  moderationModule,
  automodModule,
  // Support et animation
  ticketsModule,
  giveawaysModule,
  twitchModule,
  musicModule,
  // Communauté
  xpModule,
  seniorityModule,
  suggestionsModule,
  pollsModule,
  reactionRolesModule,
  afkModule,
  reportsModule,
  statsModule,
  profilesModule,
  // Agenda et publication
  birthdaysModule,
  remindersModule,
  eventsModule,
  announcementsModule,
  embedsModule,
  customCommandsModule,
  autoResponsesModule,
  // Engagement
  invitesModule,
  boostsModule,
  economyModule,
  questsModule,
  gamesModule,
  contestsModule,
  // Sécurité et accès
  rulesModule,
  verificationModule,
  antiraidModule,
  antinukeModule,
  formsModule,
  backupModule,
];
