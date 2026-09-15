import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { lireTout, lire, executer, transaction } from '../../database/db';
import { couleurPour, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { repondre } from '../../core/interactions';
import { journal } from '../../core/logService';
import { botPeutGererRole } from '../../core/permissions';
import { tronquer } from '../../core/text';
import { bouton, rangee } from '../../core/ui';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

type TypePanneau = 'button' | 'reaction' | 'select';
type ModePanneau = 'toggle' | 'unique' | 'add';

interface LignePanneau {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  titre: string;
  description: string;
  type: TypePanneau;
  mode: ModePanneau;
  genre: string;
  cree_le: number;
}

interface LigneParticipation {
  panneau_id: number;
  role_id: string;
  emoji: string | null;
  libelle: string;
  position: number;
}

const LIBELLE_MODE: Record<ModePanneau, string> = { toggle: 'Cliquer ajoute / enlève', unique: 'Un seul rôle à la fois', add: 'Ajout seulement' };

function entrees(panneauId: number): LigneParticipation[] {
  return lireTout<LigneParticipation>('SELECT * FROM roles_panneaux WHERE panneau_id = ? ORDER BY position, libelle', panneauId);
}

function exigerPanneau(serveurId: string, id: number | string | undefined): LignePanneau {
  const panneauBoutons = lire<LignePanneau>('SELECT * FROM panneaux_roles WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!panneauBoutons) throw new ErreurUtilisateur('Panneau introuvable.');
  return panneauBoutons;
}

/** Normalise un émoji saisi : unicode ou <:nom:id> ; pour les réactions, l'identifiant sert de clé. */
function cleEmoji(brut: string | null): string | null {
  if (!brut) return null;
  const enseignes = /<a?:\w+:(\d+)>/.exec(brut);
  return enseignes ? enseignes[1]! : brut.trim();
}

function afficher(serveur: Guild, panneauBoutons: LignePanneau) {
  const liste = entrees(panneauBoutons.id);
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(tronquer(panneauBoutons.titre, 256))
    .setDescription(
      tronquer(
        [panneauBoutons.description, '', ...liste.map((e) => `${e.emoji ?? '•'} **${e.libelle}** — <@&${e.role_id}>`), '', `-# ${panneauBoutons.type === 'reaction' ? 'Réagis' : 'Clique'} pour choisir · ${LIBELLE_MODE[panneauBoutons.mode]}`]
          .filter((l, i) => l !== '' || i > 0)
          .join('\n'),
        4096,
      ),
    );
  if (panneauBoutons.type === 'button') {
    const boutons = liste.slice(0, 25).map((e) => bouton(`rr:b:${panneauBoutons.id}:${e.role_id}`, e.libelle, ButtonStyle.Secondary, e.emoji ?? undefined));
    const rangees = [];
    for (let i = 0; i < boutons.length; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
    return { embeds: [embed], components: rangees };
  }
  if (panneauBoutons.type === 'select' && liste.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rr:s:${panneauBoutons.id}`)
      .setPlaceholder('Choisis tes rôles')
      .setMinValues(0)
      .setMaxValues(panneauBoutons.mode === 'unique' ? 1 : liste.length)
      .addOptions(liste.slice(0, 25).map((e) => ({ label: e.libelle, value: e.role_id, emoji: e.emoji ?? undefined })));
    return { embeds: [embed], components: [rangee(menu)] };
  }
  return { embeds: [embed], components: [] };
}

async function publier(serveur: Guild, panneauBoutons: LignePanneau): Promise<string> {
  const salon = serveur.channels.cache.get(panneauBoutons.salon_id) as GuildTextBasedChannel | undefined;
  if (!salon?.isTextBased()) throw new ErreurUtilisateur('Le salon du panneau est introuvable.');
  const charge = afficher(serveur, panneauBoutons);
  let message = panneauBoutons.message_id ? await salon.messages.fetch(panneauBoutons.message_id).catch(() => null) : null;
  if (message) await message.edit(charge);
  else {
    message = await salon.send(charge);
    executer('UPDATE panneaux_roles SET message_id = ? WHERE id = ?', message.id, panneauBoutons.id);
  }
  if (panneauBoutons.type === 'reaction') {
    for (const e of entrees(panneauBoutons.id)) if (e.emoji) await message.react(e.emoji).catch(() => undefined);
  }
  return message.url;
}

/** Applique un choix de rôle en respectant le mode du panneau. Retourne un compte rendu. */
async function appliquerChoix(membre: GuildMember, panneauBoutons: LignePanneau, roleId: string, forcerAjout?: boolean): Promise<string> {
  const role = membre.guild.roles.cache.get(roleId);
  if (!role) throw new ErreurUtilisateur('Ce rôle n’existe plus.');
  if (!botPeutGererRole(membre.guild, role)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle (il est au-dessus du mien).');
  const possede = membre.roles.cache.has(roleId);
  const ajouter = forcerAjout ?? !possede;
  if (!ajouter) {
    if (panneauBoutons.mode === 'add') return `Tu gardes <@&${roleId}>.`;
    await membre.roles.remove(roleId, `Panneau de rôles #${panneauBoutons.id}`);
    return `➖ <@&${roleId}> retiré.`;
  }
  if (possede) return `Tu as déjà <@&${roleId}>.`;
  if (panneauBoutons.mode === 'unique') {
    const autres = entrees(panneauBoutons.id).map((e) => e.role_id).filter((id) => id !== roleId && membre.roles.cache.has(id));
    if (autres.length) await membre.roles.remove(autres, `Panneau de rôles #${panneauBoutons.id} (unique)`).catch(() => undefined);
  }
  await membre.roles.add(roleId, `Panneau de rôles #${panneauBoutons.id}`);
  void journal(membre.guild, 'autorole', { titre: 'Rôle choisi', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Rôle** : <@&${roleId}>`, `**Panneau** : ${panneauBoutons.titre}`] });
  return `➕ <@&${roleId}> ajouté.`;
}

async function surReaction(reaction: MessageReaction | PartialMessageReaction, utilisateur: User | PartialUser, ajoute: boolean) {
  if (utilisateur.bot) return;
  const message = reaction.message;
  if (!message.guildId) return;
  const panneauBoutons = lire<LignePanneau>("SELECT * FROM panneaux_roles WHERE message_id = ? AND type = 'reaction'", message.id);
  if (!panneauBoutons) return;
  const cle = reaction.emoji.id ?? reaction.emoji.name;
  const entree = entrees(panneauBoutons.id).find((e) => cleEmoji(e.emoji) === cle);
  if (!entree) return;
  const serveur = message.guild ?? (await reaction.client.guilds.fetch(message.guildId));
  const membre = await serveur.members.fetch(utilisateur.id).catch(() => null);
  if (!membre) return;
  if (!ajoute && panneauBoutons.mode === 'add') return;
  await appliquerChoix(membre, panneauBoutons, entree.role_id, ajoute).catch(() => undefined);
  if (ajoute && panneauBoutons.mode === 'unique') {
    const complet = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
    const charge = complet?.message;
    if (charge) {
      for (const autre of charge.reactions.cache.values()) {
        if ((autre.emoji.id ?? autre.emoji.name) !== cle) await autre.users.remove(utilisateur.id).catch(() => undefined);
      }
    }
  }
}

function autocompletionPanneaux(serveurId: string, saisie: string) {
  return lireTout<LignePanneau>('SELECT * FROM panneaux_roles WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 100', serveurId)
    .filter((p) => `${p.id} ${p.titre}`.toLowerCase().includes(saisie.toLowerCase()))
    .slice(0, 25)
    .map((p) => ({ name: tronquer(`#${p.id} · ${p.titre} (${p.type})`, 100), value: p.id }));
}

const panneauRoles: CommandeSlash = {
  categorie: 'roles',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Panneaux de rôles')
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Créer un panneau')
        .addStringOption((o) => o.setName('titre').setDescription('Ex : 🎮 JEUX PRÉFÉRÉS').setRequired(true).setMaxLength(200))
        .addStringOption((o) =>
          o.setName('type').setDescription('Comment choisir').setRequired(true).addChoices({ name: 'Boutons', value: 'button' }, { name: 'Réactions', value: 'reaction' }, { name: 'Menu déroulant', value: 'select' }),
        )
        .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('description').setDescription('Texte du panneau').setMaxLength(1000))
        .addStringOption((o) =>
          o.setName('mode').setDescription('Règle').addChoices({ name: 'Ajoute / enlève', value: 'toggle' }, { name: 'Un seul rôle à la fois', value: 'unique' }, { name: 'Ajout seulement', value: 'add' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un rôle à un panneau')
        .addIntegerOption((o) => o.setName('panneau').setDescription('Le panneau').setRequired(true).setAutocomplete(true))
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Texte du bouton (nom du rôle par défaut)').setMaxLength(80))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji (obligatoire pour les réactions)').setMaxLength(64)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un rôle d’un panneau')
        .addIntegerOption((o) => o.setName('panneau').setDescription('Le panneau').setRequired(true).setAutocomplete(true))
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('supprimer')
        .setDescription('Supprimer un panneau')
        .addIntegerOption((o) => o.setName('panneau').setDescription('Le panneau').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Les panneaux du serveur')),
  async autocompletion(interaction) {
    await interaction.respond(autocompletionPanneaux(interaction.guildId, String(interaction.options.getFocused())));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'liste') {
      const panneaux = lireTout<LignePanneau>('SELECT * FROM panneaux_roles WHERE serveur_id = ? ORDER BY cree_le DESC', serveur.id);
      const lignes = panneaux.map((p) => `**#${p.id}** ${tronquer(p.titre, 60)} — ${p.type} · ${entrees(p.id).length} rôle(s) · <#${p.salon_id}>`);
      return repondre(interaction, { embeds: [info(serveur, lignes.join('\n') || 'Aucun panneau.', { titre: 'Panneaux de rôles', sujet: '🎭' })], ephemeral: true });
    }
    if (sousCommande === 'creer') {
      const salon = interaction.options.getChannel('salon') ?? interaction.channel;
      if (!salon) return;
      const r = executer(
        'INSERT INTO panneaux_roles (serveur_id, salon_id, titre, description, type, mode, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
        serveur.id,
        salon.id,
        interaction.options.getString('titre', true),
        interaction.options.getString('description') ?? '',
        interaction.options.getString('type', true),
        interaction.options.getString('mode') ?? 'toggle',
        Date.now(),
      );
      return repondre(interaction, { embeds: [ok(serveur, `Panneau **#${r.lastInsertRowid}** créé. Ajoute des rôles avec \`/reactionrole ajouter\` : il sera publié automatiquement.`)], ephemeral: true });
    }
    const panneauBoutons = exigerPanneau(serveur.id, interaction.options.getInteger('panneau', true));
    if (sousCommande === 'supprimer') {
      const salon = serveur.channels.cache.get(panneauBoutons.salon_id);
      if (salon?.isTextBased() && panneauBoutons.message_id) await salon.messages.delete(panneauBoutons.message_id).catch(() => undefined);
      executer('DELETE FROM panneaux_roles WHERE id = ?', panneauBoutons.id);
      return repondre(interaction, { embeds: [ok(serveur, `Panneau #${panneauBoutons.id} supprimé.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    if (sousCommande === 'retirer') {
      executer('DELETE FROM roles_panneaux WHERE panneau_id = ? AND role_id = ?', panneauBoutons.id, role.id);
      const url = await publier(serveur, panneauBoutons);
      return repondre(interaction, { embeds: [ok(serveur, `<@&${role.id}> retiré du panneau. ${url}`)], ephemeral: true });
    }
    const emoji = interaction.options.getString('emoji');
    if (panneauBoutons.type === 'reaction' && !emoji) throw new ErreurUtilisateur('Un émoji est obligatoire pour un panneau à réactions.');
    if (!botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle : place mon rôle au-dessus.');
    if (entrees(panneauBoutons.id).length >= 25) throw new ErreurUtilisateur('25 rôles maximum par panneau.');
    transaction(() => {
      const position = entrees(panneauBoutons.id).length;
      executer(
        'INSERT OR REPLACE INTO roles_panneaux (panneau_id, role_id, emoji, libelle, position) VALUES (?, ?, ?, ?, ?)',
        panneauBoutons.id,
        role.id,
        emoji,
        interaction.options.getString('label') ?? role.name,
        position,
      );
    });
    const url = await publier(serveur, panneauBoutons);
    return repondre(interaction, { embeds: [ok(serveur, `<@&${role.id}> ajouté au panneau. ${url}`)], ephemeral: true });
  },
};

const roleNotifications: CommandeSlash = {
  categorie: 'roles',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('notificationrole')
    .setDescription('Panneau 🔔 notifications en un clic')
    .addRoleOption((o) => o.setName('lives').setDescription('Rôle 🔴 Lives Twitch'))
    .addRoleOption((o) => o.setName('youtube').setDescription('Rôle 🎥 YouTube'))
    .addRoleOption((o) => o.setName('giveaways').setDescription('Rôle 🎉 Giveaways'))
    .addRoleOption((o) => o.setName('annonces').setDescription('Rôle 📢 Annonces'))
    .addRoleOption((o) => o.setName('evenements').setDescription('Rôle 🎮 Événements'))
    .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async executer(interaction) {
    const serveur = interaction.guild;
    const choix: [string, string, string][] = [
      ['lives', '🔴', 'Lives Twitch'],
      ['youtube', '🎥', 'YouTube'],
      ['giveaways', '🎉', 'Giveaways'],
      ['annonces', '📢', 'Annonces'],
      ['evenements', '🎮', 'Événements'],
    ];
    const choisis = choix.map(([option, emoji, libelle]) => ({ role: interaction.options.getRole(option), emoji, label: libelle })).filter((p) => p.role);
    if (!choisis.length) throw new ErreurUtilisateur('Choisis au moins un rôle.');
    const bloques = choisis.filter((c) => !botPeutGererRole(serveur, serveur.roles.cache.get(c.role!.id)!));
    if (bloques.length) throw new ErreurUtilisateur(`Je ne peux pas donner ${bloques.map((b) => `<@&${b.role!.id}>`).join(', ')} : place mon rôle au-dessus.`);
    const salon = interaction.options.getChannel('salon') ?? interaction.channel;
    if (!salon) return;
    const panneauId = transaction(() => {
      const r = executer(
        "INSERT INTO panneaux_roles (serveur_id, salon_id, titre, description, type, mode, genre, cree_le) VALUES (?, ?, '🔔 NOTIFICATIONS', ?, 'button', 'toggle', 'notification', ?)",
        serveur.id,
        salon.id,
        'Choisis toi-même les notifications que tu veux recevoir.',
        Date.now(),
      );
      choisis.forEach((c, i) => executer('INSERT INTO roles_panneaux (panneau_id, role_id, emoji, libelle, position) VALUES (?, ?, ?, ?, ?)', r.lastInsertRowid, c.role!.id, c.emoji, c.label, i));
      return r.lastInsertRowid;
    });
    const url = await publier(serveur, exigerPanneau(serveur.id, panneauId));
    await repondre(interaction, { embeds: [ok(serveur, `Panneau de notifications publié : ${url}`)], ephemeral: true });
  },
};

export const moduleRolesAChoisir: ModuleBot = {
  id: 'reactionroles',
  nom: 'Rôles à choisir',
  emoji: '🎭',
  description: 'Panneaux de rôles : réactions, boutons, menus et notifications',
  desactivable: true,
  actifParDefaut: true,
  commandes: [panneauRoles, roleNotifications],
  composants: [
    {
      prefixe: 'rr',
      async bouton(interaction: ButtonInteraction<'cached'>, [, panneauId, roleId]) {
        const panneauBoutons = exigerPanneau(interaction.guildId, panneauId);
        if (!entrees(panneauBoutons.id).some((e) => e.role_id === roleId)) throw new ErreurUtilisateur('Ce rôle n’est plus proposé.');
        const texte = await appliquerChoix(interaction.member, panneauBoutons, roleId!);
        await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [, panneauId]) {
        if (!interaction.isStringSelectMenu()) return;
        const panneauBoutons = exigerPanneau(interaction.guildId, panneauId);
        const proposes = entrees(panneauBoutons.id).map((e) => e.role_id);
        const voulus = new Set(interaction.values.filter((v) => proposes.includes(v)));
        const resultats: string[] = [];
        for (const roleId of proposes) {
          const possede = interaction.member.roles.cache.has(roleId);
          if (voulus.has(roleId) && !possede) resultats.push(await appliquerChoix(interaction.member, panneauBoutons, roleId, true).catch((e: Error) => `⚠️ ${e.message}`));
          if (!voulus.has(roleId) && possede && panneauBoutons.mode !== 'add') resultats.push(await appliquerChoix(interaction.member, panneauBoutons, roleId, false).catch((e: Error) => `⚠️ ${e.message}`));
        }
        await interaction.reply({ embeds: [ok(interaction.guild, resultats.join('\n') || 'Aucun changement.')], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('messageReactionAdd', (reaction, utilisateur) => surReaction(reaction, utilisateur, true)),
    sur('messageReactionRemove', (reaction, utilisateur) => surReaction(reaction, utilisateur, false)),
    sur('messageDelete', (message) => {
      executer('UPDATE panneaux_roles SET message_id = NULL WHERE message_id = ?', message.id);
    }),
  ],
};
