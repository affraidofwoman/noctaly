import { randomInt } from 'node:crypto';
import {
  AuditLogEvent,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type GuildTextBasedChannel,
  GuildVerificationLevel,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { botPeutGererRole, estExempte, estProprietaireBot, membresListe } from '../coeur/acces';
import { bouton, construireFormulaire, couleurPour, erreur, info, ok, rangee, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import {
  CarteExpirante,
  creerRegistre,
  ErreurUtilisateur,
  formaterDuree,
  joursDepuis,
  LimiteurFenetre,
  marqueTemps, Niveau } from '../coeur/outils';
import { lireConfig, modifierConfig } from '../coeur/reglages';
import { donnerRolesAuto } from './arrivees';
import { serveurVerrouille, verrouiller } from './moderation';

const registre = creerRegistre('antiraid');

const arrivees = new Map<string, number[]>();
const membresRecents = new Map<string, GuildMember[]>();
const derniereAlerte = new Map<string, number>();
const limiteurMentions = new Map<string, LimiteurFenetre>();
const modeRaid = new Map<string, { jusqua: number; niveauPrecedent: GuildVerificationLevel }>();
const DUREE_MODE_RAID_MS = 30 * 60_000;

function enregistrerArrivee(membre: GuildMember, fenetreMs: number): number {
  const maintenant = Date.now();
  const liste = (arrivees.get(membre.guild.id) ?? []).filter((t) => maintenant - t < fenetreMs);
  liste.push(maintenant);
  arrivees.set(membre.guild.id, liste);
  const membres = (membresRecents.get(membre.guild.id) ?? []).filter((m) => maintenant - (m.joinedTimestamp ?? maintenant) < fenetreMs).slice(-60);
  membres.push(membre);
  membresRecents.set(membre.guild.id, membres);
  return liste.length;
}

async function alerter(serveur: Guild, titre: string, lignes: string[]): Promise<void> {
  void journal(serveur, 'security', { titre, ton: 'alerte', lignes });
  if ((derniereAlerte.get(serveur.id) ?? 0) > Date.now()) return;
  derniereAlerte.set(serveur.id, Date.now() + 10 * 60_000);
  const embed = new EmbedBuilder().setColor(couleurPour(serveur, 'error')).setTitle(`🚨 ${titre}`).setDescription(lignes.join('\n')).setFooter({ text: serveur.name }).setTimestamp();
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).antiraid.salonAlerteId);
  if (salon) await salon.send({ embeds: [embed] }).catch(() => undefined);
  const destinataires = new Set([serveur.ownerId, ...membresListe('streamer', serveur.id)]);
  for (const id of destinataires) {
    const utilisateur = await serveur.client.users.fetch(id).catch(() => null);
    await utilisateur?.send({ embeds: [embed] }).catch(() => undefined);
  }
}

