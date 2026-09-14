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
import { all, get, run, transaction } from '../../database/db';
import { colorFor, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { reply } from '../../core/interactions';
import { journal } from '../../core/logService';
import { canBotManageRole } from '../../core/permissions';
import { truncate } from '../../core/text';
import { button, row } from '../../core/ui';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';

type PanelType = 'button' | 'reaction' | 'select';
type PanelMode = 'toggle' | 'unique' | 'add';

interface PanelRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string;
  type: PanelType;
  mode: PanelMode;
  kind: string;
  created_at: number;
}

interface EntryRow {
  panel_id: number;
  role_id: string;
  emoji: string | null;
  label: string;
  position: number;
}

const MODE_LABEL: Record<PanelMode, string> = { toggle: 'Cliquer ajoute / enlève', unique: 'Un seul rôle à la fois', add: 'Ajout seulement' };

function entries(panelId: number): EntryRow[] {
  return all<EntryRow>('SELECT * FROM reaction_role_entries WHERE panel_id = ? ORDER BY position, label', panelId);
}

function requirePanel(guildId: string, id: number | string | undefined): PanelRow {
  const panel = get<PanelRow>('SELECT * FROM reaction_roles WHERE id = ? AND guild_id = ?', Number(id), guildId);
  if (!panel) throw new UserError('Panneau introuvable.');
  return panel;
}

/** Normalise un émoji saisi : unicode ou <:nom:id> ; pour les réactions, l'identifiant sert de clé. */
function emojiKey(raw: string | null): string | null {
  if (!raw) return null;
  const custom = /<a?:\w+:(\d+)>/.exec(raw);
  return custom ? custom[1]! : raw.trim();
}

function render(guild: Guild, panel: PanelRow) {
  const list = entries(panel.id);
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild))
    .setTitle(truncate(panel.title, 256))
    .setDescription(
      truncate(
        [panel.description, '', ...list.map((e) => `${e.emoji ?? '•'} **${e.label}** — <@&${e.role_id}>`), '', `-# ${panel.type === 'reaction' ? 'Réagis' : 'Clique'} pour choisir · ${MODE_LABEL[panel.mode]}`]
          .filter((l, i) => l !== '' || i > 0)
          .join('\n'),
        4096,
      ),
    );
  if (panel.type === 'button') {
    const buttons = list.slice(0, 25).map((e) => button(`rr:b:${panel.id}:${e.role_id}`, e.label, ButtonStyle.Secondary, e.emoji ?? undefined));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
    return { embeds: [embed], components: rows };
  }
  if (panel.type === 'select' && list.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rr:s:${panel.id}`)
      .setPlaceholder('Choisis tes rôles')
      .setMinValues(0)
      .setMaxValues(panel.mode === 'unique' ? 1 : list.length)
      .addOptions(list.slice(0, 25).map((e) => ({ label: e.label, value: e.role_id, emoji: e.emoji ?? undefined })));
    return { embeds: [embed], components: [row(select)] };
  }
  return { embeds: [embed], components: [] };
}

async function publish(guild: Guild, panel: PanelRow): Promise<string> {
  const channel = guild.channels.cache.get(panel.channel_id) as GuildTextBasedChannel | undefined;
  if (!channel?.isTextBased()) throw new UserError('Le salon du panneau est introuvable.');
  const payload = render(guild, panel);
  let message = panel.message_id ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
  if (message) await message.edit(payload);
  else {
    message = await channel.send(payload);
    run('UPDATE reaction_roles SET message_id = ? WHERE id = ?', message.id, panel.id);
  }
  if (panel.type === 'reaction') {
    for (const e of entries(panel.id)) if (e.emoji) await message.react(e.emoji).catch(() => undefined);
  }
  return message.url;
}

/** Applique un choix de rôle en respectant le mode du panneau. Retourne un compte rendu. */
async function applyChoice(member: GuildMember, panel: PanelRow, roleId: string, forceAdd?: boolean): Promise<string> {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) throw new UserError('Ce rôle n’existe plus.');
  if (!canBotManageRole(member.guild, role)) throw new UserError('Je ne peux pas donner ce rôle (il est au-dessus du mien).');
  const has = member.roles.cache.has(roleId);
  const add = forceAdd ?? !has;
  if (!add) {
    if (panel.mode === 'add') return `Tu gardes <@&${roleId}>.`;
    await member.roles.remove(roleId, `Panneau de rôles #${panel.id}`);
    return `➖ <@&${roleId}> retiré.`;
  }
  if (has) return `Tu as déjà <@&${roleId}>.`;
  if (panel.mode === 'unique') {
    const others = entries(panel.id).map((e) => e.role_id).filter((id) => id !== roleId && member.roles.cache.has(id));
    if (others.length) await member.roles.remove(others, `Panneau de rôles #${panel.id} (unique)`).catch(() => undefined);
  }
  await member.roles.add(roleId, `Panneau de rôles #${panel.id}`);
  void journal(member.guild, 'autorole', { title: 'Rôle choisi', tone: 'ok', lines: [`**Membre** : <@${member.id}>`, `**Rôle** : <@&${roleId}>`, `**Panneau** : ${panel.title}`] });
  return `➕ <@&${roleId}> ajouté.`;
}

