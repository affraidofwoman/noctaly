import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type User,
  UserSelectMenuBuilder,
} from 'discord.js';
import {
  ajouterWhitelist,
  type CleEmoji,
  CLES_EMOJIS,
  COULEUR_DEFAUT,
  creerEnseigne,
  type DefinitionWhitelist,
  emojiPour,
  enHexa,
  enseigneDe,
  entreeWhitelist,
  estEmoji,
  estLienImage,
  estProprietaireFixe,
  estWhitelist,
  libelleNiveau,
  type LiensEnseigne,
  lireCouleur,
  lireEnseigne,
  lireNiveau,
  lireWhitelist,
  listerEnseignes,
  membresListe,
  modifierEnseigne,
  MOTIF_CLE,
  PALETTES,
  peutGererWhitelist,
  poserServeursEnseigne,
  renommerEnseigne,
  retirerWhitelist,
  supprimerEnseigne,
  type WhitelistId,
  WHITELISTS,
  whitelistsMembre, estProprietaireBot, whitelistsVisibles } from '../coeur/acces';
import {
  bouton,
  construireFormulaire,
  demanderConfirmation,
  embedEnseigne,
  erreur,
  estLienHttp,
  info,
  nomEnseigne,
  ok,
  rangee,
  refus,
  repondre,
  suiviReponse,
} from '../coeur/affichage';
import {
  afficherAccueil,
  afficherPage,
  afficherSection,
  lirePageReglage,
  type PageReglage,
  pagesDeSection,
  SECTIONS_REGLAGE,
  type SectionReglage,
  traiterBoutonReglage,
  traiterFenetreReglage,
  traiterMenuReglage,
} from '../coeur/assistant';
import { executer, lireJson } from '../coeur/base';
import { creerSalonsJournal, historiser, journal, salonJournalPour, synchroniserAccesJournaux, TYPES_JOURNAUX } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type GestionnaireComposant, type ModuleBot, type PanneauAffiche, prefixePanneau } from '../coeur/noyau';
import { ErreurUtilisateur, fuseauValide, marqueTemps, resoudreUtilisateur, tronquer, trouverEntree, type DomainePrefixe, DOMAINES_PREFIXES, Niveau } from '../coeur/outils';
import {
  activerModule,
  lireConfig,
  lireEtatsModules,
  lireModules,
  moduleActif,
  THEMES,
  viderCacheConfig,
  viderCacheModules,
} from '../coeur/reglages';
import { menuServeursInstallation } from './installation';

const champPrefixe = (domaine: DomainePrefixe) => ({
  genre: 'text' as const,
  cle: `prefix_${domaine}`,
  libelle: `Préfixe ${DOMAINES_PREFIXES[domaine].label.toLowerCase()}`,
  longueurMax: 5,
  obligatoire: true,
  lire: (c: import('../coeur/reglages').ConfigServeur) => c.prefixes[domaine],
  ecrire: (c: import('../coeur/reglages').ConfigServeur, v: string) => {
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
    description: 'Le thème des messages du bot. « Enseigne » reprend les couleurs du streamer (réglées par l’owner bot).',
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
          if (modele) c.general.couleurs = { ...modele.colors };
        },
      },
      {
        genre: 'text',
        cle: 'primary',
        libelle: 'Couleur principale (#hex)',
        longueurMax: 7,
        lire: (c) => c.general.couleurs.principale,
        ecrire: (c, v) => {
          c.general.couleurs.principale = v.toUpperCase().startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
          c.general.theme = 'custom';
        },
        validate: (v) => (/^#?[0-9a-f]{6}$/i.test(v) ? null : 'Code hexadécimal attendu (ex : #5865F2).'),
      },
      {
        genre: 'text',
        cle: 'footer',
        libelle: 'Pied de page (vide = enseigne)',
        longueurMax: 128,
        lire: (c) => c.general.pied,
        ecrire: (c, v) => {
          c.general.pied = v;
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
          const suivi = suiviReponse(interaction, interaction.guild, 'Salons de logs');
          const { cree, titreLie } = await creerSalonsJournal(interaction.guild, (f, t) => suivi.regler(f, t)).catch((echec: unknown) => {
            throw echec instanceof Error && (echec as { code?: number }).code === 50013
              ? new ErreurUtilisateur('Il me faut la permission « Gérer les salons ».')
              : echec;
          });
          await suivi.terminer();
          await interaction.editReply({ embeds: [ok(interaction.guild, `**${cree}** salon(s) ou catégorie(s) créé(s), **${titreLie}** déjà présent(s) et relié(s).`, { titre: 'Salons de logs' })] });
        },
      },
    ],
  },
];

const LIEES_AUX_JOURNAUX: WhitelistId[] = ['streamer', 'admin', 'sys', 'staff', 'logs'];

function peutGerer(membre: GuildMember, definition: DefinitionWhitelist): boolean {
  return peutGererWhitelist(lireNiveau(membre), definition, estProprietaireFixe(membre.id), membre.id === membre.guild.ownerId);
}

function optionsWhitelists(serveurId: string, spectateurId: string, cibleId?: string) {
  return whitelistsVisibles(estProprietaireBot(spectateurId)).map((w) => {
    const possede = cibleId ? estWhitelist(w.id, cibleId, serveurId) : false;
    return {
      label: tronquer(`${w.groupe} · ${w.libelle}`, 100),
      value: w.id,
      emoji: cibleId ? (possede ? '✅' : w.emoji) : w.emoji,
      description: tronquer(cibleId ? `${possede ? 'Oui — choisir pour retirer' : 'Non — choisir pour donner'} · ${w.description}` : w.description, 100),
    };
  });
}