async function activerModeRaid(serveur: Guild): Promise<boolean> {
  if (modeRaid.has(serveur.id)) return false;
  if (!serveur.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return false;
  const niveauPrecedent = serveur.verificationLevel;
  if (niveauPrecedent < GuildVerificationLevel.High) {
    await serveur.setVerificationLevel(GuildVerificationLevel.High, 'Anti-raid : salve d’arrivées anormale').catch(() => undefined);
  }
  modeRaid.set(serveur.id, { jusqua: Date.now() + DUREE_MODE_RAID_MS, niveauPrecedent });
  return true;
}

async function surArrivee(membre: GuildMember): Promise<'stop' | void> {
  if (membre.user.bot) return;
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).antiraid;
  const nombre = enregistrerArrivee(membre, reglages.fenetreArriveesSecondes * 1000);
  const age = joursDepuis(membre.user.createdTimestamp);

  if (reglages.ageCompteMinJours && age < reglages.ageCompteMinJours && reglages.actionSuspects !== 'none') {
    const raison = `Anti-raid : compte de ${age} jour(s)`;
    if (reglages.actionSuspects === 'kick' && membre.kickable) {
      await membre.send({ embeds: [info(serveur, `Ton compte est trop récent pour rejoindre **${serveur.name}** pour le moment. Réessaie dans quelques jours.`)] }).catch(() => undefined);
      await membre.kick(raison).catch(() => undefined);
      void journal(serveur, 'security', { titre: 'Compte suspect expulsé', ton: 'alerte', lignes: [`<@${membre.id}> \`${membre.user.tag}\` — compte de ${age} j`] });
      return 'stop';
    }
    if (reglages.actionSuspects === 'timeout' && membre.moderatable) {
      await membre.timeout(60 * 60_000, raison).catch(() => undefined);
      void journal(serveur, 'security', { titre: 'Compte suspect en timeout', ton: 'alerte', lignes: [`<@${membre.id}> \`${membre.user.tag}\` — compte de ${age} j (1 h)`] });
    }
  }

  if (nombre < reglages.seuilArrivees) return;
  const recents = membresRecents.get(serveur.id) ?? [];
  const jeunes = recents.filter((m) => joursDepuis(m.user.createdTimestamp) < 7).length;
  const modeRaidActive = await activerModeRaid(serveur);
  let texteVerrouillage = '';
  if (reglages.verrouillageAuto && !serveurVerrouille(serveur.id) && serveur.members.me) {
    const r = await verrouiller(serveur, 'server', serveur.id, serveur.members.me.user, 'Anti-raid automatique').catch(() => null);
    if (r) texteVerrouillage = `🔒 Lockdown automatique : **${r.verrouilles}** salon(s) fermés (\`/lockdown end\` pour rouvrir).`;
  }
  historiser(serveur.id, 'security', 'raid', null, null, { joins: nombre, young: jeunes });
  await alerter(serveur, 'Anti-raid — arrivées massives', [
    `**${nombre}** arrivées en **${reglages.fenetreArriveesSecondes} s** (seuil : ${reglages.seuilArrivees}).`,
    `Comptes de moins de 7 jours : **${jeunes}**`,
    modeRaidActive ? `🛡️ Niveau de vérification monté à « Élevé » pendant ${formaterDuree(DUREE_MODE_RAID_MS)}.` : '',
    texteVerrouillage,
    '',
    `Derniers arrivés : ${recents.slice(-10).map((m) => `<@${m.id}>`).join(' ')}`,
  ].filter(Boolean));
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member || estExempte(message.member)) return;
  const reglages = lireConfig(message.guildId).antiraid;
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  if (!mentions || !reglages.seuilMentions) return;
  const cle = `${message.guildId}:${reglages.seuilMentions}`;
  let limiteur = limiteurMentions.get(cle);
  if (!limiteur) limiteurMentions.set(cle, (limiteur = new LimiteurFenetre(reglages.seuilMentions, 30_000)));
  let bloques = false;
  for (let i = 0; i < mentions; i++) if (!limiteur.compter(message.author.id)) bloques = true;
  if (!bloques) return;
  limiteur.reinitialiser(message.author.id);
  await message.delete().catch(() => undefined);
  if (message.member.moderatable) await message.member.timeout(30 * 60_000, 'Anti-raid : mentions massives').catch(() => undefined);
  await alerter(message.guild, 'Anti-raid — mentions massives', [`<@${message.author.id}> a mentionné plus de **${reglages.seuilMentions}** personnes/rôles en 30 s.`, 'Message supprimé et membre mis en timeout 30 min.']);
}

