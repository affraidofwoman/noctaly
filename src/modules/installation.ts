import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type OverwriteResolvable,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { enseigneDe, estProprietaireBot } from '../coeur/acces';
import { bouton, embedEnseigne, ok, rangee, repondre, suiviReponse } from '../coeur/affichage';
import { creerSalonsJournal } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot } from '../coeur/noyau';
import { ErreurUtilisateur, identifiantDepuisTexte, Niveau, tronquer } from '../coeur/outils';
import { activerModule, type ConfigServeur, lireModules, modifierConfig } from '../coeur/reglages';
import { poserPanneauRolesModele } from './messages';

// - Le plan du serveur -
// Ce que l’installation crée, dans l’ordre d’affichage sur Discord.
export type Acces = 'reglement' | 'libre';

export interface SalonPlan {
  cle: string;
  nom: string;
  type: 'texte' | 'vocal';
  lecture?: boolean;
  fils?: boolean;
  sujet?: string;
  alias?: string[];
  lien?(c: ConfigServeur, id: string, roles: Record<string, string>): void;
}

export interface CategoriePlan {
  cle: string;
  nom: string;
  visibilite: 'tous' | 'membres' | 'staff';
  salons: SalonPlan[];
}

export const PLAN: CategoriePlan[] = [
  {
    cle: 'accueil',
    nom: '📌 Accueil',
    visibilite: 'tous',
    salons: [
      { cle: 'bienvenue', nom: '👋・bienvenue', type: 'texte', lecture: true, sujet: 'Les nouveaux arrivants', alias: ['welcome', 'arrivees'], lien: (c, id) => void ((c.bienvenue.salonId ??= id), (c.depart.salonId ??= id)) },
      { cle: 'reglement', nom: '📜・règlement', type: 'texte', lecture: true, sujet: 'À lire et à accepter pour accéder au serveur', alias: ['regles', 'rules'], lien: (c, id, r) => void ((c.reglement.salonId ??= id), (c.reglement.roleAcceptationId ??= r.membre ?? null)) },
      { cle: 'roles', nom: '🎭・rôles', type: 'texte', lecture: true, sujet: 'Tes rôles et tes notifications, en un clic', alias: ['autoroles', 'roles-auto'] },
    ],
  },
  {
    cle: 'infos',
    nom: '📢 Infos',
    visibilite: 'membres',
    salons: [
      { cle: 'annonces', nom: '📢・annonces', type: 'texte', lecture: true, sujet: 'Les nouvelles importantes', alias: ['news', 'annonce'], lien: (c, id) => void (c.annonces.salonDefautId ??= id) },
      { cle: 'lives', nom: '🔴・lives', type: 'texte', lecture: true, sujet: 'Les lives, dès qu’ils commencent', alias: ['live', 'twitch', 'stream', 'streams'], lien: (c, id, r) => void ((c.twitch.salonDefautId ??= id), (c.twitch.roleDefautId ??= r.lives ?? null)) },
      { cle: 'evenements', nom: '📅・événements', type: 'texte', lecture: true, sujet: 'Les soirées et rendez-vous de la commu', alias: ['events', 'evenement', 'horaires-de-streams'], lien: (c, id, r) => void ((c.evenements.salonDefautId ??= id), (c.evenements.roleMentionId ??= r.evenements ?? null)) },
      { cle: 'giveaways', nom: '🎉・giveaways', type: 'texte', lecture: true, sujet: 'Les cadeaux à gagner', alias: ['giveaway', 'concours'], lien: (c, id, r) => void ((c.tirages.salonDefautId ??= id), (c.tirages.roleMentionId ??= r.giveaways ?? null)) },
    ],
  },
  {
    cle: 'discussion',
    nom: '💬 Discussion',
    visibilite: 'membres',
    salons: [
      { cle: 'general', nom: '💬・général', type: 'texte', sujet: 'On parle de tout, dans la bonne humeur', alias: ['chat', 'discussion'], lien: (c, id) => void ((c.anniversaires.salonId ??= id), (c.boosts.salonId ??= id)) },
      { cle: 'medias', nom: '📸・médias', type: 'texte', sujet: 'Images, vidéos et memes', alias: ['media', 'images'] },
      { cle: 'clips', nom: '🎬・clips', type: 'texte', sujet: 'Les meilleurs moments des lives', alias: ['clip'] },
      { cle: 'suggestions', nom: '💡・suggestions', type: 'texte', lecture: true, fils: true, sujet: 'Propose tes idées avec le bouton', alias: ['suggestion', 'idees'], lien: (c, id) => void (c.suggestions.salonId ??= id) },
      { cle: 'commandes', nom: '🤖・commandes', type: 'texte', sujet: 'Les commandes du bot, c’est ici', alias: ['bot', 'bots', 'cmd'], lien: (c, id) => void ((c.xp.salonAnnonceId ??= id), c.commandes.salonsAutorises.length || (c.commandes.salonsAutorises = [id])) },
    ],
  },
  {
    cle: 'support',
    nom: '🎫 Support',
    visibilite: 'membres',
    salons: [{ cle: 'tickets', nom: '🎫・tickets', type: 'texte', lecture: true, sujet: 'Une question, un souci ? Ouvre un ticket', alias: ['ticket', 'aide'], lien: (c, id) => void (c.tickets.salonPanneauId ??= id) }],
  },
  {
    cle: 'vocal',
    nom: '🔊 Vocal',
    visibilite: 'membres',
    salons: [
      { cle: 'vocal-general', nom: '🔊 Discussion', type: 'vocal' },
      { cle: 'vocal-jeux', nom: '🎮 Jeux', type: 'vocal' },
      { cle: 'vocal-musique', nom: '🎵 Musique', type: 'vocal' },
    ],
  },
  {
    cle: 'equipe',
    nom: '🛡️ Équipe',
    visibilite: 'staff',
    salons: [
      { cle: 'staff', nom: '💼・staff', type: 'texte', sujet: 'Entre membres de l’équipe', alias: ['equipe', 'moderation'], lien: (c, id) => void ((c.general.salonStaffId ??= id), (c.antiraid.salonAlerteId ??= id)) },
      { cle: 'candidatures', nom: '📥・candidatures', type: 'texte', sujet: 'Candidatures et partenariats reçus', alias: ['partenariats'], lien: (c, id) => void ((c.formulaires.salonCandidaturesId ??= id), (c.formulaires.salonPartenariatsId ??= id)) },
    ],
  },
];

