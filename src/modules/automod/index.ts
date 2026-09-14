import { ChannelType, type Message } from 'discord.js';
import { emojiFor } from '../../core/brand';
import { info, ok, refus } from '../../core/embeds';
import { getConfig, updateConfig } from '../../core/guildConfig';
import { journal, recordLog } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isBypassed } from '../../core/permissions';
import { Cooldowns, SlidingWindowLimiter } from '../../core/rateLimit';
import type { SetupPage } from '../../core/setup';
import { truncate } from '../../core/text';
import { on, PermLevel, type BotModule, type PrefixCommand } from '../../core/types';
import { applySanction } from '../../services/moderation';
import { baseForm, DEFAULT_WORDS } from '../../services/badwords';
import { checkContent, normalizeForDuplicate, RULE_LABELS, type AutoModRule } from '../../services/automodRules';

const log = createLogger('automod');

const spamLimiters = new Map<string, SlidingWindowLimiter>();
const recentContents = new Map<string, { text: string; at: number }[]>();
const actionCooldown = new Cooldowns();

function spamHit(guildId: string, userId: string, messages: number, seconds: number): boolean {
  const key = `${guildId}:${messages}:${seconds}`;
  let limiter = spamLimiters.get(key);
  if (!limiter) spamLimiters.set(key, (limiter = new SlidingWindowLimiter(messages, seconds * 1000)));
  return !limiter.hit(`${guildId}:${userId}`);
}

function duplicateHit(guildId: string, userId: string, content: string, count: number): boolean {
  const text = normalizeForDuplicate(content);
  if (text.length < 3) return false;
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const list = (recentContents.get(key) ?? []).filter((e) => now - e.at < 60_000);
  list.push({ text, at: now });
  recentContents.set(key, list.slice(-20));
  if (recentContents.size > 5000) recentContents.delete(recentContents.keys().next().value!);
  return list.filter((e) => e.text === text).length >= count;
}

async function punish(message: Message<true>, rule: AutoModRule, detail: string): Promise<void> {
  const guild = message.guild;
  const cfg = getConfig(guild.id).automod;
  await message.delete().catch(() => undefined);

  // Une seule réaction par personne toutes les 10 secondes : pas de cascade de sanctions sur un spam.
  if (actionCooldown.take(`${guild.id}:${message.author.id}`, 10_000) > 0) return;

  const label = RULE_LABELS[rule];
  const notice = await message.channel
    .send({ embeds: [refus(guild, `<@${message.author.id}>, ${label.notice}.`)], allowedMentions: { users: [message.author.id] } })
    .catch(() => null);
  if (notice) setTimeout(() => void notice.delete().catch(() => undefined), 6_000).unref();

  let sanction = 'message supprimé';
  const me = guild.members.me;
  if (me && cfg.action !== 'delete') {
    try {
      await applySanction({
        guild,
        actor: me,
        target: message.author,
        type: cfg.action === 'warn' ? 'warn' : 'timeout',
        reason: `AutoMod — ${label.label}`,
        durationMs: cfg.action === 'timeout' ? cfg.timeoutMinutes * 60_000 : undefined,
        auto: cfg.action === 'timeout',
      });
      sanction = cfg.action === 'warn' ? 'avertissement' : `timeout ${cfg.timeoutMinutes} min`;
    } catch (err) {
      log.warn(`Sanction AutoMod impossible : ${(err as Error).message}`);
    }
  }

  recordLog(guild.id, 'automod', rule, message.author.id, null, { detail, channelId: message.channelId });
  void journal(guild, 'automod', {
    title: `AutoMod — ${label.label}`,
    tone: 'alerte',
    lines: [
      `**Membre** : <@${message.author.id}> \`${message.author.tag}\``,
      `**Salon** : <#${message.channelId}>`,
      `**Détecté** : \`${truncate(detail, 100)}\``,
      `**Action** : ${sanction}`,
      '',
      truncate(message.content, 1500),
    ],
  });
}

async function onMessage(message: Message): Promise<'stop' | void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const cfg = getConfig(message.guildId).automod;
  if (cfg.whitelistChannels.includes(message.channelId) || cfg.whitelistUsers.includes(message.author.id)) return;
  if (message.member.roles.cache.some((r) => cfg.whitelistRoles.includes(r.id))) return;
  if (cfg.ignoreStaff && isBypassed(message.member)) return;

  const content = message.content ?? '';
  const mentions = new Set([...message.mentions.users.keys(), ...message.mentions.roles.keys()]).size;
  const verdict = checkContent(cfg, content, mentions, message.mentions.everyone && !message.member.permissions.has('MentionEveryone'));
  if (verdict) {
    await punish(message, verdict.rule, verdict.detail);
    return 'stop';
  }
  if (cfg.spam.enabled && spamHit(message.guildId, message.author.id, cfg.spam.messages, cfg.spam.seconds)) {
    await punish(message, 'spam', `${cfg.spam.messages} messages / ${cfg.spam.seconds} s`);
    return 'stop';
  }
  if (cfg.duplicates.enabled && content && duplicateHit(message.guildId, message.author.id, content, cfg.duplicates.count)) {
    await punish(message, 'duplicates', truncate(content, 80));
    return 'stop';
  }
}

