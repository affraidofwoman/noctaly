import { AttachmentBuilder, ChannelType, EmbedBuilder, type Guild, type GuildMember } from 'discord.js';
import { emojiFor } from '../../core/brand';
import { brandEmbed, colorFor } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { resolveTextChannel } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { isHttpUrl } from '../../core/ui';
import { renderTemplate, variablesHelp } from '../../core/variables';
import { on, type BotModule } from '../../core/types';
import { buildWelcomeCard } from '../../services/welcomeCard';

const log = createLogger('bienvenue');

/** Envoie l'accueil d'un membre. Retourne le salon utilisé, ou null si rien n'a été envoyé. */
export async function sendWelcome(member: GuildMember): Promise<string | null> {
  const guild = member.guild;
  const cfg = getConfig(guild.id).welcome;
  const channel = resolveTextChannel(guild, cfg.channelId);
  if (!channel) return null;

  const text = renderTemplate(cfg.message, { member, guild });
  const allowedMentions = { users: [member.id], roles: [] as string[] };
  let card: Buffer | null = null;
  if (cfg.imageMode === 'card') card = await buildWelcomeCard(member);
  const files = card ? [new AttachmentBuilder(card, { name: 'bienvenue.png' })] : [];

  if (!cfg.useEmbed) {
    await channel.send({ content: truncate(text, 2000), files, allowedMentions });
    return channel.id;
  }

  const embed = new EmbedBuilder()
    .setColor(colorFor(guild))
    .setTitle(renderTemplate(cfg.title || `${emojiFor(guild.id, 'bienvenue')} Nouveau membre`, { member, guild }).slice(0, 256))
    .setDescription(truncate(text, 4096))
    .setFooter({ text: `${member.user.tag} · ${guild.memberCount}ᵉ membre`, iconURL: member.user.displayAvatarURL({ size: 64 }) })
    .setTimestamp();
  if (card) embed.setImage('attachment://bienvenue.png');
  else if (cfg.imageMode === 'url' && isHttpUrl(cfg.imageUrl)) embed.setImage(cfg.imageUrl);
  else embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));

  try {
    await channel.send({ embeds: [embed], files, allowedMentions });
  } catch (err) {
    if (!files.length) throw err;
    // La carte a été refusée : l'accueil part sans elle.
    embed.setImage(null).setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    await channel.send({ embeds: [embed], allowedMentions });
  }
  return channel.id;
}

async function sendWelcomeDm(member: GuildMember): Promise<void> {
  const cfg = getConfig(member.guild.id).welcome;
  if (!cfg.dmEnabled || !cfg.dmMessage) return;
  const embed = brandEmbed(member.guild)
    .setTitle(`${emojiFor(member.guild.id, 'bienvenue')} ${member.guild.name}`)
    .setDescription(truncate(renderTemplate(cfg.dmMessage, { member, guild: member.guild }), 4096))
    .setThumbnail(member.guild.iconURL({ size: 128 }));
  await member.send({ embeds: [embed] }).catch(() => undefined);
}

// ─── Compteur de membres (renommage limité par Discord : 2 fois / 10 min) ──

const pendingCounters = new Set<string>();
const lastRename = new Map<string, number>();
const RENAME_INTERVAL = 5 * 60_000 + 10_000;

async function updateCounter(guild: Guild): Promise<void> {
  const cfg = getConfig(guild.id).welcome;
  if (!cfg.counterChannelId) return;
  const channel = guild.channels.cache.get(cfg.counterChannelId);
  if (!channel || channel.type === ChannelType.GuildCategory || !('setName' in channel)) return;
  const name = renderTemplate(cfg.counterFormat, { guild }).slice(0, 100);
  if (channel.name === name) return;
  if (Date.now() - (lastRename.get(guild.id) ?? 0) < RENAME_INTERVAL) {
    pendingCounters.add(guild.id);
    return;
  }
  lastRename.set(guild.id, Date.now());
  pendingCounters.delete(guild.id);
  await channel.setName(name, 'Compteur de membres').catch((err: Error) => log.warn(`Compteur non renommé : ${err.message}`));
}

export function scheduleCounter(guild: Guild): void {
  void updateCounter(guild);
}

