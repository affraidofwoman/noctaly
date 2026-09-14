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
import { run } from '../database/db';
import { erreur, refus } from './embeds';
import { describeDiscordError, GENERIC_ERROR, UserError } from './errors';
import { getConfig } from './guildConfig';
import { handleInteractionError, replyEmbed } from './interactions';
import { journal } from './logService';
import { createLogger } from './logger';
import { getModule, isModuleEnabled } from './moduleManager';
import { getLevel, hasAccess, isBypassed, levelLabel } from './permissions';
import { Cooldowns, SlidingWindowLimiter } from './rateLimit';
import { dayKey } from './time';
import {
  PermLevel,
  type AnyModuleEvent,
  type BotModule,
  type ComponentHandler,
  type PrefixCommand,
  type PrefixDomain,
  type SlashCommand,
} from './types';

const log = createLogger('dispatcher');

export interface CommandEntry {
  command: SlashCommand;
  module: BotModule;
}

export interface PrefixEntry {
  command: PrefixCommand;
  module: BotModule;
}

interface ComponentEntry {
  handler: ComponentHandler;
  module: BotModule;
}

/** Commandes inconnues (ex : commandes personnalisées) : un module peut les prendre en charge. */
export type UnknownCommandHandler = (interaction: ChatInputCommandInteraction<'cached'>) => Promise<boolean>;
export type UnknownPrefixHandler = (message: Message<true>, name: string, args: string[]) => Promise<boolean>;

export function requiredLevel(command: SlashCommand, group: string | null, sub: string | null): PermLevel {
  if (command.subLevels) {
    const key = group && sub ? `${group} ${sub}` : sub ?? '';
    const found = command.subLevels[key] ?? (group ? command.subLevels[group] : undefined);
    if (found !== undefined) return found;
  }
  return command.level ?? PermLevel.MEMBER;
}

/** Retrouve le serveur concerné par les arguments d'un événement Discord. */
export function resolveGuildId(args: unknown[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    if (arg instanceof Guild) return arg.id;
    const a = arg as { guild?: { id?: string } | null; guildId?: string | null; message?: { guildId?: string | null } };
    if (a.guild && typeof a.guild.id === 'string') return a.guild.id;
    if (typeof a.guildId === 'string') return a.guildId;
    if (a.message && typeof a.message.guildId === 'string') return a.message.guildId;
  }
  return null;
}