const antiraid: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Protection contre les raids')
    .addSubcommand((s) => s.setName('status').setDescription('État de la protection'))
    .addSubcommand((s) => s.setName('panique').setDescription('Mode raid immédiat : vérification élevée et lockdown'))
    .addSubcommand((s) => s.setName('fin').setDescription('Terminer le mode raid')),
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'panique') {
      await interaction.deferReply({ flags: 64 });
      await activerModeRaid(serveur);
      const r = serveurVerrouille(serveur.id) ? null : await verrouiller(serveur, 'server', serveur.id, interaction.user, 'Mode panique anti-raid').catch(() => null);
      return interaction.editReply({ embeds: [ok(serveur, `🚨 Mode raid activé : vérification élevée${r ? `, **${r.verrouilles}** salon(s) verrouillés` : ''}.\n-# \`/antiraid fin\` puis \`/lockdown end portee:Serveur\` pour revenir à la normale.`)] });
    }
    if (sousCommande === 'fin') {
      const etat = modeRaid.get(serveur.id);
      if (etat) {
        await serveur.setVerificationLevel(etat.niveauPrecedent, 'Fin du mode raid').catch(() => undefined);
        modeRaid.delete(serveur.id);
      }
      return repondre(interaction, { embeds: [ok(serveur, etat ? 'Mode raid terminé, vérification remise à son niveau habituel.' : 'Aucun mode raid en cours.')], ephemeral: true });
    }
    const reglages = lireConfig(serveur.id).antiraid;
    const etat = modeRaid.get(serveur.id);
    return repondre(interaction, {
      embeds: [
        info(
          serveur,
          [
            `• Seuil — **${reglages.seuilArrivees}** arrivées en **${reglages.fenetreArriveesSecondes} s**`,
            `• Comptes suspects — moins de **${reglages.ageCompteMinJours} j** → ${reglages.actionSuspects === 'none' ? 'rien' : reglages.actionSuspects}`,
            `• Lockdown automatique — **${reglages.verrouillageAuto ? 'oui' : 'non'}**`,
            `• Mentions massives — **${reglages.seuilMentions}** en 30 s`,
            `• Mode raid — ${etat ? `actif jusqu’à ${marqueTemps(etat.jusqua, 'R')}` : 'inactif'}`,
            `• Lockdown serveur — ${serveurVerrouille(serveur.id) ? '🔒 en cours' : 'non'}`,
          ].join('\n'),
          { titre: 'Anti-raid', sujet: '🚨' },
        ),
      ],
      ephemeral: true,
    });
  },
};

const pageReglage: PageReglage = {
  id: 'antiraid',
  section: 'security',
  titre: 'Anti-raid',
  emoji: '🚨',
  moduleId: 'antiraid',
  ordre: 3,
  description: 'Arrivées massives → alerte (salon + MP au propriétaire et aux streamers), vérification Discord renforcée 30 min, lockdown en option.',
  champs: [
    { genre: 'channel', cle: 'alert', libelle: 'Salon d’alerte (en plus de securite-log)', lire: (c) => c.antiraid.salonAlerteId, ecrire: (c, v) => void (c.antiraid.salonAlerteId = v) },
    {
      genre: 'choice',
      cle: 'suspicious',
      libelle: 'Comptes trop récents',
      options: [
        { valeur: 'none', libelle: 'Ne rien faire (alerte seulement)', emoji: '👀' },
        { valeur: 'timeout', libelle: 'Timeout 1 h', emoji: '⏳' },
        { valeur: 'kick', libelle: 'Expulser', emoji: '👢' },
      ],
      lire: (c) => c.antiraid.actionSuspects,
      ecrire: (c, v) => void (c.antiraid.actionSuspects = v as 'none' | 'timeout' | 'kick'),
    },
    { genre: 'toggle', cle: 'lock', libelle: 'Lockdown automatique', lire: (c) => c.antiraid.verrouillageAuto, ecrire: (c, v) => void (c.antiraid.verrouillageAuto = v) },
    { genre: 'number', cle: 'threshold', libelle: 'Arrivées déclenchant l’alerte', min: 3, max: 500, lire: (c) => c.antiraid.seuilArrivees, ecrire: (c, v) => void (c.antiraid.seuilArrivees = v) },
    { genre: 'number', cle: 'window', libelle: 'Fenêtre', min: 5, max: 3600, unite: 's', lire: (c) => c.antiraid.fenetreArriveesSecondes, ecrire: (c, v) => void (c.antiraid.fenetreArriveesSecondes = v) },
    { genre: 'number', cle: 'age', libelle: 'Compte suspect si moins de', min: 0, max: 365, unite: 'j', lire: (c) => c.antiraid.ageCompteMinJours, ecrire: (c, v) => void (c.antiraid.ageCompteMinJours = v) },
    { genre: 'number', cle: 'mentions', libelle: 'Mentions max en 30 s', min: 5, max: 500, lire: (c) => c.antiraid.seuilMentions, ecrire: (c, v) => void (c.antiraid.seuilMentions = v) },
  ],
};