// - Les rôles de départ -
// Du plus haut au plus bas : chaque rôle créé se range sous le précédent.
export const ROLES_PLAN: { cle: string; nom: string; couleur: number; permissions?: bigint[] }[] = [
  { cle: 'moderation', nom: 'Modération', couleur: 0xe0455a, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.MoveMembers] },
  { cle: 'staff', nom: 'Staff', couleur: 0xf5a524 },
  { cle: 'membre', nom: 'Membre', couleur: 0x9b87f5 },
  { cle: 'majeur', nom: 'Majeur', couleur: 0 },
  { cle: 'mineur', nom: 'Mineur', couleur: 0 },
  { cle: 'lives', nom: 'Notif Lives', couleur: 0 },
  { cle: 'annonces', nom: 'Notif Annonces', couleur: 0 },
  { cle: 'giveaways', nom: 'Notif Giveaways', couleur: 0 },
  { cle: 'evenements', nom: 'Notif Événements', couleur: 0 },
];

const simple = (nom: string) => identifiantDepuisTexte(nom.replace(/^[^\p{L}\p{N}]+/u, ''));

// - Retrouver l’existant -
export function associer(existants: { id: string; nom: string; texte: boolean; categorie: boolean }[], plan: CategoriePlan[]): Map<string, string> {
  const trouves = new Map<string, string>();
  const pris = new Set<string>();
  const chercher = (cle: string, noms: string[], filtre: (e: (typeof existants)[number]) => boolean) => {
    const vises = new Set(noms.map(simple));
    const e = existants.find((x) => !pris.has(x.id) && filtre(x) && vises.has(simple(x.nom)));
    if (e) {
      trouves.set(cle, e.id);
      pris.add(e.id);
    }
  };
  for (const c of plan) {
    chercher(c.cle, [c.nom], (e) => e.categorie);
    for (const s of c.salons) chercher(s.cle, [s.nom, ...(s.alias ?? [])], (e) => !e.categorie && e.texte === (s.type === 'texte'));
  }
  return trouves;
}