const listField = (key: 'links' | 'badWords', label: string) => ({
  kind: 'text' as const,
  key,
  label,
  long: true,
  maxLength: 2000,
  get: (c: import('../../core/guildConfig').GuildConfig) => (key === 'links' ? c.automod.links.whitelist : c.automod.badWords.words).join(', '),
  set: (c: import('../../core/guildConfig').GuildConfig, v: string) => {
    const items = [...new Set(v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 300);
    if (key === 'links') c.automod.links.whitelist = items.map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    else c.automod.badWords.words = [...new Set(items.map(baseForm).filter(Boolean))];
  },
});

const pages: SetupPage[] = [
  {
    id: 'automod',
    section: 'moderation',
    title: 'AutoMod',
    emoji: '🤖',
    moduleId: 'automod',
    order: 2,
    description: 'Les filtres automatiques. Le staff, le bypass et les salons/rôles autorisés sont ignorés.\n-# Liste des domaines et mots : séparés par des virgules.',
    fields: [
      { kind: 'toggle', key: 'spam', label: 'Spam', get: (c) => c.automod.spam.enabled, set: (c, v) => void (c.automod.spam.enabled = v) },
      { kind: 'toggle', key: 'dup', label: 'Répétition', get: (c) => c.automod.duplicates.enabled, set: (c, v) => void (c.automod.duplicates.enabled = v) },
      { kind: 'toggle', key: 'links', label: 'Liens', get: (c) => c.automod.links.enabled, set: (c, v) => void (c.automod.links.enabled = v) },
      { kind: 'toggle', key: 'invites', label: 'Invitations', get: (c) => c.automod.invites.enabled, set: (c, v) => void (c.automod.invites.enabled = v) },
      { kind: 'toggle', key: 'words', label: 'Mots interdits', get: (c) => c.automod.badWords.enabled, set: (c, v) => void (c.automod.badWords.enabled = v) },
      { kind: 'toggle', key: 'mentions', label: 'Mentions', get: (c) => c.automod.mentions.enabled, set: (c, v) => void (c.automod.mentions.enabled = v) },
      { kind: 'toggle', key: 'caps', label: 'Majuscules', get: (c) => c.automod.caps.enabled, set: (c, v) => void (c.automod.caps.enabled = v) },
      {
        kind: 'choice',
        key: 'action',
        label: 'Action',
        options: [
          { value: 'delete', label: 'Supprimer le message', emoji: '🗑️' },
          { value: 'warn', label: 'Supprimer + avertir', emoji: '⚠️' },
          { value: 'timeout', label: 'Supprimer + timeout', emoji: '⏳' },
        ],
        get: (c) => c.automod.action,
        set: (c, v) => void (c.automod.action = v as 'delete' | 'warn' | 'timeout'),
      },
      { ...listField('links', 'Domaines autorisés') },
      { ...listField('badWords', 'Mots interdits') },
      { kind: 'number', key: 'mentionsmax', label: 'Mentions max', min: 1, max: 50, get: (c) => c.automod.mentions.max, set: (c, v) => void (c.automod.mentions.max = v) },
      { kind: 'number', key: 'timeout', label: 'Durée du timeout', min: 1, max: 1440, unit: 'min', get: (c) => c.automod.timeoutMinutes, set: (c, v) => void (c.automod.timeoutMinutes = v) },
    ],
  },
  {
    id: 'automod-advanced',
    section: 'moderation',
    title: 'AutoMod — réglages fins',
    emoji: '🎚️',
    order: 3,
    description: 'Seuils des filtres et exceptions.',
    fields: [
      {
        kind: 'channels',
        key: 'channels',
        label: 'Salons ignorés',
        channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement],
        get: (c) => c.automod.whitelistChannels,
        set: (c, v) => void (c.automod.whitelistChannels = v),
      },
      { kind: 'roles', key: 'roles', label: 'Rôles ignorés', get: (c) => c.automod.whitelistRoles, set: (c, v) => void (c.automod.whitelistRoles = v) },
      { kind: 'toggle', key: 'staff', label: 'Ignorer le staff', get: (c) => c.automod.ignoreStaff, set: (c, v) => void (c.automod.ignoreStaff = v) },
      { kind: 'number', key: 'spammsg', label: 'Spam : messages', min: 2, max: 30, get: (c) => c.automod.spam.messages, set: (c, v) => void (c.automod.spam.messages = v) },
      { kind: 'number', key: 'spamsec', label: 'Spam : secondes', min: 1, max: 60, unit: 's', get: (c) => c.automod.spam.seconds, set: (c, v) => void (c.automod.spam.seconds = v) },
      { kind: 'number', key: 'dup', label: 'Répétitions tolérées', min: 2, max: 20, get: (c) => c.automod.duplicates.count, set: (c, v) => void (c.automod.duplicates.count = v) },
      { kind: 'number', key: 'capspct', label: 'Majuscules : %', min: 50, max: 100, unit: '%', get: (c) => c.automod.caps.percent, set: (c, v) => void (c.automod.caps.percent = v) },
      { kind: 'number', key: 'capsmin', label: 'Majuscules : longueur min', min: 5, max: 200, get: (c) => c.automod.caps.minLength, set: (c, v) => void (c.automod.caps.minLength = v) },
    ],
  },
];

