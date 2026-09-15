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
import { executer } from '../../database/db';
import { enseigneDe } from '../../core/brand';
import { demanderConfirmation } from '../../core/confirm';
import { embedEnseigne, nomEnseigne, erreur, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig, viderCacheConfig, modifierConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { creerSalonsJournal, TYPES_JOURNAUX, salonJournalPour } from '../../core/logService';
import { viderCacheModules, lireEtatsModules, lireModules, moduleActif, activerModule } from '../../core/moduleManager';
import { lireNiveau, libelleNiveau } from '../../core/permissions';
import {
  lirePageReglage,
  traiterBoutonReglage,
  traiterFenetreReglage,
  traiterMenuReglage,
  afficherAccueil,
  afficherPage,
  afficherSection,
} from '../../core/setup';
import { identifiantDepuisTexte, tronquer } from '../../core/text';
import { bouton, rangee } from '../../core/ui';
import { Niveau, DOMAINES_PREFIXES, type ModuleBot, type CommandePrefixe, type DomainePrefixe, type CommandeSlash } from '../../core/types';
import { composantEnseignes, accueilEnseignes } from './custom';
import { pagesAdministration } from './pages';
import { composantWhitelists, accueilWhitelists, raccourcisWhitelists, whitelistsDe } from './wl';

// ─── /modules ──────────────────────────────────────────────────────────────

const MODULES_PAR_MENU = 25;

export function panneauModules(serveur: Guild, note?: string) {
  const etats = lireEtatsModules(serveur.id).filter((s) => s.module.desactivable);
  const embed = embedEnseigne(serveur)
    .setTitle('🤖 Modules du serveur')
    .setDescription(
      [note ?? 'Coche les modules à garder actifs. Un module désactivé ne répond plus, sans casser les autres.', `-# ${etats.filter((s) => s.enabled).length}/${etats.length} actifs`].join('\n'),
    );
  const moitie = Math.ceil(etats.length / 2);
  for (const partie of [etats.slice(0, moitie), etats.slice(moitie)]) {
    if (!partie.length) continue;
    embed.addFields({
      name: '​',
      value: tronquer(partie.map((s) => `${s.module.emoji} ${s.module.nom} — ${s.enabled ? '🟢' : '🔴'}`).join('\n'), 1024),
      inline: true,
    });
  }
  const composants = [];
  for (let page = 0; page * MODULES_PAR_MENU < etats.length && page < 4; page++) {
    const tranche = etats.slice(page * MODULES_PAR_MENU, (page + 1) * MODULES_PAR_MENU);
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId(`mods:set:${page}`)
          .setPlaceholder(page === 0 ? 'Modules actifs' : `Modules actifs (suite ${page + 1})`)
          .setMinValues(0)
          .setMaxValues(tranche.length)
          .addOptions(
            tranche.map((s) => ({
              label: s.module.nom,
              value: s.module.id,
              emoji: s.module.emoji,
              description: tronquer(s.module.description, 100),
              default: s.enabled,
            })),
          ),
      ),
    );
  }
  return { embeds: [embed], components: composants };
}

// ─── /quicksetup ───────────────────────────────────────────────────────────

interface SalonRapide {
  nom: string;
  lectureSeule?: boolean;
  lien?: (c: import('../../core/guildConfig').ConfigServeur, id: string) => void;
}

const STRUCTURE_RAPIDE: { categorie: string; channels: SalonRapide[] }[] = [
  {
    categorie: '📁 INFORMATION',
    channels: [
      { nom: 'bienvenue', lectureSeule: true, lien: (c, id) => void (c.bienvenue.channelId ??= id) },
      { nom: 'règlement', lectureSeule: true, lien: (c, id) => void (c.reglement.channelId ??= id) },
      { nom: 'annonces', lectureSeule: true, lien: (c, id) => void (c.annonces.salonDefautId ??= id) },
      { nom: 'lives', lectureSeule: true, lien: (c, id) => void (c.twitch.salonDefautId ??= id) },
    ],
  },
  {
    categorie: '📁 COMMUNAUTÉ',
    channels: [
      { nom: 'général' },
      { nom: 'médias' },
      { nom: 'suggestions', lien: (c, id) => void (c.suggestions.channelId ??= id) },
    ],
  },
  { categorie: '📁 SUPPORT', channels: [{ nom: 'tickets', lectureSeule: true, lien: (c, id) => void (c.tickets.salonPanneauId ??= id) }] },
  { categorie: '📁 GIVEAWAYS', channels: [{ nom: 'giveaways', lectureSeule: true, lien: (c, id) => void (c.tirages.salonDefautId ??= id) }] },
];