export const moduleAntiraid: ModuleBot = {
  id: 'antiraid',
  nom: 'Anti-raid',
  emoji: '🚨',
  description: 'Arrivées massives, comptes suspects, mentions massives',
  desactivable: true,
  actifParDefaut: true,
  commandes: [antiraid],
  pagesReglage: [pageReglage],
  evenements: [sur('guildMemberAdd', (m) => surArrivee(m), 2), sur('messageCreate', (m) => surMessage(m), 11)],
  taches: [
    {
      nom: 'antiraid-restore',
      intervalleMs: 60_000,
      async executer(client) {
        for (const [serveurId, etat] of modeRaid) {
          if (etat.jusqua > Date.now()) continue;
          modeRaid.delete(serveurId);
          const serveur = client.guilds.cache.get(serveurId);
          if (!serveur) continue;
          await serveur.setVerificationLevel(etat.niveauPrecedent, 'Anti-raid : retour au niveau habituel').catch(() => undefined);
          void journal(serveur, 'security', { titre: 'Anti-raid — retour à la normale', ton: 'ok', lignes: ['Le niveau de vérification est revenu à son réglage habituel.'] });
          registre.info(`Mode raid terminé sur ${serveurId}`);
        }
      },
    },
  ],
};

const registreAntinuke = creerRegistre('antinuke');

type Compteur = 'channelDelete' | 'channelCreate' | 'roleDelete' | 'roleCreate' | 'ban' | 'kick' | 'creationWebhook';

const ACTIONS: Partial<Record<AuditLogEvent, { counter: Compteur; label: string }>> = {
  [AuditLogEvent.ChannelDelete]: { counter: 'channelDelete', label: 'suppressions de salons' },
  [AuditLogEvent.ChannelCreate]: { counter: 'channelCreate', label: 'créations de salons' },
  [AuditLogEvent.RoleDelete]: { counter: 'roleDelete', label: 'suppressions de rôles' },
  [AuditLogEvent.RoleCreate]: { counter: 'roleCreate', label: 'créations de rôles' },
  [AuditLogEvent.MemberBanAdd]: { counter: 'ban', label: 'bannissements' },
  [AuditLogEvent.MemberKick]: { counter: 'kick', label: 'expulsions' },
  [AuditLogEvent.WebhookCreate]: { counter: 'creationWebhook', label: 'créations de webhooks' },
};

const DANGEREUSES = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
];

const historique = new Map<string, number[]>();
const sanctionnes = new Map<string, number>();

function estDeConfiance(serveur: Guild, utilisateurId: string): boolean {
  if (utilisateurId === serveur.ownerId || utilisateurId === serveur.members.me?.id || estProprietaireBot(utilisateurId)) return true;
  const reglages = lireConfig(serveur.id).antinuke;
  return reglages.membresDeConfiance.includes(utilisateurId) || membresListe('streamer', serveur.id).includes(utilisateurId);
}

