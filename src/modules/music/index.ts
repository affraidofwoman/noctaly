import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { emojiFor } from '../../core/brand';
import { brandName, colorFor, erreur, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { createLogger } from '../../core/logger';
import { hasLevel } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { progressBar, truncate } from '../../core/text';
import { formatClock } from '../../core/time';
import { button, isHttpUrl, row } from '../../core/ui';
import { isWhitelisted } from '../../core/whitelists';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { allSessions, destroyAll, ensureSession, getSession, LOOP_LABELS, type GuildMusic, type LoopMode, type MusicEvents } from '../../services/music/player';
import { FFMPEG, initSources, resolve, spotifyEnabled, type Track } from '../../services/music/sources';

const log = createLogger('musique');
const lastAnnounce = new Map<string, Message>();

// ─── Rendu ─────────────────────────────────────────────────────────────────

const linked = (t: Track) => {
  const url = t.originalUrl ?? t.url;
  return url ? `[${truncate(t.title, 200)}](${url})` : truncate(t.title, 200);
};

function controls(session: GuildMusic | undefined, guildId: string): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const paused = session?.paused ?? false;
  const loop = session?.loop ?? 'off';
  return [
    row(
      button('mu:prev', '', ButtonStyle.Secondary, '⏮️').setDisabled(!session?.history.length),
      button('mu:toggle', '', paused ? ButtonStyle.Success : ButtonStyle.Primary, '⏯️'),
      button('mu:skip', '', ButtonStyle.Secondary, '⏭️'),
    ),
    row(
      button('mu:shuffle', '', ButtonStyle.Secondary, '🔀'),
      button('mu:loop', loop === 'off' ? '' : loop === 'track' ? '1' : '∞', loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success, '🔁'),
      button('mu:stop', '', ButtonStyle.Danger, '⏹️'),
      button('mu:queue', '', ButtonStyle.Secondary, emojiFor(guildId, 'message')),
    ),
  ];
}

export function nowPlayingEmbed(guild: Guild, session: GuildMusic | undefined): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(colorFor(guild)).setAuthor({ name: '🎵 NOW PLAYING' });
  const track = session?.current;
  if (!session || !track) {
    return embed.setDescription('💤 **Rien en lecture.** Lance `/play` ou `m!play <titre ou lien>` pour démarrer.');
  }
  const elapsed = Math.min(session.elapsed, track.duration || session.elapsed);
  embed
    .setDescription(
      [
        `${session.paused ? '⏸️' : '▶️'} **${linked(track)}**`,
        `${progressBar(track.duration ? elapsed / track.duration : 0, 16)}  \`${formatClock(elapsed)} / ${formatClock(track.duration)}\``,
      ].join('\n'),
    )
    .addFields(
      { name: '🔊 Volume', value: `${Math.round(session.volume * 100)} %`, inline: true },
      { name: '🔁 Boucle', value: LOOP_LABELS[session.loop], inline: true },
      { name: '📋 En attente', value: `${session.waiting} morceau${session.waiting > 1 ? 'x' : ''}`, inline: true },
      { name: '👤 Demandé par', value: `<@${track.requestedBy}>`, inline: true },
      { name: '⏳ Restant', value: track.duration ? formatClock(Math.max(0, track.duration - elapsed)) : '—', inline: true },
      { name: '🎧 Salon', value: session.channelId ? `<#${session.channelId}>` : '—', inline: true },
    )
    .setFooter({ text: `${brandName(guild)} · m!play · m!skip · m!stop · m!panel` });
  if (track.thumbnail && isHttpUrl(track.thumbnail)) embed.setThumbnail(track.thumbnail);
  return embed;
}