export function accueilWhitelists(serveur: Guild, spectateurId: string, note?: string) {
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'whitelist')} Whitelists`)
    .setDescription(
      note ??
        [
          'Choisis une whitelist pour en voir la liste.',
          '-# Relance avec quelqu’un (`/wl personne:`) pour l’ajouter ou le retirer.',
        ].join('\n'),
    );
  const groupes = new Map<string, DefinitionWhitelist[]>();
  for (const w of whitelistsVisibles(estProprietaireBot(spectateurId))) groupes.set(w.groupe, [...(groupes.get(w.groupe) ?? []), w]);
  for (const [groupe, liste] of groupes) {
    embed.addFields({
      name: groupe,
      value: liste.map((w) => `${w.emoji} **${w.libelle}** — \`${membresListe(w.id, serveur.id).length}\``).join('\n'),
      inline: true,
    });
  }
  const menu = new StringSelectMenuBuilder().setCustomId('wl:list').setPlaceholder('Quelle whitelist ?').addOptions(optionsWhitelists(serveur.id, spectateurId));
  return { embeds: [embed], components: [rangee(menu)] };
}

export function listeWhitelist(membre: GuildMember, listeId: WhitelistId, note?: string) {
  const serveur = membre.guild;
  const definition = lireWhitelist(listeId)!;
  const ids = membresListe(listeId, serveur.id);
  const lignes = ids.slice(0, 40).map((id) => {
    const entree = entreeWhitelist(listeId, id, serveur.id);
    const extra = entree ? ` · ${marqueTemps(entree.ajoute_le, 'R')}${entree.ajoute_par ? ` par <@${entree.ajoute_par}>` : ''}` : estProprietaireFixe(id) ? ' · *fixe (.env)*' : '';
    return `• <@${id}> \`${id}\`${extra}`;
  });
  const embed = embedEnseigne(serveur)
    .setTitle(`${definition.emoji} Whitelist ${definition.libelle} (${ids.length})`)
    .setDescription(
      [
        `-# ${definition.description}`,
        definition.portee === 'global' ? '-# Portée : **tous les serveurs**' : '',
        note ? `\n${note}` : '',
        '',
        lignes.length ? lignes.join('\n') : '*Personne pour l’instant.*',
        ids.length > 40 ? `-# … +${ids.length - 40} autre(s)` : '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const composants = [];
  if (peutGerer(membre, definition)) {
    composants.push(rangee(new UserSelectMenuBuilder().setCustomId(`wl:add:${listeId}`).setPlaceholder('Ajouter quelqu’un').setMinValues(1).setMaxValues(5)));
    const retirables = ids.filter((id) => !(listeId === 'owner' && estProprietaireFixe(id))).slice(0, 25);
    if (retirables.length) {
      composants.push(
        rangee(
          new StringSelectMenuBuilder()
            .setCustomId(`wl:rm:${listeId}`)
            .setPlaceholder('Retirer quelqu’un')
            .setMinValues(1)
            .setMaxValues(retirables.length)
            .addOptions(
              retirables.map((id) => {
                const m = serveur.members.cache.get(id);
                return { label: tronquer(m?.user.tag ?? id, 100), value: id, description: m ? id : 'hors du serveur' };
              }),
            ),
        ),
      );
    }
  } else {
    embed.setFooter({ text: `Tu peux voir cette liste, pas la modifier (accès requis : ${libelleNiveau(definition.gerePar)})` });
  }
  composants.push(rangee(bouton('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  return { embeds: [embed], components: composants };
}

export function whitelistsDe(membre: GuildMember, cible: User, note?: string) {
  const serveur = membre.guild;
  const actuel = whitelistsMembre(cible.id, serveur.id);
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: cible.tag, iconURL: cible.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiPour(serveur.id, 'whitelist')} Whitelists — ${cible.displayName}`)
    .setDescription(
      [
        `Choisis la whitelist à donner ou retirer à <@${cible.id}>.`,
        note ? `\n${note}` : '',
        '',
        `**Actuellement :** ${actuel.length ? actuel.map((w) => `${w.emoji} ${w.libelle}`).join(' · ') : '*aucune*'}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`wl:user:${cible.id}`)
    .setPlaceholder('Quelle whitelist ?')
    .addOptions(optionsWhitelists(serveur.id, membre.id, cible.id).filter((o) => peutGerer(membre, lireWhitelist(o.value)!)));
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = menu.options.length ? [rangee(menu)] : [];
  composants.push(rangee(bouton('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  if (!menu.options.length) embed.setFooter({ text: 'Tu n’as le droit de modifier aucune whitelist.' });
  return { embeds: [embed], components: composants };
}

export type ResultatBascule = { ok: true; ajoute: boolean; texte: string } | { ok: false; texte: string };

export async function basculerWhitelist(auteur: GuildMember, listeId: WhitelistId, cible: User, forcer?: 'add' | 'remove'): Promise<ResultatBascule> {
  const definition = lireWhitelist(listeId);
  if (!definition) return { ok: false, texte: 'Whitelist inconnue.' };
  const serveur = auteur.guild;
  if (!peutGerer(auteur, definition)) return { ok: false, texte: `Tu ne peux pas modifier la whitelist **${definition.libelle}**.` };
  if (cible.bot) return { ok: false, texte: 'Les bots ne vont pas en whitelist.' };
  if (listeId === 'owner' && estProprietaireFixe(cible.id)) return { ok: false, texte: 'Cet owner est fixé dans la configuration du bot.' };

  const possede = estWhitelist(listeId, cible.id, serveur.id);
  const ajouter = forcer ? forcer === 'add' : !possede;
  if (ajouter === possede) return { ok: true, ajoute: ajouter, texte: `<@${cible.id}> ${ajouter ? 'est déjà' : 'n’est pas'} dans **${definition.libelle}**.` };

  if (ajouter) ajouterWhitelist(listeId, cible.id, serveur.id, auteur.id);
  else retirerWhitelist(listeId, cible.id, serveur.id);

  if (listeId !== 'owner') historiser(serveur.id, 'whitelist', ajouter ? 'add' : 'remove', cible.id, auteur.id, { list: listeId });
  if (listeId !== 'owner') void journal(serveur, 'whitelist', {
    titre: ajouter ? 'Whitelist accordée' : 'Whitelist retirée',
    ton: ajouter ? 'ok' : 'alerte',
    lignes: [`**Whitelist** : ${definition.emoji} ${definition.libelle}${definition.portee === 'global' ? ' *(globale)*' : ''}`, `**Membre** : <@${cible.id}> \`${cible.id}\``],
    par: auteur.user,
  });
  if (LIEES_AUX_JOURNAUX.includes(listeId)) void synchroniserAccesJournaux(serveur).catch(() => undefined);

  return { ok: true, ajoute: ajouter, texte: `<@${cible.id}> ${ajouter ? 'ajouté à' : 'retiré de'} la whitelist **${definition.libelle}**.` };
}

export const composantWhitelists: GestionnaireComposant = {
  prefixe: 'wl',
  niveau: Niveau.STAFF,
  async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
    if (action === 'home') await interaction.update(accueilWhitelists(interaction.guild, interaction.user.id));
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, argument]) {
    const membre = interaction.member;
    if (action === 'list' && interaction.isStringSelectMenu()) {
      const listeId = interaction.values[0] as WhitelistId;
      if (!lireWhitelist(listeId) || (listeId === 'owner' && !estProprietaireBot(membre.id))) return;
      await interaction.update(listeWhitelist(membre, listeId));
      return;
    }
    if (action === 'add' && interaction.isUserSelectMenu() && argument) {
      const resultats: string[] = [];
      for (const utilisateur of interaction.users.values()) {
        const r = await basculerWhitelist(membre, argument as WhitelistId, utilisateur, 'add');
        resultats.push(`${r.ok ? '✅' : '⛔'} ${r.texte}`);
      }
      await interaction.update(listeWhitelist(membre, argument as WhitelistId, resultats.join('\n')));
      return;
    }
    if (action === 'rm' && interaction.isStringSelectMenu() && argument) {
      const resultats: string[] = [];
      for (const id of interaction.values) {
        const utilisateur = await resoudreUtilisateur(interaction.client, id);
        if (!utilisateur) {
          retirerWhitelist(argument as WhitelistId, id, interaction.guildId);
          resultats.push(`✅ \`${id}\` retiré.`);
          continue;
        }
        const r = await basculerWhitelist(membre, argument as WhitelistId, utilisateur, 'remove');
        resultats.push(`${r.ok ? '✅' : '⛔'} ${r.texte}`);
      }
      await interaction.update(listeWhitelist(membre, argument as WhitelistId, resultats.join('\n')));
      return;
    }
    if (action === 'user' && interaction.isStringSelectMenu() && argument) {
      const cible = await resoudreUtilisateur(interaction.client, argument);
      if (!cible) {
        await interaction.update({ embeds: [erreur(interaction.guild, 'Utilisateur introuvable.')], components: [] });
        return;
      }
      const r = await basculerWhitelist(membre, interaction.values[0] as WhitelistId, cible);
      await interaction.update(whitelistsDe(membre, cible, `${r.ok ? '✅' : '⛔'} ${r.texte}`));
    }
  },
};

export function raccourcisWhitelists(): CommandePrefixe[] {
  return WHITELISTS.map((definition) => ({
    nom: definition.raccourci,
    domaine: definition.id === 'owner' ? 'owner' : 'general',
    categorie: definition.id === 'owner' ? 'owner' : 'admin',
    description: `Whitelist ${definition.libelle}`,
    usage: '[membre]',
    niveau: definition.id === 'owner' ? Niveau.PROPRIETAIRE_BOT : Niveau.STAFF,
    async executer(message: Message<true>, parametres: string[]) {
      if (!message.member) return;
      if (!parametres[0]) {
        await message.reply({ ...listeWhitelist(message.member, definition.id), components: [], allowedMentions: { repliedUser: false } });
        return;
      }
      const cible = await resoudreUtilisateur(message.client, parametres[0]);
      if (!cible) {
        await message.reply({ embeds: [erreur(message.guild, 'Identifiant Discord attendu.')], allowedMentions: { repliedUser: false } });
        return;
      }
      const r = await basculerWhitelist(message.member, definition.id, cible);
      const embed = r.ok ? ok(message.guild, r.texte, { titre: 'Whitelist', sujet: definition.emoji }) : refus(message.guild, r.texte);
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  }));
}

const AUCUN = '—';
const EMOJIS_PAR_PAGE = 25;

function exigerEnseigne(cle: string | undefined) {
  const s = cle ? lireEnseigne(cle) : null;
  if (!s) throw new ErreurUtilisateur('Cette enseigne n’existe plus.');
  return s;
}

// - La liste des enseignes -
export function accueilEnseignes(client: Client, note?: string) {
  const enseignes = listerEnseignes();
  const embed = new EmbedBuilder()
    .setColor(COULEUR_DEFAUT)
    .setTitle('🎨 Enseignes')
    .setDescription(note ?? 'Chaque streamer a sa couleur, son nom, son logo et ses émojis. Les messages du bot prennent ceux du serveur où ils sont envoyés.');
  if (enseignes.length) {
    embed.addFields(
      enseignes.slice(0, 24).map((s) => ({
        name: tronquer(s.nom, 256),
        value: `${enHexa(s.couleur ?? COULEUR_DEFAUT)} · ${s.guilds.length} serveur(s)${s.pseudo_twitch ? ` · 🔴 ${s.pseudo_twitch}` : ''}`,
        inline: true,
      })),
    );
  } else {
    embed.addFields({ name: 'Aucune enseigne', value: 'Le bot garde ses couleurs d’origine partout.', inline: false });
  }
  const composants = [];
  if (enseignes.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('cu:open')
          .setPlaceholder('Ouvrir une enseigne')
          .addOptions(
            enseignes.slice(0, 25).map((s) => ({
              label: tronquer(s.nom, 100),
              value: s.cle,
              description: tronquer(`${s.guilds.length} serveur(s) · ${enHexa(s.couleur ?? COULEUR_DEFAUT)}`, 100),
            })),
          ),
      ),
    );
  }
  composants.push(rangee(bouton('cu:new', 'Nouvelle enseigne', ButtonStyle.Success, '➕')));
  void client;
  return { embeds: [embed], components: composants };
}

export function ecranEnseigne(client: Client, cle: string, note?: string) {
  const s = exigerEnseigne(cle);
  const couleur = s.couleur ?? COULEUR_DEFAUT;
  const liens = lireJson<LiensEnseigne>(s.liens, {});
  const emojis = lireJson<Record<string, string>>(s.emojis, {});

  const apercu = new EmbedBuilder()
    .setColor(couleur)
    .setTitle(s.nom)
    .setDescription('Voilà de quoi auront l’air les messages de cette enseigne.')
    .addFields(
      { name: 'Couleur', value: `${enHexa(couleur)}${s.couleur === null ? ' *(celle du bot)*' : ''}`, inline: true },
      { name: 'Émojis repris', value: String(Object.keys(emojis).length), inline: true },
      { name: 'Serveurs couverts', value: String(s.guilds.length), inline: true },
    );
  if (s.logo) apercu.setThumbnail(s.logo);
  if (s.pied) apercu.setFooter({ text: s.pied, iconURL: s.logo ?? undefined });
  if (s.fond) apercu.setImage(s.fond);

  const nomServeur = (id: string) => client.guilds.cache.get(id)?.name ?? id;
  const lignesLiens = (Object.entries(liens) as [string, string][]).filter(([, v]) => v).map(([k, v]) => `• ${k} — ${v}`);
  const reglages = new EmbedBuilder()
    .setColor(couleur)
    .setTitle('Réglages')
    .addFields(
      { name: 'Clé', value: `\`${s.cle}\``, inline: true },
      { name: 'Chaîne Twitch', value: s.pseudo_twitch ? `[${s.pseudo_twitch}](https://twitch.tv/${s.pseudo_twitch})` : AUCUN, inline: true },
      { name: 'Pied de page', value: s.pied || AUCUN, inline: true },
      { name: 'Liens', value: tronquer(lignesLiens.join('\n') || AUCUN, 1024), inline: false },
      { name: 'Serveurs de l’enseigne', value: tronquer(s.guilds.length ? s.guilds.map((g) => `• ${nomServeur(g)}`).join('\n') : AUCUN, 1024), inline: false },
    );
  if (note) reglages.setDescription(note);

  const quoi = new StringSelectMenuBuilder()
    .setCustomId(`cu:what:${cle}`)
    .setPlaceholder('Que veux-tu changer ?')
    .addOptions(
      { label: 'La couleur', value: 'color', description: 'Une palette, ou ton code exact', emoji: '🎨' },
      { label: 'Le nom', value: 'name', description: 'Ce qui s’affiche en tête des écrans', emoji: '🏷️' },
      { label: 'La clé', value: 'key', description: 'L’identifiant, en cas d’erreur de saisie', emoji: '🔑' },
      { label: 'Le pied de page', value: 'footer', description: 'La signature sous chaque message', emoji: '✍️' },
      { label: 'Le logo', value: 'logo', description: 'Une image, en https', emoji: '🖼️' },
      { label: 'Le fond de bienvenue', value: 'background', description: 'L’image derrière la carte d’arrivée', emoji: '🌄' },
      { label: 'La chaîne Twitch', value: 'twitch', description: 'Le pseudo Twitch du streamer', emoji: '🔴' },
      { label: 'Les liens', value: 'links', description: 'Twitch, YouTube, X, TikTok, Instagram', emoji: '🔗' },
      { label: 'Les serveurs couverts', value: 'guilds', description: 'Où cette enseigne s’applique', emoji: '🌐' },
      { label: 'Les émojis', value: 'emojis', description: 'Seulement ceux que tu veux changer', emoji: '😀' },
    );

  return {
    embeds: [apercu, reglages],
    components: [
      rangee(quoi),
      rangee(
        bouton('cu:home', 'Toutes les enseignes', ButtonStyle.Secondary, '⬅️'),
        bouton(`cu:inst:${cle}`, 'Installer un serveur', ButtonStyle.Success, '🏗️').setDisabled(!s.guilds.length),
        bouton(`cu:del:${cle}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
      ),
    ],
  };
}

function ecranCouleur(cle: string) {
  const s = exigerEnseigne(cle);
  const actuel = s.couleur ?? COULEUR_DEFAUT;
  const embed = new EmbedBuilder()
    .setColor(actuel)
    .setTitle('Couleur')
    .setDescription('Quatre familles, six tons chacune. Ou donne ton code exact.')
    .addFields(PALETTES.map((p) => ({ name: p.name, value: `${p.description}\n${p.tons.map((t) => t.name).join(' · ')}`, inline: false })))
    .setFooter({ text: `Actuellement : ${enHexa(actuel)}` });
  const tons = PALETTES.flatMap((p) => p.tons.map((t) => ({ ...t, palette: p.name }))).slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:col:${cle}`)
    .setPlaceholder('Choisir un ton')
    .addOptions(tons.map((t) => ({ label: `${t.name} — ${t.palette}`, value: String(t.color), description: enHexa(t.color), default: t.color === actuel })));
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`cu:hex:${cle}`, 'Code exact', ButtonStyle.Primary),
        bouton(`cu:reset:${cle}`, 'Couleur du bot', ButtonStyle.Secondary),
        bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function ecranServeurs(client: Client, cle: string) {
  const s = exigerEnseigne(cle);
  const serveurs = [...client.guilds.cache.values()].slice(0, 25);
  const embed = new EmbedBuilder()
    .setColor(s.couleur ?? COULEUR_DEFAUT)
    .setTitle('Serveurs de l’enseigne')
    .setDescription('Les messages envoyés sur ces serveurs prennent les couleurs de l’enseigne.\n-# Un serveur ne peut appartenir qu’à une seule enseigne.');
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:srv:${cle}`)
    .setPlaceholder('Choisir les serveurs')
    .setMinValues(0)
    .setMaxValues(Math.max(1, serveurs.length))
    .addOptions(
      serveurs.length
        ? serveurs.map((g) => ({ label: tronquer(g.name, 100), value: g.id, description: `${g.memberCount} membre(s)`, default: s.guilds.includes(g.id) }))
        : [{ label: 'Aucun serveur', value: 'none' }],
    );
  return { embeds: [embed], components: [rangee(menu), rangee(bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary, '⬅️'))] };
}

function ecranEmojis(cle: string, page = 0) {
  const s = exigerEnseigne(cle);
  const enseignes = lireJson<Record<string, string>>(s.emojis, {});
  const cles = (Object.keys(CLES_EMOJIS) as CleEmoji[]).sort();
  const pages = Math.max(1, Math.ceil(cles.length / EMOJIS_PAR_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const tranche = cles.slice(p * EMOJIS_PAR_PAGE, (p + 1) * EMOJIS_PAR_PAGE);
  const pris = Object.entries(enseignes);
  const embed = new EmbedBuilder()
    .setColor(s.couleur ?? COULEUR_DEFAUT)
    .setTitle('Émojis')
    .setDescription('Choisis une clé pour lui donner ton émoji. Celles que tu laisses gardent celui du bot — pas besoin de tout fournir.')
    .addFields({ name: `Repris par l’enseigne (${pris.length})`, value: tronquer(pris.length ? pris.map(([n, c]) => `${c} \`${n}\``).join(' · ') : AUCUN, 1024) })
    .setFooter({ text: `Page ${p + 1} sur ${pages} · ${cles.length} clés en tout` });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:emo:${cle}`)
    .setPlaceholder('Quelle clé changer ?')
    .addOptions(
      tranche.map((k) => ({
        label: k,
        value: k,
        description: enseignes[k] ? 'repris par l’enseigne' : `garde ${CLES_EMOJIS[k]}`,
      })),
    );
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`cu:emop:${cle}:${p - 1}`, 'Précédent', ButtonStyle.Secondary, '⬅️').setDisabled(p === 0),
        bouton(`cu:emop:${cle}:${p + 1}`, 'Suivant', ButtonStyle.Secondary, '➡️').setDisabled(p >= pages - 1),
        bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary),
      ),
    ],
  };
}

const CHAMPS_TEXTE: Record<string, { title: string; label: string; long?: boolean; required: boolean; max: number }> = {
  name: { title: 'Le nom', label: 'Nom de l’enseigne', required: true, max: 64 },
  footer: { title: 'Le pied de page', label: 'Signature (vide = aucune)', required: false, max: 128 },
  logo: { title: 'Le logo', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  background: { title: 'Le fond de bienvenue', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  twitch: { title: 'La chaîne Twitch', label: 'Pseudo Twitch (vide = aucune)', required: false, max: 25 },
};

export const composantEnseignes: GestionnaireComposant = {
  prefixe: 'cu',
  niveau: Niveau.PROPRIETAIRE_BOT,
  async bouton(interaction: ButtonInteraction<'cached'>, [action, cle, extra]) {
    const client = interaction.client;
    switch (action) {
      case 'home':
        await interaction.update(accueilEnseignes(client));
        return;
      case 'm':
        await interaction.update(ecranEnseigne(client, cle!));
        return;
      case 'new':
        await interaction.showModal(
          construireFormulaire('cu:newm', 'Nouvelle enseigne', [
            { id: 'key', libelle: 'Clé (minuscules, chiffres, - et _)', indication: 'ex : zerator', longueurMax: 32, longueurMin: 2 },
            { id: 'name', libelle: 'Nom affiché', indication: 'ex : ZeratoR', longueurMax: 64 },
          ]),
        );
        return;
      case 'hex':
        await interaction.showModal(construireFormulaire(`cu:hexm:${cle}`, 'Code couleur', [{ id: 'value', libelle: 'Code hexadécimal', indication: '#9146FF', longueurMax: 7 }]));
        return;
      case 'reset':
        modifierEnseigne(cle!, { couleur: null });
        await interaction.update(ecranEnseigne(client, cle!, '✅ Couleur remise à celle du bot.'));
        return;
      case 'emop':
        await interaction.update(ecranEmojis(cle!, Number(extra) || 0));
        return;
      case 'inst': {
        const serveurs = exigerEnseigne(cle).guilds.map((id) => client.guilds.cache.get(id)).filter((g): g is Guild => Boolean(g));
        if (!serveurs.length) throw new ErreurUtilisateur('Choisis d’abord les serveurs de l’enseigne.');
        await interaction.update({
          embeds: [info(interaction.guild, 'Quel serveur installer ? Tu verras le plan avant que quoi que ce soit ne soit créé.', { titre: 'Installer un serveur', sujet: '🏗️' })],
          components: [menuServeursInstallation(serveurs), rangee(bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary, '⬅️'))],
        });
        return;
      }
      case 'del': {
        const s = exigerEnseigne(cle);
        await demanderConfirmation(interaction, {
          titre: 'Supprimer l’enseigne ?',
          description: `L’enseigne **${s.nom}** sera supprimée. Ses ${s.guilds.length} serveur(s) reprendront les couleurs du bot.`,
          libelleConfirmation: 'Supprimer',
          surConfirmation: async (i) => {
            supprimerEnseigne(s.cle);
            await i.update({ embeds: [new EmbedBuilder().setColor(0x3fe08f).setDescription(`✅ Enseigne **${s.nom}** supprimée.`)], components: [] });
          },
        });
        return;
      }
    }
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, cle]) {
    if (!interaction.isStringSelectMenu()) return;
    const client = interaction.client;
    const valeur = interaction.values[0] ?? '';
    switch (action) {
      case 'open':
        await interaction.update(ecranEnseigne(client, valeur));
        return;
      case 'what': {
        const s = exigerEnseigne(cle);
        if (valeur === 'color') return void (await interaction.update(ecranCouleur(s.cle)));
        if (valeur === 'guilds') return void (await interaction.update(ecranServeurs(client, s.cle)));
        if (valeur === 'emojis') return void (await interaction.update(ecranEmojis(s.cle)));
        if (valeur === 'key') {
          await interaction.showModal(construireFormulaire(`cu:keym:${s.cle}`, 'La clé', [{ id: 'value', libelle: 'Nouvelle clé (a-z, 0-9, - et _)', valeur: s.cle, longueurMax: 32 }]));
          return;
        }
        if (valeur === 'links') {
          const liens = lireJson<LiensEnseigne>(s.liens, {});
          await interaction.showModal(
            construireFormulaire(`cu:linksm:${s.cle}`, 'Les liens', [
              { id: 'twitch', libelle: 'Twitch', valeur: liens.twitch, obligatoire: false, longueurMax: 200 },
              { id: 'youtube', libelle: 'YouTube', valeur: liens.youtube, obligatoire: false, longueurMax: 200 },
              { id: 'x', libelle: 'X / Twitter', valeur: liens.x, obligatoire: false, longueurMax: 200 },
              { id: 'tiktok', libelle: 'TikTok', valeur: liens.tiktok, obligatoire: false, longueurMax: 200 },
              { id: 'instagram', libelle: 'Instagram', valeur: liens.instagram, obligatoire: false, longueurMax: 200 },
            ]),
          );
          return;
        }
        const champ = CHAMPS_TEXTE[valeur];
        if (!champ) return;
        const actuel = valeur === 'twitch' ? s.pseudo_twitch : (s as unknown as Record<string, string | null>)[valeur];
        await interaction.showModal(
          construireFormulaire(`cu:txtm:${s.cle}:${valeur}`, champ.title, [{ id: 'value', libelle: champ.label, valeur: actuel, obligatoire: champ.required, longueurMax: champ.max }]),
        );
        return;
      }
      case 'col': {
        const couleur = lireCouleur(Number(valeur));
        if (couleur === null) throw new ErreurUtilisateur('Couleur invalide.');
        modifierEnseigne(cle!, { couleur });
        await interaction.update(ecranEnseigne(client, cle!, `✅ Couleur : **${enHexa(couleur)}**`));
        return;
      }
      case 'srv': {
        const ids = interaction.values.filter((v) => v !== 'none');
        poserServeursEnseigne(cle!, ids);
        await interaction.update(ecranEnseigne(client, cle!, `✅ ${ids.length} serveur(s) couvert(s).${ids.length ? ' Pour tout y créer d’un coup : 🏗️ **Installer un serveur**.' : ''}`));
        return;
      }
      case 'emo': {
        const s = exigerEnseigne(cle);
        const actuel = lireJson<Record<string, string>>(s.emojis, {})[valeur];
        await interaction.showModal(
          construireFormulaire(`cu:emom:${s.cle}:${valeur}`, `Émoji « ${valeur} »`, [
            { id: 'value', libelle: 'Émoji (vide = celui du bot)', indication: '<:nom:123456789012345678> ou 🎉', valeur: actuel, obligatoire: false, longueurMax: 64 },
          ]),
        );
        return;
      }
    }
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, cle, extra]) {
    const client = interaction.client;
    const repondreEcran = async (charge: ReturnType<typeof ecranEnseigne>) => {
      if (interaction.isFromMessage()) await interaction.update(charge);
      else await interaction.reply({ ...charge, flags: 64 });
    };
    switch (action) {
      case 'newm': {
        const nouvelleCle = interaction.fields.getTextInputValue('key').trim().toLowerCase();
        const nom = interaction.fields.getTextInputValue('name').trim();
        if (!MOTIF_CLE.test(nouvelleCle)) throw new ErreurUtilisateur('Clé invalide : 2 à 32 caractères parmi a-z, 0-9, - et _.');
        if (lireEnseigne(nouvelleCle)) throw new ErreurUtilisateur('Cette clé existe déjà.');
        creerEnseigne(nouvelleCle, nom || nouvelleCle);
        await repondreEcran(ecranEnseigne(client, nouvelleCle, '✅ Enseigne créée. Choisis maintenant ce que tu veux régler.'));
        return;
      }
      case 'keym': {
        const nouvelleCle = interaction.fields.getTextInputValue('value').trim().toLowerCase();
        if (!MOTIF_CLE.test(nouvelleCle)) throw new ErreurUtilisateur('Clé invalide : 2 à 32 caractères parmi a-z, 0-9, - et _.');
        if (nouvelleCle !== cle && lireEnseigne(nouvelleCle)) throw new ErreurUtilisateur('Cette clé est déjà prise par une autre enseigne.');
        exigerEnseigne(cle);
        renommerEnseigne(cle!, nouvelleCle);
        await repondreEcran(ecranEnseigne(client, nouvelleCle, nouvelleCle === cle ? 'Clé inchangée.' : `✅ Clé changée : \`${cle}\` → \`${nouvelleCle}\`. Serveurs et blacklist suivent.`));
        return;
      }
      case 'hexm': {
        const couleur = lireCouleur(interaction.fields.getTextInputValue('value'));
        if (couleur === null) throw new ErreurUtilisateur('Code attendu : 6 caractères hexadécimaux, ex. `#9146FF`.');
        modifierEnseigne(cle!, { couleur });
        await repondreEcran(ecranEnseigne(client, cle!, `✅ Couleur : **${enHexa(couleur)}**`));
        return;
      }
      case 'txtm': {
        const brut = interaction.fields.getTextInputValue('value').trim();
        if (extra === 'name') {
          if (!brut) throw new ErreurUtilisateur('Le nom ne peut pas être vide.');
          modifierEnseigne(cle!, { nom: brut });
        } else if (extra === 'footer') {
          modifierEnseigne(cle!, { pied: brut || null });
        } else if (extra === 'logo' || extra === 'background') {
          if (brut && !estLienImage(brut)) throw new ErreurUtilisateur('Lien attendu : https, terminé par .png, .jpg, .gif ou .webp.');
          modifierEnseigne(cle!, { [extra]: brut || null });
        } else if (extra === 'twitch') {
          const pseudo = brut.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
          if (pseudo && !/^[a-z0-9_]{3,25}$/.test(pseudo)) throw new ErreurUtilisateur('Pseudo Twitch invalide.');
          modifierEnseigne(cle!, { pseudo_twitch: pseudo || null });
        }
        await repondreEcran(ecranEnseigne(client, cle!, '✅ C’est enregistré.'));
        return;
      }
      case 'linksm': {
        const liens: LiensEnseigne = {};
        const rejetes: string[] = [];
        for (const k of ['twitch', 'youtube', 'x', 'tiktok', 'instagram'] as const) {
          const v = interaction.fields.getTextInputValue(k).trim();
          if (!v) continue;
          if (!estLienHttp(v)) rejetes.push(k);
          else liens[k] = v;
        }
        modifierEnseigne(cle!, { liens });
        await repondreEcran(ecranEnseigne(client, cle!, rejetes.length ? `⚠️ Ignorés (lien http(s) attendu) : ${rejetes.join(', ')}` : '✅ Liens enregistrés.'));
        return;
      }
      case 'emom': {
        const s = exigerEnseigne(cle);
        const cleEmoji = extra as CleEmoji;
        if (!(cleEmoji in CLES_EMOJIS)) throw new ErreurUtilisateur('Clé d’émoji inconnue.');
        const brut = interaction.fields.getTextInputValue('value').trim();
        const emojis = lireJson<Partial<Record<CleEmoji, string>>>(s.emojis, {});
        if (!brut) delete emojis[cleEmoji];
        else if (!estEmoji(brut)) throw new ErreurUtilisateur('Émoji attendu : un émoji unicode ou `<:nom:id>`.');
        else emojis[cleEmoji] = brut;
        modifierEnseigne(s.cle, { emojis });
        if (interaction.isFromMessage()) await interaction.update(ecranEmojis(s.cle));
        else await interaction.reply({ ...ecranEmojis(s.cle), flags: 64 });
        return;
      }
    }
  },
};

