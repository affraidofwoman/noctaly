import { GuildMember, SlashCommandBuilder, type Guild, type User } from 'discord.js';
import { lire } from '../../database/db';
import { embedEnseigne, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { moduleActif } from '../../core/moduleManager';
import { lireNiveau, libelleNiveau } from '../../core/permissions';
import { formaterNombre, identifiantDepuisTexte, tronquer } from '../../core/text';
import { joursDepuis, formaterDuree } from '../../core/time';
import { Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { supprimerBadge, lireBadge, donnerBadge, listerBadges, retirerBadge, enregistrerBadge, badgesMembre } from '../../services/badges';
import { activiteMembre } from '../../services/stats';
import { nombreTickets } from '../../services/tickets';
import { victoiresDe } from '../../services/giveaways';
import { lireXp, niveauDepuisXp, rangDe } from '../../services/xp';

/** Badges automatiques calculés à l'affichage (staff, booster, ancienneté). */
function synchroniserBadgesAuto(membre: GuildMember): void {
  if (!lireConfig(membre.guild.id).profils.badgesAuto) return;
  const g = membre.guild.id;
  if (lireNiveau(membre) >= Niveau.SUPPORT) donnerBadge(g, membre.id, 'staff');
  if (membre.premiumSinceTimestamp) donnerBadge(g, membre.id, 'vip');
  if (membre.joinedTimestamp && joursDepuis(membre.joinedTimestamp) >= 180) donnerBadge(g, membre.id, 'og');
  if (lireXp(g, membre.id).niveau >= 10) donnerBadge(g, membre.id, 'actif');
}

export function embedProfil(serveur: Guild, utilisateur: User, membre: GuildMember | null) {
  if (membre) synchroniserBadgesAuto(membre);
  const g = serveur.id;
  const xp = lireXp(g, utilisateur.id);
  const progression = niveauDepuisXp(xp.xp);
  const activite = activiteMembre(g, utilisateur.id);
  const pieces = lire<{ solde: number }>('SELECT solde FROM economie WHERE serveur_id = ? AND utilisateur_id = ?', g, utilisateur.id)?.solde ?? 0;
  const serie = lire<{ actuelle: number; record: number }>('SELECT actuelle, record FROM series WHERE serveur_id = ? AND utilisateur_id = ?', g, utilisateur.id);
  const invitations = lire<{ n: number }>('SELECT COUNT(*) AS n FROM invitations WHERE serveur_id = ? AND parrain_id = ? AND faux = 0 AND parti_le IS NULL', g, utilisateur.id)?.n ?? 0;
  const badges = badgesMembre(g, utilisateur.id);
  const economie = lireConfig(g).economie;

  const embed = embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`👤 PROFIL DE ${(membre?.displayName ?? utilisateur.displayName).toUpperCase()}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '⭐ Niveau', value: `${progression.niveau}${rangDe(g, utilisateur.id) ? ` · #${rangDe(g, utilisateur.id)}` : ''}`, inline: true },
      { name: '🏆 XP', value: formaterNombre(xp.xp), inline: true },
      { name: '📅 Membre depuis', value: membre?.joinedTimestamp ? `${joursDepuis(membre.joinedTimestamp)} jours` : '—', inline: true },
      { name: '🎫 Tickets', value: String(nombreTickets(g, utilisateur.id)), inline: true },
      { name: '🎉 Giveaways gagnés', value: String(victoiresDe(g, utilisateur.id)), inline: true },
      { name: '💬 Messages', value: formaterNombre(activite?.messages ?? 0), inline: true },
    );
  if (activite?.secondes_vocal) embed.addFields({ name: '🎙️ Vocal', value: formaterDuree(activite.secondes_vocal * 1000), inline: true });
  if (moduleActif(g, 'economy')) embed.addFields({ name: `${economie.emojiMonnaie} ${economie.nomMonnaie}`, value: formaterNombre(pieces), inline: true });
  if (serie?.actuelle) embed.addFields({ name: '🔥 Série', value: `${serie.actuelle} jour${serie.actuelle > 1 ? 's' : ''} (record ${serie.record})`, inline: true });
  if (moduleActif(g, 'invites')) embed.addFields({ name: '📨 Invitations', value: String(invitations), inline: true });
  if (membre) embed.addFields({ name: '🛡️ Accès', value: libelleNiveau(lireNiveau(membre)), inline: true });
  embed.addFields({ name: `🏅 Badges (${badges.length})`, value: badges.length ? tronquer(badges.map((b) => `${b.emoji} ${b.nom}`).join('\n'), 1024) : '*Aucun badge pour l’instant.*', inline: false });
  if (membre?.displayColor) embed.setColor(membre.displayColor);
  return embed;
}

const profil: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Le profil communautaire')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async executer(interaction) {
    const utilisateur = interaction.options.getUser('membre') ?? interaction.user;
    const membre = interaction.options.getMember('membre') ?? (utilisateur.id === interaction.user.id ? interaction.member : null);
    await repondre(interaction, { embeds: [embedProfil(interaction.guild, utilisateur, membre instanceof GuildMember ? membre : null)] });
  },
};

const badge: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('badge')
    .setDescription('Les badges')
    .addSubcommand((s) => s.setName('liste').setDescription('Les badges du serveur'))
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un badge')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Créer ou modifier un badge')
        .addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji').setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(120)),
    )
    .addSubcommand((s) =>
      s
        .setName('supprimer')
        .setDescription('Supprimer un badge')
        .addStringOption((o) => o.setName('badge').setDescription('Le badge').setRequired(true).setAutocomplete(true)),
    ),
  niveauxSousCommandes: { donner: Niveau.STAFF, retirer: Niveau.STAFF, creer: Niveau.ADMIN, supprimer: Niveau.ADMIN },
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listerBadges(interaction.guildId)
        .filter((b) => b.nom.toLowerCase().includes(saisie) || b.badge_id.includes(saisie))
        .slice(0, 25)
        .map((b) => ({ name: `${b.emoji} ${b.nom}`.slice(0, 100), value: b.badge_id })),
    );
  },
  async executer(interaction) {
    const g = interaction.guildId;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'liste') {
      return repondre(interaction, { embeds: [info(interaction.guild, listerBadges(g).map((b) => `${b.emoji} **${b.nom}** — ${b.description || '—'} \`${b.badge_id}\``).join('\n') || 'Aucun badge.', { titre: 'Badges', sujet: '🏅' })], ephemeral: true });
    }
    if (sousCommande === 'creer') {
      const nom = interaction.options.getString('nom', true);
      const id = identifiantDepuisTexte(nom, 32);
      enregistrerBadge(g, { badge_id: id, nom, emoji: interaction.options.getString('emoji', true), description: interaction.options.getString('description') ?? '' });
      return repondre(interaction, { embeds: [ok(interaction.guild, `Badge **${nom}** enregistré (\`${id}\`).`)], ephemeral: true });
    }
    const badgeId = interaction.options.getString('badge', true);
    const definition = lireBadge(g, badgeId);
    if (!definition) throw new ErreurUtilisateur('Badge introuvable.');
    if (sousCommande === 'supprimer') {
      supprimerBadge(g, badgeId);
      return repondre(interaction, { embeds: [ok(interaction.guild, `Badge **${definition.nom}** supprimé.`)], ephemeral: true });
    }
    const utilisateur = interaction.options.getUser('membre', true);
    const change = sousCommande === 'donner' ? donnerBadge(g, utilisateur.id, badgeId, interaction.user.id) : retirerBadge(g, utilisateur.id, badgeId);
    return repondre(interaction, {
      embeds: [ok(interaction.guild, change ? `${definition.emoji} **${definition.nom}** ${sousCommande === 'donner' ? 'donné à' : 'retiré à'} <@${utilisateur.id}>.` : `Rien n’a changé pour <@${utilisateur.id}>.`)],
      ephemeral: true,
    });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'profil',
    alias: ['profile', 'p'],
    domaine: 'general',
    categorie: 'community',
    description: 'Le profil communautaire',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const membre = id ? await message.guild.members.fetch(id).catch(() => null) : message.member;
      const utilisateur = membre?.user ?? (id ? await message.client.users.fetch(id).catch(() => null) : message.author);
      if (!utilisateur) throw new ErreurUtilisateur('Membre introuvable.');
      await message.reply({ embeds: [embedProfil(message.guild, utilisateur, membre)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleProfils: ModuleBot = {
  id: 'profiles',
  nom: 'Profils & badges',
  emoji: '👤',
  description: 'Profil communautaire et badges automatiques ou donnés',
  desactivable: true,
  actifParDefaut: true,
  commandes: [profil, badge],
  commandesPrefixe,
  pagesReglage: [
    {
      id: 'profiles',
      section: 'community',
      titre: 'Profils & badges',
      emoji: '🏅',
      moduleId: 'profiles',
      ordre: 6,
      description: 'Badges automatiques : 🛡️ Staff, 💎 VIP (booster), 🏆 OG (180 j), ⭐ Actif (niveau 10), 🎉 Giveaway Winner, 🎂 Birthday.',
      champs: [{ genre: 'toggle', cle: 'auto', libelle: 'Badges automatiques', lire: (c) => c.profils.badgesAuto, ecrire: (c, v) => void (c.profils.badgesAuto = v) }],
    },
  ],
};
