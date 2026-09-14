import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonBuilder,
  type ButtonInteraction,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { brandEmbed } from './embeds';
import { getConfig, updateConfig, type GuildConfig } from './guildConfig';
import { getModule, isModuleEnabled, setModuleEnabled } from './moduleManager';
import { canBotManageRole } from './permissions';
import { truncate } from './text';
import { button, buildModal, row, type ModalField } from './ui';
import { UserError } from './errors';

export type SetupSectionId =
  | 'welcome'
  | 'logs'
  | 'tickets'
  | 'giveaways'
  | 'twitch'
  | 'moderation'
  | 'music'
  | 'roles'
  | 'community'
  | 'security'
  | 'appearance';

export const SETUP_SECTIONS: Record<SetupSectionId, { label: string; emoji: string }> = {
  welcome: { label: 'Bienvenue', emoji: '👋' },
  logs: { label: 'Logs', emoji: '📜' },
  tickets: { label: 'Tickets', emoji: '🎫' },
  giveaways: { label: 'Giveaways', emoji: '🎉' },
  twitch: { label: 'Twitch', emoji: '🔴' },
  moderation: { label: 'Modération', emoji: '🛡️' },
  music: { label: 'Musique', emoji: '🎵' },
  roles: { label: 'Rôles', emoji: '🎭' },
  community: { label: 'Communauté', emoji: '💡' },
  security: { label: 'Sécurité & accès', emoji: '🔐' },
  appearance: { label: 'Apparence', emoji: '🎨' },
};

interface BaseField {
  key: string;
  label: string;
  help?: string;
}

export type SetupField =
  | (BaseField & {
      kind: 'channel';
      channelTypes?: ChannelType[];
      get(c: GuildConfig): string | null;
      set(c: GuildConfig, v: string | null): void;
    })
  | (BaseField & {
      kind: 'channels';
      channelTypes?: ChannelType[];
      max?: number;
      get(c: GuildConfig): string[];
      set(c: GuildConfig, v: string[]): void;
    })
  | (BaseField & { kind: 'role'; assignable?: boolean; get(c: GuildConfig): string | null; set(c: GuildConfig, v: string | null): void })
  | (BaseField & {
      kind: 'roles';
      assignable?: boolean;
      max?: number;
      get(c: GuildConfig): string[];
      set(c: GuildConfig, v: string[]): void;
    })
  | (BaseField & { kind: 'toggle'; get(c: GuildConfig): boolean; set(c: GuildConfig, v: boolean): void })
  | (BaseField & {
      kind: 'text';
      long?: boolean;
      maxLength?: number;
      required?: boolean;
      get(c: GuildConfig): string;
      set(c: GuildConfig, v: string): void;
      validate?(v: string): string | null;
    })
  | (BaseField & {
      kind: 'number';
      min: number;
      max: number;
      unit?: string;
      get(c: GuildConfig): number;
      set(c: GuildConfig, v: number): void;
    })
  | (BaseField & {
      kind: 'choice';
      options: { value: string; label: string; emoji?: string }[];
      get(c: GuildConfig): string;
      set(c: GuildConfig, v: string): void;
    })
  | (BaseField & {
      kind: 'multichoice';
      options: { value: string; label: string; emoji?: string }[];
      get(c: GuildConfig): string[];
      set(c: GuildConfig, v: string[]): void;
    });

