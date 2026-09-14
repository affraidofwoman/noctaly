import { randomInt } from 'node:crypto';
import { ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, type ButtonInteraction, type Guild } from 'discord.js';
import { colorFor } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import type { SetupPage } from '../../core/setup';
import { neutralizeMentions, truncate } from '../../core/text';
import { button, row } from '../../core/ui';
import type { BotModule, SlashCommand } from '../../core/types';

type Game = 'eightBall' | 'coinflip' | 'dice' | 'rps';

function requireGame(guildId: string, game: Game): void {
  if (!getConfig(guildId).games[game]) throw new UserError('Ce mini-jeu est désactivé sur ce serveur.');
}

const ANSWERS = [
  'Oui, clairement.', 'C’est certain.', 'Sans aucun doute.', 'Tu peux compter dessus.', 'Très probablement.', 'Les signes disent oui.',
  'Réponse floue, réessaie.', 'Redemande plus tard.', 'Mieux vaut ne pas te le dire maintenant.', 'Concentre-toi et redemande.',
  'N’y compte pas.', 'Ma réponse est non.', 'Mes sources disent non.', 'Très peu probable.', 'Chat a dit non. 🐈',
];

const embed = (guild: Guild) => new EmbedBuilder().setColor(colorFor(guild));

const eightBall: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Pose une question à la boule magique')
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true).setMaxLength(200)),
  async execute(i) {
    requireGame(i.guildId, 'eightBall');
    const q = neutralizeMentions(i.options.getString('question', true));
    await reply(i, { embeds: [embed(i.guild).setTitle('🎱 Boule magique').setDescription(`**${truncate(q, 200)}**\n\n${ANSWERS[randomInt(ANSWERS.length)]}`)] });
  },
};

const coinflip: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder().setName('coinflip').setDescription('Pile ou face'),
  async execute(i) {
    requireGame(i.guildId, 'coinflip');
    const heads = randomInt(2) === 0;
    await reply(i, { embeds: [embed(i.guild).setTitle('🪙 Pile ou face').setDescription(`La pièce tombe sur… **${heads ? 'Pile' : 'Face'}** !`)] });
  },
};

const dice: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Lancer des dés')
    .addIntegerOption((o) => o.setName('faces').setDescription('Nombre de faces (6 par défaut)').setMinValue(2).setMaxValue(1000))
    .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre de dés (1 par défaut)').setMinValue(1).setMaxValue(20)),
  async execute(i) {
    requireGame(i.guildId, 'dice');
    const faces = i.options.getInteger('faces') ?? 6;
    const count = i.options.getInteger('nombre') ?? 1;
    const rolls = Array.from({ length: count }, () => randomInt(1, faces + 1));
    await reply(i, {
      embeds: [embed(i.guild).setTitle('🎲 Lancer de dés').setDescription(`${count} d${faces} : ${rolls.map((r) => `**${r}**`).join(' · ')}${count > 1 ? `\nTotal : **${rolls.reduce((a, b) => a + b, 0)}**` : ''}`)],
    });
  },
};

const RPS: Record<string, { label: string; emoji: string; beats: string }> = {
  pierre: { label: 'Pierre', emoji: '🪨', beats: 'ciseaux' },
  feuille: { label: 'Feuille', emoji: '📄', beats: 'pierre' },
  ciseaux: { label: 'Ciseaux', emoji: '✂️', beats: 'feuille' },
};

const rps: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Pierre, feuille, ciseaux')
    .addUserOption((o) => o.setName('adversaire').setDescription('Défier un membre (contre le bot par défaut)')),
  async execute(i) {
    requireGame(i.guildId, 'rps');
    const opponent = i.options.getUser('adversaire');
    if (opponent && (opponent.bot || opponent.id === i.user.id)) throw new UserError('Choisis un autre membre (pas un bot, pas toi).');
    const opp = opponent?.id ?? 'bot';
    await reply(i, {
      embeds: [embed(i.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(opponent ? `<@${i.user.id}> défie <@${opponent.id}> ! Chacun choisit en secret.` : 'Choisis ton coup !')],
      components: [row(...Object.entries(RPS).map(([key, v]) => button(`rps:${i.user.id}:${opp}:${key}`, v.label, ButtonStyle.Secondary, v.emoji)))],
      allowedMentions: { users: opponent ? [opponent.id] : [] },
    });
  },
};