export function compterAction(cle: string, fenetreMs: number, maintenant = Date.now()): number {
  const liste = (historique.get(cle) ?? []).filter((t) => maintenant - t < fenetreMs);
  liste.push(maintenant);
  historique.set(cle, liste);
  return liste.length;
}

async function neutraliser(serveur: Guild, executantId: string, raison: string): Promise<string> {
  const reglages = lireConfig(serveur.id).antinuke;
  const membre = await serveur.members.fetch(executantId).catch(() => null);
  if (!membre) return 'compte introuvable';
  if (reglages.action === 'alert') return 'alerte seulement';
  const moi = serveur.members.me!;
  if (moi.roles.highest.comparePositionTo(membre.roles.highest) <= 0) return 'impossible : son rôle est au-dessus du mien';
  if (membre.user.bot && reglages.action !== 'ban') {
    await membre.kick(raison).catch(() => undefined);
    return 'bot expulsé';
  }
  if (reglages.action === 'ban') {
    await membre.ban({ reason: raison }).catch(() => undefined);
    return 'banni';
  }
  if (reglages.action === 'kick') {
    await membre.kick(raison).catch(() => undefined);
    return 'expulsé';
  }
  const roles = membre.roles.cache.filter((r) => r.id !== serveur.id && !r.managed && DANGEREUSES.some((p) => r.permissions.has(p)) && moi.roles.highest.comparePositionTo(r) > 0);
  if (roles.size) await membre.roles.remove([...roles.keys()], raison).catch(() => undefined);
  return `rôles dangereux retirés (${roles.size})`;
}

async function surAudit(entree: GuildAuditLogsEntry, serveur: Guild): Promise<void> {
  const definition = ACTIONS[entree.action];
  const executantId = entree.executorId;
  if (!definition || !executantId || estDeConfiance(serveur, executantId)) return;
  const reglages = lireConfig(serveur.id).antinuke;
  const seuil = reglages.thresholds[definition.counter];
  if (!seuil) return;
  const nombre = compterAction(`${serveur.id}:${executantId}:${definition.counter}`, reglages.fenetreSecondes * 1000);
  if (nombre < seuil) return;
  const cle = `${serveur.id}:${executantId}`;
  if ((sanctionnes.get(cle) ?? 0) > Date.now()) return;
  sanctionnes.set(cle, Date.now() + 5 * 60_000);

  const issue = await neutraliser(serveur, executantId, `Anti-nuke : ${nombre} ${definition.label} en ${reglages.fenetreSecondes} s`);
  historiser(serveur.id, 'security', 'nuke', executantId, null, { counter: definition.counter, count: nombre, outcome: issue });
  const lignes = [`**Compte** : <@${executantId}> \`${executantId}\``, `**Détecté** : ${nombre} ${definition.label} en ${reglages.fenetreSecondes} s (seuil ${seuil})`, `**Réaction** : ${issue}`];
  void journal(serveur, 'security', { titre: 'Anti-nuke déclenché', ton: 'alerte', lignes });
  registreAntinuke.avertir(`Anti-nuke sur ${serveur.id} : ${executantId} — ${definition.counter} ×${nombre} → ${issue}`);
  const embed = new EmbedBuilder().setColor(couleurPour(serveur, 'error')).setTitle('💥 Anti-nuke déclenché').setDescription(lignes.join('\n')).setFooter({ text: serveur.name }).setTimestamp();
  for (const id of new Set([serveur.ownerId, ...membresListe('streamer', serveur.id)])) {
    const utilisateur = await serveur.client.users.fetch(id).catch(() => null);
    await utilisateur?.send({ embeds: [embed] }).catch(() => undefined);
  }
}

