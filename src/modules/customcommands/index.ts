import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client, type Guild, type Message } from 'discord.js';
import { all, get, run } from '../../database/db';
import { getDispatcher } from '../../core/bot';
import { brandEmbed, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { buildModal } from '../../core/ui';
import { renderTemplate, variablesHelp } from '../../core/variables';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';

const log = createLogger('commandes-perso');

interface CustomRow {
  guild_id: string;
  name: string;
  description: string;
  response: string;
  as_embed: number;
  discord_command_id: string | null;
  uses: number;
}

const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

function findCommand(guildId: string, name: string): CustomRow | undefined {
  return get<CustomRow>('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', guildId, name.toLowerCase());
}

function payload(guild: Guild, row: CustomRow, ctx: Parameters<typeof renderTemplate>[1]) {
  run('UPDATE custom_commands SET uses = uses + 1 WHERE guild_id = ? AND name = ?', row.guild_id, row.name);
  const text = renderTemplate(row.response, ctx);
  if (row.as_embed) return { embeds: [brandEmbed(guild).setDescription(truncate(text, 4096))], allowedMentions: { parse: [] as [] } };
  return { content: truncate(text, 2000), allowedMentions: { parse: [] as [] } };
}

/** Enregistre la commande comme commande slash du serveur (sans toucher aux commandes globales). */
async function registerGuildCommand(guild: Guild, row: CustomRow): Promise<string | null> {
  if (getDispatcher().commands.has(row.name)) return null;
  try {
    const created = await guild.commands.create({ name: row.name, description: truncate(row.description || `Commande personnalisée /${row.name}`, 100) });
    run('UPDATE custom_commands SET discord_command_id = ? WHERE guild_id = ? AND name = ?', created.id, guild.id, row.name);
    return created.id;
  } catch (err) {
    log.warn(`Commande /${row.name} non enregistrée sur ${guild.id} : ${(err as Error).message}`);
    return null;
  }
}

async function unregisterGuildCommand(guild: Guild, row: CustomRow): Promise<void> {
  if (row.discord_command_id) await guild.commands.delete(row.discord_command_id).catch(() => undefined);
}

const customcommand: SlashCommand = {
  category: 'customization',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('customcommand')
    .setDescription('Commandes personnalisées')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Créer ou modifier une commande')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : twitter (lettres, chiffres, - et _)').setRequired(true).setMaxLength(32))
        .addBooleanOption((o) => o.setName('embed').setDescription('Répondre dans un embed')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Supprimer une commande')
        .addStringOption((o) => o.setName('nom').setDescription('La commande').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les commandes personnalisées')),
  async autocomplete(interaction) {
    const focused = String(interaction.options.getFocused()).toLowerCase();
    const rows = all<CustomRow>('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY name', interaction.guildId);
    await interaction.respond(rows.filter((r) => r.name.includes(focused)).slice(0, 25).map((r) => ({ name: r.name, value: r.name })));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    const prefix = getConfig(guild.id).customcommands.prefix;
    if (sub === 'list') {
      const rows = all<CustomRow>('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY name', guild.id);
      const lines = rows.map((r) => `**${prefix}${r.name}**${r.discord_command_id ? ` · /${r.name}` : ''} — ${truncate(r.description || r.response, 60)} \`${r.uses}×\``);
      return reply(interaction, { embeds: [info(guild, lines.join('\n') || 'Aucune commande personnalisée.', { titre: 'Commandes personnalisées', sujet: '🧩' })], ephemeral: true });
    }
    const name = interaction.options.getString('nom', true).toLowerCase();
    if (sub === 'remove') {
      const row = findCommand(guild.id, name);
      if (!row) throw new UserError('Commande introuvable.');
      await unregisterGuildCommand(guild, row);
      run('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?', guild.id, name);
      return reply(interaction, { embeds: [ok(guild, `Commande **${name}** supprimée.`)], ephemeral: true });
    }
    if (!NAME_PATTERN.test(name)) throw new UserError('Nom invalide : 1 à 32 caractères parmi a-z, 0-9, - et _.');
    const existing = findCommand(guild.id, name);
    await interaction.showModal(
      buildModal(`cc:save:${name}:${interaction.options.getBoolean('embed') ? 1 : existing?.as_embed ?? 0}`, `Commande ${prefix}${name}`.slice(0, 45), [
        { id: 'response', label: 'Réponse', long: true, value: existing?.response, maxLength: 2000, placeholder: '🐦 Twitter : https://x.com/…  ({user}, {server}, {membercount})' },
        { id: 'description', label: 'Description (pour /help et la commande slash)', value: existing?.description, required: false, maxLength: 100 },
      ]),
    );
  },
};

async function handleSlash(interaction: ChatInputCommandInteraction<'cached'>): Promise<boolean> {
  if (!isModuleEnabled(interaction.guildId, 'customcommands')) return false;
  const row = findCommand(interaction.guildId, interaction.commandName);
  if (!row) return false;
  await interaction.reply(payload(interaction.guild, row, { member: interaction.member, guild: interaction.guild, channel: interaction.channel }));
  return true;
}

async function handleMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const prefix = getConfig(message.guildId).customcommands.prefix;
  if (!prefix || !message.content.startsWith(prefix)) return;
  const name = message.content.slice(prefix.length).split(/\s+/)[0]?.toLowerCase();
  if (!name || !NAME_PATTERN.test(name)) return;
  const row = findCommand(message.guildId, name);
  if (!row) return;
  await message.reply({ ...payload(message.guild, row, { member: message.member, guild: message.guild, channel: message.channel }), allowedMentions: { parse: [], repliedUser: false } });
}