const setupPage: SetupPage = {
  id: 'welcome',
  section: 'welcome',
  title: 'Bienvenue',
  emoji: '👋',
  moduleId: 'welcome',
  order: 1,
  description: `Le message posté à chaque arrivée, avec la carte aux couleurs de l’enseigne.\n-# Variables : ${['mention', 'user', 'username', 'server', 'membercount', 'createdat'].map((v) => `\`{${v}}\``).join(' ')}`,
  fields: [
    { kind: 'channel', key: 'channel', label: 'Salon de bienvenue', get: (c) => c.welcome.channelId, set: (c, v) => void (c.welcome.channelId = v) },
    {
      kind: 'channel',
      key: 'counter',
      label: 'Salon compteur de membres',
      channelTypes: [ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildStageVoice],
      get: (c) => c.welcome.counterChannelId,
      set: (c, v) => void (c.welcome.counterChannelId = v),
    },
    {
      kind: 'choice',
      key: 'image',
      label: 'Image',
      options: [
        { value: 'card', label: 'Carte de bienvenue générée', emoji: '🖼️' },
        { value: 'url', label: 'Image fixe (lien)', emoji: '🔗' },
        { value: 'none', label: 'Juste l’avatar', emoji: '👤' },
      ],
      get: (c) => c.welcome.imageMode,
      set: (c, v) => void (c.welcome.imageMode = v as 'card' | 'url' | 'none'),
    },
    { kind: 'toggle', key: 'embed', label: 'Embed', get: (c) => c.welcome.useEmbed, set: (c, v) => void (c.welcome.useEmbed = v) },
    { kind: 'toggle', key: 'dm', label: 'Message privé', get: (c) => c.welcome.dmEnabled, set: (c, v) => void (c.welcome.dmEnabled = v) },
    { kind: 'text', key: 'title', label: 'Titre', maxLength: 200, get: (c) => c.welcome.title, set: (c, v) => void (c.welcome.title = v) },
    { kind: 'text', key: 'message', label: 'Message', long: true, maxLength: 2000, required: true, get: (c) => c.welcome.message, set: (c, v) => void (c.welcome.message = v) },
    { kind: 'text', key: 'dmmessage', label: 'Message privé', long: true, maxLength: 2000, get: (c) => c.welcome.dmMessage, set: (c, v) => void (c.welcome.dmMessage = v) },
    {
      kind: 'text',
      key: 'imageurl',
      label: 'Lien de l’image fixe',
      maxLength: 500,
      get: (c) => c.welcome.imageUrl,
      set: (c, v) => void (c.welcome.imageUrl = v),
      validate: (v) => (!v || isHttpUrl(v) ? null : 'Lien http(s) attendu.'),
    },
    { kind: 'text', key: 'counterformat', label: 'Nom du compteur', maxLength: 90, get: (c) => c.welcome.counterFormat, set: (c, v) => void (c.welcome.counterFormat = v) },
  ],
};

export const welcomeModule: BotModule = {
  id: 'welcome',
  name: 'Bienvenue',
  emoji: '👋',
  description: 'Message, carte, message privé et compteur de membres',
  toggleable: true,
  defaultEnabled: true,
  setupPages: [setupPage],
  events: [
    on('guildMemberAdd', async (member) => {
      if (member.user.bot) {
        scheduleCounter(member.guild);
        return;
      }
      // En premier : rien de ce qui suit ne doit pouvoir empêcher un accueil.
      await sendWelcome(member).catch((err: Error) => log.warn(`${member.id} non accueilli : ${err.message}`));
      await sendWelcomeDm(member);
      scheduleCounter(member.guild);
    }, 40),
    on('guildMemberRemove', (member) => {
      scheduleCounter(member.guild);
    }),
  ],
  tasks: [
    {
      name: 'welcome-counter',
      intervalMs: 60_000,
      async run(client) {
        for (const guildId of [...pendingCounters]) {
          const guild = client.guilds.cache.get(guildId);
          if (!guild || !isModuleEnabled(guildId, 'welcome')) {
            pendingCounters.delete(guildId);
            continue;
          }
          await updateCounter(guild);
        }
      },
    },
  ],
  tests: [
    {
      id: 'message',
      label: 'Message de bienvenue',
      emoji: '👋',
      description: 'Poster ton propre accueil dans le salon réglé',
      async run(interaction) {
        const channelId = await sendWelcome(interaction.member);
        return channelId ? `✅ Accueil posté dans <#${channelId}>.` : '⚠️ Aucun salon de bienvenue utilisable (réglage ou permissions).';
      },
    },
    {
      id: 'variables',
      label: 'Variables disponibles',
      emoji: '🧩',
      description: 'La liste des variables des messages',
      async run() {
        return variablesHelp(['user', 'mention', 'username', 'userid', 'server', 'membercount', 'createdat', 'date', 'time', 'brand']);
      },
    },
  ],
};