// - Les permissions -
export function droits(categorie: CategoriePlan, salon: SalonPlan | null, ids: { tous: string; bot: string; membre?: string; moderation?: string; staff?: string }, acces: Acces): { id: string; allow: bigint[]; deny: bigint[] }[] {
  const table = new Map<string, { id: string; allow: Set<bigint>; deny: Set<bigint> }>();
  const regler = (id: string | undefined, autorise: bigint[], refuse: bigint[] = []) => {
    if (!id) return;
    const e = table.get(id) ?? { id, allow: new Set(), deny: new Set() };
    autorise.forEach((p) => e.allow.add(p));
    refuse.forEach((p) => e.deny.add(p));
    table.set(id, e);
  };
  const P = PermissionFlagsBits;
  regler(ids.bot, [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.AddReactions, P.ManageMessages, ...(salon?.type === 'texte' ? [] : [P.Connect, P.Speak])]);
  if (categorie.visibilite === 'staff' || (categorie.visibilite === 'membres' && acces === 'reglement')) {
    regler(ids.tous, [], [P.ViewChannel]);
    if (categorie.visibilite === 'membres') regler(ids.membre, [P.ViewChannel]);
    regler(ids.moderation, [P.ViewChannel]);
    regler(ids.staff, [P.ViewChannel]);
  }
  if (salon?.lecture) {
    regler(ids.tous, [], [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads, ...(salon.fils ? [] : [P.SendMessagesInThreads])]);
    regler(ids.moderation, [P.SendMessages]);
  }
  return [...table.values()].map((e) => ({ id: e.id, allow: [...e.allow], deny: [...e.deny] }));
}