function queueEmbed(guild: Guild, session: GuildMusic, page = 0): EmbedBuilder {
  const all = [...session.queue, ...session.reserve];
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const lines = all.slice(p * perPage, (p + 1) * perPage).map((t, i) => `**${p * perPage + i + 1}.** ${truncate(t.title, 80)} \`[${formatClock(t.duration)}]\` — <@${t.requestedBy}>`);
  return new EmbedBuilder()
    .setColor(colorFor(guild))
    .setTitle('📋 File d’attente')
    .setDescription(
      `${session.current ? `**En cours :** ${linked(session.current)} \`[${formatClock(session.current.duration)}]\`\n\n` : ''}${lines.length ? lines.join('\n') : '_Rien après le morceau en cours._'}`,
    )
    .setFooter({ text: `Page ${p + 1}/${pages} · ${all.length} en attente · Boucle : ${LOOP_LABELS[session.loop]} · Volume : ${Math.round(session.volume * 100)}%` });
}

// ─── Événements du lecteur ─────────────────────────────────────────────────

function textChannel(session: GuildMusic): GuildTextBasedChannel | null {
  const ch = session.textChannelId ? session.guild.channels.cache.get(session.textChannelId) : null;
  return ch && ch.isTextBased() ? (ch as GuildTextBasedChannel) : null;
}

async function announce(session: GuildMusic, payload: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<MessageActionRowComponentBuilder>[] }) {
  const channel = textChannel(session);
  if (!channel) return;
  const sent = await channel.send(payload).catch(() => null);
  const previous = lastAnnounce.get(session.guild.id);
  if (sent) lastAnnounce.set(session.guild.id, sent);
  // Un seul panneau « Lecture en cours » à la fois, comme sur Airline.
  if (previous && sent && previous.id !== sent.id) await previous.delete().catch(() => undefined);
}

const events: MusicEvents = {
  onStart(session) {
    if (!getConfig(session.guild.id).music.announceNowPlaying) return;
    void announce(session, { embeds: [nowPlayingEmbed(session.guild, session)], components: controls(session, session.guild.id) });
  },
  onError(session, track, error) {
    void announce(session, {
      embeds: [new EmbedBuilder().setColor(colorFor(session.guild, 'error')).setDescription(`⚠️ Impossible de lire **${truncate(track?.title ?? 'ce morceau', 150)}** : \`${truncate(error.message, 200)}\`. Passage au suivant.`)],
    });
  },
  onFinish(session) {
    void announce(session, { embeds: [new EmbedBuilder().setColor(colorFor(session.guild)).setDescription('📭 File terminée. Ajoute un morceau avec `m!play` — je quitte le vocal dans 5 minutes sinon.')] });
  },
};

// ─── Actions partagées (préfixe, slash, boutons) ───────────────────────────

function isDj(member: GuildMember): boolean {
  const cfg = getConfig(member.guild.id).music;
  return hasLevel(member, PermLevel.STAFF) || isWhitelisted('dj', member.id, member.guild.id) || member.roles.cache.some((r) => cfg.djRoles.includes(r.id));
}

function requireSession(guild: Guild, needTrack = false): GuildMusic {
  const session = getSession(guild.id);
  if (!session?.connection) throw new UserError('Je ne suis pas en vocal.');
  if (needTrack && !session.current) throw new UserError('Rien n’est en train de jouer.');
  return session;
}

function requireSameChannel(member: GuildMember, session: GuildMusic): void {
  if (!session.isInSameChannel(member) && !isDj(member)) throw new UserError('Rejoins le salon vocal du bot pour contrôler la lecture.');
}

