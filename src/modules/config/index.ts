import {
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { run } from '../../database/db';
import { brandFor } from '../../core/brand';
import { askConfirmation } from '../../core/confirm';
import { brandEmbed, brandName, erreur, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig, resetConfigCache, updateConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { ensureLogChannels, LOG_TYPES, logChannelFor } from '../../core/logService';
import { clearModuleCache, getModuleStates, getModules, isModuleEnabled, setModuleEnabled } from '../../core/moduleManager';
import { getLevel, levelLabel } from '../../core/permissions';
import {
  getSetupPage,
  handleSetupButton,
  handleSetupModal,
  handleSetupSelect,
  renderHome,
  renderPage,
  renderSection,
} from '../../core/setup';
import { slugify, truncate } from '../../core/text';
import { button, row } from '../../core/ui';
import { PermLevel, PREFIX_DOMAINS, type BotModule, type PrefixCommand, type PrefixDomain, type SlashCommand } from '../../core/types';
import { customComponent, customHome } from './custom';
import { configPages } from './pages';
import { wlComponent, wlHome, wlPrefixCommands, wlUser } from './wl';

// ─── /modules ──────────────────────────────────────────────────────────────

const MODULES_PER_MENU = 25;

export function modulesPanel(guild: Guild, note?: string) {
  const states = getModuleStates(guild.id).filter((s) => s.module.toggleable);
  const embed = brandEmbed(guild)
    .setTitle('🤖 Modules du serveur')
    .setDescription(
      [note ?? 'Coche les modules à garder actifs. Un module désactivé ne répond plus, sans casser les autres.', `-# ${states.filter((s) => s.enabled).length}/${states.length} actifs`].join('\n'),
    );
  const half = Math.ceil(states.length / 2);
  for (const part of [states.slice(0, half), states.slice(half)]) {
    if (!part.length) continue;
    embed.addFields({
      name: '​',
      value: truncate(part.map((s) => `${s.module.emoji} ${s.module.name} — ${s.enabled ? '🟢' : '🔴'}`).join('\n'), 1024),
      inline: true,
    });
  }
  const components = [];
  for (let page = 0; page * MODULES_PER_MENU < states.length && page < 4; page++) {
    const slice = states.slice(page * MODULES_PER_MENU, (page + 1) * MODULES_PER_MENU);
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`mods:set:${page}`)
          .setPlaceholder(page === 0 ? 'Modules actifs' : `Modules actifs (suite ${page + 1})`)
          .setMinValues(0)
          .setMaxValues(slice.length)
          .addOptions(
            slice.map((s) => ({
              label: s.module.name,
              value: s.module.id,
              emoji: s.module.emoji,
              description: truncate(s.module.description, 100),
              default: s.enabled,
            })),
          ),
      ),
    );
  }
  return { embeds: [embed], components };
}

// ─── /quicksetup ───────────────────────────────────────────────────────────

interface QuickChannel {
  name: string;
  readOnly?: boolean;
  link?: (c: import('../../core/guildConfig').GuildConfig, id: string) => void;
}

const QUICK_STRUCTURE: { category: string; channels: QuickChannel[] }[] = [
  {
    category: '📁 INFORMATION',
    channels: [
      { name: 'bienvenue', readOnly: true, link: (c, id) => void (c.welcome.channelId ??= id) },
      { name: 'règlement', readOnly: true, link: (c, id) => void (c.rules.channelId ??= id) },
      { name: 'annonces', readOnly: true, link: (c, id) => void (c.announcements.defaultChannelId ??= id) },
      { name: 'lives', readOnly: true, link: (c, id) => void (c.twitch.defaultChannelId ??= id) },
    ],
  },
  {
    category: '📁 COMMUNAUTÉ',
    channels: [
      { name: 'général' },
      { name: 'médias' },
      { name: 'suggestions', link: (c, id) => void (c.suggestions.channelId ??= id) },
    ],
  },
  { category: '📁 SUPPORT', channels: [{ name: 'tickets', readOnly: true, link: (c, id) => void (c.tickets.panelChannelId ??= id) }] },
  { category: '📁 GIVEAWAYS', channels: [{ name: 'giveaways', readOnly: true, link: (c, id) => void (c.giveaways.defaultChannelId ??= id) }] },
];