// - L’installation -
const REQUISES: [bigint, string][] = [
  [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
  [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
  [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement'],
  [PermissionFlagsBits.MuteMembers, 'Rendre muet'],
  [PermissionFlagsBits.MoveMembers, 'Déplacer des membres'],
];

const MODULES_INSTALLES = ['welcome', 'leave', 'rules', 'reactionroles', 'tickets', 'suggestions', 'logs'];

async function poserPanneau(serveur: Guild, id: string, salon: GuildTextBasedChannel): Promise<void> {
  const panneau = lireModules().flatMap((m) => m.panneaux ?? []).find((p) => p.id === id);
  if (panneau && serveur.members.me) await panneau.poser(salon, serveur.members.me);
}

export async function installer(serveur: Guild, acces: Acces, progression?: (fait: number, total: number) => void): Promise<string[]> {
  const moi = serveur.members.me;
  if (!moi) throw new ErreurUtilisateur('Le bot n’est pas prêt sur ce serveur.');
  const manquantes = REQUISES.filter(([p]) => !moi.permissions.has(p)).map(([, l]) => l);
  if (manquantes.length) throw new ErreurUtilisateur(`Il me manque des permissions : **${manquantes.join('**, **')}**.\n-# Le plus simple : donne-moi la permission Administrateur le temps de l’installation.`);
  const enseigne = enseigneDe(serveur.id);
  const salonsPrevus = PLAN.reduce((n, c) => n + 1 + c.salons.length, 0);
  const membres = acces === 'reglement' ? await serveur.members.fetch().then((m) => [...m.values()].filter((x) => !x.user.bot)) : [];
  const total = ROLES_PLAN.length + salonsPrevus + 22 + 5 + membres.length;
  let fait = 0;
  const pas = () => progression?.(++fait, total);
  const rapport = { roles: 0, rolesRepris: 0, salons: 0, salonsRepris: 0, panneaux: [] as string[], membres: 0 };

  const roles: Record<string, string> = {};
  for (const r of ROLES_PLAN) {
    const existant = serveur.roles.cache.find((x) => !x.managed && simple(x.name) === simple(r.nom));
    if (existant) {
      roles[r.cle] = existant.id;
      rapport.rolesRepris++;
    } else {
      const cree = await serveur.roles.create({ name: r.nom, color: r.couleur, permissions: r.permissions ?? [], mentionable: false, reason: 'Installation du serveur' });
      roles[r.cle] = cree.id;
      rapport.roles++;
    }
    pas();
  }

  const existants = associer(
    [...serveur.channels.cache.values()].map((c) => ({ id: c.id, nom: c.name, texte: c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement, categorie: c.type === ChannelType.GuildCategory })),
    PLAN,
  );
  const ids = { tous: serveur.roles.everyone.id, bot: moi.id, membre: roles.membre, moderation: roles.moderation, staff: roles.staff };
  const versDiscord = (liste: ReturnType<typeof droits>): OverwriteResolvable[] => liste.map((d) => ({ id: d.id, allow: d.allow, deny: d.deny, type: d.id === moi.id ? OverwriteType.Member : OverwriteType.Role }));
  const liens: { lien: NonNullable<SalonPlan['lien']>; id: string }[] = [];
  const nouveaux = new Map<string, GuildBasedChannel>();

  for (const categorie of PLAN) {
    let parentId = existants.get(categorie.cle);
    if (parentId) rapport.salonsRepris++;
    else {
      const cree = await serveur.channels.create({ name: categorie.nom, type: ChannelType.GuildCategory, permissionOverwrites: versDiscord(droits(categorie, null, ids, acces)), reason: 'Installation du serveur' });
      parentId = cree.id;
      rapport.salons++;
    }
    pas();
    for (const salon of categorie.salons) {
      let id = existants.get(salon.cle);
      if (id) rapport.salonsRepris++;
      else {
        const cree = await serveur.channels.create({
          name: salon.nom,
          type: salon.type === 'texte' ? ChannelType.GuildText : ChannelType.GuildVoice,
          parent: parentId,
          topic: salon.type === 'texte' ? salon.sujet : undefined,
          permissionOverwrites: versDiscord(droits(categorie, salon, ids, acces)),
          reason: 'Installation du serveur',
        });
        id = cree.id;
        nouveaux.set(salon.cle, cree);
        rapport.salons++;
      }
      if (salon.lien) liens.push({ lien: salon.lien, id });
      pas();
    }
  }

  modifierConfig(serveur.id, (c) => {
    for (const { lien, id } of liens) lien(c, id, roles);
    if (roles.moderation && !c.permissions.moderateur.includes(roles.moderation)) c.permissions.moderateur.push(roles.moderation);
    if (roles.staff && !c.permissions.staff.includes(roles.staff)) c.permissions.staff.push(roles.staff);
  });
  for (const id of MODULES_INSTALLES) activerModule(serveur.id, id, true);

  const journaux = await creerSalonsJournal(serveur, (f, t) => progression?.(fait + Math.round((f / t) * 22), total));
  fait += 22;

  // - Les panneaux, seulement dans les salons neufs -
  const texte = (cle: string) => nouveaux.get(cle) as GuildTextBasedChannel | undefined;
  const essayer = async (nom: string, action: () => Promise<unknown>) => {
    await action()
      .then(() => rapport.panneaux.push(nom))
      .catch(() => undefined);
    pas();
  };
  const salonReglement = texte('reglement');
  if (salonReglement) await essayer('règlement', () => poserPanneau(serveur, 'reglement', salonReglement));
  const salonRoles = texte('roles');
  if (salonRoles) {
    await essayer('âge', () =>
      poserPanneauRolesModele(salonRoles, {
        titre: '🎂 Ton âge',
        description: 'Pour que chacun profite des salons qui lui correspondent.',
        mode: 'unique',
        genre: 'age',
        roles: [
          { id: roles.mineur!, emoji: '🧒', libelle: 'Mineur' },
          { id: roles.majeur!, emoji: '🧑', libelle: 'Majeur' },
        ],
      }),
    );
    await essayer('notifications', () =>
      poserPanneauRolesModele(salonRoles, {
        titre: '🔔 Tes notifications',
        description: `Choisis ce qui mérite une mention. Tu peux changer d’avis quand tu veux.`,
        mode: 'toggle',
        genre: 'notification',
        roles: [
          { id: roles.lives!, emoji: '🔴', libelle: 'Lives' },
          { id: roles.annonces!, emoji: '📢', libelle: 'Annonces' },
          { id: roles.giveaways!, emoji: '🎉', libelle: 'Giveaways' },
          { id: roles.evenements!, emoji: '📅', libelle: 'Événements' },
        ],
      }),
    );
  } else fait += 2;
  const salonTickets = texte('tickets');
  if (salonTickets) await essayer('tickets', () => poserPanneau(serveur, 'tickets', salonTickets));
  const salonSuggestions = texte('suggestions');
  if (salonSuggestions) await essayer('suggestions', () => poserPanneau(serveur, 'suggestions', salonSuggestions));

  const membre = roles.membre ? serveur.roles.cache.get(roles.membre) : undefined;
  if (membre) {
    for (const m of membres) {
      if (!m.roles.cache.has(membre.id)) {
        await m.roles.add(membre, 'Installation : membre déjà présent').catch(() => undefined);
        rapport.membres++;
      }
      pas();
    }
  }

  return [
    `🏗️ **${rapport.salons}** salon(s) et catégorie(s) créés · **${rapport.salonsRepris}** repris tels quels`,
    `🎭 **${rapport.roles}** rôle(s) créés · **${rapport.rolesRepris}** repris`,
    `📜 Logs : **${journaux.cree}** créé(s) · **${journaux.titreLie}** repris`,
    `🪧 Panneaux posés : ${rapport.panneaux.length ? rapport.panneaux.join(', ') : 'aucun (salons déjà existants)'}`,
    acces === 'reglement' ? `✅ Accès après le règlement · **${rapport.membres}** membre(s) déjà là ont reçu <@&${roles.membre}>` : '🔓 Accès libre : tout le monde voit tout',
    '',
    `-# ${enseigne.cle ? `Aux couleurs de **${enseigne.nom}**. ` : ''}Tout se retouche dans \`/serv\`, les panneaux se reposent avec \`/affiche\`.`,
  ];
}

// - L’écran d’installation -
export function ecranInstallation(serveur: Guild) {
  const embed = embedEnseigne(serveur)
    .setTitle('🏗️ Installer le serveur')
    .setDescription(
      [
        'Le bot crée ce qui manque, relie chaque réglage et pose les panneaux.',
        '**Rien n’est supprimé ni écrasé** : un salon ou un rôle déjà là est repris.',
      ].join('\n'),
    )
    .addFields(
      ...PLAN.map((c) => ({
        name: c.nom,
        value: tronquer(c.salons.map((s) => `${s.nom}${s.lecture ? ' 🔒' : ''}`).join('\n'), 1024),
        inline: true,
      })),
      { name: '🎭 Rôles', value: ROLES_PLAN.map((r) => r.nom).join(' · '), inline: false },
      { name: '📜 Logs', value: 'Une catégorie privée, un salon par sujet, visible selon les whitelists.', inline: false },
      {
        name: 'Qui voit quoi ?',
        value: [
          '🔒 **Après le règlement** : les nouveaux ne voient que l’accueil tant qu’ils n’ont pas accepté. Les membres déjà là reçoivent le rôle Membre.',
          '🔓 **Libre** : tout est visible tout de suite, le règlement reste à lire.',
          '-# 🔒 à côté d’un salon : seul le bot et la modération y écrivent.',
        ].join('\n'),
        inline: false,
      },
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton(`inst:go:reglement:${serveur.id}`, 'Accès après le règlement', ButtonStyle.Success, '🔒'),
        bouton(`inst:go:libre:${serveur.id}`, 'Accès libre', ButtonStyle.Secondary, '🔓'),
      ),
    ],
  };
}

export function menuServeursInstallation(serveurs: Guild[]) {
  return rangee(
    new StringSelectMenuBuilder()
      .setCustomId('inst:pick')
      .setPlaceholder('Quel serveur installer ?')
      .addOptions(serveurs.slice(0, 25).map((g) => ({ label: tronquer(g.name, 100), value: g.id, description: `${g.memberCount} membre(s)` }))),
  );
}

const commandeInstaller: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('installer').setDescription('Installer le serveur'),
  async executer(interaction) {
    await repondre(interaction, { ...ecranInstallation(interaction.guild), ephemeral: true });
  },
};