// - /modules -

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

// - /test -

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
    `${reglages.bienvenue.salonId ? '✅' : '⚠️'} Salon de bienvenue`,
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

// - Commandes -

const assistant: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('setup').setDescription('Régler le serveur'),
  async executer(interaction) {
    await repondre(interaction, { ...afficherAccueil(interaction.guild), ephemeral: true });
  },
};

const commandeModules: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('modules').setDescription('Les modules'),
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
    .addSubcommand((s) => s.setName('apparence').setDescription('Apparence'))
    .addSubcommand((s) => s.setName('permissions').setDescription('Rôles d’accès'))
    .addSubcommand((s) => s.setName('prefixes').setDescription('Préfixes'))
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
  donnees: new SlashCommandBuilder().setName('test').setDescription('Tester le bot'),
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
    const charge = cible ? whitelistsDe(interaction.member, cible) : accueilWhitelists(interaction.guild, interaction.user.id);
    await repondre(interaction, { ...charge, ephemeral: true });
  },
};

// - Menus façon Airline -
// Rangés par groupe : on choisit, le bot fait le reste.
export interface EntreeMenu {
  id: string;
  nom: string;
  emoji: string;
  groupe: string;
  quoi: string;
  alias?: string[];
}

export function optionsRangees(entrees: EntreeMenu[]) {
  const groupes: string[] = [];
  for (const e of entrees) if (!groupes.includes(e.groupe)) groupes.push(e.groupe);
  return [...entrees]
    .sort((a, b) => groupes.indexOf(a.groupe) - groupes.indexOf(b.groupe) || a.nom.localeCompare(b.nom, 'fr'))
    .slice(0, 25)
    .map((e) => ({ label: tronquer(groupes.length > 1 ? `${e.groupe} · ${e.nom}` : e.nom, 100), value: e.id, emoji: e.emoji, description: tronquer(e.quoi, 100) }));
}

