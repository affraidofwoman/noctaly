import { ChannelType } from 'discord.js';
import { creerSalonsJournal } from '../../core/logService';
import { ok } from '../../core/embeds';
import type { PageReglage } from '../../core/setup';
import { THEMES } from '../../core/themes';
import { fuseauValide } from '../../core/time';
import { DOMAINES_PREFIXES, type DomainePrefixe } from '../../core/types';
import { ErreurUtilisateur } from '../../core/errors';

const champPrefixe = (domaine: DomainePrefixe) => ({
  genre: 'text' as const,
  cle: `prefix_${domaine}`,
  libelle: `Préfixe ${DOMAINES_PREFIXES[domaine].label.toLowerCase()}`,
  longueurMax: 5,
  obligatoire: true,
  lire: (c: import('../../core/guildConfig').ConfigServeur) => c.prefixes[domaine],
  ecrire: (c: import('../../core/guildConfig').ConfigServeur, v: string) => {
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
        genre: 'choice',
        cle: 'theme',
        libelle: 'Thème',
        options: [
          { valeur: 'brand', libelle: 'Enseigne du streamer', emoji: '🎥' },
          ...Object.entries(THEMES).map(([valeur, t]) => ({ valeur, libelle: t.label, emoji: t.emoji })),
          { valeur: 'custom', libelle: 'Personnalisé (couleurs ci-dessous)', emoji: '🖌️' },
        ],
        lire: (c) => c.general.theme,
        ecrire: (c, v) => {
          c.general.theme = v as typeof c.general.theme;
          const modele = THEMES[v as keyof typeof THEMES];
          if (modele) c.general.colors = { ...modele.colors };
        },
      },
      {
        genre: 'text',
        cle: 'primary',
        libelle: 'Couleur principale (#hex)',
        longueurMax: 7,
        lire: (c) => c.general.colors.primary,
        ecrire: (c, v) => {
          c.general.colors.primary = v.toUpperCase().startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
          c.general.theme = 'custom';
        },
        validate: (v) => (/^#?[0-9a-f]{6}$/i.test(v) ? null : 'Code hexadécimal attendu (ex : #5865F2).'),
      },
      {
        genre: 'text',
        cle: 'footer',
        libelle: 'Pied de page (vide = enseigne)',
        longueurMax: 128,
        lire: (c) => c.general.footer,
        ecrire: (c, v) => {
          c.general.footer = v;
        },
      },
      {
        genre: 'text',
        cle: 'timezone',
        libelle: 'Fuseau horaire',
        longueurMax: 64,
        obligatoire: true,
        lire: (c) => c.general.fuseau,
        ecrire: (c, v) => {
          c.general.fuseau = v;
        },
        validate: (v) => (fuseauValide(v) ? null : 'Fuseau IANA attendu (ex : Europe/Paris).'),
      },
      {
        genre: 'channel',
        cle: 'staff',
        libelle: 'Salon staff (rapports, candidatures…)',
        lire: (c) => c.general.salonStaffId,
        ecrire: (c, v) => {
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
      { genre: 'roles', cle: 'streamer', libelle: '🎥 Streamer', lire: (c) => c.permissions.streamer, ecrire: (c, v) => void (c.permissions.streamer = v) },
      { genre: 'roles', cle: 'admin', libelle: '🛠️ Admin', lire: (c) => c.permissions.admin, ecrire: (c, v) => void (c.permissions.admin = v) },
      { genre: 'roles', cle: 'moderator', libelle: '🛡️ Système (modération)', lire: (c) => c.permissions.moderateur, ecrire: (c, v) => void (c.permissions.moderateur = v) },
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
      { genre: 'roles', cle: 'staff', libelle: '⭐ Staff', lire: (c) => c.permissions.staff, ecrire: (c, v) => void (c.permissions.staff = v) },
      { genre: 'roles', cle: 'support', libelle: '🎫 Support', lire: (c) => c.permissions.support, ecrire: (c, v) => void (c.permissions.support = v) },
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
        genre: 'channels',
        cle: 'cmdchannels',
        libelle: 'Salons de commandes',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice],
        lire: (c) => c.commandes.salonsAutorises,
        ecrire: (c, v) => void (c.commandes.salonsAutorises = v),
      },
      { genre: 'toggle', cle: 'deltrigger', libelle: 'Effacer la commande', lire: (c) => c.commandes.effacerCommande, ecrire: (c, v) => void (c.commandes.effacerCommande = v) },
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
        genre: 'channel',
        cle: 'fallback',
        libelle: 'Salon par défaut (types sans salon)',
        lire: (c) => c.journaux.salonSecoursId,
        ecrire: (c, v) => void (c.journaux.salonSecoursId = v),
      },
      {
        genre: 'channels',
        cle: 'ignored',
        libelle: 'Salons ignorés par les logs',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement],
        lire: (c) => c.journaux.salonsIgnores,
        ecrire: (c, v) => void (c.journaux.salonsIgnores = v),
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