function normalizeName(name: string): string {
  return slugify(name.replace(/^[^\p{L}\p{N}]+/u, ''));
}

function findChannel(guild: Guild, name: string, type: ChannelType): GuildBasedChannel | undefined {
  const target = normalizeName(name);
  return guild.channels.cache.find((c) => c.type === type && normalizeName(c.name) === target);
}

async function runQuickSetup(guild: Guild): Promise<string[]> {
  const report: string[] = [];
  const links: { link: QuickChannel['link']; id: string }[] = [];
  const everyone = guild.roles.everyone.id;
  for (const block of QUICK_STRUCTURE) {
    let category = findChannel(guild, block.category, ChannelType.GuildCategory) as CategoryChannel | undefined;
    if (!category) {
      category = await guild.channels.create({ name: block.category, type: ChannelType.GuildCategory, reason: '/quicksetup' });
      report.push(`➕ Catégorie **${block.category}**`);
    } else {
      report.push(`✔️ Catégorie **${category.name}** déjà présente`);
    }
    for (const ch of block.channels) {
      const existing = findChannel(guild, ch.name, ChannelType.GuildText);
      if (existing) {
        report.push(`　✔️ <#${existing.id}> déjà présent`);
        links.push({ link: ch.link, id: existing.id });
        continue;
      }
      const created = await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: '/quicksetup',
        permissionOverwrites: ch.readOnly
          ? [
              { id: everyone, deny: [PermissionFlagsBits.SendMessages], type: OverwriteType.Role },
              { id: guild.members.me!.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks], type: OverwriteType.Member },
            ]
          : [],
      });
      report.push(`　➕ <#${created.id}>`);
      links.push({ link: ch.link, id: created.id });
    }
  }
  updateConfig(guild.id, (c) => {
    for (const { link, id } of links) link?.(c, id);
  });
  const logs = await ensureLogChannels(guild);
  report.push(`📜 Logs : **${logs.created}** créé(s), **${logs.linked}** relié(s)`);
  return report;
}

// ─── /test ─────────────────────────────────────────────────────────────────