// - /affiche -
function panneauxDisponibles(serveur: Guild): PanneauAffiche[] {
  return lireModules().filter((m) => moduleActif(serveur.id, m.id)).flatMap((m) => m.panneaux ?? []);
}

export function ecranAffiche(serveur: Guild) {
  const panneaux = panneauxDisponibles(serveur);
  const embed = embedEnseigne(serveur)
    .setTitle('🪧 Poser un panneau')
    .setDescription(
      [
        'Choisis le panneau : il est posé **dans ce salon**, tout de suite.',
        '',
        ...panneaux.map((p) => `${p.emoji} **${p.nom}** — ${p.quoi}`),
        '',
        `-# Au clavier : \`${lireConfig(serveur.id).prefixes.salon}<nom>\`, par exemple \`${lireConfig(serveur.id).prefixes.salon}reglement\`.`,
      ].join('\n'),
    );
  if (!panneaux.length) return { embeds: [embed.setDescription('Aucun module à panneau n’est activé (`/modules`).')], components: [] };
  return { embeds: [embed], components: [rangee(new StringSelectMenuBuilder().setCustomId('aff:pick').setPlaceholder('Quel panneau ?').addOptions(optionsRangees(panneaux)))] };
}

const composantAffiche: GestionnaireComposant = {
  prefixe: 'aff',
  niveau: Niveau.ADMIN,
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
    if (!interaction.isStringSelectMenu()) return;
    const serveur = interaction.guild;
    const panneau = panneauxDisponibles(serveur).find((p) => p.id === (action === 'pick' ? interaction.values[0] : id));
    if (!panneau) throw new ErreurUtilisateur('Ce panneau n’est plus disponible.');
    const salon = interaction.channel as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    if (action === 'pick' && panneau.choix) {
      const choix = panneau.choix(serveur);
      if (!choix.length) throw new ErreurUtilisateur(`Rien à poser pour « ${panneau.nom} » pour l’instant.`);
      await interaction.update({
        embeds: [info(serveur, 'Lequel ?', { titre: panneau.nom, sujet: panneau.emoji })],
        components: [rangee(new StringSelectMenuBuilder().setCustomId(`aff:val:${panneau.id}`).setPlaceholder('Lequel ?').addOptions(choix.slice(0, 25)))],
      });
      return;
    }
    await interaction.deferUpdate();
    const note = await panneau.poser(salon, interaction.member, action === 'val' ? interaction.values[0] : undefined);
    await interaction.editReply({ embeds: [ok(serveur, note, { titre: panneau.nom, sujet: panneau.emoji })], components: [] });
  },
};

