import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AnySelectMenuInteraction,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  type ClientEvents,
  Events,
  GatewayIntentBits,
  Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  Options,
  Partials,
  type RepliableInteraction,
  REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  Routes,
} from 'discord.js';
import { aAcces, estExempte, libelleNiveau, lireNiveau } from './acces';
import { erreur, refus, repondreEmbed, traiterErreurInteraction } from './affichage';
import type { PageReglage } from './assistant';
import { executer } from './base';
import { journal } from './journaux';
import {
  cleJour,
  creerRegistre,
  decrireErreurDiscord,
  Delais,
  environnement,
  ERREUR_GENERIQUE,
  ErreurUtilisateur,
  LimiteurFenetre, type CategorieAide, type DomainePrefixe, Niveau, simplifier } from './outils';
import { lireConfig, lireModule, moduleActif } from './reglages';

export interface DonneesCommande {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface CommandeSlash {
  donnees: DonneesCommande;
  categorie: CategorieAide;
  niveau?: Niveau;
  niveauxSousCommandes?: Record<string, Niveau>;
  whitelist?: string;
  delaiSecondes?: number;
  executer(interaction: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocompletion?(interaction: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

export interface CommandePrefixe {
  nom: string;
  alias?: string[];
  domaine: DomainePrefixe;
  categorie: CategorieAide;
  description: string;
  usage?: string;
  niveau?: Niveau;
  whitelist?: string;
  horsAide?: boolean;
  executer(message: Message<true>, parametres: string[]): Promise<unknown>;
}

export interface GestionnaireComposant {
  prefixe: string;
  niveau?: Niveau;
  whitelist?: string;
  bouton?(interaction: ButtonInteraction<'cached'>, parametres: string[]): Promise<unknown>;
  menu?(interaction: AnySelectMenuInteraction<'cached'>, parametres: string[]): Promise<unknown>;
  fenetre?(interaction: ModalSubmitInteraction<'cached'>, parametres: string[]): Promise<unknown>;
}

export type ResultatEvenement = void | 'stop';

export interface EvenementModuleUnique<K extends keyof ClientEvents> {
  evenement: K;
  priorite: number;
  executer(...parametres: ClientEvents[K]): unknown;
}

export type EvenementModule = { [K in keyof ClientEvents]: EvenementModuleUnique<K> }[keyof ClientEvents];

export function sur<K extends keyof ClientEvents>(
  evenement: K,
  executer: (...parametres: ClientEvents[K]) => unknown,
  priorite = 100,
): EvenementModule {
  return { event: evenement, run: executer, priority: priorite } as unknown as EvenementModule;
}

export interface TachePlanifiee {
  nom: string;
  intervalleMs: number;
  auDemarrage?: boolean;
  executer(client: Client<true>): Promise<void>;
}

export interface TestModule {
  id: string;
  libelle: string;
  emoji: string;
  description: string;
  executer(interaction: AnySelectMenuInteraction<'cached'>): Promise<string>;
}

// - Panneau posé par /affiche -
export interface PanneauAffiche {
  id: string;
  alias?: string[];
  nom: string;
  emoji: string;
  groupe: string;
  quoi: string;
  choix?(serveur: Guild): { label: string; value: string; description?: string }[];
  poser(salon: GuildTextBasedChannel, membre: GuildMember, valeur?: string): Promise<string>;
}

// - Le préfixe d’un panneau -
// `&tickets` pose le panneau dans le salon, comme le menu de /affiche.
export function prefixePanneau(panneau: PanneauAffiche, description: string): CommandePrefixe {
  return {
    nom: panneau.id,
    alias: panneau.alias,
    domaine: 'salon',
    categorie: 'panneaux',
    description,
    usage: panneau.choix ? '<lequel>' : undefined,
    niveau: Niveau.ADMIN,
    async executer(message, parametres) {
      const saisie = simplifier(parametres.join(' '));
      let valeur: string | undefined;
      if (panneau.choix) {
        const choix = panneau.choix(message.guild);
        if (!choix.length) throw new ErreurUtilisateur(`Rien à poser pour « ${panneau.nom} » pour l’instant.`);
        valeur = saisie ? choix.find((c) => simplifier(c.value) === saisie || simplifier(c.label).includes(saisie))?.value : undefined;
        if (!valeur) throw new ErreurUtilisateur(`Précise lequel : ${choix.slice(0, 15).map((c) => `\`${c.value}\` ${c.label}`).join(' · ')}`);
      }
      await panneau.poser(message.channel, message.member!, valeur);
      await message.delete().catch(() => undefined);
    },
  };
}

export interface ModuleBot {
  id: string;
  nom: string;
  emoji: string;
  description: string;
  desactivable: boolean;
  actifParDefaut: boolean;
  commandes?: CommandeSlash[];
  commandesPrefixe?: CommandePrefixe[];
  composants?: GestionnaireComposant[];
  evenements?: EvenementModule[];
  taches?: TachePlanifiee[];
  pagesReglage?: PageReglage[];
  panneaux?: PanneauAffiche[];
  tests?: TestModule[];
  auDemarrage?(client: Client<true>): Promise<void>;
  aLArret?(): Promise<void> | void;
}

export function creerClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,
      ReactionManager: 50,
      PresenceManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 1800, lifetime: 3600 },
    },
  });
}

const registreAiguilleur = creerRegistre('dispatcher');

export interface EntreeCommande {
  commande: CommandeSlash;
  module: ModuleBot;
}

export interface EntreePrefixe {
  commande: CommandePrefixe;
  module: ModuleBot;
}

interface EntreeComposant {
  gestionnaire: GestionnaireComposant;
  module: ModuleBot;
}

export type GestionnaireCommandeInconnue = (interaction: ChatInputCommandInteraction<'cached'>) => Promise<boolean>;
export type GestionnairePrefixeInconnu = (message: Message<true>, nom: string, parametres: string[]) => Promise<boolean>;

export function niveauRequis(commande: CommandeSlash, groupe: string | null, sousCommande: string | null): Niveau {
  if (commande.niveauxSousCommandes) {
    const cle = groupe && sousCommande ? `${groupe} ${sousCommande}` : sousCommande ?? '';
    const trouve = commande.niveauxSousCommandes[cle] ?? (groupe ? commande.niveauxSousCommandes[groupe] : undefined);
    if (trouve !== undefined) return trouve;
  }
  return commande.niveau ?? Niveau.MEMBRE;
}

export function resoudreServeurId(parametres: unknown[]): string | null {
  for (const argument of parametres) {
    if (!argument || typeof argument !== 'object') continue;
    if (argument instanceof Guild) return argument.id;
    const a = argument as { guild?: { id?: string } | null; guildId?: string | null; message?: { guildId?: string | null } };
    if (a.guild && typeof a.guild.id === 'string') return a.guild.id;
    if (typeof a.guildId === 'string') return a.guildId;
    if (a.message && typeof a.message.guildId === 'string') return a.message.guildId;
  }
  return null;
}

export function decouperArguments(saisie: string): string[] {
  const sortie: string[] = [];
  const expression = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = expression.exec(saisie)) !== null) sortie.push(m[1] ?? m[2] ?? m[3] ?? '');
  return sortie;
}

export function trouverPrefixe(contenu: string, prefixes: Record<DomainePrefixe, string>): { domain: DomainePrefixe; name: string; rest: string } | null {
  const candidats = (Object.entries(prefixes) as [DomainePrefixe, string][])
    .filter(([, p]) => p && contenu.toLowerCase().startsWith(p.toLowerCase()))
    .sort((a, b) => b[1].length - a[1].length);
  for (const [domaine, prefixe] of candidats) {
    const corps = contenu.slice(prefixe.length);
    const m = /^([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u.exec(corps);
    if (m) return { domain: domaine, name: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() };
  }
  return null;
}

export class Aiguilleur {
  readonly commandes = new Map<string, EntreeCommande>();
  readonly commandesPrefixe = new Map<string, EntreePrefixe>();
  private readonly composants = new Map<string, EntreeComposant>();
  private readonly evenements = new Map<keyof ClientEvents, { event: EvenementModule; module: ModuleBot }[]>();
  private readonly gestionnairesInconnus: GestionnaireCommandeInconnue[] = [];
  private readonly gestionnairesPrefixesInconnus: GestionnairePrefixeInconnu[] = [];
  private readonly limiteur = new LimiteurFenetre(10, 10_000);
  private readonly delais = new Delais();

  constructor(modules: ModuleBot[], composantsCoeur: GestionnaireComposant[] = []) {
    const coeur = modules.find((m) => !m.desactivable);
    if (!coeur) throw new Error('Aucun module cœur (toggleable: false) enregistré');
    for (const gestionnaire of composantsCoeur) this.ajouterComposant(gestionnaire, coeur);
    for (const module of modules) {
      for (const commande of module.commandes ?? []) {
        const nom = commande.donnees.name;
        if (this.commandes.has(nom)) throw new Error(`Commande en double : /${nom} (${module.id})`);
        this.commandes.set(nom, { commande, module });
      }
      for (const commande of module.commandesPrefixe ?? []) {
        for (const nom of [commande.nom, ...(commande.alias ?? [])]) {
          const cle = `${commande.domaine}:${nom.toLowerCase()}`;
          if (this.commandesPrefixe.has(cle)) throw new Error(`Commande à préfixe en double : ${cle} (${module.id})`);
          this.commandesPrefixe.set(cle, { commande, module });
        }
      }
      for (const gestionnaire of module.composants ?? []) this.ajouterComposant(gestionnaire, module);
      for (const evenement of module.evenements ?? []) this.ajouterEvenement(evenement, module);
    }
    this.ajouterEvenement({ evenement: 'messageCreate', priorite: 50, executer: (message: Message) => this.traiterPrefixe(message) } as EvenementModule, coeur);
    for (const liste of this.evenements.values()) liste.sort((a, b) => a.event.priorite - b.event.priorite);
  }

  private ajouterEvenement(evenement: EvenementModule, module: ModuleBot): void {
    const liste = this.evenements.get(evenement.evenement) ?? [];
    liste.push({ event: evenement, module });
    this.evenements.set(evenement.evenement, liste);
  }

  private ajouterComposant(gestionnaire: GestionnaireComposant, module: ModuleBot): void {
    if (gestionnaire.prefixe.includes(':')) throw new Error(`Préfixe invalide : ${gestionnaire.prefixe}`);
    if (this.composants.has(gestionnaire.prefixe)) throw new Error(`Préfixe de composant en double : ${gestionnaire.prefixe}`);
    this.composants.set(gestionnaire.prefixe, { gestionnaire, module });
  }

  surCommandeInconnue(gestionnaire: GestionnaireCommandeInconnue): void {
    this.gestionnairesInconnus.push(gestionnaire);
  }

  surPrefixeInconnu(gestionnaire: GestionnairePrefixeInconnu): void {
    this.gestionnairesPrefixesInconnus.push(gestionnaire);
  }

  brancher(client: Client): void {
    client.on(Events.InteractionCreate, (interaction) => {
      void this.traiterInteraction(interaction);
    });
    for (const [nomEvenement, gestionnaires] of this.evenements) {
      client.on(nomEvenement, (...parametres: unknown[]) => {
        void this.distribuerEvenement(nomEvenement, gestionnaires, parametres);
      });
    }
  }

  private async distribuerEvenement(nomEvenement: keyof ClientEvents, gestionnaires: { event: EvenementModule; module: ModuleBot }[], parametres: unknown[]): Promise<void> {
    const serveurId = resoudreServeurId(parametres);
    for (const { event: evenement, module } of gestionnaires) {
      if (serveurId && !moduleActif(serveurId, module.id)) continue;
      try {
        const resultat = await (evenement.executer as (...a: unknown[]) => unknown)(...parametres);
        if (resultat === 'stop') break;
      } catch (echec) {
        registreAiguilleur.erreur(`Erreur dans ${module.id} (${String(nomEvenement)})`, echec);
      }
    }
  }

  private async traiterInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) return await this.traiterCommande(interaction);
      if (interaction.isAutocomplete()) return await this.traiterAutocompletion(interaction);
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) return await this.traiterComposant(interaction);
    } catch (echec) {
      registreAiguilleur.erreur('Interaction non gérée', echec);
    }
  }

  private async traiterCommande(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await repondreEmbed(interaction, erreur(null, 'Les commandes de ce bot s’utilisent sur un serveur.'));
      return;
    }
    if (!this.limiteur.compter(interaction.user.id)) {
      await repondreEmbed(interaction, refus(interaction.guild, 'Doucement ! Réessaie dans quelques secondes.'));
      return;
    }

    const entree = this.commandes.get(interaction.commandName);
    if (!entree) {
      for (const gestionnaire of this.gestionnairesInconnus) {
        try {
          if (await gestionnaire(interaction)) return;
        } catch (echec) {
          await traiterErreurInteraction(interaction, echec, `/${interaction.commandName}`);
          return;
        }
      }
      await repondreEmbed(interaction, erreur(interaction.guild, 'Cette commande n’existe plus. Elle disparaîtra de la liste sous peu.'));
      return;
    }

    const { commande, module } = entree;
    if (!moduleActif(interaction.guildId, module.id)) {
      await repondreEmbed(interaction, refus(interaction.guild, `Le module **${module.emoji} ${module.nom}** est désactivé ici.\n-# Un admin peut l’activer dans /setup → Modules.`));
      return;
    }

    const groupe = interaction.options.getSubcommandGroup(false);
    const sousCommande = interaction.options.getSubcommand(false);
    const requis = niveauRequis(commande, groupe, sousCommande);
    if (requis > Niveau.MEMBRE && !aAcces(interaction.member, requis, commande.whitelist)) {
      if (requis === Niveau.PROPRIETAIRE_BOT) return void (await repondreEmbed(interaction, refus(interaction.guild, 'Commande indisponible.')));
      await repondreEmbed(interaction, refus(interaction.guild, `Cette commande ne t’est pas ouverte.\n-# Accès requis : **${libelleNiveau(requis)}**${commande.whitelist ? ` ou whitelist **${commande.whitelist}**` : ''}.`));
      return;
    }

    if (commande.delaiSecondes && lireNiveau(interaction.member) < Niveau.MODERATEUR) {
      const partis = this.delais.prendre(`${commande.donnees.name}:${interaction.user.id}`, commande.delaiSecondes * 1000);
      if (partis > 0) {
        await repondreEmbed(interaction, refus(interaction.guild, `Tu pourras la relancer dans **${Math.ceil(partis / 1000)} s**.`));
        return;
      }
    }

    try {
      compterCommande(interaction.guildId);
      await commande.executer(interaction);
      if (requis >= Niveau.STAFF) {
        void journal(interaction.guild, 'command', {
          titre: 'Commande utilisée',
          lignes: [`**/${[commande.donnees.name, groupe, sousCommande].filter(Boolean).join(' ')}** dans <#${interaction.channelId}>`],
          par: interaction.user,
        });
      }
    } catch (echec) {
      await traiterErreurInteraction(interaction, echec, `/${commande.donnees.name}${sousCommande ? ` ${sousCommande}` : ''}`);
    }
  }

  private async traiterAutocompletion(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    const entree = this.commandes.get(interaction.commandName);
    if (!entree?.commande.autocompletion || !moduleActif(interaction.guildId, entree.module.id)) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    try {
      await entree.commande.autocompletion(interaction);
    } catch (echec) {
      registreAiguilleur.avertir(`Autocomplete /${interaction.commandName} en échec`, echec);
      await interaction.respond([]).catch(() => undefined);
    }
  }

  private async traiterComposant(brut: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    const interaction = brut as RepliableInteraction & (MessageComponentInteraction | ModalSubmitInteraction);
    if (!interaction.inCachedGuild()) return;
    const [prefixe = '', ...parametres] = interaction.customId.split(':');
    const entree = this.composants.get(prefixe);
    if (!entree) {
      await repondreEmbed(interaction, erreur(interaction.guild, 'Ce bouton n’est plus actif. Relance la commande.'));
      return;
    }
    if (!this.limiteur.compter(interaction.user.id)) {
      await repondreEmbed(interaction, refus(interaction.guild, 'Doucement ! Réessaie dans quelques secondes.'));
      return;
    }
    const { gestionnaire, module } = entree;
    if (!moduleActif(interaction.guildId, module.id)) {
      await repondreEmbed(interaction, refus(interaction.guild, `Le module **${module.emoji} ${module.nom}** est désactivé ici.`));
      return;
    }
    const requis = gestionnaire.niveau ?? Niveau.MEMBRE;
    if (requis > Niveau.MEMBRE && !aAcces(interaction.member, requis, gestionnaire.whitelist)) {
      if (requis === Niveau.PROPRIETAIRE_BOT) return void (await repondreEmbed(interaction, refus(interaction.guild, 'Action indisponible.')));
      await repondreEmbed(interaction, refus(interaction.guild, `Cette action ne t’est pas ouverte.\n-# Accès requis : **${libelleNiveau(requis)}**.`));
      return;
    }
    try {
      if (interaction.isButton() && gestionnaire.bouton) await gestionnaire.bouton(interaction, parametres);
      else if (interaction.isAnySelectMenu() && gestionnaire.menu) await gestionnaire.menu(interaction, parametres);
      else if (interaction.isModalSubmit() && gestionnaire.fenetre) await gestionnaire.fenetre(interaction, parametres);
      else await repondreEmbed(interaction, erreur(interaction.guild, 'Ce bouton n’est plus actif.'));
    } catch (echec) {
      await traiterErreurInteraction(interaction, echec, `composant ${prefixe}`);
    }
  }

  private async traiterPrefixe(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || !message.content || !message.member) return;
    const reglages = lireConfig(message.guildId);
    const correspondance = trouverPrefixe(message.content, reglages.prefixes);
    if (!correspondance) return;

    const entree = this.commandesPrefixe.get(`${correspondance.domain}:${correspondance.name}`);
    const parametres = decouperArguments(correspondance.rest);
    if (!entree) {
      for (const gestionnaire of this.gestionnairesPrefixesInconnus) {
        try {
          if (await gestionnaire(message, correspondance.name, parametres)) return;
        } catch (echec) {
          registreAiguilleur.avertir('Commande personnalisée en échec', echec);
          return;
        }
      }
      return;
    }

    const { commande, module } = entree;
    if (!moduleActif(message.guildId, module.id)) return;
    const requis = commande.niveau ?? Niveau.MEMBRE;
    if (requis > Niveau.MEMBRE && !aAcces(message.member, requis, commande.whitelist)) {
      registreAiguilleur.debogage(`Accès refusé ${correspondance.domain}:${correspondance.name} pour ${message.author.tag}`);
      return;
    }
    if (reglages.commandes.salonsAutorises.length && !reglages.commandes.salonsAutorises.includes(message.channelId) && !estExempte(message.member)) {
      return;
    }
    if (!this.limiteur.compter(message.author.id)) return;

    try {
      compterCommande(message.guildId);
      await commande.executer(message, parametres);
      if (reglages.commandes.effacerCommande) await message.delete().catch(() => undefined);
      if (requis >= Niveau.STAFF) {
        void journal(message.guild, 'command', {
          titre: 'Commande utilisée',
          lignes: [`**${reglages.prefixes[correspondance.domain]}${correspondance.name}** ${tronquerArguments(correspondance.rest)} dans <#${message.channelId}>`],
          par: message.author,
        });
      }
    } catch (echec) {
      const texte = echec instanceof ErreurUtilisateur ? echec.message : decrireErreurDiscord(echec) ?? ERREUR_GENERIQUE;
      if (!(echec instanceof ErreurUtilisateur) && !decrireErreurDiscord(echec)) registreAiguilleur.erreur(`Préfixe ${correspondance.domain}:${correspondance.name}`, echec);
      await message.reply({ embeds: [erreur(message.guild, texte)], allowedMentions: { repliedUser: false } }).catch(() => undefined);
    }
  }
}

function tronquerArguments(valeur: string): string {
  return valeur.length > 120 ? `${valeur.slice(0, 119)}…` : valeur;
}

function compterCommande(serveurId: string): void {
  try {
    const jour = cleJour(Date.now(), lireConfig(serveurId).general.fuseau);
    executer(
      `INSERT INTO statistiques_jour (serveur_id, jour, commandes) VALUES (?, ?, 1)
       ON CONFLICT(serveur_id, jour) DO UPDATE SET commandes = commandes + 1`,
      serveurId,
      jour,
    );
  } catch {}
}

export function moduleDeCommande(aiguilleur: Aiguilleur, nom: string): ModuleBot | undefined {
  const entree = aiguilleur.commandes.get(nom);
  return entree ? lireModule(entree.module.id) : undefined;
}

interface EtatBot {
  client: Client<true> | null;
  aiguilleur: Aiguilleur | null;
  debutLe: number;
}

export const etatBot: EtatBot = {
  client: null,
  aiguilleur: null,
  debutLe: Date.now(),
};

export function lireClient(): Client<true> {
  if (!etatBot.client) throw new Error('Client Discord non prêt');
  return etatBot.client;
}

export function lireAiguilleur(): Aiguilleur {
  if (!etatBot.aiguilleur) throw new Error('Dispatcher non initialisé');
  return etatBot.aiguilleur;
}

const registre = creerRegistre('scheduler');

interface EtatTache {
  tache: TachePlanifiee;
  prochainPassage: number;
  enCours: boolean;
  echecs: number;
}

export class Planificateur {
  private readonly taches = new Map<string, EtatTache>();
  private minuteur: NodeJS.Timeout | null = null;

  constructor(private readonly battementMs = 5_000) {}

  ajouter(tache: TachePlanifiee): void {
    if (this.taches.has(tache.nom)) throw new Error(`Tâche en double : ${tache.nom}`);
    this.taches.set(tache.nom, {
      tache,
      prochainPassage: Date.now() + (tache.auDemarrage ? 3_000 : tache.intervalleMs),
      enCours: false,
      echecs: 0,
    });
  }

  demarrer(client: Client<true>): void {
    if (this.minuteur) return;
    this.minuteur = setInterval(() => this.battement(client), this.battementMs);
    this.minuteur.unref();
  }

  arreter(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
  }

  private battement(client: Client<true>): void {
    const maintenant = Date.now();
    for (const etat of this.taches.values()) {
      if (etat.enCours || etat.prochainPassage > maintenant) continue;
      etat.enCours = true;
      const commence = Date.now();
      etat.tache
        .executer(client)
        .then(() => {
          etat.echecs = 0;
          const ecoule = Date.now() - commence;
          if (ecoule > 10_000) registre.avertir(`Tâche lente « ${etat.tache.nom} » : ${ecoule} ms`);
        })
        .catch((echec: unknown) => {
          etat.echecs++;
          registre.erreur(`Tâche « ${etat.tache.nom} » en échec (${etat.echecs})`, echec);
        })
        .finally(() => {
          etat.enCours = false;
          const recul = Math.min(8, 2 ** Math.max(0, etat.echecs - 1));
          etat.prochainPassage = Date.now() + etat.tache.intervalleMs * (etat.echecs ? recul : 1);
        });
    }
  }
}

export const planificateur = new Planificateur();

const registreEnregistrement = creerRegistre('deploy');

export function construireCommandes(modules: ModuleBot[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const charge = modules.flatMap((m) => (m.commandes ?? []).map((c) => c.donnees.toJSON()));
  const noms = new Set<string>();
  for (const commande of charge) {
    if (noms.has(commande.name)) throw new Error(`Commande en double : /${commande.name}`);
    noms.add(commande.name);
  }
  if (charge.length > 100) throw new Error(`Trop de commandes (${charge.length}/100)`);
  return charge;
}

export async function enregistrerCommandes(modules: ModuleBot[], options: { force?: boolean } = {}): Promise<boolean> {
  const charge = construireCommandes(modules);
  const cible = environnement.serveurDevId ? `guild:${environnement.serveurDevId}` : 'global';
  const empreinte = createHash('sha256').update(cible).update(JSON.stringify(charge)).digest('hex');
  const fichierEmpreinte = path.join(path.dirname(environnement.cheminBase), '.commands-hash');

  if (!options.force) {
    try {
      if (fs.readFileSync(fichierEmpreinte, 'utf8').trim() === empreinte) {
        registreEnregistrement.info('Commandes déjà à jour, aucun envoi nécessaire.');
        return false;
      }
    } catch {}
  }

  const reste = new REST({ version: '10' }).setToken(environnement.jetonDiscord);
  const route = environnement.serveurDevId
    ? Routes.applicationGuildCommands(environnement.clientId, environnement.serveurDevId)
    : Routes.applicationCommands(environnement.clientId);
  await reste.put(route, { body: charge });
  fs.mkdirSync(path.dirname(fichierEmpreinte), { recursive: true });
  fs.writeFileSync(fichierEmpreinte, empreinte);
  registreEnregistrement.info(`${charge.length} commandes enregistrées (${cible}).`);
  return true;
}
