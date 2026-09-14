import { ChannelType } from 'discord.js';
import { ensureLogChannels } from '../../core/logService';
import { ok } from '../../core/embeds';
import type { SetupPage } from '../../core/setup';
import { THEMES } from '../../core/themes';
import { isValidTimezone } from '../../core/time';
import { PREFIX_DOMAINS, type PrefixDomain } from '../../core/types';
import { UserError } from '../../core/errors';

const prefixField = (domain: PrefixDomain) => ({
  kind: 'text' as const,
  key: `prefix_${domain}`,
  label: `Préfixe ${PREFIX_DOMAINS[domain].label.toLowerCase()}`,
  maxLength: 5,
  required: true,
  get: (c: import('../../core/guildConfig').GuildConfig) => c.prefixes[domain],
  set: (c: import('../../core/guildConfig').GuildConfig, v: string) => {
    c.prefixes[domain] = v;
  },
  validate: (v: string) => (/^\S{1,5}$/.test(v) && !/[`\\]/.test(v) ? null : '1 à 5 caractères, sans espace.'),
});

export const configPages: SetupPage[] = [
  {
    id: 'appearance',
    section: 'appearance',
    title: 'Apparence',
    emoji: '🎨',
    description: 'Le thème des messages du bot. « Enseigne » reprend les couleurs du streamer (réglées par l’owner bot avec /custom).',
    fields: [
      {
        kind: 'choice',
        key: 'theme',
        label: 'Thème',
        options: [
          { value: 'brand', label: 'Enseigne du streamer', emoji: '🎥' },
          ...Object.entries(THEMES).map(([value, t]) => ({ value, label: t.label, emoji: t.emoji })),
          { value: 'custom', label: 'Personnalisé (couleurs ci-dessous)', emoji: '🖌️' },
        ],
        get: (c) => c.general.theme,
        set: (c, v) => {
          c.general.theme = v as typeof c.general.theme;
          const preset = THEMES[v as keyof typeof THEMES];
          if (preset) c.general.colors = { ...preset.colors };
        },
      },
      {
        kind: 'text',
        key: 'primary',
        label: 'Couleur principale (#hex)',
        maxLength: 7,
        get: (c) => c.general.colors.primary,
        set: (c, v) => {
          c.general.colors.primary = v.toUpperCase().startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
          c.general.theme = 'custom';
        },
        validate: (v) => (/^#?[0-9a-f]{6}$/i.test(v) ? null : 'Code hexadécimal attendu (ex : #5865F2).'),
      },
      {
        kind: 'text',
        key: 'footer',
        label: 'Pied de page (vide = enseigne)',
        maxLength: 128,
        get: (c) => c.general.footer,
        set: (c, v) => {
          c.general.footer = v;
        },
      },
      {
        kind: 'text',
        key: 'timezone',
        label: 'Fuseau horaire',
        maxLength: 64,
        required: true,
        get: (c) => c.general.timezone,
        set: (c, v) => {
          c.general.timezone = v;
        },
        validate: (v) => (isValidTimezone(v) ? null : 'Fuseau IANA attendu (ex : Europe/Paris).'),
      },
      {
        kind: 'channel',
        key: 'staff',
        label: 'Salon staff (rapports, candidatures…)',
        get: (c) => c.general.staffChannelId,
        set: (c, v) => {
          c.general.staffChannelId = v;
        },
      },
    ],
  },
  {
    id: 'perms-high',
    section: 'security',
    title: 'Rôles — direction',
    emoji: '👑',
    order: 10,
    description:
      'Rôles qui donnent un accès au bot. Les whitelists par ID (`/wl`) s’ajoutent à ces rôles.\n-# Propriétaire du serveur = Streamer · Administrateur Discord = Admin.',
    fields: [
      { kind: 'roles', key: 'streamer', label: '🎥 Streamer', get: (c) => c.permissions.streamer, set: (c, v) => void (c.permissions.streamer = v) },
      { kind: 'roles', key: 'admin', label: '🛠️ Admin', get: (c) => c.permissions.admin, set: (c, v) => void (c.permissions.admin = v) },
      { kind: 'roles', key: 'moderator', label: '🛡️ Système (modération)', get: (c) => c.permissions.moderator, set: (c, v) => void (c.permissions.moderator = v) },
    ],
  },
  {
    id: 'perms-staff',
    section: 'security',
    title: 'Rôles — équipe',
    emoji: '⭐',
    order: 11,
    description: 'Rôles de l’équipe. Chaque niveau garde tout ce que donnent les précédents.',
    fields: [
      { kind: 'roles', key: 'staff', label: '⭐ Staff', get: (c) => c.permissions.staff, set: (c, v) => void (c.permissions.staff = v) },
      { kind: 'roles', key: 'support', label: '🎫 Support', get: (c) => c.permissions.support, set: (c, v) => void (c.permissions.support = v) },
    ],
  },
  {
    id: 'prefixes',
    section: 'security',
    title: 'Préfixes & salons de commandes',
    emoji: '⌨️',
    order: 12,
    description:
      'Les commandes à préfixe sont rangées par domaine : `+` sanctions, `&` salons, `=` général, `.` owner, `m!` musique.\n-# Salons de commandes : là où les commandes à préfixe marchent (vide = partout, le bypass ignore la règle).',
    fields: [
      prefixField('sanction'),
      prefixField('salon'),
      prefixField('general'),
      prefixField('owner'),
      prefixField('music'),
      {
        kind: 'channels',
        key: 'cmdchannels',
        label: 'Salons de commandes',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice],
        get: (c) => c.commands.allowedChannels,
        set: (c, v) => void (c.commands.allowedChannels = v),
      },
      { kind: 'toggle', key: 'deltrigger', label: 'Effacer la commande', get: (c) => c.commands.deleteTrigger, set: (c, v) => void (c.commands.deleteTrigger = v) },
    ],
  },
  {
    id: 'logs',
    section: 'logs',
    title: 'Logs',
    emoji: '📜',
    moduleId: 'logs',
    description:
      'Un salon par type de log, rangés dans des catégories « Logs · … » visibles seulement par le staff concerné et les whitelists.\n-# « Créer les salons » ne touche jamais aux salons existants.',
    fields: [
      {
        kind: 'channel',
        key: 'fallback',
        label: 'Salon par défaut (types sans salon)',
        get: (c) => c.logs.fallbackChannelId,
        set: (c, v) => void (c.logs.fallbackChannelId = v),
      },
      {
        kind: 'channels',
        key: 'ignored',
        label: 'Salons ignorés par les logs',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement],
        get: (c) => c.logs.ignoredChannels,
        set: (c, v) => void (c.logs.ignoredChannels = v),
      },
    ],
    actions: [
      {
        id: 'create',
        label: 'Créer les salons',
        emoji: '🏗️',
        async run(interaction) {
          await interaction.deferReply({ flags: 64 });
          const { created, linked } = await ensureLogChannels(interaction.guild).catch((err: unknown) => {
            throw err instanceof Error && (err as { code?: number }).code === 50013
              ? new UserError('Il me faut la permission « Gérer les salons ».')
              : err;
          });
          await interaction.editReply({ embeds: [ok(interaction.guild, `**${created}** salon(s) ou catégorie(s) créé(s), **${linked}** déjà présent(s) et relié(s).`, { titre: 'Salons de logs' })] });
        },
      },
    ],
  },
];