const antinuke: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.STREAMER,
  donnees: new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Protection contre les comptes compromis')
    .addSubcommand((s) => s.setName('status').setDescription('Seuils et réaction'))
    .addSubcommand((s) =>
      s
        .setName('confiance')
        .setDescription('Ajouter ou retirer un compte de confiance')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    ),
  async executer(interaction) {
    const serveur = interaction.guild;
    if (interaction.options.getSubcommand() === 'confiance') {
      const utilisateur = interaction.options.getUser('membre', true);
      if (utilisateur.bot && utilisateur.id === interaction.client.user.id) throw new ErreurUtilisateur('Le bot est toujours de confiance.');
      let ajoute = false;
      modifierConfig(serveur.id, (c) => {
        const liste = c.antinuke.membresDeConfiance;
        if (liste.includes(utilisateur.id)) c.antinuke.membresDeConfiance = liste.filter((id) => id !== utilisateur.id);
        else {
          liste.push(utilisateur.id);
          ajoute = true;
        }
      });
      return repondre(interaction, { embeds: [ok(serveur, `<@${utilisateur.id}> ${ajoute ? 'ajouté aux' : 'retiré des'} comptes de confiance.`)], ephemeral: true });
    }
    const reglages = lireConfig(serveur.id).antinuke;
    return repondre(interaction, {
      embeds: [
        info(
          serveur,
          [
            `Fenêtre : **${reglages.fenetreSecondes} s** · réaction : **${reglages.action}**`,
            '',
            ...Object.values(ACTIONS).map((a) => `• ${a!.label} — seuil **${reglages.thresholds[a!.counter]}**`),
            '',
            `Comptes de confiance : ${reglages.membresDeConfiance.map((id) => `<@${id}>`).join(' ') || '*aucun*'} (+ propriétaire, streamers, owners bot)`,
          ].join('\n'),
          { titre: 'Anti-nuke', sujet: '💥' },
        ),
      ],
      ephemeral: true,
    });
  },
};

const champCompteur = (compteur: Compteur, libelle: string) => ({
  genre: 'number' as const,
  cle: compteur,
  libelle,
  min: 1,
  max: 100,
  lire: (c: import('../coeur/reglages').ConfigServeur) => c.antinuke.thresholds[compteur],
  ecrire: (c: import('../coeur/reglages').ConfigServeur, v: number) => void (c.antinuke.thresholds[compteur] = v),
});

const pageReglageAntinuke: PageReglage = {
  id: 'antinuke',
  section: 'security',
  titre: 'Anti-nuke',
  emoji: '💥',
  moduleId: 'antinuke',
  ordre: 4,
  description: 'Surveille le journal d’audit : un compte qui supprime ou crée en masse est neutralisé.\n-# Il me faut « Voir les logs du serveur » et un rôle au-dessus des rôles du staff.',
  champs: [
    {
      genre: 'choice',
      cle: 'action',
      libelle: 'Réaction',
      options: [
        { valeur: 'alert', libelle: 'Alerter seulement', emoji: '📣' },
        { valeur: 'strip', libelle: 'Retirer ses rôles dangereux', emoji: '🧯' },
        { valeur: 'kick', libelle: 'Expulser', emoji: '👢' },
        { valeur: 'ban', libelle: 'Bannir', emoji: '🔨' },
      ],
      lire: (c) => c.antinuke.action,
      ecrire: (c, v) => void (c.antinuke.action = v as 'alert' | 'strip' | 'kick' | 'ban'),
    },
    champCompteur('channelDelete', 'Suppressions de salons'),
    champCompteur('roleDelete', 'Suppressions de rôles'),
    champCompteur('ban', 'Bannissements'),
    champCompteur('channelCreate', 'Créations de salons'),
    { genre: 'number', cle: 'window', libelle: 'Fenêtre', min: 5, max: 600, unite: 's', lire: (c) => c.antinuke.fenetreSecondes, ecrire: (c, v) => void (c.antinuke.fenetreSecondes = v) },
  ],
};