const REQUIRED_PERMISSIONS: [bigint, string][] = [
  [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
  [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
  [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement'],
  [PermissionFlagsBits.KickMembers, 'Expulser'],
  [PermissionFlagsBits.BanMembers, 'Bannir'],
  [PermissionFlagsBits.ViewAuditLog, 'Voir les logs du serveur'],
  [PermissionFlagsBits.ManageGuild, 'Gérer le serveur (invitations)'],
  [PermissionFlagsBits.EmbedLinks, 'Intégrer des liens'],
  [PermissionFlagsBits.AttachFiles, 'Joindre des fichiers'],
  [PermissionFlagsBits.AddReactions, 'Ajouter des réactions'],
  [PermissionFlagsBits.Connect, 'Se connecter (vocal)'],
  [PermissionFlagsBits.Speak, 'Parler (vocal)'],
];

function diagnostic(guild: Guild) {
  const me = guild.members.me;
  const lines = REQUIRED_PERMISSIONS.map(([flag, label]) => `${me?.permissions.has(flag) ? '✅' : '❌'} ${label}`);
  const cfg = getConfig(guild.id);
  const topRole = me?.roles.highest;
  const aboveBot = guild.roles.cache.filter((r) => topRole && r.comparePositionTo(topRole) > 0 && !r.managed).size;
  const missingLogs = LOG_TYPES.filter((t) => !logChannelFor(guild, t.type)).length;
  const checks = [
    `${cfg.welcome.channelId ? '✅' : '⚠️'} Salon de bienvenue`,
    `${cfg.tickets.panelChannelId ? '✅' : '⚠️'} Salon des tickets`,
    `${missingLogs === 0 ? '✅' : '⚠️'} Salons de logs (${LOG_TYPES.length - missingLogs}/${LOG_TYPES.length})`,
    `${brandFor(guild.id).key ? '✅' : 'ℹ️'} Enseigne : **${brandName(guild)}**`,
    `${aboveBot === 0 ? '✅' : '⚠️'} Rôles au-dessus du bot : **${aboveBot}**`,
  ];
  return brandEmbed(guild)
    .setTitle('🩺 Diagnostic')
    .addFields(
      { name: 'Permissions du bot', value: lines.join('\n'), inline: true },
      { name: 'Configuration', value: checks.join('\n'), inline: true },
    );
}

function testMenu(guild: Guild) {
  const tests = getModules()
    .filter((m) => isModuleEnabled(guild.id, m.id))
    .flatMap((m) => (m.tests ?? []).map((t) => ({ module: m, test: t })));
  const select = new StringSelectMenuBuilder()
    .setCustomId('cfgtest:run')
    .setPlaceholder('Que veux-tu tester ?')
    .addOptions([
      { label: 'Diagnostic des permissions', value: 'diag', emoji: '🩺', description: 'Permissions du bot et réglages manquants' },
      ...tests.slice(0, 24).map(({ module, test }) => ({
        label: truncate(`${module.name} · ${test.label}`, 100),
        value: `${module.id}:${test.id}`,
        emoji: test.emoji,
        description: truncate(test.description, 100),
      })),
    ]);
  return row(select);
}

// ─── Commandes ─────────────────────────────────────────────────────────────

const setup: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder().setName('setup').setDescription('Configurer le serveur pas à pas'),
  async execute(interaction) {
    await reply(interaction, { ...renderHome(interaction.guild), ephemeral: true });
  },
};

const quicksetup: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder().setName('quicksetup').setDescription('Créer les salons de base en un clic'),
  async execute(interaction) {
    const preview = QUICK_STRUCTURE.map((b) => `**${b.category}**\n${b.channels.map((c) => `　#${c.name}`).join('\n')}`).join('\n');
    await askConfirmation(interaction, {
      title: 'Créer la structure du serveur ?',
      description: `${preview}\n**📜 Logs · …** (un salon par type)\n\n-# Aucun salon existant n’est modifié ni écrasé.`,
      confirmLabel: 'Créer',
      onConfirm: async (i) => {
        await i.update({ embeds: [info(i.guild, 'Création en cours…')], components: [] });
        const report = await runQuickSetup(i.guild);
        await i.editReply({ embeds: [ok(i.guild, truncate(report.join('\n'), 4000), { titre: 'Structure prête' })] });
      },
    });
  },
};

const modulesCommand: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder().setName('modules').setDescription('Activer ou couper les modules'),
  async execute(interaction) {
    await reply(interaction, { ...modulesPanel(interaction.guild), ephemeral: true });
  },
};

const config: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Réglages du serveur')
    .addSubcommand((s) => s.setName('voir').setDescription('Résumé des réglages'))
    .addSubcommand((s) => s.setName('apparence').setDescription('Thème, couleurs, fuseau horaire'))
    .addSubcommand((s) => s.setName('permissions').setDescription('Rôles qui donnent un accès au bot'))
    .addSubcommand((s) => s.setName('prefixes').setDescription('Préfixes et salons de commandes'))
    .addSubcommand((s) => s.setName('reset').setDescription('Tout remettre à zéro')),
  subLevels: { reset: PermLevel.STREAMER },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (sub === 'apparence') return reply(interaction, { ...renderPage(guild, getSetupPage('appearance')!), ephemeral: true });
    if (sub === 'permissions') return reply(interaction, { ...renderSection(guild, 'security'), ephemeral: true });
    if (sub === 'prefixes') return reply(interaction, { ...renderPage(guild, getSetupPage('prefixes')!), ephemeral: true });
    if (sub === 'reset') {
      return askConfirmation(interaction, {
        title: 'Tout remettre à zéro ?',
        description: 'Tous les réglages du bot **sur ce serveur** reviennent à leurs valeurs d’origine, et les modules reprennent leur état par défaut.\nLes données (warns, XP, tickets…) sont conservées.',
        confirmLabel: 'Réinitialiser',
        onConfirm: async (i) => {
          run('DELETE FROM guild_settings WHERE guild_id = ?', i.guildId);
          run('DELETE FROM guild_modules WHERE guild_id = ?', i.guildId);
          resetConfigCache(i.guildId);
          clearModuleCache(i.guildId);
          await i.update({ embeds: [ok(i.guild, 'Réglages remis à zéro.')], components: [] });
        },
      });
    }
    const cfg = getConfig(guild.id);
    const roles = (ids: string[]) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : '—');
    const enabled = getModuleStates(guild.id).filter((s) => s.module.toggleable);
    const embed = brandEmbed(guild)
      .setTitle('⚙️ Réglages du serveur')
      .addFields(
        { name: 'Enseigne', value: brandName(guild), inline: true },
        { name: 'Thème', value: cfg.general.theme, inline: true },
        { name: 'Fuseau', value: cfg.general.timezone, inline: true },
        {
          name: 'Préfixes',
          value: (Object.keys(PREFIX_DOMAINS) as PrefixDomain[]).map((d) => `${PREFIX_DOMAINS[d].emoji} \`${cfg.prefixes[d]}\``).join(' · '),
          inline: false,
        },
        {
          name: 'Rôles d’accès',
          value: [
            `🎥 Streamer — ${roles(cfg.permissions.streamer)}`,
            `🛠️ Admin — ${roles(cfg.permissions.admin)}`,
            `🛡️ Système — ${roles(cfg.permissions.moderator)}`,
            `⭐ Staff — ${roles(cfg.permissions.staff)}`,
            `🎫 Support — ${roles(cfg.permissions.support)}`,
          ].join('\n'),
          inline: false,
        },
        { name: 'Modules', value: `${enabled.filter((s) => s.enabled).length}/${enabled.length} actifs`, inline: true },
        { name: 'Salons de logs', value: `${LOG_TYPES.filter((t) => logChannelFor(guild, t.type)).length}/${LOG_TYPES.length}`, inline: true },
        { name: 'Ton accès', value: levelLabel(getLevel(interaction.member)), inline: true },
      );
    return reply(interaction, { embeds: [embed], ephemeral: true });
  },
};

