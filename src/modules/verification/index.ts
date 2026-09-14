import { randomInt } from 'node:crypto';
import { ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, SlashCommandBuilder, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { colorFor, erreur, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, resolveTextChannel } from '../../core/logService';
import { canBotManageRole } from '../../core/permissions';
import { TtlMap } from '../../core/sessions';
import type { SetupPage } from '../../core/setup';
import { daysSince } from '../../core/time';
import { button, buildModal, row } from '../../core/ui';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { grantAutoroles } from '../../services/autorole';

const codes = new TtlMap<string, { code: string; tries: number }>(5 * 60_000);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Code affiché avec des espaces fines et des caractères invisibles pour gêner la lecture automatique. */
function displayCode(code: string): string {
  return code.split('').join('​ ');
}

async function verify(member: GuildMember): Promise<string> {
  const guild = member.guild;
  const cfg = getConfig(guild.id).verification;
  if (cfg.minAccountAgeDays && daysSince(member.user.createdTimestamp) < cfg.minAccountAgeDays) {
    void journal(guild, 'security', { title: 'Vérification refusée', tone: 'alerte', lines: [`<@${member.id}> : compte trop récent (${daysSince(member.user.createdTimestamp)} j < ${cfg.minAccountAgeDays} j)`] });
    throw new UserError(`Ton compte Discord doit avoir au moins **${cfg.minAccountAgeDays} jours** pour accéder au serveur. Contacte le staff si besoin.`);
  }
  const verified = cfg.verifiedRoleId ? guild.roles.cache.get(cfg.verifiedRoleId) : null;
  if (!verified || !canBotManageRole(guild, verified)) throw new UserError('La vérification est mal configurée. Préviens le staff.');
  if (member.roles.cache.has(verified.id)) return 'Tu es déjà vérifié(e) ✅';
  await member.roles.add(verified, 'Vérification réussie');
  const unverified = cfg.unverifiedRoleId ? guild.roles.cache.get(cfg.unverifiedRoleId) : null;
  if (unverified && canBotManageRole(guild, unverified)) await member.roles.remove(unverified, 'Vérification réussie').catch(() => undefined);
  await grantAutoroles(member, 'member', 'Rôle automatique après vérification');
  void journal(guild, 'security', { title: 'Membre vérifié', tone: 'ok', lines: [`<@${member.id}> \`${member.user.tag}\``] });
  return `Bienvenue ! Tu as maintenant accès au serveur avec <@&${verified.id}>.`;
}

const verifyCommand: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Le panneau de vérification')
    .addChannelOption((o) => o.setName('salon').setDescription('Où le poster').addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    const cfg = getConfig(interaction.guildId).verification;
    if (!cfg.verifiedRoleId) throw new UserError('Choisis d’abord le rôle « vérifié » dans `/setup` → Sécurité & accès.');
    const channel = (interaction.options.getChannel('salon') ?? resolveTextChannel(interaction.guild, cfg.channelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!channel) throw new UserError('Salon introuvable.');
    const embed = new EmbedBuilder()
      .setColor(colorFor(interaction.guild))
      .setTitle('🔐 VÉRIFICATION')
      .setDescription(`Bienvenue sur **${interaction.guild.name}** !\n\nPour accéder au serveur, clique sur le bouton ci-dessous${cfg.method === 'captcha' ? ' puis recopie le code affiché' : ''}.`);
    const sent = await channel.send({ embeds: [embed], components: [row(button('verif:start', 'Me vérifier', ButtonStyle.Success, '✅'))] });
    await reply(interaction, { embeds: [ok(interaction.guild, `Panneau posté : ${sent.url}`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'verification',
  section: 'security',
  title: 'Vérification',
  emoji: '🔐',
  moduleId: 'verification',
  order: 2,
  description:
    'Les nouveaux arrivent avec un accès limité, puis se vérifient (`/verify`).\n-# Donne au rôle « non vérifié » un accès au seul salon de vérification. Les rôles automatiques sont donnés après vérification.',
  fields: [
    { kind: 'role', key: 'verified', label: 'Rôle vérifié', assignable: true, get: (c) => c.verification.verifiedRoleId, set: (c, v) => void (c.verification.verifiedRoleId = v) },
    { kind: 'role', key: 'unverified', label: 'Rôle non vérifié (à l’arrivée)', assignable: true, get: (c) => c.verification.unverifiedRoleId, set: (c, v) => void (c.verification.unverifiedRoleId = v) },
    {
      kind: 'choice',
      key: 'method',
      label: 'Méthode',
      options: [
        { value: 'button', label: 'Un simple clic', emoji: '🖱️' },
        { value: 'captcha', label: 'Recopier un code (anti-bot)', emoji: '🔢' },
      ],
      get: (c) => c.verification.method,
      set: (c, v) => void (c.verification.method = v as 'button' | 'captcha'),
    },
    { kind: 'channel', key: 'channel', label: 'Salon de vérification', get: (c) => c.verification.channelId, set: (c, v) => void (c.verification.channelId = v) },
    { kind: 'number', key: 'age', label: 'Âge minimum du compte', min: 0, max: 365, unit: 'j', get: (c) => c.verification.minAccountAgeDays, set: (c, v) => void (c.verification.minAccountAgeDays = v) },
  ],
};

export const verificationModule: BotModule = {
  id: 'verification',
  name: 'Vérification',
  emoji: '🔐',
  description: 'Accès limité à l’arrivée puis vérification (clic ou code)',
  toggleable: true,
  defaultEnabled: false,
  commands: [verifyCommand],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'verif',
      async button(interaction, [action]) {
        const cfg = getConfig(interaction.guildId).verification;
        if (action === 'start' && cfg.method === 'button') {
          const text = await verify(interaction.member);
          await interaction.reply({ embeds: [ok(interaction.guild, text)], flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'start') {
          const code = makeCode();
          codes.set(`${interaction.guildId}:${interaction.user.id}`, { code, tries: 0 });
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild)).setTitle('🔢 Ton code').setDescription(`Recopie ce code :\n\n# ${displayCode(code)}\n\n-# Valable 5 minutes.`)],
            components: [row(button('verif:enter', 'Entrer le code', ButtonStyle.Primary, '⌨️'))],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (action === 'enter') {
          await interaction.showModal(buildModal('verif:code', 'Vérification', [{ id: 'code', label: 'Le code affiché', maxLength: 12, minLength: 6 }]));
        }
      },
      async modal(interaction) {
        const key = `${interaction.guildId}:${interaction.user.id}`;
        const pending = codes.get(key);
        if (!pending) throw new UserError('Ton code a expiré. Clique à nouveau sur « Me vérifier ».');
        const typed = interaction.fields.getTextInputValue('code').replace(/[\s​]/g, '').toUpperCase();
        if (typed !== pending.code) {
          pending.tries++;
          if (pending.tries >= 3) codes.delete(key);
          await interaction.reply({ embeds: [erreur(interaction.guild, pending.tries >= 3 ? 'Trop d’essais. Relance la vérification.' : 'Code incorrect, réessaie.')], flags: MessageFlags.Ephemeral });
          return;
        }
        codes.delete(key);
        const text = await verify(interaction.member);
        await interaction.reply({ embeds: [ok(interaction.guild, text)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [
    on('guildMemberAdd', async (member) => {
      if (member.user.bot) return;
      const cfg = getConfig(member.guild.id).verification;
      const role = cfg.unverifiedRoleId ? member.guild.roles.cache.get(cfg.unverifiedRoleId) : null;
      if (role && canBotManageRole(member.guild, role)) await member.roles.add(role, 'En attente de vérification').catch(() => undefined);
    }, 44),
  ],
};