export const moduleAntinuke: ModuleBot = {
  id: 'antinuke',
  nom: 'Anti-nuke',
  emoji: '💥',
  description: 'Suppressions, créations et bans en masse d’un compte compromis',
  desactivable: true,
  actifParDefaut: true,
  commandes: [antinuke],
  pagesReglage: [pageReglageAntinuke],
  evenements: [sur('guildAuditLogEntryCreate', (entree, serveur) => surAudit(entree, serveur), 1)],
};

const codes = new CarteExpirante<string, { code: string; tries: number }>(5 * 60_000);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function fabriquerCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

function afficherCode(code: string): string {
  return code.split('').join('​ ');
}

async function verifier(membre: GuildMember): Promise<string> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).verification;
  if (reglages.ageCompteMinJours && joursDepuis(membre.user.createdTimestamp) < reglages.ageCompteMinJours) {
    void journal(serveur, 'security', { titre: 'Vérification refusée', ton: 'alerte', lignes: [`<@${membre.id}> : compte trop récent (${joursDepuis(membre.user.createdTimestamp)} j < ${reglages.ageCompteMinJours} j)`] });
    throw new ErreurUtilisateur(`Ton compte Discord doit avoir au moins **${reglages.ageCompteMinJours} jours** pour accéder au serveur. Contacte le staff si besoin.`);
  }
  const verifie = reglages.roleVerifieId ? serveur.roles.cache.get(reglages.roleVerifieId) : null;
  if (!verifie || !botPeutGererRole(serveur, verifie)) throw new ErreurUtilisateur('La vérification est mal configurée. Préviens le staff.');
  if (membre.roles.cache.has(verifie.id)) return 'Tu es déjà vérifié(e) ✅';
  await membre.roles.add(verifie, 'Vérification réussie');
  const nonVerifie = reglages.roleNonVerifieId ? serveur.roles.cache.get(reglages.roleNonVerifieId) : null;
  if (nonVerifie && botPeutGererRole(serveur, nonVerifie)) await membre.roles.remove(nonVerifie, 'Vérification réussie').catch(() => undefined);
  await donnerRolesAuto(membre, 'member', 'Rôle automatique après vérification');
  void journal(serveur, 'security', { titre: 'Membre vérifié', ton: 'ok', lignes: [`<@${membre.id}> \`${membre.user.tag}\``] });
  return `Bienvenue ! Tu as maintenant accès au serveur avec <@&${verifie.id}>.`;
}

const commandeVerifier: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Le panneau de vérification')
    .addChannelOption((o) => o.setName('salon').setDescription('Où le poster').addChannelTypes(ChannelType.GuildText)),
  async executer(interaction) {
    const reglages = lireConfig(interaction.guildId).verification;
    if (!reglages.roleVerifieId) throw new ErreurUtilisateur('Choisis d’abord le rôle « vérifié » dans `/setup` → Sécurité & accès.');
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(interaction.guild, reglages.channelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const embed = new EmbedBuilder()
      .setColor(couleurPour(interaction.guild))
      .setTitle('🔐 VÉRIFICATION')
      .setDescription(`Bienvenue sur **${interaction.guild.name}** !\n\nPour accéder au serveur, clique sur le bouton ci-dessous${reglages.method === 'captcha' ? ' puis recopie le code affiché' : ''}.`);
    const envoye = await salon.send({ embeds: [embed], components: [rangee(bouton('verif:start', 'Me vérifier', ButtonStyle.Success, '✅'))] });
    await repondre(interaction, { embeds: [ok(interaction.guild, `Panneau posté : ${envoye.url}`)], ephemeral: true });
  },
};