function normaliserNom(nom: string): string {
  return identifiantDepuisTexte(nom.replace(/^[^\p{L}\p{N}]+/u, ''));
}

function trouverSalon(serveur: Guild, nom: string, type: ChannelType): GuildBasedChannel | undefined {
  const cible = normaliserNom(nom);
  return serveur.channels.cache.find((c) => c.type === type && normaliserNom(c.name) === cible);
}

async function lancerInstallationRapide(serveur: Guild): Promise<string[]> {
  const signalement: string[] = [];
  const liens: { link: SalonRapide['lien']; id: string }[] = [];
  const tousMembres = serveur.roles.everyone.id;
  for (const groupe of STRUCTURE_RAPIDE) {
    let categorie = trouverSalon(serveur, groupe.categorie, ChannelType.GuildCategory) as CategoryChannel | undefined;
    if (!categorie) {
      categorie = await serveur.channels.create({ name: groupe.categorie, type: ChannelType.GuildCategory, reason: '/quicksetup' });
      signalement.push(`➕ Catégorie **${groupe.categorie}**`);
    } else {
      signalement.push(`✔️ Catégorie **${categorie.name}** déjà présente`);
    }
    for (const salonVise of groupe.channels) {
      const existant = trouverSalon(serveur, salonVise.nom, ChannelType.GuildText);
      if (existant) {
        signalement.push(`　✔️ <#${existant.id}> déjà présent`);
        liens.push({ link: salonVise.lien, id: existant.id });
        continue;
      }
      const cree = await serveur.channels.create({
        name: salonVise.nom,
        type: ChannelType.GuildText,
        parent: categorie.id,
        reason: '/quicksetup',
        permissionOverwrites: salonVise.lectureSeule
          ? [
              { id: tousMembres, deny: [PermissionFlagsBits.SendMessages], type: OverwriteType.Role },
              { id: serveur.members.me!.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks], type: OverwriteType.Member },
            ]
          : [],
      });
      signalement.push(`　➕ <#${cree.id}>`);
      liens.push({ link: salonVise.lien, id: cree.id });
    }
  }
  modifierConfig(serveur.id, (c) => {
    for (const { link: lien, id } of liens) lien?.(c, id);
  });
  const journaux = await creerSalonsJournal(serveur);
  signalement.push(`📜 Logs : **${journaux.cree}** créé(s), **${journaux.titreLie}** relié(s)`);
  return signalement;
}

// ─── /test ─────────────────────────────────────────────────────────────────

const PERMISSIONS_REQUISES: [bigint, string][] = [
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

function diagnostic(serveur: Guild) {
  const moi = serveur.members.me;
  const lignes = PERMISSIONS_REQUISES.map(([drapeau, libelle]) => `${moi?.permissions.has(drapeau) ? '✅' : '❌'} ${libelle}`);
  const reglages = lireConfig(serveur.id);
  const roleHaut = moi?.roles.highest;
  const auDessusDuBot = serveur.roles.cache.filter((r) => roleHaut && r.comparePositionTo(roleHaut) > 0 && !r.managed).size;
  const journauxManquants = TYPES_JOURNAUX.filter((t) => !salonJournalPour(serveur, t.type)).length;
  const verifications = [
    `${reglages.bienvenue.channelId ? '✅' : '⚠️'} Salon de bienvenue`,
    `${reglages.tickets.salonPanneauId ? '✅' : '⚠️'} Salon des tickets`,
    `${journauxManquants === 0 ? '✅' : '⚠️'} Salons de logs (${TYPES_JOURNAUX.length - journauxManquants}/${TYPES_JOURNAUX.length})`,
    `${enseigneDe(serveur.id).cle ? '✅' : 'ℹ️'} Enseigne : **${nomEnseigne(serveur)}**`,
    `${auDessusDuBot === 0 ? '✅' : '⚠️'} Rôles au-dessus du bot : **${auDessusDuBot}**`,
  ];
  return embedEnseigne(serveur)
    .setTitle('🩺 Diagnostic')
    .addFields(
      { name: 'Permissions du bot', value: lignes.join('\n'), inline: true },
      { name: 'Configuration', value: verifications.join('\n'), inline: true },
    );
}

function menuTests(serveur: Guild) {
  const tests = lireModules()
    .filter((m) => moduleActif(serveur.id, m.id))
    .flatMap((m) => (m.tests ?? []).map((t) => ({ module: m, test: t })));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('cfgtest:run')
    .setPlaceholder('Que veux-tu tester ?')
    .addOptions([
      { label: 'Diagnostic des permissions', value: 'diag', emoji: '🩺', description: 'Permissions du bot et réglages manquants' },
      ...tests.slice(0, 24).map(({ module, test }) => ({
        label: tronquer(`${module.nom} · ${test.libelle}`, 100),
        value: `${module.id}:${test.id}`,
        emoji: test.emoji,
        description: tronquer(test.description, 100),
      })),
    ]);
  return rangee(menu);
}

// ─── Commandes ─────────────────────────────────────────────────────────────

const assistant: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('setup').setDescription('Configurer le serveur pas à pas'),
  async executer(interaction) {
    await repondre(interaction, { ...afficherAccueil(interaction.guild), ephemeral: true });
  },
};