function voiceOf(member: GuildMember) {
  const channel = member.voice.channel;
  if (!channel) throw new UserError('Rejoins un salon vocal d’abord.');
  const perms = channel.permissionsFor(member.guild.members.me!);
  if (!perms?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new UserError('Je n’ai pas la permission de rejoindre / parler dans ce salon.');
  const busy = getSession(member.guild.id);
  if (busy?.channelId && busy.channelId !== channel.id && busy.current && !isDj(member)) throw new UserError(`Je joue déjà dans <#${busy.channelId}>.`);
  return channel;
}

async function doPlay(member: GuildMember, textChannelId: string, query: string): Promise<EmbedBuilder> {
  if (!query.trim()) throw new UserError('Usage : `m!play <lien ou recherche>`.');
  if (!FFMPEG) throw new UserError('FFmpeg est introuvable sur la machine du bot : la musique est indisponible.');
  const channel = voiceOf(member);
  const result = await resolve(query);
  if (result.kind === 'error') throw new UserError(result.reason);
  const session = ensureSession(member.guild, events);
  session.textChannelId = textChannelId;
  session.join(channel);
  const guild = member.guild;

  if (result.kind === 'playlist') {
    if (!result.tracks.length) throw new UserError('Cette playlist est vide ou inaccessible.');
    const tracks = result.tracks.map((t) => ({ ...t, requestedBy: member.id, fromPlaylist: true }));
    const { reserved } = session.add(tracks);
    return ok(guild, `Playlist **${truncate(result.name, 100)}** ajoutée — **${tracks.length}** morceaux, à partir de **${truncate(tracks[0]!.title, 100)}**${reserved ? ` — dont **${reserved}** en réserve, qui remonteront tout seuls` : ''}.`);
  }

  const track: Track = { ...result.track, requestedBy: member.id };
  const { position, immediate } = session.add([track]);
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild))
    .setAuthor({ name: immediate ? 'Lecture en cours' : 'Ajouté à la file' })
    .addFields({ name: 'Morceau', value: linked(track) })
    .setFooter({ text: `Demandé par ${member.user.username}`, iconURL: member.user.displayAvatarURL({ size: 64 }) });
  if (track.thumbnail && isHttpUrl(track.thumbnail)) embed.setThumbnail(track.thumbnail);
  if (immediate) embed.addFields({ name: 'Durée du morceau', value: formatClock(track.duration), inline: true });
  else {
    embed.addFields(
      { name: 'Avant lecture (estimé)', value: formatClock(session.timeUntil(position - 1)), inline: true },
      { name: 'Durée du morceau', value: formatClock(track.duration), inline: true },
      { name: 'Position dans la file', value: String(position), inline: true },
    );
  }
  return embed;
}

type Action = 'pause' | 'resume' | 'toggle' | 'skip' | 'stop' | 'shuffle' | 'prev' | 'join' | 'leave' | 'cancelplaylist';

function doAction(member: GuildMember, action: Action, textChannelId: string | null): string {
  const guild = member.guild;
  if (action === 'join') {
    const channel = voiceOf(member);
    const session = ensureSession(guild, events);
    if (textChannelId) session.textChannelId = textChannelId;
    session.join(channel);
    return `✅ Rejoint **${channel.name}**.`;
  }
  const session = requireSession(guild, ['pause', 'resume', 'toggle', 'skip', 'prev'].includes(action));
  requireSameChannel(member, session);
  switch (action) {
    case 'pause':
      if (session.paused) return 'ℹ️ Déjà en pause.';
      session.togglePause();
      return '⏸️ Lecture en pause.';
    case 'resume':
      if (!session.paused) return 'ℹ️ La lecture n’est pas en pause.';
      session.togglePause();
      return '▶️ Lecture reprise.';
    case 'toggle':
      return session.togglePause() ? '⏸️ Lecture en pause.' : '▶️ Lecture reprise.';
    case 'skip': {
      const current = session.current!;
      if (isDj(member) || current.requestedBy === member.id || session.humanListeners() <= 2) {
        session.skip();
        return `⏭️ **${truncate(current.title, 150)}** passé.`;
      }
      session.skipVotes.add(member.id);
      const needed = session.votesNeeded();
      if (session.skipVotes.size < needed) return `🗳️ Vote pour passer **${truncate(current.title, 120)}** : **${session.skipVotes.size}/${needed}**.`;
      session.skip();
      return `⏭️ **${truncate(current.title, 150)}** passé (vote majoritaire).`;
    }
    case 'prev': {
      const prev = session.previous();
      return prev ? `⏮️ Retour à **${truncate(prev.title, 150)}**.` : 'ℹ️ Aucun morceau précédent.';
    }
    case 'shuffle':
      if (session.waiting < 2) throw new UserError('Pas assez de morceaux en attente pour mélanger.');
      return `🔀 File mélangée — **${session.shuffle()}** morceaux.`;
    case 'cancelplaylist': {
      const n = session.clearPlaylistTracks();
      return n ? `✅ Playlist annulée — **${n}** morceau(x) retiré(s).` : 'ℹ️ Aucune playlist en attente.';
    }
    case 'stop':
    case 'leave': {
      if (!isDj(member) && session.humanListeners() > 1 && session.current?.requestedBy !== member.id) {
        throw new UserError('Seul un DJ (ou la personne seule en vocal) peut tout arrêter.');
      }
      const played = session.played;
      session.destroy();
      lastAnnounce.get(guild.id)?.edit({ components: [] }).catch(() => undefined);
      return `🎵 Merci d’avoir écouté avec **${brandName(guild)}** ! La file est vidée et je quitte le vocal.${played ? ` **${played}** morceau${played > 1 ? 'x' : ''} joué${played > 1 ? 's' : ''} cette session.` : ''}`;
    }
  }
  return '';
}

