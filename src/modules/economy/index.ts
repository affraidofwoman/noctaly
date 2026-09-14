import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type User,
} from 'discord.js';
import { brandEmbed, info, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { linesToPages, paginate } from '../../core/pagination';
import { canBotManageRole } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { formatNumber, medal, truncate } from '../../core/text';
import { dayKey, previousDayKey, ts } from '../../core/time';
import { button, row } from '../../core/ui';
import { on, PermLevel, type BotModule, type PrefixCommand, type SlashCommand } from '../../core/types';
import { emitActivity } from '../../services/activity';
import { getBadge, grantBadge } from '../../services/badges';
import { addCoins, buy, inventory, richest, setDaily, shopItem, shopItems, transfer, wallet, type ShopItem } from '../../services/economy';
import { run } from '../../database/db';

const messageCooldowns = new Map<string, number>();

function coins(guildId: string, amount: number): string {
  const eco = getConfig(guildId).economy;
  return `**${formatNumber(amount)}** ${eco.currencyEmoji} ${eco.currencyName}`;
}

function balanceEmbed(guild: Guild, user: User) {
  const w = wallet(guild.id, user.id);
  const eco = getConfig(guild.id).economy;
  return brandEmbed(guild)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${eco.currencyEmoji} Porte-monnaie`)
    .setDescription(
      [
        `• Solde — ${coins(guild.id, w.balance)}`,
        `• Gagné au total — **${formatNumber(w.total_earned)}**`,
        `• Série de /daily — **${w.daily_streak}** jour${w.daily_streak > 1 ? 's' : ''}`,
        '',
        '-# Monnaie purement virtuelle, sans aucune valeur réelle.',
      ].join('\n'),
    );
}

function claimDaily(member: GuildMember): string {
  const guild = member.guild;
  const eco = getConfig(guild.id).economy;
  const tz = getConfig(guild.id).general.timezone;
  const w = wallet(guild.id, member.id);
  const today = dayKey(Date.now(), tz);
  const last = w.last_daily ? dayKey(w.last_daily, tz) : null;
  if (last === today) throw new UserError('Tu as déjà récupéré ta récompense aujourd’hui. Reviens demain !');
  const streak = last === previousDayKey(today) ? w.daily_streak + 1 : 1;
  const amount = eco.dailyAmount + Math.min(streak - 1, 30) * eco.streakBonus;
  const balance = addCoins(guild.id, member.id, amount, 'daily');
  setDaily(guild.id, member.id, Date.now(), streak);
  emitActivity({ guildId: guild.id, userId: member.id, type: 'daily', amount: 1 });
  return `🎁 Tu reçois ${coins(guild.id, amount)} !\n🔥 Série : **${streak}** jour${streak > 1 ? 's' : ''}${streak > 1 ? ` (+${Math.min(streak - 1, 30) * eco.streakBonus} de bonus)` : ''}\n-# Nouveau solde : ${formatNumber(balance)}`;
}

function richPages(guild: Guild) {
  const lines = richest(guild.id, 200).map((r, i) => `${medal(i + 1)} <@${r.user_id}> — ${coins(guild.id, r.balance)}`);
  if (!lines.length) lines.push('*Personne n’a encore de pièces.*');
  return linesToPages(lines, 10, (content, page, total) => brandEmbed(guild).setTitle('🏆 Les plus riches').setDescription(content).setFooter({ text: `Page ${page}/${total}` }));
}

// ─── Boutique ──────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<ShopItem['type'], string> = { role: 'Rôle', badge: 'Badge', item: 'Article' };

function shopPayload(guild: Guild, userId: string, note?: string) {
  const items = shopItems(guild.id);
  const embed = brandEmbed(guild)
    .setTitle('🛒 Boutique communautaire')
    .setDescription(
      [
        note,
        `Ton solde : ${coins(guild.id, wallet(guild.id, userId).balance)}`,
        '',
        items.length
          ? items.map((i) => `${i.emoji} **${i.name}** — ${coins(guild.id, i.price)}${i.stock !== null ? ` · stock ${i.stock}` : ''}\n-# ${TYPE_LABEL[i.type]}${i.description ? ` · ${truncate(i.description, 80)}` : ''}`).join('\n')
          : '*La boutique est vide pour le moment.*',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const components = items.length
    ? [
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`shop:pick:${userId}`)
            .setPlaceholder('Acheter un article')
            .addOptions(items.slice(0, 25).map((i) => ({ label: truncate(i.name, 100), value: String(i.id), emoji: i.emoji, description: truncate(`${i.price} · ${TYPE_LABEL[i.type]}`, 100) }))),
        ),
      ]
    : [];
  return { embeds: [embed], components };
}

async function deliver(member: GuildMember, item: ShopItem): Promise<string> {
  const guild = member.guild;
  if (item.type === 'role' && item.value) {
    const role = guild.roles.cache.get(item.value);
    if (!role || !canBotManageRole(guild, role)) throw new UserError('Ce rôle ne peut plus être donné. Préviens le staff.');
    if (member.roles.cache.has(role.id)) throw new UserError('Tu as déjà ce rôle.');
    await member.roles.add(role, `Achat boutique : ${item.name}`);
    return `Le rôle <@&${role.id}> t’a été donné.`;
  }
  if (item.type === 'badge' && item.value) {
    if (!grantBadge(guild.id, member.id, item.value)) throw new UserError('Tu as déjà ce badge.');
    return `Le badge ${getBadge(guild.id, item.value)?.emoji ?? ''} **${getBadge(guild.id, item.value)?.name ?? item.value}** est sur ton profil.`;
  }
  const staff = resolveTextChannel(guild, getConfig(guild.id).general.staffChannelId);
  await staff?.send({ embeds: [info(guild, `🛒 <@${member.id}> a acheté **${item.name}** (${item.price}). À livrer !`)], allowedMentions: { parse: [] } }).catch(() => undefined);
  return staff ? 'Le staff a été prévenu pour te le remettre.' : 'Ouvre un ticket pour le récupérer.';
}

// ─── Commandes ─────────────────────────────────────────────────────────────

const balance: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Ton porte-monnaie')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addBooleanOption((o) => o.setName('classement').setDescription('Voir le classement des plus riches')),
  async execute(interaction) {
    if (interaction.options.getBoolean('classement')) return paginate(interaction, richPages(interaction.guild));
    return reply(interaction, { embeds: [balanceEmbed(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const daily: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder().setName('daily').setDescription('Ta récompense quotidienne'),
  async execute(interaction) {
    await reply(interaction, { embeds: [ok(interaction.guild, claimDaily(interaction.member), { titre: 'Récompense du jour' })] });
  },
};

const give: SlashCommand = {
  category: 'economy',
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Donner des pièces')
    .addUserOption((o) => o.setName('membre').setDescription('À qui').setRequired(true))
    .addIntegerOption((o) => o.setName('montant').setDescription('Combien').setRequired(true).setMinValue(1).setMaxValue(1_000_000)),
  async execute(interaction) {
    const target = interaction.options.getUser('membre', true);
    const amount = interaction.options.getInteger('montant', true);
    if (target.bot || target.id === interaction.user.id) throw new UserError('Choisis un autre membre (pas toi, pas un bot).');
    try {
      transfer(interaction.guildId, interaction.user.id, target.id, amount);
    } catch {
      throw new UserError('Solde insuffisant.');
    }
    await reply(interaction, { embeds: [ok(interaction.guild, `<@${interaction.user.id}> donne ${coins(interaction.guildId, amount)} à <@${target.id}>.`)], allowedMentions: { users: [target.id] } });
  },
};

const shop: SlashCommand = {
  category: 'economy',
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('La boutique')
    .addSubcommand((s) => s.setName('voir').setDescription('Ouvrir la boutique'))
    .addSubcommand((s) => s.setName('inventaire').setDescription('Tes achats'))
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un article')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Rôle spécial').setRequired(true).setMaxLength(60))
        .addIntegerOption((o) => o.setName('prix').setDescription('Prix').setRequired(true).setMinValue(1).setMaxValue(10_000_000))
        .addStringOption((o) => o.setName('type').setDescription('Ce que ça donne').setRequired(true).addChoices({ name: 'Un rôle', value: 'role' }, { name: 'Un badge', value: 'badge' }, { name: 'Un article à livrer par le staff', value: 'item' }))
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle (type rôle)'))
        .addStringOption((o) => o.setName('badge').setDescription('Identifiant du badge (type badge, voir /badge liste)').setMaxLength(32))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji').setMaxLength(64))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(150))
        .addIntegerOption((o) => o.setName('stock').setDescription('Stock (vide = illimité)').setMinValue(1).setMaxValue(100000)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un article')
        .addIntegerOption((o) => o.setName('article').setDescription('L’article').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('crediter')
        .setDescription('Donner ou retirer des pièces (admin)')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('montant').setDescription('Négatif pour retirer').setRequired(true).setMinValue(-10_000_000).setMaxValue(10_000_000)),
    ),
  subLevels: { ajouter: PermLevel.ADMIN, retirer: PermLevel.ADMIN, crediter: PermLevel.ADMIN },
  async autocomplete(interaction) {
    await interaction.respond(shopItems(interaction.guildId).slice(0, 25).map((i) => ({ name: truncate(`${i.name} — ${i.price}`, 100), value: i.id })));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'voir') return reply(interaction, { ...shopPayload(guild, interaction.user.id), ephemeral: true });
    if (sub === 'inventaire') {
      const items = inventory(guild.id, interaction.user.id);
      return reply(interaction, { embeds: [info(guild, items.map((i) => `• **${i.item_name}** — ${i.price} · ${ts(i.bought_at, 'd')}`).join('\n') || 'Aucun achat.', { titre: 'Ton inventaire', sujet: '🎒' })], ephemeral: true });
    }
    if (sub === 'retirer') {
      run('DELETE FROM shop_items WHERE guild_id = ? AND id = ?', guild.id, interaction.options.getInteger('article', true));
      return reply(interaction, { embeds: [ok(guild, 'Article retiré de la boutique.')], ephemeral: true });
    }
    if (sub === 'crediter') {
      const user = interaction.options.getUser('membre', true);
      const amount = interaction.options.getInteger('montant', true);
      let balanceAfter: number;
      try {
        balanceAfter = addCoins(guild.id, user.id, amount, 'admin');
      } catch {
        throw new UserError('Le solde ne peut pas devenir négatif.');
      }
      void journal(guild, 'community', { title: 'Pièces modifiées', tone: 'info', lines: [`**Membre** : <@${user.id}>`, `**Montant** : ${amount}`, `**Nouveau solde** : ${balanceAfter}`], by: interaction.user });
      return reply(interaction, { embeds: [ok(guild, `<@${user.id}> : ${amount >= 0 ? '+' : ''}${formatNumber(amount)} → ${coins(guild.id, balanceAfter)}.`)], ephemeral: true });
    }
    const type = interaction.options.getString('type', true) as ShopItem['type'];
    let value: string | null = null;
    if (type === 'role') {
      const role = interaction.options.getRole('role');
      if (!role) throw new UserError('Choisis le rôle à vendre (option `role`).');
      if (!canBotManageRole(guild, guild.roles.cache.get(role.id)!)) throw new UserError('Je ne peux pas donner ce rôle : place mon rôle au-dessus.');
      value = role.id;
    } else if (type === 'badge') {
      value = interaction.options.getString('badge');
      if (!value || !getBadge(guild.id, value)) throw new UserError('Badge introuvable (voir `/badge liste`).');
    }
    if (shopItems(guild.id).length >= 25) throw new UserError('25 articles maximum.');
    run(
      'INSERT INTO shop_items (guild_id, name, description, emoji, price, type, value, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      guild.id,
      interaction.options.getString('nom', true),
      interaction.options.getString('description') ?? '',
      interaction.options.getString('emoji') ?? (type === 'role' ? '🎨' : type === 'badge' ? '💎' : '🎟️'),
      interaction.options.getInteger('prix', true),
      type,
      value,
      interaction.options.getInteger('stock'),
      Date.now(),
    );
    return reply(interaction, { embeds: [ok(guild, 'Article ajouté à la boutique.')], ephemeral: true });
  },
};

const prefixCommands: PrefixCommand[] = [
  {
    name: 'bal',
    aliases: ['balance', 'coins'],
    domain: 'general',
    category: 'economy',
    description: 'Ton porte-monnaie',
    usage: '[membre]',
    async execute(message, args) {
      const id = args[0]?.replace(/\D/g, '');
      const user = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [balanceEmbed(message.guild, user)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'daily',
    domain: 'general',
    category: 'economy',
    description: 'Ta récompense quotidienne',
    async execute(message) {
      if (!message.member) return;
      await message.reply({ embeds: [ok(message.guild, claimDaily(message.member), { titre: 'Récompense du jour' })], allowedMentions: { repliedUser: false } });
    },
  },
];

const setupPage: SetupPage = {
  id: 'economy',
  section: 'community',
  title: 'Économie',
  emoji: '💰',
  moduleId: 'economy',
  order: 9,
  description: 'Une monnaie **purement virtuelle** gagnée en participant (messages, /daily, quêtes), à dépenser dans la boutique (`/shop ajouter`).',
  fields: [
    { kind: 'text', key: 'name', label: 'Nom de la monnaie', maxLength: 30, required: true, get: (c) => c.economy.currencyName, set: (c, v) => void (c.economy.currencyName = v) },
    { kind: 'text', key: 'emoji', label: 'Émoji de la monnaie', maxLength: 64, required: true, get: (c) => c.economy.currencyEmoji, set: (c, v) => void (c.economy.currencyEmoji = v) },
    { kind: 'number', key: 'daily', label: 'Récompense /daily', min: 0, max: 1_000_000, get: (c) => c.economy.dailyAmount, set: (c, v) => void (c.economy.dailyAmount = v) },
    { kind: 'number', key: 'bonus', label: 'Bonus par jour de série', min: 0, max: 100_000, get: (c) => c.economy.streakBonus, set: (c, v) => void (c.economy.streakBonus = v) },
    { kind: 'number', key: 'message', label: 'Pièces par message (cooldown 60 s)', min: 0, max: 1000, get: (c) => c.economy.perMessage, set: (c, v) => void (c.economy.perMessage = v) },
  ],
};

export const economyModule: BotModule = {
  id: 'economy',
  name: 'Économie',
  emoji: '💰',
  description: 'Monnaie virtuelle, /daily, dons et boutique',
  toggleable: true,
  defaultEnabled: false,
  commands: [balance, daily, give, shop],
  prefixCommands,
  setupPages: [setupPage],
  components: [
    {
      prefix: 'shop',
      async select(interaction: AnySelectMenuInteraction<'cached'>, [, ownerId]) {
        if (!interaction.isStringSelectMenu()) return;
        if (ownerId !== interaction.user.id) return interaction.reply({ ...shopPayload(interaction.guild, interaction.user.id), flags: MessageFlags.Ephemeral });
        const item = shopItem(interaction.guildId, Number(interaction.values[0]));
        if (!item) throw new UserError('Cet article n’existe plus.');
        await interaction.update({
          ...shopPayload(interaction.guild, interaction.user.id, `Acheter ${item.emoji} **${item.name}** pour ${coins(interaction.guildId, item.price)} ?`),
          components: [row(button(`shop:buy:${interaction.user.id}:${item.id}`, 'Acheter', ButtonStyle.Success, '🛒'), button(`shop:back:${interaction.user.id}`, 'Retour', ButtonStyle.Secondary, '⬅️'))],
        });
      },
      async button(interaction: ButtonInteraction<'cached'>, [action, ownerId, itemId]) {
        if (ownerId !== interaction.user.id) throw new UserError('Cette boutique appartient à quelqu’un d’autre : lance `/shop voir`.');
        if (action === 'back') return interaction.update(shopPayload(interaction.guild, interaction.user.id));
        const item = shopItem(interaction.guildId, Number(itemId));
        if (!item) throw new UserError('Cet article n’existe plus.');
        let balanceAfter: number;
        try {
          balanceAfter = buy(interaction.guildId, interaction.user.id, item);
        } catch (err) {
          throw new UserError((err as Error).message === 'rupture de stock' ? 'Rupture de stock.' : 'Solde insuffisant.');
        }
        try {
          const text = await deliver(interaction.member, item);
          await interaction.update(shopPayload(interaction.guild, interaction.user.id, `✅ Acheté : ${item.emoji} **${item.name}**. ${text}\n-# Nouveau solde : ${formatNumber(balanceAfter)}`));
        } catch (err) {
          // Livraison impossible : remboursement.
          addCoins(interaction.guildId, interaction.user.id, item.price, 'refund');
          run('DELETE FROM inventory WHERE id = (SELECT MAX(id) FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?)', interaction.guildId, interaction.user.id, item.id);
          if (item.stock !== null) run('UPDATE shop_items SET stock = stock + 1 WHERE id = ?', item.id);
          await interaction.update(shopPayload(interaction.guild, interaction.user.id, `⚠️ ${(err as Error).message} Tu as été remboursé.`));
        }
      },
    },
  ],
  events: [
    on('messageCreate', (message: Message) => {
      if (!message.inGuild() || message.author.bot) return;
      const eco = getConfig(message.guildId).economy;
      if (eco.perMessage <= 0) return;
      const key = `${message.guildId}:${message.author.id}`;
      const now = Date.now();
      if ((messageCooldowns.get(key) ?? 0) > now) return;
      messageCooldowns.set(key, now + eco.messageCooldownSeconds * 1000);
      if (messageCooldowns.size > 20_000) for (const [k, v] of messageCooldowns) if (v < now) messageCooldowns.delete(k);
      addCoins(message.guildId, message.author.id, eco.perMessage, 'message');
    }, 180),
  ],
};