const prefixesInstallation: CommandePrefixe[] = [
  {
    nom: 'installer',
    alias: ['install', 'setupauto'],
    domaine: 'general',
    categorie: 'admin',
    description: 'Installer le serveur',
    niveau: Niveau.ADMIN,
    async executer(message) {
      await message.reply({ ...ecranInstallation(message.guild), allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleInstallation: ModuleBot = {
  id: 'installation',
  nom: 'Installation',
  emoji: '🏗️',
  description: 'Salons, rôles, permissions, logs et panneaux en un clic',
  desactivable: false,
  actifParDefaut: true,
  commandes: [commandeInstaller],
  commandesPrefixe: prefixesInstallation,
  composants: [
    {
      prefixe: 'inst',
      niveau: Niveau.ADMIN,
      async bouton(interaction: ButtonInteraction<'cached'>, [action, acces, serveurId]) {
        if (action !== 'go' || (acces !== 'reglement' && acces !== 'libre')) return;
        if (serveurId !== interaction.guildId && !estProprietaireBot(interaction.user.id)) throw new ErreurUtilisateur('Réservé aux owners du bot.');
        const serveur = interaction.client.guilds.cache.get(serveurId ?? '');
        if (!serveur) throw new ErreurUtilisateur('Je ne suis plus sur ce serveur.');
        await interaction.update({ embeds: [ok(interaction.guild, 'C’est parti…', { titre: `Installation de ${serveur.name}`, sujet: '🏗️' })], components: [] });
        const suivi = suiviReponse(interaction, interaction.guild, `Installation de ${serveur.name}`);
        try {
          const lignes = await installer(serveur, acces, (f, t) => suivi.regler(f, t));
          await suivi.terminer();
          await interaction.editReply({ embeds: [ok(interaction.guild, lignes.join('\n'), { titre: 'Serveur installé', sujet: '🏗️' })], components: [] });
        } catch (echec) {
          await suivi.terminer();
          throw echec;
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!estProprietaireBot(interaction.user.id)) throw new ErreurUtilisateur('Réservé aux owners du bot.');
        const serveur = interaction.client.guilds.cache.get(interaction.values[0] ?? '');
        if (!serveur) throw new ErreurUtilisateur('Je ne suis plus sur ce serveur.');
        await interaction.update(ecranInstallation(serveur));
      },
    },
  ],
};