const prefixCommands: PrefixCommand[] = [
  {
    name: 'badword',
    domain: 'sanction',
    category: 'salons',
    description: 'Mots interdits (seul : liste)',
    usage: '[mot|on|off]',
    level: PermLevel.MODERATOR,
    async execute(message, args) {
      const guildId = message.guildId;
      const arg = args.join(' ').trim();
      const cfg = getConfig(guildId).automod.badWords;
      const subject = { titre: 'Mots interdits', sujet: emojiFor(guildId, 'sanction') };
      if (!arg) {
        const text = cfg.words.length ? cfg.words.map((w) => `\`${w}\``).join(' · ') : '*Aucun mot.*';
        await message.reply({ embeds: [info(message.guild, `Filtre : **${cfg.enabled ? 'actif' : 'coupé'}**\n\n${truncate(text, 3800)}`, subject)], allowedMentions: { repliedUser: false } });
        return;
      }
      if (arg === 'on' || arg === 'off') {
        const seeded = arg === 'on' && cfg.words.length === 0;
        updateConfig(guildId, (c) => {
          c.automod.badWords.enabled = arg === 'on';
          if (seeded) c.automod.badWords.words = [...DEFAULT_WORDS];
        });
        await message.reply({ embeds: [ok(message.guild, `Filtre ${arg === 'on' ? 'activé' : 'coupé'}.${seeded ? `\n-# Liste de départ : ${DEFAULT_WORDS.length} mots.` : ''}`, subject)], allowedMentions: { repliedUser: false } });
        return;
      }
      const word = baseForm(arg);
      if (!word) throw new Error('mot invalide');
      let added = false;
      updateConfig(guildId, (c) => {
        const list = c.automod.badWords.words;
        const idx = list.indexOf(word);
        if (idx === -1) {
          list.push(word);
          added = true;
        } else list.splice(idx, 1);
      });
      await message.delete().catch(() => undefined);
      await message.channel.send({ embeds: [ok(message.guild, `\`${word}\` ${added ? 'ajouté au' : 'retiré du'} filtre.`, subject)] });
    },
  },
];

export const automodModule: BotModule = {
  id: 'automod',
  name: 'AutoMod',
  emoji: '🤖',
  description: 'Spam, flood, liens, invitations, mots interdits, mentions, majuscules',
  toggleable: true,
  defaultEnabled: true,
  setupPages: pages,
  prefixCommands,
  events: [on('messageCreate', (m) => onMessage(m), 10), on('messageUpdate', (_old, m) => (m.partial ? undefined : onMessage(m as Message)), 10)],
  tests: [
    {
      id: 'rules',
      label: 'État des filtres',
      emoji: '🤖',
      description: 'Les filtres actifs et l’action choisie',
      async run(interaction) {
        const a = getConfig(interaction.guildId).automod;
        const rows: [string, boolean][] = [
          ['Spam', a.spam.enabled],
          ['Répétition', a.duplicates.enabled],
          ['Liens', a.links.enabled],
          ['Invitations', a.invites.enabled],
          ['Mots interdits', a.badWords.enabled],
          ['Mentions', a.mentions.enabled],
          ['Majuscules', a.caps.enabled],
        ];
        return `${rows.map(([l, e]) => `${e ? '🟢' : '🔴'} ${l}`).join('\n')}\n\nAction : **${a.action}**`;
      },
    },
  ],
};
