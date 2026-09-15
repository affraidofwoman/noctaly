import {
  Events,
  Guild,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ClientEvents,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { executer } from '../database/db';
import { erreur, refus } from './embeds';
import { decrireErreurDiscord, ERREUR_GENERIQUE, ErreurUtilisateur } from './errors';
import { lireConfig } from './guildConfig';
import { traiterErreurInteraction, repondreEmbed } from './interactions';
import { journal } from './logService';
import { creerRegistre } from './logger';
import { lireModule, moduleActif } from './moduleManager';
import { lireNiveau, aAcces, estExempte, libelleNiveau } from './permissions';
import { Delais, LimiteurFenetre } from './rateLimit';
import { cleJour } from './time';
import {
  Niveau,
  type EvenementModule,
  type ModuleBot,
  type GestionnaireComposant,
  type CommandePrefixe,
  type DomainePrefixe,
  type CommandeSlash,
} from './types';

const registre = creerRegistre('dispatcher');

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

/** Commandes inconnues (ex : commandes personnalisées) : un module peut les prendre en charge. */
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

/** Retrouve le serveur concerné par les arguments d'un événement Discord. */
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

/** Découpe les arguments en respectant les guillemets : `a "b c" d` → [a, b c, d]. */
export function decouperArguments(saisie: string): string[] {
  const sortie: string[] = [];
  const expression = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = expression.exec(saisie)) !== null) sortie.push(m[1] ?? m[2] ?? m[3] ?? '');
  return sortie;
}

/** Trouve le domaine et la commande visés par un message, selon les préfixes du serveur. */
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
      for (const evt of module.evenements ?? []) this.ajouterEvenement(evt, module);
    }
    // Les commandes à préfixe passent après l'automod (priorité 10) et avant le reste.
    this.ajouterEvenement({ evenement: 'messageCreate', priorite: 50, executer: (message: Message) => this.traiterPrefixe(message) } as EvenementModule, coeur);
    for (const liste of this.evenements.values()) liste.sort((a, b) => a.event.priorite - b.event.priorite);
  }

  private ajouterEvenement(evt: EvenementModule, module: ModuleBot): void {
    const liste = this.evenements.get(evt.evenement) ?? [];
    liste.push({ event: evt, module });
    this.evenements.set(evt.evenement, liste);
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
        // Isolation : une erreur d'un module n'empêche jamais les autres de s'exécuter.
        registre.erreur(`Erreur dans ${module.id} (${String(nomEvenement)})`, echec);
      }
    }
  }

  private async traiterInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) return await this.traiterCommande(interaction);
      if (interaction.isAutocomplete()) return await this.traiterAutocompletion(interaction);
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) return await this.traiterComposant(interaction);
    } catch (echec) {
      registre.erreur('Interaction non gérée', echec);
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
      await repondreEmbed(interaction, refus(interaction.guild, `Le module **${module.emoji} ${module.nom}** est désactivé ici.\n-# Un admin peut l’activer avec /modules.`));
      return;
    }

    const groupe = interaction.options.getSubcommandGroup(false);
    const sousCommande = interaction.options.getSubcommand(false);
    const requis = niveauRequis(commande, groupe, sousCommande);
    if (requis > Niveau.MEMBRE && !aAcces(interaction.member, requis, commande.whitelist)) {
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
      registre.avertir(`Autocomplete /${interaction.commandName} en échec`, echec);
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

  /** Commandes à préfixe : + sanctions, & salons, = général, . owner, m! musique (préfixes réglables par serveur). */
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
          registre.avertir('Commande personnalisée en échec', echec);
          return;
        }
      }
      return;
    }

    const { commande, module } = entree;
    if (!moduleActif(message.guildId, module.id)) return;
    const requis = commande.niveau ?? Niveau.MEMBRE;
    if (requis > Niveau.MEMBRE && !aAcces(message.member, requis, commande.whitelist)) {
      // Comme sur Airline : un accès refusé ne répond rien en public, il est seulement tracé.
      registre.debogage(`Accès refusé ${correspondance.domain}:${correspondance.name} pour ${message.author.tag}`);
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
      if (!(echec instanceof ErreurUtilisateur) && !decrireErreurDiscord(echec)) registre.erreur(`Préfixe ${correspondance.domain}:${correspondance.name}`, echec);
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
  } catch {
    /* statistique non critique */
  }
}

export function moduleDeCommande(aiguilleur: Aiguilleur, nom: string): ModuleBot | undefined {
  const entree = aiguilleur.commandes.get(nom);
  return entree ? lireModule(entree.module.id) : undefined;
}