/** Coups en attente pour les duels (clé : message). */
const pending = new Map<string, Map<string, string>>();

async function onRps(interaction: ButtonInteraction<'cached'>, [challenger, opponent, move]: string[]) {
  if (!move || !RPS[move]) return;
  const players = [challenger, opponent];
  if (opponent === 'bot') {
    if (interaction.user.id !== challenger) throw new UserError('Lance ta propre partie avec `/rps`.');
    const botMove = Object.keys(RPS)[randomInt(3)]!;
    const result = move === botMove ? 'Égalité !' : RPS[move]!.beats === botMove ? 'Tu gagnes ! 🎉' : 'Le bot gagne ! 🤖';
    await interaction.update({ embeds: [embed(interaction.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(`Toi : ${RPS[move]!.emoji} **${RPS[move]!.label}**\nBot : ${RPS[botMove]!.emoji} **${RPS[botMove]!.label}**\n\n**${result}**`)], components: [] });
    return;
  }
  if (!players.includes(interaction.user.id)) throw new UserError('Ce duel ne te concerne pas.');
  const moves = pending.get(interaction.message.id) ?? new Map<string, string>();
  moves.set(interaction.user.id, move);
  pending.set(interaction.message.id, moves);
  if (moves.size < 2) {
    await interaction.reply({ content: `Coup enregistré : ${RPS[move]!.emoji} — en attente de l’adversaire.`, flags: MessageFlags.Ephemeral });
    return;
  }
  pending.delete(interaction.message.id);
  const a = moves.get(challenger!)!;
  const b = moves.get(opponent!)!;
  const result = a === b ? 'Égalité !' : RPS[a]!.beats === b ? `<@${challenger}> gagne ! 🎉` : `<@${opponent}> gagne ! 🎉`;
  await interaction.update({
    embeds: [embed(interaction.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(`<@${challenger}> : ${RPS[a]!.emoji} **${RPS[a]!.label}**\n<@${opponent}> : ${RPS[b]!.emoji} **${RPS[b]!.label}**\n\n**${result}**`)],
    components: [],
  });
}

const setupPage: SetupPage = {
  id: 'games',
  section: 'community',
  title: 'Mini-jeux',
  emoji: '🎲',
  moduleId: 'games',
  order: 11,
  description: 'Chaque mini-jeu peut être activé séparément.',
  fields: [
    { kind: 'toggle', key: '8ball', label: '8ball', get: (c) => c.games.eightBall, set: (c, v) => void (c.games.eightBall = v) },
    { kind: 'toggle', key: 'coinflip', label: 'Pile ou face', get: (c) => c.games.coinflip, set: (c, v) => void (c.games.coinflip = v) },
    { kind: 'toggle', key: 'dice', label: 'Dés', get: (c) => c.games.dice, set: (c, v) => void (c.games.dice = v) },
    { kind: 'toggle', key: 'rps', label: 'Pierre-feuille-ciseaux', get: (c) => c.games.rps, set: (c, v) => void (c.games.rps = v) },
  ],
};

export const gamesModule: BotModule = {
  id: 'games',
  name: 'Mini-jeux',
  emoji: '🎲',
  description: '8ball, pile ou face, dés, pierre-feuille-ciseaux',
  toggleable: true,
  defaultEnabled: false,
  commands: [eightBall, coinflip, dice, rps],
  setupPages: [setupPage],
  components: [{ prefix: 'rps', button: (i, args) => onRps(i, args) }],
};