function setVolume(member: GuildMember, raw: string): string {
  const session = requireSession(member.guild);
  requireSameChannel(member, session);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 200) throw new UserError('Volume entre 1 et 200.');
  session.setVolume(value);
  return `🔊 Volume réglé à **${value}%**.`;
}

function setLoop(member: GuildMember, raw: string | null): string {
  const session = requireSession(member.guild);
  requireSameChannel(member, session);
  const map: Record<string, LoopMode> = { off: 'off', non: 'off', piste: 'track', track: 'track', morceau: 'track', file: 'queue', queue: 'queue' };
  const order: LoopMode[] = ['off', 'track', 'queue'];
  const mode = raw ? map[raw.toLowerCase()] : order[(order.indexOf(session.loop) + 1) % order.length];
  if (!mode) throw new UserError('Usage : `m!loop <off|piste|file>`.');
  session.loop = mode;
  return `🔁 Boucle : **${LOOP_LABELS[mode]}**.`;
}

function removeAt(member: GuildMember, raw: string): string {
  const session = requireSession(member.guild);
  requireSameChannel(member, session);
  const position = Number.parseInt(raw, 10);
  if (!Number.isFinite(position) || position < 1 || position > session.waiting) throw new UserError(`Usage : \`m!remove <position>\` (1 à ${session.waiting}).`);
  const removed = session.remove(position);
  if (!removed) throw new UserError('Cette position n’existe plus.');
  if (removed.requestedBy !== member.id && !isDj(member)) {
    session.queue.splice(position - 1, 0, removed);
    throw new UserError('Tu ne peux retirer que tes propres morceaux.');
  }
  return `🗑️ **${truncate(removed.title, 150)}** retiré de la file.`;
}

// ─── Panneau (m!panel) ─────────────────────────────────────────────────────

const PANEL_OPTIONS: { value: string; label: string; description: string; emoji: string }[] = [
  { value: 'queue', label: 'File d’attente', description: 'Les morceaux en attente', emoji: '📋' },
  { value: 'shuffle', label: 'Mélanger la file', description: 'Ordre aléatoire', emoji: '🔀' },
  { value: 'loop-off', label: 'Boucle : désactivée', description: 'Lecture normale', emoji: '➡️' },
  { value: 'loop-track', label: 'Boucle : le morceau', description: 'Répète le morceau en cours', emoji: '🔂' },
  { value: 'loop-queue', label: 'Boucle : la file', description: 'Répète toute la file', emoji: '🔁' },
  ...[10, 25, 50, 75, 100, 125, 150, 200].map((v) => ({ value: `vol-${v}`, label: `Volume ${v} %`, description: v <= 25 ? 'Fond sonore' : v <= 75 ? 'Posé' : v === 100 ? 'Normal' : 'Fort', emoji: v <= 25 ? '🔈' : v <= 100 ? '🔉' : '📢' })),
  { value: 'join', label: 'Rejoindre mon salon', description: 'Fait venir le bot', emoji: '📥' },
  { value: 'cancelplaylist', label: 'Annuler la playlist', description: 'Retire les morceaux de playlist', emoji: '🚪' },
];

function panelPayload(guild: Guild) {
  const session = getSession(guild.id);
  const select = new StringSelectMenuBuilder().setCustomId('mu:panel').setPlaceholder('Une action…').addOptions(PANEL_OPTIONS);
  return { embeds: [nowPlayingEmbed(guild, session)], components: [...controls(session, guild.id), row(select)] };
}

// ─── Commandes à préfixe m! ────────────────────────────────────────────────

async function replyText(message: Message<true>, text: string) {
  await message.reply({ embeds: [new EmbedBuilder().setColor(colorFor(message.guild)).setDescription(text)], allowedMentions: { repliedUser: false } });
}

