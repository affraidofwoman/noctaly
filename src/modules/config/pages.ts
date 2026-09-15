import { ChannelType } from 'discord.js';
import { creerSalonsJournal } from '../../core/logService';
import { ok } from '../../core/embeds';
import type { PageReglage } from '../../core/setup';
import { THEMES } from '../../core/themes';
import { fuseauValide } from '../../core/time';
import { DOMAINES_PREFIXES, type DomainePrefixe } from '../../core/types';
import { ErreurUtilisateur } from '../../core/errors';

const champPrefixe = (domaine: DomainePrefixe) => ({
  kind: 'text' as const,
  cle: `prefix_${domaine}`,
  libelle: `Préfixe ${DOMAINES_PREFIXES[domaine].label.toLowerCase()}`,
  maxLength: 5,
  required: true,
  get: (c: import('../../core/guildConfig').ConfigServeur) => c.prefixes[domaine],
  set: (c: import('../../core/guildConfig').ConfigServeur, v: string) => {
    c.prefixes[domaine] = v;
  },
  validate: (v: string) => (/^\S{1,5}$/.test(v) && !/[`\\]/.test(v) ? null : '1 à 5 caractères, sans espace.'),
});

export const pagesAdministration: PageReglage[] = [
  {
    id: 'appearance',
    section: 'appearance',
    titre: 'Apparence',
    emoji: '🎨',
    description: 'Le thème des messages du bot. « Enseigne » reprend les couleurs du streamer (réglées par l’owner bot avec /custom).',
    champs: [
      {
        kind: 'choice',
        cle: 'theme',
        libelle: 'Thème',
        options: [
          { value: 'brand', label: 'Enseigne du streamer', emoji: '🎥' },
          ...Object.entries(THEMES).map(([valeur, t]) => ({ value: valeur, label: t.label, emoji: t.emoji })),
          { value: 'custom', label: 'Personnalisé (couleurs ci-dessous)', emoji: '🖌️' },
        ],
        get: (c) => c.general.theme,
        set: (c, v) => {
          c.general.theme = v as typeof c.general.theme;
          const modele = THEMES[v as keyof typeof THEMES];
          if (modele) c.general.colors = { ...modele.colors };
        },
      },
      {
        kind: 'text',
        cle: 'primary',
        libelle: 'Couleur principale (#hex)',
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
        cle: 'footer',
        libelle: 'Pied de page (vide = enseigne)',
        maxLength: 128,
        get: (c) => c.general.footer,
        set: (c, v) => {
          c.general.footer = v;
        },
      },
      {
        kind: 'text',
        cle: 'timezone',
        libelle: 'Fuseau horaire',
        maxLength: 64,
        required: true,
        get: (c) => c.general.fuseau,
        set: (c, v) => {
          c.general.fuseau = v;
        },
        validate: (v) => (fuseauValide(v) ? null : 'Fuseau IANA attendu (ex : Europe/Paris).'),
      },
      {
        kind: 'channel',
        cle: 'staff',
        libelle: 'Salon staff (rapports, candidatures…)',
        get: (c) => c.general.salonStaffId,
        set: (c, v) => {
          c.general.salonStaffId = v;
        },
      },
    ],
  },
  {
    id: 'perms-high',
    section: 'security',
    titre: 'Rôles — direction',
    emoji: '👑',
    ordre: 10,
    description:
      'Rôles qui donnent un accès au bot. Les whitelists par ID (`/wl`) s’ajoutent à ces rôles.\n-# Propriétaire du serveur = Streamer · Administrateur Discord = Admin.',
    champs: [
      { kind: 'roles', cle: 'streamer', libelle: '🎥 Streamer', get: (c) => c.permissions.streamer, set: (c, v) => void (c.permissions.streamer = v) },
      { kind: 'roles', cle: 'admin', libelle: '🛠️ Admin', get: (c) => c.permissions.admin, set: (c, v) => void (c.permissions.admin = v) },
      { kind: 'roles', cle: 'moderator', libelle: '🛡️ Système (modération)', get: (c) => c.permissions.moderateur, set: (c, v) => void (c.permissions.moderateur = v) },
    ],
  },
  {
    id: 'perms-staff',
    section: 'security',
    titre: 'Rôles — équipe',
    emoji: '⭐',
    ordre: 11,
    description: 'Rôles de l’équipe. Chaque niveau garde tout ce que donnent les précédents.',
    champs: [
      { kind: 'roles', cle: 'staff', libelle: '⭐ Staff', get: (c) => c.permissions.staff, set: (c, v) => void (c.permissions.staff = v) },
      { kind: 'roles', cle: 'support', libelle: '🎫 Support', get: (c) => c.permissions.support, set: (c, v) => void (c.permissions.support = v) },
    ],
  },
  {
    id: 'prefixes',
    section: 'security',
    titre: 'Préfixes & salons de commandes',
    emoji: '⌨️',
    ordre: 12,
    description:
      'Les commandes à préfixe sont rangées par domaine : `+` sanctions, `&` salons, `=` général, `.` owner, `m!` musique.\n-# Salons de commandes : là où les commandes à préfixe marchent (vide = partout, le bypass ignore la règle).',
    champs: [
      champPrefixe('sanction'),
      champPrefixe('salon'),
      champPrefixe('general'),
      champPrefixe('owner'),
      champPrefixe('music'),
      {
        kind: 'channels',
        cle: 'cmdchannels',
        libelle: 'Salons de commandes',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice],
        get: (c) => c.commandes.salonsAutorises,
        set: (c, v) => void (c.commandes.salonsAutorises = v),
      },
      { kind: 'toggle', cle: 'deltrigger', libelle: 'Effacer la commande', get: (c) => c.commandes.effacerCommande, set: (c, v) => void (c.commandes.effacerCommande = v) },
    ],
  },
  {
    id: 'logs',
    section: 'logs',
    titre: 'Logs',
    emoji: '📜',
    moduleId: 'logs',
    description:
      'Un salon par type de log, rangés dans des catégories « Logs · … » visibles seulement par le staff concerné et les whitelists.\n-# « Créer les salons » ne touche jamais aux salons existants.',
    champs: [
      {
        kind: 'channel',
        cle: 'fallback',
        libelle: 'Salon par défaut (types sans salon)',
        get: (c) => c.journaux.salonSecoursId,
        set: (c, v) => void (c.journaux.salonSecoursId = v),
      },
      {
        kind: 'channels',
        cle: 'ignored',
        libelle: 'Salons ignorés par les logs',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement],
        get: (c) => c.journaux.salonsIgnores,
        set: (c, v) => void (c.journaux.salonsIgnores = v),
      },
    ],
    actions: [
      {
        id: 'create',
        libelle: 'Créer les salons',
        emoji: '🏗️',
        async executer(interaction) {
          await interaction.deferReply({ flags: 64 });
          const { cree, titreLie } = await creerSalonsJournal(interaction.guild).catch((echec: unknown) => {
            throw echec instanceof Error && (echec as { code?: number }).code === 50013
              ? new ErreurUtilisateur('Il me faut la permission « Gérer les salons ».')
              : echec;
          });
          await interaction.editReply({ embeds: [ok(interaction.guild, `**${cree}** salon(s) ou catégorie(s) créé(s), **${titreLie}** déjà présent(s) et relié(s).`, { titre: 'Salons de logs' })] });
        },
      },
    ],
  },
];