/** Découpe les arguments en respectant les guillemets : `a "b c" d` → [a, b c, d]. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Trouve le domaine et la commande visés par un message, selon les préfixes du serveur. */
export function matchPrefix(content: string, prefixes: Record<PrefixDomain, string>): { domain: PrefixDomain; name: string; rest: string } | null {
  const candidates = (Object.entries(prefixes) as [PrefixDomain, string][])
    .filter(([, p]) => p && content.toLowerCase().startsWith(p.toLowerCase()))
    .sort((a, b) => b[1].length - a[1].length);
  for (const [domain, prefix] of candidates) {
    const body = content.slice(prefix.length);
    const m = /^([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u.exec(body);
    if (m) return { domain, name: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() };
  }
  return null;
}

export class Dispatcher {
  readonly commands = new Map<string, CommandEntry>();
  readonly prefixCommands = new Map<string, PrefixEntry>();
  private readonly components = new Map<string, ComponentEntry>();
  private readonly events = new Map<keyof ClientEvents, { event: AnyModuleEvent; module: BotModule }[]>();
  private readonly unknownHandlers: UnknownCommandHandler[] = [];
  private readonly unknownPrefixHandlers: UnknownPrefixHandler[] = [];
  private readonly limiter = new SlidingWindowLimiter(10, 10_000);
  private readonly cooldowns = new Cooldowns();

  constructor(modules: BotModule[], coreComponents: ComponentHandler[] = []) {
    const core = modules.find((m) => !m.toggleable);
    if (!core) throw new Error('Aucun module cœur (toggleable: false) enregistré');
    for (const handler of coreComponents) this.addComponent(handler, core);
    for (const mod of modules) {
      for (const command of mod.commands ?? []) {
        const name = command.data.name;
        if (this.commands.has(name)) throw new Error(`Commande en double : /${name} (${mod.id})`);
        this.commands.set(name, { command, module: mod });
      }
      for (const command of mod.prefixCommands ?? []) {
        for (const name of [command.name, ...(command.aliases ?? [])]) {
          const key = `${command.domain}:${name.toLowerCase()}`;
          if (this.prefixCommands.has(key)) throw new Error(`Commande à préfixe en double : ${key} (${mod.id})`);
          this.prefixCommands.set(key, { command, module: mod });
        }
      }
      for (const handler of mod.components ?? []) this.addComponent(handler, mod);
      for (const ev of mod.events ?? []) this.addEvent(ev, mod);
    }
    // Les commandes à préfixe passent après l'automod (priorité 10) et avant le reste.
    this.addEvent({ event: 'messageCreate', priority: 50, run: (message: Message) => this.handlePrefix(message) } as AnyModuleEvent, core);
    for (const list of this.events.values()) list.sort((a, b) => a.event.priority - b.event.priority);
  }

  private addEvent(ev: AnyModuleEvent, mod: BotModule): void {
    const list = this.events.get(ev.event) ?? [];
    list.push({ event: ev, module: mod });
    this.events.set(ev.event, list);
  }

  private addComponent(handler: ComponentHandler, mod: BotModule): void {
    if (handler.prefix.includes(':')) throw new Error(`Préfixe invalide : ${handler.prefix}`);
    if (this.components.has(handler.prefix)) throw new Error(`Préfixe de composant en double : ${handler.prefix}`);
    this.components.set(handler.prefix, { handler, module: mod });
  }

  onUnknownCommand(handler: UnknownCommandHandler): void {
    this.unknownHandlers.push(handler);
  }

  onUnknownPrefix(handler: UnknownPrefixHandler): void {
    this.unknownPrefixHandlers.push(handler);
  }

  attach(client: Client): void {
    client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });
    for (const [eventName, handlers] of this.events) {
      client.on(eventName, (...args: unknown[]) => {
        void this.dispatchEvent(eventName, handlers, args);
      });
    }
  }

  private async dispatchEvent(eventName: keyof ClientEvents, handlers: { event: AnyModuleEvent; module: BotModule }[], args: unknown[]): Promise<void> {
    const guildId = resolveGuildId(args);
    for (const { event, module } of handlers) {
      if (guildId && !isModuleEnabled(guildId, module.id)) continue;
      try {
        const result = await (event.run as (...a: unknown[]) => unknown)(...args);
        if (result === 'stop') break;
      } catch (err) {
        // Isolation : une erreur d'un module n'empêche jamais les autres de s'exécuter.
        log.error(`Erreur dans ${module.id} (${String(eventName)})`, err);
      }
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) return await this.handleCommand(interaction);
      if (interaction.isAutocomplete()) return await this.handleAutocomplete(interaction);
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) return await this.handleComponent(interaction);
    } catch (err) {
      log.error('Interaction non gérée', err);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await replyEmbed(interaction, erreur(null, 'Les commandes de ce bot s’utilisent sur un serveur.'));
      return;
    }
    if (!this.limiter.hit(interaction.user.id)) {
      await replyEmbed(interaction, refus(interaction.guild, 'Doucement ! Réessaie dans quelques secondes.'));
      return;
    }

    const entry = this.commands.get(interaction.commandName);
    if (!entry) {
      for (const handler of this.unknownHandlers) {
        try {
          if (await handler(interaction)) return;
        } catch (err) {
          await handleInteractionError(interaction, err, `/${interaction.commandName}`);
          return;
        }
      }
      await replyEmbed(interaction, erreur(interaction.guild, 'Cette commande n’existe plus. Elle disparaîtra de la liste sous peu.'));
      return;
    }

    const { command, module } = entry;
    if (!isModuleEnabled(interaction.guildId, module.id)) {
      await replyEmbed(interaction, refus(interaction.guild, `Le module **${module.emoji} ${module.name}** est désactivé ici.\n-# Un admin peut l’activer avec /modules.`));
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const needed = requiredLevel(command, group, sub);
    if (needed > PermLevel.MEMBER && !hasAccess(interaction.member, needed, command.whitelist)) {
      await replyEmbed(interaction, refus(interaction.guild, `Cette commande ne t’est pas ouverte.\n-# Accès requis : **${levelLabel(needed)}**${command.whitelist ? ` ou whitelist **${command.whitelist}**` : ''}.`));
      return;
    }

    if (command.cooldownSeconds && getLevel(interaction.member) < PermLevel.MODERATOR) {
      const left = this.cooldowns.take(`${command.data.name}:${interaction.user.id}`, command.cooldownSeconds * 1000);
      if (left > 0) {
        await replyEmbed(interaction, refus(interaction.guild, `Tu pourras la relancer dans **${Math.ceil(left / 1000)} s**.`));
        return;
      }
    }

    try {
      bumpCommandStat(interaction.guildId);
      await command.execute(interaction);
      if (needed >= PermLevel.STAFF) {
        void journal(interaction.guild, 'command', {
          title: 'Commande utilisée',
          lines: [`**/${[command.data.name, group, sub].filter(Boolean).join(' ')}** dans <#${interaction.channelId}>`],
          by: interaction.user,
        });
      }
    } catch (err) {
      await handleInteractionError(interaction, err, `/${command.data.name}${sub ? ` ${sub}` : ''}`);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    const entry = this.commands.get(interaction.commandName);
    if (!entry?.command.autocomplete || !isModuleEnabled(interaction.guildId, entry.module.id)) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    try {
      await entry.command.autocomplete(interaction);
    } catch (err) {
      log.warn(`Autocomplete /${interaction.commandName} en échec`, err);
      await interaction.respond([]).catch(() => undefined);
    }
  }

  private async handleComponent(raw: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    const interaction = raw as RepliableInteraction & (MessageComponentInteraction | ModalSubmitInteraction);
    if (!interaction.inCachedGuild()) return;
    const [prefix = '', ...args] = interaction.customId.split(':');
    const entry = this.components.get(prefix);
    if (!entry) {
      await replyEmbed(interaction, erreur(interaction.guild, 'Ce bouton n’est plus actif. Relance la commande.'));
      return;
    }
    if (!this.limiter.hit(interaction.user.id)) {
      await replyEmbed(interaction, refus(interaction.guild, 'Doucement ! Réessaie dans quelques secondes.'));
      return;
    }
    const { handler, module } = entry;
    if (!isModuleEnabled(interaction.guildId, module.id)) {
      await replyEmbed(interaction, refus(interaction.guild, `Le module **${module.emoji} ${module.name}** est désactivé ici.`));
      return;
    }
    const needed = handler.level ?? PermLevel.MEMBER;
    if (needed > PermLevel.MEMBER && !hasAccess(interaction.member, needed, handler.whitelist)) {
      await replyEmbed(interaction, refus(interaction.guild, `Cette action ne t’est pas ouverte.\n-# Accès requis : **${levelLabel(needed)}**.`));
      return;
    }
    try {
      if (interaction.isButton() && handler.button) await handler.button(interaction, args);
      else if (interaction.isAnySelectMenu() && handler.select) await handler.select(interaction, args);
      else if (interaction.isModalSubmit() && handler.modal) await handler.modal(interaction, args);
      else await replyEmbed(interaction, erreur(interaction.guild, 'Ce bouton n’est plus actif.'));
    } catch (err) {
      await handleInteractionError(interaction, err, `composant ${prefix}`);
    }
  }

  /** Commandes à préfixe : + sanctions, & salons, = général, . owner, m! musique (préfixes réglables par serveur). */
  private async handlePrefix(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || !message.content || !message.member) return;
    const cfg = getConfig(message.guildId);
    const match = matchPrefix(message.content, cfg.prefixes);
    if (!match) return;

    const entry = this.prefixCommands.get(`${match.domain}:${match.name}`);
    const args = splitArgs(match.rest);
    if (!entry) {
      for (const handler of this.unknownPrefixHandlers) {
        try {
          if (await handler(message, match.name, args)) return;
        } catch (err) {
          log.warn('Commande personnalisée en échec', err);
          return;
        }
      }
      return;
    }

    const { command, module } = entry;
    if (!isModuleEnabled(message.guildId, module.id)) return;
    const needed = command.level ?? PermLevel.MEMBER;
    if (needed > PermLevel.MEMBER && !hasAccess(message.member, needed, command.whitelist)) {
      // Comme sur Airline : un accès refusé ne répond rien en public, il est seulement tracé.
      log.debug(`Accès refusé ${match.domain}:${match.name} pour ${message.author.tag}`);
      return;
    }
    if (cfg.commands.allowedChannels.length && !cfg.commands.allowedChannels.includes(message.channelId) && !isBypassed(message.member)) {
      return;
    }
    if (!this.limiter.hit(message.author.id)) return;

    try {
      bumpCommandStat(message.guildId);
      await command.execute(message, args);
      if (cfg.commands.deleteTrigger) await message.delete().catch(() => undefined);
      if (needed >= PermLevel.STAFF) {
        void journal(message.guild, 'command', {
          title: 'Commande utilisée',
          lines: [`**${cfg.prefixes[match.domain]}${match.name}** ${truncateArgs(match.rest)} dans <#${message.channelId}>`],
          by: message.author,
        });
      }
    } catch (err) {
      const text = err instanceof UserError ? err.message : describeDiscordError(err) ?? GENERIC_ERROR;
      if (!(err instanceof UserError) && !describeDiscordError(err)) log.error(`Préfixe ${match.domain}:${match.name}`, err);
      await message.reply({ embeds: [erreur(message.guild, text)], allowedMentions: { repliedUser: false } }).catch(() => undefined);
    }
  }
}

function truncateArgs(value: string): string {
  return value.length > 120 ? `${value.slice(0, 119)}…` : value;
}

function bumpCommandStat(guildId: string): void {
  try {
    const day = dayKey(Date.now(), getConfig(guildId).general.timezone);
    run(
      `INSERT INTO stats_daily (guild_id, day, commands) VALUES (?, ?, 1)
       ON CONFLICT(guild_id, day) DO UPDATE SET commands = commands + 1`,
      guildId,
      day,
    );
  } catch {
    /* statistique non critique */
  }
}

export function moduleOfCommand(dispatcher: Dispatcher, name: string): BotModule | undefined {
  const entry = dispatcher.commands.get(name);
  return entry ? getModule(entry.module.id) : undefined;
}
