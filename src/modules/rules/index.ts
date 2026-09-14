import { ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, SlashCommandBuilder, type GuildTextBasedChannel } from 'discord.js';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { canBotManageRole } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { button, row } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { run } from '../../database/db';

function panel(guild: import('discord.js').Guild) {
  const cfg = getConfig(guild.id).rules;
  const embed = new EmbedBuilder().setColor(colorFor(guild)).setTitle(truncate(cfg.title, 256));
  for (const s of cfg.sections.slice(0, 25)) embed.addFields({ name: truncate(s.title, 256), value: truncate(s.content, 1024), inline: false });
  embed.setFooter({ text: `${guild.name} · en restant ici, tu acceptes ces règles` });
  return { embeds: [embed], components: cfg.acceptRoleId ? [row(button('rules:accept', 'J’accepte le règlement', ButtonStyle.Success, '✅'))] : [] };
}

/** Sections éditables en texte : « ## Titre » puis le contenu, répété. */
export function parseSections(input: string): { title: string; content: string }[] {
  const out: { title: string; content: string }[] = [];
  for (const block of input.split(/^##\s*/m).map((b) => b.trim()).filter(Boolean)) {
    const [title, ...rest] = block.split('\n');
    const content = rest.join('\n').trim();
    if (title && content) out.push({ title: title.trim(), content });
  }
  return out.slice(0, 25);
}

const rules: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Le panneau du règlement')
    .addChannelOption((o) => o.setName('salon').setDescription('Où le poster (salon réglé par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async execute(interaction) {
    const cfg = getConfig(interaction.guildId).rules;
    const channel = (interaction.options.getChannel('salon') ?? resolveTextChannel(interaction.guild, cfg.channelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!channel) throw new UserError('Salon introuvable.');
    const sent = await channel.send(panel(interaction.guild));
    await reply(interaction, { embeds: [ok(interaction.guild, `Règlement posté : ${sent.url}${cfg.acceptRoleId ? '' : '\n-# Aucun rôle d’acceptation réglé : le bouton n’apparaît pas.'}`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'rules',
  section: 'security',
  title: 'Règlement',
  emoji: '📜',
  moduleId: 'rules',
  order: 1,
  description: 'Le panneau `/rules` avec un bouton « J’accepte » qui donne le rôle membre.\n-# Sections : une ligne `## Titre` puis le texte, répété.',
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon du règlement', get: (c) => c.rules.channelId, set: (c, v) => void (c.rules.channelId = v) },
    { kind: 'role', key: 'accept', label: 'Rôle donné en acceptant', assignable: true, get: (c) => c.rules.acceptRoleId, set: (c, v) => void (c.rules.acceptRoleId = v) },
    { kind: 'role', key: 'remove', label: 'Rôle retiré en acceptant', assignable: true, get: (c) => c.rules.removeRoleId, set: (c, v) => void (c.rules.removeRoleId = v) },
    { kind: 'text', key: 'title', label: 'Titre', maxLength: 200, required: true, get: (c) => c.rules.title, set: (c, v) => void (c.rules.title = v) },
    {
      kind: 'text',
      key: 'sections',
      label: 'Sections',
      long: true,
      maxLength: 4000,
      required: true,
      get: (c) => c.rules.sections.map((s) => `## ${s.title}\n${s.content}`).join('\n\n'),
      set: (c, v) => void (c.rules.sections = parseSections(v)),
      validate: (v) => (parseSections(v).length ? null : 'Au moins une section : `## Titre` puis le texte.'),
    },
  ],
};

export const rulesModule: BotModule = {
  id: 'rules',
  name: 'Règlement',
  emoji: '📜',
  description: 'Panneau de règlement avec acceptation',
  toggleable: true,
  defaultEnabled: true,
  commands: [rules],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'rules',
      async button(interaction) {
        const cfg = getConfig(interaction.guildId).rules;
        const guild = interaction.guild;
        const role = cfg.acceptRoleId ? guild.roles.cache.get(cfg.acceptRoleId) : null;
        if (!role || !canBotManageRole(guild, role)) throw new UserError('Le rôle du règlement n’est pas utilisable. Préviens le staff.');
        if (interaction.member.roles.cache.has(role.id)) {
          await interaction.reply({ embeds: [ok(guild, 'Tu as déjà accepté le règlement. Merci ! 💜')], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.member.roles.add(role, 'Règlement accepté');
        const remove = cfg.removeRoleId ? guild.roles.cache.get(cfg.removeRoleId) : null;
        if (remove && canBotManageRole(guild, remove)) await interaction.member.roles.remove(remove, 'Règlement accepté').catch(() => undefined);
        run('INSERT OR IGNORE INTO users (guild_id, user_id, first_seen) VALUES (?, ?, ?)', guild.id, interaction.user.id, Date.now());
        void journal(guild, 'autorole', { title: 'Règlement accepté', tone: 'ok', lines: [`<@${interaction.user.id}> a reçu <@&${role.id}>`] });
        await interaction.reply({ embeds: [ok(guild, `Merci ! Tu as maintenant accès au serveur avec le rôle <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