const simple = (name: string, action: Action, description: string, aliases: string[] = []): PrefixCommand => ({
  name,
  aliases,
  domain: 'music',
  category: 'music',
  description,
  async execute(message) {
    if (!message.member) return;
    await replyText(message, doAction(message.member, action, message.channelId));
  },
});

const prefixCommands: PrefixCommand[] = [
  {
    name: 'play',
    aliases: ['p'],
    domain: 'music',
    category: 'music',
    description: 'Un titre ou un lien',
    usage: '<titre ou lien>',
    async execute(message, args) {
      if (!message.member) return;
      const loading = await message.reply({ embeds: [new EmbedBuilder().setColor(colorFor(message.guild)).setDescription('🔎 Recherche…')], allowedMentions: { repliedUser: false } });
      try {
        const embed = await doPlay(message.member, message.channelId, args.join(' '));
        await loading.edit({ embeds: [embed] });
      } catch (err) {
        await loading.edit({ embeds: [erreur(message.guild, err instanceof UserError ? err.message : 'La lecture a échoué.')] });
      }
    },
  },
  simple('join', 'join', 'Me faire venir'),
  simple('pause', 'pause', 'Suspendre'),
  simple('resume', 'resume', 'Reprendre'),
  simple('skip', 'skip', 'Au suivant', ['s', 'next']),
  simple('previous', 'prev', 'Morceau précédent', ['prev', 'back']),
  simple('stop', 'stop', 'Tout arrêter', ['leave', 'dc']),
  simple('shuffle', 'shuffle', 'Mélanger'),
  simple('annuler', 'cancelplaylist', 'Annuler la playlist'),
  {
    name: 'queue',
    aliases: ['q'],
    domain: 'music',
    category: 'music',
    description: 'Ce qui suit',
    async execute(message, args) {
      const session = requireSession(message.guild);
      await message.reply({ embeds: [queueEmbed(message.guild, session, (Number(args[0]) || 1) - 1)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'nowplaying',
    aliases: ['np'],
    domain: 'music',
    category: 'music',
    description: 'En cours',
    async execute(message) {
      await message.reply({ embeds: [nowPlayingEmbed(message.guild, getSession(message.guildId))], components: controls(getSession(message.guildId), message.guildId), allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'volume',
    aliases: ['vol', 'v'],
    domain: 'music',
    category: 'music',
    description: 'De 1 à 200 %',
    usage: '<1-200>',
    async execute(message, args) {
      if (!message.member) return;
      await replyText(message, setVolume(message.member, args[0] ?? ''));
    },
  },
  {
    name: 'loop',
    domain: 'music',
    category: 'music',
    description: 'off · piste · file',
    usage: '[off|piste|file]',
    async execute(message, args) {
      if (!message.member) return;
      await replyText(message, setLoop(message.member, args[0] ?? null));
    },
  },
  {
    name: 'remove',
    aliases: ['rm'],
    domain: 'music',
    category: 'music',
    description: 'Retirer un rang',
    usage: '<position>',
    async execute(message, args) {
      if (!message.member) return;
      await replyText(message, removeAt(message.member, args[0] ?? ''));
    },
  },
  {
    name: 'panel',
    domain: 'music',
    category: 'music',
    description: 'Tout au clic',
    async execute(message) {
      await message.channel.send(panelPayload(message.guild));
    },
  },
  {
    name: 'help',
    domain: 'music',
    category: 'music',
    description: 'Les commandes musique',
    async execute(message) {
      const p = getConfig(message.guildId).prefixes.music;
      const embed = new EmbedBuilder()
        .setColor(colorFor(message.guild))
        .setTitle('🎵 La musique')
        .setDescription(`Toutes les commandes musique. Le panneau **${p}panel** fait la même chose au clic.`)
        .addFields(
          { name: '🎵 Écouter', value: [`**${p}play** — Un titre ou un lien`, `**${p}join** — Me faire venir`, `**${p}panel** — Tout au clic`].join('\n'), inline: true },
          { name: '⏯️ Pendant la lecture', value: [`**${p}pause** — Suspendre`, `**${p}resume** — Reprendre`, `**${p}skip** — Au suivant`, `**${p}previous** — Précédent`, `**${p}stop** — Tout arrêter`].join('\n'), inline: true },
          { name: '​', value: '⠀', inline: false },
          { name: '📋 La file', value: [`**${p}queue** — Ce qui suit`, `**${p}np** — En cours`, `**${p}shuffle** — Mélanger`, `**${p}remove** — Retirer un rang`].join('\n'), inline: true },
          { name: '⚙️ Réglages', value: [`**${p}volume** — De 1 à 200 %`, `**${p}loop** — off · piste · file`].join('\n'), inline: true },
        )
        .setFooter({ text: `${brandName(message.guild)} · /help pour le reste du bot` });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
];

// ─── Commandes slash ───────────────────────────────────────────────────────

function slash(name: string, description: string, run: (i: ChatInputCommandInteraction<'cached'>) => Promise<string | void>, build?: (b: SlashCommandBuilder) => SlashCommandBuilder): SlashCommand {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description);
  return {
    category: 'music',
    data: build ? build(builder) : builder,
    async execute(interaction) {
      const text = await run(interaction);
      if (text) await interaction.reply({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setDescription(text)] });
    },
  };
}

const commands: SlashCommand[] = [
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Jouer un titre ou un lien')
      .addStringOption((o) => o.setName('recherche').setDescription('Titre, lien YouTube, SoundCloud, Spotify ou Deezer').setRequired(true).setMaxLength(500)),
    cooldownSeconds: 2,
    async execute(interaction) {
      await interaction.deferReply();
      const embed = await doPlay(interaction.member, interaction.channelId, interaction.options.getString('recherche', true));
      await interaction.editReply({ embeds: [embed] });
    },
  },
  slash('pause', 'Mettre en pause', async (i) => doAction(i.member, 'pause', i.channelId)),
  slash('resume', 'Reprendre la lecture', async (i) => doAction(i.member, 'resume', i.channelId)),
  slash('skip', 'Passer au suivant', async (i) => doAction(i.member, 'skip', i.channelId)),
  slash('stop', 'Tout arrêter et quitter', async (i) => doAction(i.member, 'stop', i.channelId)),
  slash('join', 'Me faire venir en vocal', async (i) => doAction(i.member, 'join', i.channelId)),
  slash('leave', 'Me faire quitter le vocal', async (i) => doAction(i.member, 'leave', i.channelId)),
  slash('shuffle', 'Mélanger la file', async (i) => doAction(i.member, 'shuffle', i.channelId)),
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('La file d’attente')
      .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
    async execute(interaction) {
      const session = requireSession(interaction.guild);
      await interaction.reply({ embeds: [queueEmbed(interaction.guild, session, (interaction.options.getInteger('page') ?? 1) - 1)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Le morceau en cours'),
    async execute(interaction) {
      const session = getSession(interaction.guildId);
      await interaction.reply({ embeds: [nowPlayingEmbed(interaction.guild, session)], components: controls(session, interaction.guildId) });
    },
  },
  slash('volume', 'Régler le volume', async (i) => setVolume(i.member, String(i.options.getInteger('valeur', true))), (b) =>
    b.addIntegerOption((o) => o.setName('valeur').setDescription('De 1 à 200 %').setMinValue(1).setMaxValue(200).setRequired(true)) as SlashCommandBuilder,
  ),
  slash('loop', 'Boucle : off, morceau ou file', async (i) => setLoop(i.member, i.options.getString('mode')), (b) =>
    b.addStringOption((o) => o.setName('mode').setDescription('Le mode (alterne si vide)').addChoices({ name: 'Désactivée', value: 'off' }, { name: 'Le morceau', value: 'piste' }, { name: 'La file', value: 'file' })) as SlashCommandBuilder,
  ),
];

const setupPage: SetupPage = {
  id: 'music',
  section: 'music',
  title: 'Musique',
  emoji: '🎵',
  moduleId: 'music',
  description: 'Le lecteur : YouTube, SoundCloud, Spotify (si configuré) et Deezer.\n-# Les DJ (rôles ci-dessous, whitelist DJ ou staff) passent les morceaux sans vote et peuvent tout arrêter.',
  fields: [
    { kind: 'roles', key: 'dj', label: 'Rôles DJ', max: 10, get: (c) => c.music.djRoles, set: (c, v) => void (c.music.djRoles = v) },
    { kind: 'toggle', key: 'announce', label: 'Annoncer chaque morceau', get: (c) => c.music.announceNowPlaying, set: (c, v) => void (c.music.announceNowPlaying = v) },
    { kind: 'number', key: 'volume', label: 'Volume par défaut', min: 1, max: 200, unit: '%', get: (c) => c.music.defaultVolume, set: (c, v) => void (c.music.defaultVolume = v) },
    { kind: 'number', key: 'empty', label: 'Quitter si seul après', min: 0, max: 60, unit: 'min', get: (c) => c.music.leaveOnEmptyMinutes, set: (c, v) => void (c.music.leaveOnEmptyMinutes = v) },
    { kind: 'number', key: 'maxqueue', label: 'Taille de file (×25 en réserve)', min: 10, max: 1000, get: (c) => c.music.maxQueue, set: (c, v) => void (c.music.maxQueue = v) },
  ],
};

export const musicModule: BotModule = {
  id: 'music',
  name: 'Musique',
  emoji: '🎵',
  description: 'Lecteur YouTube / SoundCloud / Spotify / Deezer avec panneau',
  toggleable: true,
  defaultEnabled: true,
  commands,
  prefixCommands,
  setupPages: [setupPage],
  components: [
    {
      prefix: 'mu',
      async button(interaction: ButtonInteraction<'cached'>, [action]) {
        const member = interaction.member;
        if (action === 'queue') {
          const session = requireSession(interaction.guild);
          return interaction.reply({ embeds: [queueEmbed(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        let text: string;
        if (action === 'loop') text = setLoop(member, null);
        else text = doAction(member, action as Action, interaction.channelId);
        const session = getSession(interaction.guildId);
        await interaction.update({ embeds: [nowPlayingEmbed(interaction.guild, session)], components: session ? interaction.message.components.length > 2 ? panelPayload(interaction.guild).components : controls(session, interaction.guildId) : [] });
        if (text) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setDescription(text)], flags: MessageFlags.Ephemeral });
      },
      async select(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!interaction.isStringSelectMenu()) return;
        const member = interaction.member;
        const value = interaction.values[0] ?? '';
        let text = '';
        if (value === 'queue') {
          const session = requireSession(interaction.guild);
          return interaction.reply({ embeds: [queueEmbed(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        if (value.startsWith('vol-')) text = setVolume(member, value.slice(4));
        else if (value.startsWith('loop-')) text = setLoop(member, value.slice(5) === 'track' ? 'piste' : value.slice(5) === 'queue' ? 'file' : 'off');
        else text = doAction(member, value as Action, interaction.channelId);
        await interaction.update(panelPayload(interaction.guild));
        if (text) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setDescription(text)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [
    on('voiceStateUpdate', (before, after) => {
      const session = getSession(after.guild.id);
      if (!session) return;
      if (after.id === after.client.user.id && !after.channelId) {
        session.destroy();
        return;
      }
      if (before.channelId === session.channelId || after.channelId === session.channelId) session.checkEmpty();
    }),
  ],
  async onReady() {
    await initSources();
    log.info(`Musique prête — FFmpeg : ${FFMPEG ? 'oui' : 'NON'} · Spotify : ${spotifyEnabled() ? 'oui' : 'non'}`);
  },
  onShutdown() {
    destroyAll();
  },
  tests: [
    {
      id: 'status',
      label: 'État du lecteur',
      emoji: '🎵',
      description: 'FFmpeg, Spotify et sessions en cours',
      async run() {
        return [
          `${FFMPEG ? '✅' : '❌'} FFmpeg${FFMPEG ? ` (${FFMPEG.length > 40 ? '…' + FFMPEG.slice(-40) : FFMPEG})` : ' introuvable'}`,
          `${spotifyEnabled() ? '✅' : 'ℹ️'} Spotify${spotifyEnabled() ? '' : ' non configuré (liens Spotify refusés)'}`,
          `🎧 ${allSessions().length} session(s) en cours sur tous les serveurs`,
        ].join('\n');
      },
    },
  ],
};