const installationRapide: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('quicksetup').setDescription('Créer les salons de base en un clic'),
  async executer(interaction) {
    const apercu = STRUCTURE_RAPIDE.map((b) => `**${b.categorie}**\n${b.channels.map((c) => `　#${c.nom}`).join('\n')}`).join('\n');
    await demanderConfirmation(interaction, {
      titre: 'Créer la structure du serveur ?',
      description: `${apercu}\n**📜 Logs · …** (un salon par type)\n\n-# Aucun salon existant n’est modifié ni écrasé.`,
      libelleConfirmation: 'Créer',
      surConfirmation: async (i) => {
        await i.update({ embeds: [info(i.guild, 'Création en cours…')], components: [] });
        const signalement = await lancerInstallationRapide(i.guild);
        await i.editReply({ embeds: [ok(i.guild, tronquer(signalement.join('\n'), 4000), { titre: 'Structure prête' })] });
      },
    });
  },
};

const commandeModules: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('modules').setDescription('Activer ou couper les modules'),
  async executer(interaction) {
    await repondre(interaction, { ...panneauModules(interaction.guild), ephemeral: true });
  },
};

const config: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Réglages du serveur')
    .addSubcommand((s) => s.setName('voir').setDescription('Résumé des réglages'))
    .addSubcommand((s) => s.setName('apparence').setDescription('Thème, couleurs, fuseau horaire'))
    .addSubcommand((s) => s.setName('permissions').setDescription('Rôles qui donnent un accès au bot'))
    .addSubcommand((s) => s.setName('prefixes').setDescription('Préfixes et salons de commandes'))
    .addSubcommand((s) => s.setName('reset').setDescription('Tout remettre à zéro')),
  niveauxSousCommandes: { reset: Niveau.STREAMER },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    if (sousCommande === 'apparence') return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('appearance')!), ephemeral: true });
    if (sousCommande === 'permissions') return repondre(interaction, { ...afficherSection(serveur, 'security'), ephemeral: true });
    if (sousCommande === 'prefixes') return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('prefixes')!), ephemeral: true });
    if (sousCommande === 'reset') {
      return demanderConfirmation(interaction, {
        titre: 'Tout remettre à zéro ?',
        description: 'Tous les réglages du bot **sur ce serveur** reviennent à leurs valeurs d’origine, et les modules reprennent leur état par défaut.\nLes données (warns, XP, tickets…) sont conservées.',
        libelleConfirmation: 'Réinitialiser',
        surConfirmation: async (i) => {
          executer('DELETE FROM reglages_serveurs WHERE serveur_id = ?', i.guildId);
          executer('DELETE FROM modules_serveurs WHERE serveur_id = ?', i.guildId);
          viderCacheConfig(i.guildId);
          viderCacheModules(i.guildId);
          await i.update({ embeds: [ok(i.guild, 'Réglages remis à zéro.')], components: [] });
        },
      });
    }
    const reglages = lireConfig(serveur.id);
    const roles = (ids: string[]) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : '—');
    const actif = lireEtatsModules(serveur.id).filter((s) => s.module.desactivable);
    const embed = embedEnseigne(serveur)
      .setTitle('⚙️ Réglages du serveur')
      .addFields(
        { name: 'Enseigne', value: nomEnseigne(serveur), inline: true },
        { name: 'Thème', value: reglages.general.theme, inline: true },
        { name: 'Fuseau', value: reglages.general.fuseau, inline: true },
        {
          name: 'Préfixes',
          value: (Object.keys(DOMAINES_PREFIXES) as DomainePrefixe[]).map((d) => `${DOMAINES_PREFIXES[d].emoji} \`${reglages.prefixes[d]}\``).join(' · '),
          inline: false,
        },
        {
          name: 'Rôles d’accès',
          value: [
            `🎥 Streamer — ${roles(reglages.permissions.streamer)}`,
            `🛠️ Admin — ${roles(reglages.permissions.admin)}`,
            `🛡️ Système — ${roles(reglages.permissions.moderateur)}`,
            `⭐ Staff — ${roles(reglages.permissions.staff)}`,
            `🎫 Support — ${roles(reglages.permissions.support)}`,
          ].join('\n'),
          inline: false,
        },
        { name: 'Modules', value: `${actif.filter((s) => s.enabled).length}/${actif.length} actifs`, inline: true },
        { name: 'Salons de logs', value: `${TYPES_JOURNAUX.filter((t) => salonJournalPour(serveur, t.type)).length}/${TYPES_JOURNAUX.length}`, inline: true },
        { name: 'Ton accès', value: libelleNiveau(lireNiveau(interaction.member)), inline: true },
      );
    return repondre(interaction, { embeds: [embed], ephemeral: true });
  },
};

