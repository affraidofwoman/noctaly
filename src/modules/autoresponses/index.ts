import { MessageFlags, SlashCommandBuilder, type Message } from 'discord.js';
import { all, run } from '../../database/db';
import { info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { reply } from '../../core/interactions';
import { Cooldowns } from '../../core/rateLimit';
import { neutralizeMentions, truncate } from '../../core/text';
import { buildModal } from '../../core/ui';
import { renderTemplate } from '../../core/variables';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';

type MatchType = 'contains' | 'exact' | 'startswith' | 'word';

interface ResponseRow {
  id: number;
  guild_id: string;
  trigger: string;
  match_type: MatchType;
  response: string;
}

const MATCH_LABEL: Record<MatchType, string> = { contains: 'contient', exact: 'exactement', startswith: 'commence par', word: 'mot entier' };

const cache = new Map<string, ResponseRow[]>();
const cooldowns = new Cooldowns();

function list(guildId: string): ResponseRow[] {
  let rows = cache.get(guildId);
  if (!rows) {
    rows = all<ResponseRow>('SELECT id, guild_id, trigger, match_type, response FROM auto_responses WHERE guild_id = ? ORDER BY id', guildId);
    cache.set(guildId, rows);
  }
  return rows;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function matches(row: Pick<ResponseRow, 'trigger' | 'match_type'>, content: string): boolean {
  const text = normalize(content);
  const trigger = normalize(row.trigger);
  if (!trigger) return false;
  switch (row.match_type) {
    case 'exact':
      return text === trigger;
    case 'startswith':
      return text.startsWith(trigger);
    case 'word':
      return ` ${text.replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${trigger} `);
    default:
      return text.includes(trigger);
  }
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const row = list(message.guildId).find((r) => matches(r, message.content));
  if (!row) return;
  if (cooldowns.take(`${message.channelId}:${row.id}`, 15_000) > 0) return;
  await message
    .reply({ content: truncate(renderTemplate(row.response, { member: message.member, guild: message.guild, channel: message.channel }), 2000), allowedMentions: { parse: [], repliedUser: false } })
    .catch(() => undefined);
}

const autoresponse: SlashCommand = {
  category: 'customization',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('autoresponse')
    .setDescription('Réponses automatiques')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Ajouter une réponse automatique')
        .addStringOption((o) => o.setName('declencheur').setDescription('Ex : youtube').setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Quand répondre')
            .addChoices({ name: 'Le message contient', value: 'contains' }, { name: 'Mot entier', value: 'word' }, { name: 'Commence par', value: 'startswith' }, { name: 'Message exact', value: 'exact' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Supprimer une réponse automatique')
        .addIntegerOption((o) => o.setName('reponse').setDescription('La réponse').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les réponses automatiques')),
  async autocomplete(interaction) {
    await interaction.respond(list(interaction.guildId).slice(0, 25).map((r) => ({ name: truncate(`#${r.id} « ${r.trigger} » → ${r.response}`, 100), value: r.id })));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const lines = list(guild.id).map((r) => `**#${r.id}** ${MATCH_LABEL[r.match_type]} « ${truncate(r.trigger, 40)} » → ${truncate(r.response, 60)}`);
      return reply(interaction, { embeds: [info(guild, lines.join('\n') || 'Aucune réponse automatique.', { titre: 'Réponses automatiques', sujet: '💬' })], ephemeral: true });
    }
    if (sub === 'remove') {
      const r = run('DELETE FROM auto_responses WHERE id = ? AND guild_id = ?', interaction.options.getInteger('reponse', true), guild.id);
      cache.delete(guild.id);
      return reply(interaction, { embeds: [ok(guild, r.changes ? 'Réponse automatique supprimée.' : 'Introuvable.')], ephemeral: true });
    }
    if (list(guild.id).length >= 50) throw new UserError('50 réponses automatiques maximum.');
    const trigger = interaction.options.getString('declencheur', true);
    const mode = interaction.options.getString('mode') ?? 'contains';
    await interaction.showModal(
      buildModal(`ar:save:${mode}`, `Réponse à « ${truncate(trigger, 25)} »`, [
        { id: 'trigger', label: 'Déclencheur', value: trigger, maxLength: 100 },
        { id: 'response', label: 'Réponse', long: true, maxLength: 2000, placeholder: '🎥 Tu peux retrouver les vidéos ici !' },
      ]),
    );
  },
};

export const autoResponsesModule: BotModule = {
  id: 'autoresponses',
  name: 'Réponses automatiques',
  emoji: '💬',
  description: 'Le bot répond quand un mot-clé est écrit',
  toggleable: true,
  defaultEnabled: true,
  commands: [autoresponse],
  components: [
    {
      prefix: 'ar',
      level: PermLevel.ADMIN,
      async modal(interaction, [, mode]) {
        const trigger = interaction.fields.getTextInputValue('trigger').trim();
        const response = neutralizeMentions(interaction.fields.getTextInputValue('response').trim());
        if (normalize(trigger).length < 2) throw new UserError('Déclencheur trop court (2 caractères minimum).');
        run(
          'INSERT INTO auto_responses (guild_id, trigger, match_type, response, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          interaction.guildId,
          trigger,
          ['contains', 'exact', 'startswith', 'word'].includes(mode ?? '') ? mode : 'contains',
          response,
          interaction.user.id,
          Date.now(),
        );
        cache.delete(interaction.guildId);
        await interaction.reply({ embeds: [ok(interaction.guild, `Quand un message ${MATCH_LABEL[(mode as MatchType) ?? 'contains']} « **${truncate(trigger, 60)}** », je répondrai :\n> ${truncate(response, 300)}`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [on('messageCreate', (m) => onMessage(m), 170)],
};