const affiche: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('affiche').setDescription('Poser un panneau'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranAffiche(interaction.guild), ephemeral: true });
  },
};

// - /serv -
const SECTIONS_SERV: SectionReglage[] = ['welcome', 'security', 'roles', 'tickets', 'logs', 'appearance'];

function pagesServ(): (EntreeMenu & { page: PageReglage })[] {
  return SECTIONS_SERV.flatMap((s) =>
    pagesDeSection(s).map((page) => ({
      id: page.id,
      nom: page.titre,
      emoji: page.emoji,
      groupe: SECTIONS_REGLAGE[s].label,
      quoi: page.description.split('\n')[0]!.replace(/[`*]/g, ''),
      page,
    })),
  );
}

export function ecranServ(serveur: Guild) {
  const embed = embedEnseigne(serveur)
    .setTitle('🏠 Le serveur')
    .setDescription(['Choisis le réglage à ouvrir.', '', '-# Tout le reste est dans `/setup`. Pour tout créer d’un coup : `/installer`.'].join('\n'));
  return { embeds: [embed], components: [rangee(new StringSelectMenuBuilder().setCustomId('srv:pick').setPlaceholder('Quel réglage ?').addOptions(optionsRangees(pagesServ())))] };
}

const composantServ: GestionnaireComposant = {
  prefixe: 'srv',
  niveau: Niveau.ADMIN,
  async menu(interaction: AnySelectMenuInteraction<'cached'>) {
    const page = pagesServ().find((p) => p.id === interaction.values[0]);
    if (!page) throw new ErreurUtilisateur('Réglage introuvable.');
    await interaction.update(afficherPage(interaction.guild, page.page));
  },
};

const serv: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('serv').setDescription('Les réglages du serveur'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranServ(interaction.guild), ephemeral: true });
  },
};

const raccourciPage = (nom: string, alias: string[], pageId: string, description: string): CommandePrefixe => ({
  nom,
  alias,
  domaine: 'general',
  categorie: 'admin',
  description,
  niveau: Niveau.ADMIN,
  async executer(message) {
    const page = lirePageReglage(pageId);
    if (!page) throw new ErreurUtilisateur('Réglage introuvable.');
    await message.reply({ ...afficherPage(message.guild, page), allowedMentions: { repliedUser: false } });
  },
});

const prefixesServeur: CommandePrefixe[] = [
  {
    nom: 'affiche',
    alias: ['panneau', 'panneaux'],
    domaine: 'salon',
    categorie: 'admin',
    description: 'Poser un panneau',
    usage: '[panneau]',
    niveau: Niveau.ADMIN,
    async executer(message, parametres) {
      const panneau = parametres[0] ? trouverEntree(panneauxDisponibles(message.guild), parametres[0]) : undefined;
      if (panneau) return prefixePanneau(panneau, panneau.nom).executer(message, parametres.slice(1));
      await message.reply({ ...ecranAffiche(message.guild), allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'serv',
    alias: ['serveur', 'reglages'],
    domaine: 'general',
    categorie: 'admin',
    description: 'Les réglages du serveur',
    usage: '[réglage]',
    niveau: Niveau.ADMIN,
    async executer(message, parametres) {
      const page = parametres.length ? trouverEntree(pagesServ(), parametres.join(' ')) : undefined;
      await message.reply({ ...(page ? afficherPage(message.guild, page.page) : ecranServ(message.guild)), allowedMentions: { repliedUser: false } });
    },
  },
  raccourciPage('bienvenue', ['welcome'], 'welcome', 'Le message d’arrivée'),
  raccourciPage('depart', ['leave'], 'leave', 'Le message de départ'),
  raccourciPage('autorole', ['autoroles'], 'autorole', 'Rôles à l’arrivée'),
];

// - Préfixes owner -

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
    description: 'Quitter un serveur',
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
  commandes: [assistant, commandeModules, config, test, wl, affiche, serv],
  commandesPrefixe: [...raccourcisWhitelists(), ...prefixesServeur, ...prefixesProprietaire],
  pagesReglage: pagesAdministration,
  composants: [
    composantWhitelists,
    composantEnseignes,
    composantAffiche,
    composantServ,
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