export interface SetupAction {
  id: string;
  label: string;
  emoji: string;
  style?: ButtonStyle;
  run(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

export interface SetupPage {
  id: string;
  section: SetupSectionId;
  title: string;
  emoji: string;
  description: string;
  /** Module dont l'activation est proposée sur la page. */
  moduleId?: string;
  fields: SetupField[];
  actions?: SetupAction[];
  order?: number;
}

const pages = new Map<string, SetupPage>();

export function registerSetupPages(list: SetupPage[]): void {
  for (const page of list) {
    if (pages.has(page.id)) throw new Error(`Page de configuration en double : ${page.id}`);
    validatePageLayout(page);
    pages.set(page.id, page);
  }
}

export function clearSetupPages(): void {
  pages.clear();
}

export function getSetupPage(id: string): SetupPage | undefined {
  return pages.get(id);
}

export function pagesForSection(section: SetupSectionId): SetupPage[] {
  return [...pages.values()].filter((p) => p.section === section).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

const SELECT_KINDS = new Set(['channel', 'channels', 'role', 'roles', 'choice', 'multichoice']);

/** Vérifie qu'une page tient dans les 5 rangées de composants autorisées par Discord. */
export function validatePageLayout(page: SetupPage): void {
  const selects = page.fields.filter((f) => SELECT_KINDS.has(f.kind)).length;
  const toggles = page.fields.filter((f) => f.kind === 'toggle').length;
  const texts = page.fields.filter((f) => f.kind === 'text' || f.kind === 'number').length;
  if (texts > 5) throw new Error(`Page ${page.id} : 5 champs texte maximum`);
  const controls = (page.moduleId ? 1 : 0) + (texts ? 1 : 0) + (page.actions?.length ?? 0) + 1;
  const rows = selects + Math.ceil(toggles / 5) + Math.ceil(controls / 5);
  if (rows > 5) throw new Error(`Page ${page.id} : trop de composants (${rows} rangées)`);
}

function displayValue(guild: Guild, field: SetupField, cfg: GuildConfig): string {
  const none = '*non défini*';
  switch (field.kind) {
    case 'channel': {
      const v = field.get(cfg);
      return v ? `<#${v}>` : none;
    }
    case 'channels': {
      const v = field.get(cfg);
      return v.length ? v.map((id) => `<#${id}>`).join(' ') : none;
    }
    case 'role': {
      const v = field.get(cfg);
      if (!v) return none;
      const role = guild.roles.cache.get(v);
      const warn = field.assignable && role && !canBotManageRole(guild, role) ? ' ⚠️ *rôle au-dessus du bot*' : '';
      return `<@&${v}>${warn}`;
    }
    case 'roles': {
      const v = field.get(cfg);
      if (!v.length) return none;
      const blocked = field.assignable
        ? v.filter((id) => {
            const r = guild.roles.cache.get(id);
            return r && !canBotManageRole(guild, r);
          })
        : [];
      return v.map((id) => `<@&${id}>`).join(' ') + (blocked.length ? `\n⚠️ ${blocked.length} rôle(s) au-dessus du bot` : '');
    }
    case 'toggle':
      return field.get(cfg) ? '🟢 Activé' : '🔴 Désactivé';
    case 'text': {
      const v = field.get(cfg);
      return v ? `>>> ${truncate(v, 180)}` : none;
    }
    case 'number':
      return `\`${field.get(cfg)}\`${field.unit ? ` ${field.unit}` : ''}`;
    case 'choice': {
      const v = field.get(cfg);
      const opt = field.options.find((o) => o.value === v);
      return opt ? `${opt.emoji ?? ''} ${opt.label}`.trim() : none;
    }
    case 'multichoice': {
      const v = field.get(cfg);
      return field.options
        .filter((o) => v.includes(o.value))
        .map((o) => `${o.emoji ?? ''} ${o.label}`.trim())
        .join(', ') || none;
    }
  }
}

export function renderHome(guild: Guild) {
  const cfg = getConfig(guild.id);
  const embed = brandEmbed(guild)
    .setTitle('🤖 CONFIGURATION DU SERVEUR')
    .setDescription(
      [
        "Bienvenue dans l'assistant !",
        '',
        'Nous allons configurer votre serveur **étape par étape**.',
        'Chaque section est indépendante : configure uniquement ce dont tu as besoin.',
        '',
        '💡 *Astuce : `/quicksetup` crée automatiquement les salons de base.*',
        cfg.setup.completedAt ? `\n✅ Dernière configuration terminée <t:${Math.floor(cfg.setup.completedAt / 1000)}:R>.` : '',
      ].join('\n'),
    );
  const sectionButtons = (Object.keys(SETUP_SECTIONS) as SetupSectionId[])
    .filter((s) => pagesForSection(s).length > 0)
    .map((s) => button(`setup:sec:${s}`, SETUP_SECTIONS[s].label, ButtonStyle.Secondary, SETUP_SECTIONS[s].emoji));
  sectionButtons.push(button('setup:done', 'Terminer', ButtonStyle.Success, '✅'));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < sectionButtons.length && rows.length < 5; i += 4) rows.push(row(...sectionButtons.slice(i, i + 4)));
  return { embeds: [embed], components: rows };
}

export function renderSection(guild: Guild, section: SetupSectionId) {
  const list = pagesForSection(section);
  if (list.length === 1) return renderPage(guild, list[0]!);
  const info = SETUP_SECTIONS[section];
  const embed = brandEmbed(guild)
    .setTitle(`${info.emoji} ${info.label.toUpperCase()}`)
    .setDescription(
      list
        .map((p) => {
          const status = p.moduleId ? (isModuleEnabled(guild.id, p.moduleId) ? '🟢' : '🔴') : '⚙️';
          return `${status} ${p.emoji} **${p.title}**\n-# ${p.description}`;
        })
        .join('\n'),
    );
  const buttons = list.map((p) => button(`setup:page:${p.id}`, p.title, ButtonStyle.Primary, p.emoji));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 4; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  rows.push(row(button('setup:home', 'Retour', ButtonStyle.Secondary, '⬅️')));
  return { embeds: [embed], components: rows };
}

export function renderPage(guild: Guild, page: SetupPage, notice?: string) {
  const cfg = getConfig(guild.id);
  const embed = brandEmbed(guild).setTitle(`${page.emoji} ${page.title.toUpperCase()}`);
  const lines = [page.description];
  if (page.moduleId) {
    const mod = getModule(page.moduleId);
    lines.push('', `**Module ${mod?.name ?? page.moduleId} :** ${isModuleEnabled(guild.id, page.moduleId) ? '🟢 Activé' : '🔴 Désactivé'}`);
  }
  if (notice) lines.push('', notice);
  embed.setDescription(lines.join('\n'));
  for (const field of page.fields.slice(0, 25)) {
    embed.addFields({
      name: field.label,
      value: truncate(`${displayValue(guild, field, cfg)}${field.help ? `\n-# ${field.help}` : ''}`, 1024),
      inline: field.kind === 'toggle' || field.kind === 'number',
    });
  }

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (const field of page.fields) {
    const id = `setup:sel:${page.id}:${field.key}`;
    const placeholder = `${field.label}`.slice(0, 100);
    if (field.kind === 'channel' || field.kind === 'channels') {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(placeholder)
        .setMinValues(0)
        .setMaxValues(field.kind === 'channel' ? 1 : Math.min(field.max ?? 25, 25))
        .setChannelTypes(...(field.channelTypes ?? [ChannelType.GuildText, ChannelType.GuildAnnouncement]));
      const current = field.kind === 'channel' ? [field.get(cfg)].filter((v): v is string => !!v) : field.get(cfg);
      const valid = current.filter((c) => guild.channels.cache.has(c)).slice(0, 25);
      if (valid.length) menu.setDefaultChannels(...valid);
      rows.push(row(menu));
    } else if (field.kind === 'role' || field.kind === 'roles') {
      const menu = new RoleSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(placeholder)
        .setMinValues(0)
        .setMaxValues(field.kind === 'role' ? 1 : Math.min(field.max ?? 25, 25));
      const current = field.kind === 'role' ? [field.get(cfg)].filter((v): v is string => !!v) : field.get(cfg);
      const valid = current.filter((r) => guild.roles.cache.has(r)).slice(0, 25);
      if (valid.length) menu.setDefaultRoles(...valid);
      rows.push(row(menu));
    } else if (field.kind === 'choice' || field.kind === 'multichoice') {
      const current = field.kind === 'choice' ? [field.get(cfg)] : field.get(cfg);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(placeholder)
        .setMinValues(field.kind === 'choice' ? 1 : 0)
        .setMaxValues(field.kind === 'choice' ? 1 : field.options.length)
        .addOptions(
          field.options.slice(0, 25).map((o) => ({
            label: o.label,
            value: o.value,
            emoji: o.emoji,
            default: current.includes(o.value),
          })),
        );
      rows.push(row(menu));
    }
  }

  const toggles = page.fields.filter((f) => f.kind === 'toggle');
  for (let i = 0; i < toggles.length; i += 5) {
    rows.push(
      row(
        ...toggles.slice(i, i + 5).map((f) => {
          const on = f.kind === 'toggle' && f.get(cfg);
          return button(`setup:tog:${page.id}:${f.key}`, f.label, on ? ButtonStyle.Success : ButtonStyle.Secondary, on ? '🟢' : '🔴');
        }),
      ),
    );
  }

  const controls: ButtonBuilder[] = [];
  if (page.moduleId) {
    const on = isModuleEnabled(guild.id, page.moduleId);
    controls.push(button(`setup:mod:${page.id}`, on ? 'Désactiver le module' : 'Activer le module', on ? ButtonStyle.Danger : ButtonStyle.Success, on ? '⏸️' : '▶️'));
  }
  if (page.fields.some((f) => f.kind === 'text' || f.kind === 'number')) {
    controls.push(button(`setup:txt:${page.id}`, 'Modifier les textes', ButtonStyle.Primary, '📝'));
  }
  for (const action of page.actions ?? []) {
    controls.push(button(`setup:act:${page.id}:${action.id}`, action.label, action.style ?? ButtonStyle.Primary, action.emoji));
  }
  const multi = pagesForSection(page.section).length > 1;
  controls.push(button(multi ? `setup:sec:${page.section}` : 'setup:home', 'Retour', ButtonStyle.Secondary, '⬅️'));
  for (let i = 0; i < controls.length; i += 5) rows.push(row(...controls.slice(i, i + 5)));

  return { embeds: [embed], components: rows.slice(0, 5) };
}

function findField(page: SetupPage, key: string | undefined): SetupField {
  const field = page.fields.find((f) => f.key === key);
  if (!field) throw new UserError('Ce paramètre est introuvable. Relance `/setup`.');
  return field;
}

function requirePage(id: string | undefined): SetupPage {
  const page = id ? pages.get(id) : undefined;
  if (!page) throw new UserError("Cette page de configuration n'existe plus. Relance `/setup`.");
  return page;
}

export async function handleSetupButton(interaction: ButtonInteraction<'cached'>, args: string[]): Promise<void> {
  const [action, pageId, key] = args;
  const guild = interaction.guild;
  switch (action) {
    case 'home':
      await interaction.update(renderHome(guild));
      return;
    case 'sec':
      await interaction.update(renderSection(guild, pageId as SetupSectionId));
      return;
    case 'page':
      await interaction.update(renderPage(guild, requirePage(pageId)));
      return;
    case 'done': {
      updateConfig(guild.id, (c) => {
        c.setup.completedAt = Date.now();
      });
      const embed = brandEmbed(guild, 'success')
        .setTitle('✅ CONFIGURATION TERMINÉE')
        .setDescription('Votre serveur est prêt ! 🎉\n\nTu peux revenir à tout moment avec `/setup`, voir les modules avec `/modules` ou tester les messages avec `/test`.');
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
    case 'tog': {
      const page = requirePage(pageId);
      const field = findField(page, key);
      if (field.kind !== 'toggle') return;
      updateConfig(guild.id, (c) => field.set(c, !field.get(c)));
      await interaction.update(renderPage(guild, page));
      return;
    }
    case 'mod': {
      const page = requirePage(pageId);
      if (!page.moduleId) return;
      setModuleEnabled(guild.id, page.moduleId, !isModuleEnabled(guild.id, page.moduleId));
      await interaction.update(renderPage(guild, page));
      return;
    }
    case 'txt': {
      const page = requirePage(pageId);
      const cfg = getConfig(guild.id);
      const modalFields: ModalField[] = [];
      for (const f of page.fields) {
        if (f.kind === 'text') {
          modalFields.push({ id: f.key, label: f.label, long: f.long, required: f.required ?? false, value: f.get(cfg), maxLength: f.maxLength ?? (f.long ? 2000 : 200) });
        } else if (f.kind === 'number') {
          modalFields.push({ id: f.key, label: `${f.label} (${f.min}-${f.max})`, value: String(f.get(cfg)), maxLength: 10 });
        }
      }
      const modal = buildModal(`setup:txtm:${page.id}`, `${page.title} — textes`, modalFields);
      await interaction.showModal(modal);
      return;
    }
    case 'act': {
      const page = requirePage(pageId);
      const act = page.actions?.find((a) => a.id === key);
      if (!act) throw new UserError('Action introuvable.');
      await act.run(interaction);
      return;
    }
  }
}

export async function handleSetupSelect(interaction: AnySelectMenuInteraction<'cached'>, args: string[]): Promise<void> {
  const [, pageId, key] = args;
  const page = requirePage(pageId);
  const field = findField(page, key);
  const values = interaction.values;
  updateConfig(interaction.guildId, (c) => {
    switch (field.kind) {
      case 'channel':
      case 'role':
        field.set(c, values[0] ?? null);
        break;
      case 'channels':
      case 'roles':
      case 'multichoice':
        field.set(c, [...values]);
        break;
      case 'choice':
        if (values[0]) field.set(c, values[0]);
        break;
      default:
        break;
    }
  });
  let notice: string | undefined;
  if ((field.kind === 'role' || field.kind === 'roles') && field.assignable) {
    const blocked = values.filter((id) => {
      const r = interaction.guild.roles.cache.get(id);
      return r && !canBotManageRole(interaction.guild, r);
    });
    if (blocked.length) {
      notice = `⚠️ Je ne peux pas attribuer ${blocked.map((id) => `<@&${id}>`).join(', ')} : place mon rôle **au-dessus** dans les paramètres du serveur.`;
    }
  }
  await interaction.update(renderPage(interaction.guild, page, notice ?? '✅ Enregistré.'));
}

export async function handleSetupModal(interaction: ModalSubmitInteraction<'cached'>, args: string[]): Promise<void> {
  const [, pageId] = args;
  const page = requirePage(pageId);
  const errors: string[] = [];
  updateConfig(interaction.guildId, (c) => {
    for (const field of page.fields) {
      if (field.kind !== 'text' && field.kind !== 'number') continue;
      let raw: string;
      try {
        raw = interaction.fields.getTextInputValue(field.key).trim();
      } catch {
        continue;
      }
      if (field.kind === 'text') {
        const problem = field.validate?.(raw) ?? null;
        if (problem) errors.push(`**${field.label}** : ${problem}`);
        else field.set(c, raw);
      } else {
        const n = Number(raw.replace(',', '.'));
        if (!Number.isFinite(n) || n < field.min || n > field.max) errors.push(`**${field.label}** : valeur entre ${field.min} et ${field.max} attendue.`);
        else field.set(c, Math.round(n));
      }
    }
  });
  const notice = errors.length ? `⚠️ Certaines valeurs ont été ignorées :\n${errors.join('\n')}` : '✅ Textes enregistrés.';
  if (interaction.isFromMessage()) await interaction.update(renderPage(interaction.guild, page, notice));
  else await interaction.reply({ ...renderPage(interaction.guild, page, notice), flags: 64 });
}