const setupPage: SetupPage = {
  id: 'customcommands',
  section: 'community',
  title: 'Commandes personnalisées',
  emoji: '🧩',
  moduleId: 'customcommands',
  order: 8,
  description: `Des réponses rapides créées avec \`/customcommand add\`, utilisables avec le préfixe choisi et en commande slash du serveur.\n-# Variables : ${['user', 'username', 'server', 'membercount', 'brand', 'twitch'].map((v) => `\`{${v}}\``).join(' ')}`,
  fields: [
    {
      kind: 'text',
      key: 'prefix',
      label: 'Préfixe des commandes perso',
      maxLength: 5,
      required: true,
      get: (c) => c.customcommands.prefix,
      set: (c, v) => void (c.customcommands.prefix = v),
      validate: (v) => (/^\S{1,5}$/.test(v) ? null : '1 à 5 caractères sans espace.'),
    },
  ],
};

export const customCommandsModule: BotModule = {
  id: 'customcommands',
  name: 'Commandes personnalisées',
  emoji: '🧩',
  description: 'Réponses personnalisées en préfixe et en slash',
  toggleable: true,
  defaultEnabled: true,
  commands: [customcommand],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'cc',
      level: PermLevel.ADMIN,
      async modal(interaction, [, name, asEmbed]) {
        const guild = interaction.guild;
        if (!name || !NAME_PATTERN.test(name)) throw new UserError('Nom invalide.');
        const response = interaction.fields.getTextInputValue('response').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_commands WHERE guild_id = ?', guild.id)?.n ?? 0;
        const existing = findCommand(guild.id, name);
        if (!existing && count >= 100) throw new UserError('100 commandes personnalisées maximum.');
        run(
          `INSERT INTO custom_commands (guild_id, name, description, response, as_embed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, name) DO UPDATE SET description = excluded.description, response = excluded.response, as_embed = excluded.as_embed`,
          guild.id,
          name,
          description,
          response,
          asEmbed === '1' ? 1 : 0,
          interaction.user.id,
          Date.now(),
        );
        const row = findCommand(guild.id, name)!;
        const slashId = row.discord_command_id ?? (await registerGuildCommand(guild, row));
        if (row.discord_command_id && description !== existing?.description) {
          await guild.commands.edit(row.discord_command_id, { description: truncate(description || `Commande personnalisée /${name}`, 100) }).catch(() => undefined);
        }
        const prefix = getConfig(guild.id).customcommands.prefix;
        await interaction.reply({
          embeds: [ok(guild, `Commande **${prefix}${name}** ${existing ? 'modifiée' : 'créée'}${slashId ? ` · aussi disponible en **/${name}**` : ''}.\n\n**Variables :**\n${variablesHelp(['user', 'username', 'server', 'membercount'])}`)],
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
  events: [on('messageCreate', (m) => handleMessage(m), 160)],
  async onReady(client: Client<true>) {
    getDispatcher().onUnknownCommand(handleSlash);
    // Les commandes perso d'un serveur où le bot est revenu sont réenregistrées si besoin.
    for (const guild of client.guilds.cache.values()) {
      for (const row of all<CustomRow>('SELECT * FROM custom_commands WHERE guild_id = ? AND discord_command_id IS NULL', guild.id).slice(0, 20)) {
        await registerGuildCommand(guild, row);
      }
    }
  },
};