async function onReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, added: boolean) {
  if (user.bot) return;
  const message = reaction.message;
  if (!message.guildId) return;
  const panel = get<PanelRow>("SELECT * FROM reaction_roles WHERE message_id = ? AND type = 'reaction'", message.id);
  if (!panel) return;
  const key = reaction.emoji.id ?? reaction.emoji.name;
  const entry = entries(panel.id).find((e) => emojiKey(e.emoji) === key);
  if (!entry) return;
  const guild = message.guild ?? (await reaction.client.guilds.fetch(message.guildId));
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  if (!added && panel.mode === 'add') return;
  await applyChoice(member, panel, entry.role_id, added).catch(() => undefined);
  if (added && panel.mode === 'unique') {
    const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
    const msg = full?.message;
    if (msg) {
      for (const other of msg.reactions.cache.values()) {
        if ((other.emoji.id ?? other.emoji.name) !== key) await other.users.remove(user.id).catch(() => undefined);
      }
    }
  }
}

function panelsAutocomplete(guildId: string, focused: string) {
  return all<PanelRow>('SELECT * FROM reaction_roles WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100', guildId)
    .filter((p) => `${p.id} ${p.title}`.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((p) => ({ name: truncate(`#${p.id} · ${p.title} (${p.type})`, 100), value: p.id }));
}

const reactionrole: SlashCommand = {
  category: 'roles',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
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
  async autocomplete(interaction) {
    await interaction.respond(panelsAutocomplete(interaction.guildId, String(interaction.options.getFocused())));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'liste') {
      const panels = all<PanelRow>('SELECT * FROM reaction_roles WHERE guild_id = ? ORDER BY created_at DESC', guild.id);
      const lines = panels.map((p) => `**#${p.id}** ${truncate(p.title, 60)} — ${p.type} · ${entries(p.id).length} rôle(s) · <#${p.channel_id}>`);
      return reply(interaction, { embeds: [info(guild, lines.join('\n') || 'Aucun panneau.', { titre: 'Panneaux de rôles', sujet: '🎭' })], ephemeral: true });
    }
    if (sub === 'creer') {
      const channel = interaction.options.getChannel('salon') ?? interaction.channel;
      if (!channel) return;
      const r = run(
        'INSERT INTO reaction_roles (guild_id, channel_id, title, description, type, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        guild.id,
        channel.id,
        interaction.options.getString('titre', true),
        interaction.options.getString('description') ?? '',
        interaction.options.getString('type', true),
        interaction.options.getString('mode') ?? 'toggle',
        Date.now(),
      );
      return reply(interaction, { embeds: [ok(guild, `Panneau **#${r.lastInsertRowid}** créé. Ajoute des rôles avec \`/reactionrole ajouter\` : il sera publié automatiquement.`)], ephemeral: true });
    }
    const panel = requirePanel(guild.id, interaction.options.getInteger('panneau', true));
    if (sub === 'supprimer') {
      const channel = guild.channels.cache.get(panel.channel_id);
      if (channel?.isTextBased() && panel.message_id) await channel.messages.delete(panel.message_id).catch(() => undefined);
      run('DELETE FROM reaction_roles WHERE id = ?', panel.id);
      return reply(interaction, { embeds: [ok(guild, `Panneau #${panel.id} supprimé.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    if (sub === 'retirer') {
      run('DELETE FROM reaction_role_entries WHERE panel_id = ? AND role_id = ?', panel.id, role.id);
      const url = await publish(guild, panel);
      return reply(interaction, { embeds: [ok(guild, `<@&${role.id}> retiré du panneau. ${url}`)], ephemeral: true });
    }
    const emoji = interaction.options.getString('emoji');
    if (panel.type === 'reaction' && !emoji) throw new UserError('Un émoji est obligatoire pour un panneau à réactions.');
    if (!canBotManageRole(guild, guild.roles.cache.get(role.id)!)) throw new UserError('Je ne peux pas donner ce rôle : place mon rôle au-dessus.');
    if (entries(panel.id).length >= 25) throw new UserError('25 rôles maximum par panneau.');
    transaction(() => {
      const position = entries(panel.id).length;
      run(
        'INSERT OR REPLACE INTO reaction_role_entries (panel_id, role_id, emoji, label, position) VALUES (?, ?, ?, ?, ?)',
        panel.id,
        role.id,
        emoji,
        interaction.options.getString('label') ?? role.name,
        position,
      );
    });
    const url = await publish(guild, panel);
    return reply(interaction, { embeds: [ok(guild, `<@&${role.id}> ajouté au panneau. ${url}`)], ephemeral: true });
  },
};

const notificationrole: SlashCommand = {
  category: 'roles',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('notificationrole')
    .setDescription('Panneau 🔔 notifications en un clic')
    .addRoleOption((o) => o.setName('lives').setDescription('Rôle 🔴 Lives Twitch'))
    .addRoleOption((o) => o.setName('youtube').setDescription('Rôle 🎥 YouTube'))
    .addRoleOption((o) => o.setName('giveaways').setDescription('Rôle 🎉 Giveaways'))
    .addRoleOption((o) => o.setName('annonces').setDescription('Rôle 📢 Annonces'))
    .addRoleOption((o) => o.setName('evenements').setDescription('Rôle 🎮 Événements'))
    .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async execute(interaction) {
    const guild = interaction.guild;
    const picks: [string, string, string][] = [
      ['lives', '🔴', 'Lives Twitch'],
      ['youtube', '🎥', 'YouTube'],
      ['giveaways', '🎉', 'Giveaways'],
      ['annonces', '📢', 'Annonces'],
      ['evenements', '🎮', 'Événements'],
    ];
    const chosen = picks.map(([opt, emoji, label]) => ({ role: interaction.options.getRole(opt), emoji, label })).filter((p) => p.role);
    if (!chosen.length) throw new UserError('Choisis au moins un rôle.');
    const blocked = chosen.filter((c) => !canBotManageRole(guild, guild.roles.cache.get(c.role!.id)!));
    if (blocked.length) throw new UserError(`Je ne peux pas donner ${blocked.map((b) => `<@&${b.role!.id}>`).join(', ')} : place mon rôle au-dessus.`);
    const channel = interaction.options.getChannel('salon') ?? interaction.channel;
    if (!channel) return;
    const panelId = transaction(() => {
      const r = run(
        "INSERT INTO reaction_roles (guild_id, channel_id, title, description, type, mode, kind, created_at) VALUES (?, ?, '🔔 NOTIFICATIONS', ?, 'button', 'toggle', 'notification', ?)",
        guild.id,
        channel.id,
        'Choisis toi-même les notifications que tu veux recevoir.',
        Date.now(),
      );
      chosen.forEach((c, i) => run('INSERT INTO reaction_role_entries (panel_id, role_id, emoji, label, position) VALUES (?, ?, ?, ?, ?)', r.lastInsertRowid, c.role!.id, c.emoji, c.label, i));
      return r.lastInsertRowid;
    });
    const url = await publish(guild, requirePanel(guild.id, panelId));
    await reply(interaction, { embeds: [ok(guild, `Panneau de notifications publié : ${url}`)], ephemeral: true });
  },
};

export const reactionRolesModule: BotModule = {
  id: 'reactionroles',
  name: 'Rôles à choisir',
  emoji: '🎭',
  description: 'Panneaux de rôles : réactions, boutons, menus et notifications',
  toggleable: true,
  defaultEnabled: true,
  commands: [reactionrole, notificationrole],
  components: [
    {
      prefix: 'rr',
      async button(interaction: ButtonInteraction<'cached'>, [, panelId, roleId]) {
        const panel = requirePanel(interaction.guildId, panelId);
        if (!entries(panel.id).some((e) => e.role_id === roleId)) throw new UserError('Ce rôle n’est plus proposé.');
        const text = await applyChoice(interaction.member, panel, roleId!);
        await interaction.reply({ embeds: [ok(interaction.guild, text)], flags: MessageFlags.Ephemeral });
      },
      async select(interaction: AnySelectMenuInteraction<'cached'>, [, panelId]) {
        if (!interaction.isStringSelectMenu()) return;
        const panel = requirePanel(interaction.guildId, panelId);
        const offered = entries(panel.id).map((e) => e.role_id);
        const wanted = new Set(interaction.values.filter((v) => offered.includes(v)));
        const results: string[] = [];
        for (const roleId of offered) {
          const has = interaction.member.roles.cache.has(roleId);
          if (wanted.has(roleId) && !has) results.push(await applyChoice(interaction.member, panel, roleId, true).catch((e: Error) => `⚠️ ${e.message}`));
          if (!wanted.has(roleId) && has && panel.mode !== 'add') results.push(await applyChoice(interaction.member, panel, roleId, false).catch((e: Error) => `⚠️ ${e.message}`));
        }
        await interaction.reply({ embeds: [ok(interaction.guild, results.join('\n') || 'Aucun changement.')], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [
    on('messageReactionAdd', (reaction, user) => onReaction(reaction, user, true)),
    on('messageReactionRemove', (reaction, user) => onReaction(reaction, user, false)),
    on('messageDelete', (message) => {
      run('UPDATE reaction_roles SET message_id = NULL WHERE message_id = ?', message.id);
    }),
  ],
};
