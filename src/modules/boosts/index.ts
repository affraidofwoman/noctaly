import { EmbedBuilder, MessageType, SlashCommandBuilder, type GuildMember, type Message } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, couleurPour, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig, modifierConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { moduleActif } from '../../core/moduleManager';
import { botPeutGererRole } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { medaille, tronquer } from '../../core/text';
import { remplirModele } from '../../core/variables';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { lireBadge, donnerBadge } from '../../services/badges';
import { ajouterPieces } from '../../services/economy';

const TYPES_BOOST = new Set([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);
const boostsRecents = new Map<string, number>();

async function appliquerRecompenses(membre: GuildMember, nombre: number): Promise<string[]> {
  const serveur = membre.guild;
  const donnes: string[] = [];
  for (const r of lireConfig(serveur.id).boosts.recompenses.filter((x) => x.count === nombre)) {
    const role = r.roleId ? serveur.roles.cache.get(r.roleId) : null;
    if (role && botPeutGererRole(serveur, role)) {
      await membre.roles.add(role, `Récompense de ${nombre} boost(s)`).catch(() => undefined);
      donnes.push(`<@&${role.id}>`);
    }
    if (r.badgeId && donnerBadge(serveur.id, membre.id, r.badgeId)) donnes.push(`${lireBadge(serveur.id, r.badgeId)?.emoji ?? '🏅'} badge`);
    if (r.pieces > 0 && moduleActif(serveur.id, 'economy')) {
      ajouterPieces(serveur.id, membre.id, r.pieces, 'boost');
      donnes.push(`${r.pieces} ${lireConfig(serveur.id).economie.emojiMonnaie}`);
    }
  }
  return donnes;
}

/** Un boost : compteur, rôle booster, badge VIP, récompenses et annonce. */
async function enregistrerBoost(membre: GuildMember): Promise<void> {
  const serveur = membre.guild;
  const cle = `${serveur.id}:${membre.id}`;
  if ((boostsRecents.get(cle) ?? 0) > Date.now()) return;
  boostsRecents.set(cle, Date.now() + 30_000);
  const maintenant = Date.now();
  executer(
    `INSERT INTO boosts (serveur_id, utilisateur_id, nombre, premier_boost_le, dernier_boost_le) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET nombre = nombre + 1, dernier_boost_le = excluded.dernier_boost_le`,
    serveur.id,
    membre.id,
    maintenant,
    maintenant,
  );
  const nombre = lire<{ nombre: number }>('SELECT nombre FROM boosts WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, membre.id)?.nombre ?? 1;
  const reglages = lireConfig(serveur.id).boosts;
  const roleBooster = reglages.roleBoosterId ? serveur.roles.cache.get(reglages.roleBoosterId) : null;
  if (roleBooster && botPeutGererRole(serveur, roleBooster)) await membre.roles.add(roleBooster, 'Booster').catch(() => undefined);
  donnerBadge(serveur.id, membre.id, 'vip');
  const recompenses = await appliquerRecompenses(membre, nombre);
  void journal(serveur, 'boost', { titre: 'Nouveau boost', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Boosts de ce membre** : ${nombre}`, `**Boosts du serveur** : ${serveur.premiumSubscriptionCount ?? 0}`, recompenses.length ? `**Récompenses** : ${recompenses.join(', ')}` : null] });
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
  if (!salon) return;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(`${emojiPour(serveur.id, 'boost')} NOUVEAU BOOST !`)
    .setDescription(tronquer(remplirModele(reglages.message, { membre, serveur }), 4000) + (recompenses.length ? `\n\n🎁 Récompenses : ${recompenses.join(', ')}` : ''))
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }));
  await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
}

const boost: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('boost')
    .setDescription('Les boosts du serveur')
    .addSubcommand((s) => s.setName('top').setDescription('Les boosters du serveur'))
    .addSubcommand((s) =>
      s
        .setName('recompense')
        .setDescription('Ajouter une récompense de boosts')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Au bout de combien de boosts').setRequired(true).setMinValue(1).setMaxValue(100))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle donné'))
        .addStringOption((o) => o.setName('badge').setDescription('Badge donné (identifiant)').setMaxLength(32))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces données').setMinValue(0).setMaxValue(10_000_000)),
    )
    .addSubcommand((s) => s.setName('recompenses').setDescription('Les récompenses configurées'))
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer les récompenses d’un palier')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Le palier').setRequired(true).setMinValue(1).setMaxValue(100)),
    ),
  niveauxSousCommandes: { recompense: Niveau.ADMIN, retirer: Niveau.ADMIN, recompenses: Niveau.STAFF },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'top') {
      const rangees = lireTout<{ utilisateur_id: string; nombre: number }>('SELECT utilisateur_id, nombre FROM boosts WHERE serveur_id = ? ORDER BY nombre DESC, premier_boost_le LIMIT 25', serveur.id);
      return repondre(interaction, {
        embeds: [embedEnseigne(serveur).setTitle('🚀 Boosters').setDescription(rangees.map((r, i) => `${medaille(i + 1)} <@${r.utilisateur_id}> — **${r.nombre}** boost(s)`).join('\n') || '*Aucun boost enregistré.*').setFooter({ text: `${serveur.premiumSubscriptionCount ?? 0} boosts · niveau ${serveur.premiumTier}` })],
      });
    }
    if (sousCommande === 'recompenses') {
      const recompenses = lireConfig(serveur.id).boosts.recompenses;
      return repondre(interaction, {
        embeds: [info(serveur, recompenses.map((r) => `**${r.count} boost(s)** → ${[r.roleId ? `<@&${r.roleId}>` : null, r.badgeId ? `badge \`${r.badgeId}\`` : null, r.pieces ? `${r.pieces} pièces` : null].filter(Boolean).join(', ')}`).join('\n') || 'Aucune récompense.', { titre: 'Récompenses de boost', sujet: '🚀' })],
        ephemeral: true,
      });
    }
    const nombre = interaction.options.getInteger('boosts', true);
    if (sousCommande === 'retirer') {
      modifierConfig(serveur.id, (c) => void (c.boosts.recompenses = c.boosts.recompenses.filter((r) => r.count !== nombre)));
      return repondre(interaction, { embeds: [ok(serveur, `Récompenses du palier ${nombre} retirées.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    const badgeId = interaction.options.getString('badge');
    const pieces = interaction.options.getInteger('pieces') ?? 0;
    if (!role && !badgeId && !pieces) throw new ErreurUtilisateur('Choisis au moins un rôle, un badge ou des pièces.');
    if (role && !botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle.');
    if (badgeId && !lireBadge(serveur.id, badgeId)) throw new ErreurUtilisateur('Badge introuvable (voir `/badge liste`).');
    modifierConfig(serveur.id, (c) => c.boosts.recompenses.push({ count: nombre, roleId: role?.id ?? null, badgeId, pieces }));
    return repondre(interaction, { embeds: [ok(serveur, `Récompense ajoutée au palier **${nombre} boost(s)**.`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'boosts',
  section: 'community',
  titre: 'Boosts',
  emoji: '🚀',
  moduleId: 'boosts',
  ordre: 13,
  description: 'Remercier les boosters, leur donner un rôle et des récompenses par palier (`/boost recompense`).\n-# Variables : `{mention}` `{user}` `{boosts}`',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des remerciements', lire: (c) => c.boosts.channelId, ecrire: (c, v) => void (c.boosts.channelId = v) },
    { genre: 'role', cle: 'role', libelle: 'Rôle booster', attribuable: true, lire: (c) => c.boosts.roleBoosterId, ecrire: (c, v) => void (c.boosts.roleBoosterId = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.boosts.message, ecrire: (c, v) => void (c.boosts.message = v) },
  ],
};

export const moduleBoosts: ModuleBot = {
  id: 'boosts',
  nom: 'Boosts',
  emoji: '🚀',
  description: 'Remerciements, rôle booster et récompenses de boost',
  desactivable: true,
  actifParDefaut: true,
  commandes: [boost],
  pagesReglage: [pageReglage],
  evenements: [
    sur('messageCreate', async (message: Message) => {
      if (!message.inGuild() || !TYPES_BOOST.has(message.type) || !message.member) return;
      await enregistrerBoost(message.member);
    }, 20),
    sur('guildMemberUpdate', async (avant, apres) => {
      const reglages = lireConfig(apres.guild.id).boosts;
      if (!avant.premiumSince && apres.premiumSince) {
        // Laisse le message système arriver en premier (il compte chaque boost) avant d'utiliser ce repli.
        setTimeout(() => void enregistrerBoost(apres), 5_000).unref();
      } else if (avant.premiumSince && !apres.premiumSince) {
        const role = reglages.roleBoosterId ? apres.guild.roles.cache.get(reglages.roleBoosterId) : null;
        if (role && botPeutGererRole(apres.guild, role)) await apres.roles.remove(role, 'Ne booste plus').catch(() => undefined);
        void journal(apres.guild, 'boost', { titre: 'Fin de boost', ton: 'alerte', lignes: [`<@${apres.id}> ne booste plus le serveur.`] });
      }
    }),
  ],
  tests: [
    {
      id: 'thanks',
      libelle: 'Remerciement de boost',
      emoji: '🚀',
      description: 'Voir le message de remerciement à ton nom (sans compter de boost)',
      async executer(interaction) {
        const reglages = lireConfig(interaction.guildId).boosts;
        const salon = resoudreSalonTexte(interaction.guild, reglages.channelId);
        if (!salon) return '⚠️ Aucun salon de remerciements utilisable.';
        await salon.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🚀 NOUVEAU BOOST ! (test)').setDescription(remplirModele(reglages.message, { membre: interaction.member, serveur: interaction.guild }))], allowedMentions: { parse: [] } });
        return `✅ Message de test posté dans <#${salon.id}>.`;
      },
    },
  ],
};