const test: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('test').setDescription('Tester les messages et les permissions'),
  async executer(interaction) {
    await repondre(interaction, { embeds: [diagnostic(interaction.guild)], components: [menuTests(interaction.guild)], ephemeral: true });
  },
};

const wl: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('wl')
    .setDescription('Donner une whitelist')
    .addUserOption((o) => o.setName('personne').setDescription('Qui')),
  async executer(interaction) {
    const cible = interaction.options.getUser('personne');
    const charge = cible ? whitelistsDe(interaction.member, cible) : accueilWhitelists(interaction.guild);
    await repondre(interaction, { ...charge, ephemeral: true });
  },
};

const enseignes: CommandeSlash = {
  categorie: 'owner',
  niveau: Niveau.PROPRIETAIRE_BOT,
  donnees: new SlashCommandBuilder().setName('custom').setDescription('Régler une enseigne'),
  async executer(interaction) {
    await repondre(interaction, { ...accueilEnseignes(interaction.client), ephemeral: true });
  },
};

// ─── Préfixes owner ────────────────────────────────────────────────────────

const prefixesProprietaire: CommandePrefixe[] = [
  {
    nom: 'servers',
    alias: ['serveurs'],
    domaine: 'owner',
    categorie: 'owner',
    description: 'Les serveurs du bot',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message) {
      const lignes = message.client.guilds.cache
        .sort((a, b) => b.memberCount - a.memberCount)
        .map((g) => `• **${tronquer(g.name, 40)}** \`${g.id}\` — ${g.memberCount} membres · ${enseigneDe(g.id).cle ? enseigneDe(g.id).nom : '*sans enseigne*'}`);
      await message.reply({ embeds: [info(message.guild, tronquer(lignes.join('\n'), 4000), { titre: `Serveurs (${lignes.length})`, sujet: '🌐' })], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'leave',
    domaine: 'owner',
    categorie: 'owner',
    description: 'Faire quitter un serveur au bot',
    usage: '<id>',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message, parametres) {
      const serveur = parametres[0] ? message.client.guilds.cache.get(parametres[0]) : null;
      if (!serveur) throw new ErreurUtilisateur('Identifiant de serveur attendu (voir `.servers`).');
      const envoye = await message.reply({
        embeds: [info(message.guild, `Quitter **${serveur.name}** (\`${serveur.id}\`) ?`, { titre: 'Confirmation', sujet: '⚠️' })],
        components: [rangee(bouton(`cfgleave:${serveur.id}:${message.author.id}`, 'Quitter', ButtonStyle.Danger, '🚪'))],
        allowedMentions: { repliedUser: false },
      });
      setTimeout(() => void envoye.edit({ components: [] }).catch(() => undefined), 60_000).unref();
    },
  },
  {
    nom: 'custom',
    domaine: 'owner',
    categorie: 'owner',
    description: 'Régler une enseigne',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message) {
      await message.reply({ ...accueilEnseignes(message.client), allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleAdministration: ModuleBot = {
  id: 'config',
  nom: 'Administration',
  emoji: '⚙️',
  description: 'Setup, modules, whitelists, enseignes',
  desactivable: false,
  actifParDefaut: true,
  commandes: [assistant, installationRapide, commandeModules, config, test, wl, enseignes],
  commandesPrefixe: [...raccourcisWhitelists(), ...prefixesProprietaire],
  pagesReglage: pagesAdministration,
  composants: [
    composantWhitelists,
    composantEnseignes,
    {
      prefixe: 'setup',
      niveau: Niveau.ADMIN,
      bouton: (i, parametres) => traiterBoutonReglage(i, parametres),
      menu: (i, parametres) => traiterMenuReglage(i, parametres),
      fenetre: (i, parametres) => traiterFenetreReglage(i, parametres),
    },
    {
      prefixe: 'mods',
      niveau: Niveau.ADMIN,
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [, pageBrute]) {
        const page = Number(pageBrute) || 0;
        const etats = lireEtatsModules(interaction.guildId).filter((s) => s.module.desactivable);
        const tranche = etats.slice(page * MODULES_PAR_MENU, (page + 1) * MODULES_PAR_MENU);
        const choisis = new Set(interaction.values);
        const changements: string[] = [];
        for (const { module, enabled: actif } of tranche) {
          const suivant = choisis.has(module.id);
          if (suivant !== actif) {
            activerModule(interaction.guildId, module.id, suivant);
            changements.push(`${suivant ? '🟢' : '🔴'} ${module.emoji} ${module.nom}`);
          }
        }
        await interaction.update(panneauModules(interaction.guild, changements.length ? `✅ ${changements.join(' · ')}` : 'Aucun changement.'));
      },
    },
    {
      prefixe: 'cfgtest',
      niveau: Niveau.ADMIN,
      async menu(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!interaction.isStringSelectMenu()) return;
        const valeur = interaction.values[0] ?? 'diag';
        if (valeur === 'diag') {
          await interaction.update({ embeds: [diagnostic(interaction.guild)], components: [menuTests(interaction.guild)] });
          return;
        }
        const [moduleId, testId] = valeur.split(':');
        const module = lireModules().find((m) => m.id === moduleId);
        const t = module?.tests?.find((x) => x.id === testId);
        if (!module || !t) throw new ErreurUtilisateur('Ce test n’existe plus.');
        await interaction.deferUpdate();
        let resultat: string;
        try {
          resultat = await t.executer(interaction);
        } catch (echec) {
          resultat = `❌ ${echec instanceof ErreurUtilisateur ? echec.message : 'Le test a échoué.'}`;
        }
        await interaction.editReply({
          embeds: [info(interaction.guild, resultat, { titre: `${module.nom} · ${t.libelle}`, sujet: t.emoji })],
          components: [menuTests(interaction.guild)],
        });
      },
    },
    {
      prefixe: 'cfgleave',
      niveau: Niveau.PROPRIETAIRE_BOT,
      async bouton(interaction: ButtonInteraction<'cached'>, [serveurId, proprietaireId]) {
        if (interaction.user.id !== proprietaireId) {
          await interaction.reply({ embeds: [erreur(interaction.guild, 'Seul l’auteur de la commande peut confirmer.')], flags: 64 });
          return;
        }
        const serveur = interaction.client.guilds.cache.get(serveurId ?? '');
        if (!serveur) {
          await interaction.update({ embeds: [erreur(interaction.guild, 'Le bot n’est plus sur ce serveur.')], components: [] });
          return;
        }
        const nom = serveur.name;
        await serveur.leave();
        await interaction.update({ embeds: [ok(interaction.guild, `Le bot a quitté **${nom}**.`)], components: [] });
      },
    },
  ],
};