const pageReglageVerification: PageReglage = {
  id: 'verification',
  section: 'security',
  titre: 'Vérification',
  emoji: '🔐',
  moduleId: 'verification',
  ordre: 2,
  description:
    'Les nouveaux arrivent avec un accès limité, puis se vérifient (`/verify`).\n-# Donne au rôle « non vérifié » un accès au seul salon de vérification. Les rôles automatiques sont donnés après vérification.',
  champs: [
    { genre: 'role', cle: 'verified', libelle: 'Rôle vérifié', attribuable: true, lire: (c) => c.verification.roleVerifieId, ecrire: (c, v) => void (c.verification.roleVerifieId = v) },
    { genre: 'role', cle: 'unverified', libelle: 'Rôle non vérifié (à l’arrivée)', attribuable: true, lire: (c) => c.verification.roleNonVerifieId, ecrire: (c, v) => void (c.verification.roleNonVerifieId = v) },
    {
      genre: 'choice',
      cle: 'method',
      libelle: 'Méthode',
      options: [
        { valeur: 'button', libelle: 'Un simple clic', emoji: '🖱️' },
        { valeur: 'captcha', libelle: 'Recopier un code (anti-bot)', emoji: '🔢' },
      ],
      lire: (c) => c.verification.method,
      ecrire: (c, v) => void (c.verification.method = v as 'button' | 'captcha'),
    },
    { genre: 'channel', cle: 'channel', libelle: 'Salon de vérification', lire: (c) => c.verification.channelId, ecrire: (c, v) => void (c.verification.channelId = v) },
    { genre: 'number', cle: 'age', libelle: 'Âge minimum du compte', min: 0, max: 365, unite: 'j', lire: (c) => c.verification.ageCompteMinJours, ecrire: (c, v) => void (c.verification.ageCompteMinJours = v) },
  ],
};

export const moduleVerification: ModuleBot = {
  id: 'verification',
  nom: 'Vérification',
  emoji: '🔐',
  description: 'Accès limité à l’arrivée puis vérification (clic ou code)',
  desactivable: true,
  actifParDefaut: false,
  commandes: [commandeVerifier],
  pagesReglage: [pageReglageVerification],
  composants: [
    {
      prefixe: 'verif',
      async bouton(interaction, [action]) {
        const reglages = lireConfig(interaction.guildId).verification;
        if (action === 'start' && reglages.method === 'button') {
          const texte = await verifier(interaction.member);
          await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'start') {
          const code = fabriquerCode();
          codes.ecrire(`${interaction.guildId}:${interaction.user.id}`, { code, tries: 0 });
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🔢 Ton code').setDescription(`Recopie ce code :\n\n# ${afficherCode(code)}\n\n-# Valable 5 minutes.`)],
            components: [rangee(bouton('verif:enter', 'Entrer le code', ButtonStyle.Primary, '⌨️'))],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (action === 'enter') {
          await interaction.showModal(construireFormulaire('verif:code', 'Vérification', [{ id: 'code', libelle: 'Le code affiché', longueurMax: 12, longueurMin: 6 }]));
        }
      },
      async fenetre(interaction) {
        const cle = `${interaction.guildId}:${interaction.user.id}`;
        const enAttente = codes.lire(cle);
        if (!enAttente) throw new ErreurUtilisateur('Ton code a expiré. Clique à nouveau sur « Me vérifier ».');
        const saisi = interaction.fields.getTextInputValue('code').replace(/[\s​]/g, '').toUpperCase();
        if (saisi !== enAttente.code) {
          enAttente.tries++;
          if (enAttente.tries >= 3) codes.supprimer(cle);
          await interaction.reply({ embeds: [erreur(interaction.guild, enAttente.tries >= 3 ? 'Trop d’essais. Relance la vérification.' : 'Code incorrect, réessaie.')], flags: MessageFlags.Ephemeral });
          return;
        }
        codes.supprimer(cle);
        const texte = await verifier(interaction.member);
        await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      if (membre.user.bot) return;
      const reglages = lireConfig(membre.guild.id).verification;
      const role = reglages.roleNonVerifieId ? membre.guild.roles.cache.get(reglages.roleNonVerifieId) : null;
      if (role && botPeutGererRole(membre.guild, role)) await membre.roles.add(role, 'En attente de vérification').catch(() => undefined);
    }, 44),
  ],
};