const test: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder().setName('test').setDescription('Tester les messages et les permissions'),
  async execute(interaction) {
    await reply(interaction, { embeds: [diagnostic(interaction.guild)], components: [testMenu(interaction.guild)], ephemeral: true });
  },
};

const wl: SlashCommand = {
  category: 'admin',
  level: PermLevel.STAFF,
  data: new SlashCommandBuilder()
    .setName('wl')
    .setDescription('Donner une whitelist')
    .addUserOption((o) => o.setName('personne').setDescription('Qui')),
  async execute(interaction) {
    const target = interaction.options.getUser('personne');
    const payload = target ? wlUser(interaction.member, target) : wlHome(interaction.guild);
    await reply(interaction, { ...payload, ephemeral: true });
  },
};

const custom: SlashCommand = {
  category: 'owner',
  level: PermLevel.BOT_OWNER,
  data: new SlashCommandBuilder().setName('custom').setDescription('Régler une enseigne'),
  async execute(interaction) {
    await reply(interaction, { ...customHome(interaction.client), ephemeral: true });
  },
};

// ─── Préfixes owner ────────────────────────────────────────────────────────

const ownerPrefix: PrefixCommand[] = [
  {
    name: 'servers',
    aliases: ['serveurs'],
    domain: 'owner',
    category: 'owner',
    description: 'Les serveurs du bot',
    level: PermLevel.BOT_OWNER,
    async execute(message) {
      const lines = message.client.guilds.cache
        .sort((a, b) => b.memberCount - a.memberCount)
        .map((g) => `• **${truncate(g.name, 40)}** \`${g.id}\` — ${g.memberCount} membres · ${brandFor(g.id).key ? brandFor(g.id).name : '*sans enseigne*'}`);
      await message.reply({ embeds: [info(message.guild, truncate(lines.join('\n'), 4000), { titre: `Serveurs (${lines.length})`, sujet: '🌐' })], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'leave',
    domain: 'owner',
    category: 'owner',
    description: 'Faire quitter un serveur au bot',
    usage: '<id>',
    level: PermLevel.BOT_OWNER,
    async execute(message, args) {
      const guild = args[0] ? message.client.guilds.cache.get(args[0]) : null;
      if (!guild) throw new UserError('Identifiant de serveur attendu (voir `.servers`).');
      const sent = await message.reply({
        embeds: [info(message.guild, `Quitter **${guild.name}** (\`${guild.id}\`) ?`, { titre: 'Confirmation', sujet: '⚠️' })],
        components: [row(button(`cfgleave:${guild.id}:${message.author.id}`, 'Quitter', ButtonStyle.Danger, '🚪'))],
        allowedMentions: { repliedUser: false },
      });
      setTimeout(() => void sent.edit({ components: [] }).catch(() => undefined), 60_000).unref();
    },
  },
  {
    name: 'custom',
    domain: 'owner',
    category: 'owner',
    description: 'Régler une enseigne',
    level: PermLevel.BOT_OWNER,
    async execute(message) {
      await message.reply({ ...customHome(message.client), allowedMentions: { repliedUser: false } });
    },
  },
];

export const configModule: BotModule = {
  id: 'config',
  name: 'Administration',
  emoji: '⚙️',
  description: 'Setup, modules, whitelists, enseignes',
  toggleable: false,
  defaultEnabled: true,
  commands: [setup, quicksetup, modulesCommand, config, test, wl, custom],
  prefixCommands: [...wlPrefixCommands(), ...ownerPrefix],
  setupPages: configPages,
  components: [
    wlComponent,
    customComponent,
    {
      prefix: 'setup',
      level: PermLevel.ADMIN,
      button: (i, args) => handleSetupButton(i, args),
      select: (i, args) => handleSetupSelect(i, args),
      modal: (i, args) => handleSetupModal(i, args),
    },
    {
      prefix: 'mods',
      level: PermLevel.ADMIN,
      async select(interaction: AnySelectMenuInteraction<'cached'>, [, pageRaw]) {
        const page = Number(pageRaw) || 0;
        const states = getModuleStates(interaction.guildId).filter((s) => s.module.toggleable);
        const slice = states.slice(page * MODULES_PER_MENU, (page + 1) * MODULES_PER_MENU);
        const chosen = new Set(interaction.values);
        const changes: string[] = [];
        for (const { module, enabled } of slice) {
          const next = chosen.has(module.id);
          if (next !== enabled) {
            setModuleEnabled(interaction.guildId, module.id, next);
            changes.push(`${next ? '🟢' : '🔴'} ${module.emoji} ${module.name}`);
          }
        }
        await interaction.update(modulesPanel(interaction.guild, changes.length ? `✅ ${changes.join(' · ')}` : 'Aucun changement.'));
      },
    },
    {
      prefix: 'cfgtest',
      level: PermLevel.ADMIN,
      async select(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!interaction.isStringSelectMenu()) return;
        const value = interaction.values[0] ?? 'diag';
        if (value === 'diag') {
          await interaction.update({ embeds: [diagnostic(interaction.guild)], components: [testMenu(interaction.guild)] });
          return;
        }
        const [moduleId, testId] = value.split(':');
        const mod = getModules().find((m) => m.id === moduleId);
        const t = mod?.tests?.find((x) => x.id === testId);
        if (!mod || !t) throw new UserError('Ce test n’existe plus.');
        await interaction.deferUpdate();
        let result: string;
        try {
          result = await t.run(interaction);
        } catch (err) {
          result = `❌ ${err instanceof UserError ? err.message : 'Le test a échoué.'}`;
        }
        await interaction.editReply({
          embeds: [info(interaction.guild, result, { titre: `${mod.name} · ${t.label}`, sujet: t.emoji })],
          components: [testMenu(interaction.guild)],
        });
      },
    },
    {
      prefix: 'cfgleave',
      level: PermLevel.BOT_OWNER,
      async button(interaction: ButtonInteraction<'cached'>, [guildId, ownerId]) {
        if (interaction.user.id !== ownerId) {
          await interaction.reply({ embeds: [erreur(interaction.guild, 'Seul l’auteur de la commande peut confirmer.')], flags: 64 });
          return;
        }
        const guild = interaction.client.guilds.cache.get(guildId ?? '');
        if (!guild) {
          await interaction.update({ embeds: [erreur(interaction.guild, 'Le bot n’est plus sur ce serveur.')], components: [] });
          return;
        }
        const name = guild.name;
        await guild.leave();
        await interaction.update({ embeds: [ok(interaction.guild, `Le bot a quitté **${name}**.`)], components: [] });
      },
    },
  ],
};

