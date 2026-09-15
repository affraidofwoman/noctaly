import { AuditLogEvent, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildAuditLogsEntry } from 'discord.js';
import { couleurPour, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig, modifierConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, historiser } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import type { PageReglage } from '../../core/setup';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { estProprietaireBot, membresListe } from '../../core/whitelists';

const registre = creerRegistre('antinuke');

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

/** Enregistre une action ; retourne le nombre d'actions du même type dans la fenêtre. */
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
  registre.avertir(`Anti-nuke sur ${serveur.id} : ${executantId} — ${definition.counter} ×${nombre} → ${issue}`);
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
  kind: 'number' as const,
  cle: compteur,
  libelle,
  min: 1,
  max: 100,
  get: (c: import('../../core/guildConfig').ConfigServeur) => c.antinuke.thresholds[compteur],
  set: (c: import('../../core/guildConfig').ConfigServeur, v: number) => void (c.antinuke.thresholds[compteur] = v),
});

const pageReglage: PageReglage = {
  id: 'antinuke',
  section: 'security',
  titre: 'Anti-nuke',
  emoji: '💥',
  moduleId: 'antinuke',
  ordre: 4,
  description: 'Surveille le journal d’audit : un compte qui supprime ou crée en masse est neutralisé.\n-# Il me faut « Voir les logs du serveur » et un rôle au-dessus des rôles du staff.',
  champs: [
    {
      kind: 'choice',
      cle: 'action',
      libelle: 'Réaction',
      options: [
        { value: 'alert', label: 'Alerter seulement', emoji: '📣' },
        { value: 'strip', label: 'Retirer ses rôles dangereux', emoji: '🧯' },
        { value: 'kick', label: 'Expulser', emoji: '👢' },
        { value: 'ban', label: 'Bannir', emoji: '🔨' },
      ],
      get: (c) => c.antinuke.action,
      set: (c, v) => void (c.antinuke.action = v as 'alert' | 'strip' | 'kick' | 'ban'),
    },
    champCompteur('channelDelete', 'Suppressions de salons'),
    champCompteur('roleDelete', 'Suppressions de rôles'),
    champCompteur('ban', 'Bannissements'),
    champCompteur('channelCreate', 'Créations de salons'),
    { kind: 'number', cle: 'window', libelle: 'Fenêtre', min: 5, max: 600, unit: 's', get: (c) => c.antinuke.fenetreSecondes, set: (c, v) => void (c.antinuke.fenetreSecondes = v) },
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
  pagesReglage: [pageReglage],
  evenements: [sur('guildAuditLogEntryCreate', (entree, serveur) => surAudit(entree, serveur), 1)],
};
