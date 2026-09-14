import { SlashCommandBuilder } from 'discord.js';
import { brandEmbed } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { isModuleEnabled } from '../../core/moduleManager';
import { canBotManageRole } from '../../core/permissions';
import { getSetupPage, renderPage, type SetupPage } from '../../core/setup';
import { on, PermLevel, type BotModule, type SlashCommand } from '../../core/types';
import { grantAutoroles } from '../../services/autorole';

const setupPage: SetupPage = {
  id: 'autorole',
  section: 'welcome',
  title: 'Rôles automatiques',
  emoji: '🎭',
  moduleId: 'autorole',
  order: 3,
  description:
    'Rôles donnés automatiquement à l’arrivée. Les rôles placés au-dessus du bot sont ignorés.\n-# Si la vérification est active, les rôles membres sont donnés après vérification.',
  fields: [
    { kind: 'roles', key: 'members', label: 'Rôles des membres', assignable: true, max: 10, get: (c) => c.autorole.memberRoles, set: (c, v) => void (c.autorole.memberRoles = v) },
    { kind: 'roles', key: 'bots', label: 'Rôles des bots', assignable: true, max: 10, get: (c) => c.autorole.botRoles, set: (c, v) => void (c.autorole.botRoles = v) },
    { kind: 'number', key: 'delay', label: 'Délai avant attribution', min: 0, max: 600, unit: 's', get: (c) => c.autorole.delaySeconds, set: (c, v) => void (c.autorole.delaySeconds = v) },
  ],
};

const autorole: SlashCommand = {
  category: 'roles',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder().setName('autorole').setDescription('Rôles donnés à l’arrivée'),
  async execute(interaction) {
    const page = getSetupPage('autorole');
    if (page) return reply(interaction, { ...renderPage(interaction.guild, page), ephemeral: true });
    const cfg = getConfig(interaction.guildId).autorole;
    const list = (ids: string[]) =>
      ids.map((id) => {
        const role = interaction.guild.roles.cache.get(id);
        return `• <@&${id}>${role && !canBotManageRole(interaction.guild, role) ? ' ⚠️ au-dessus du bot' : ''}`;
      });
    return reply(interaction, {
      embeds: [brandEmbed(interaction.guild).setTitle('🎭 Rôles automatiques').setDescription([...list(cfg.memberRoles), ...list(cfg.botRoles)].join('\n') || '—')],
      ephemeral: true,
    });
  },
};

export const autoroleModule: BotModule = {
  id: 'autorole',
  name: 'Rôles automatiques',
  emoji: '🎭',
  description: 'Rôles donnés à l’arrivée (membres et bots)',
  toggleable: true,
  defaultEnabled: true,
  commands: [autorole],
  setupPages: [setupPage],
  events: [
    on('guildMemberAdd', async (member) => {
      const guild = member.guild;
      const cfg = getConfig(guild.id);
      if (member.user.bot) {
        await grantAutoroles(member, 'bot');
        return;
      }
      // La vérification donne elle-même les rôles membres une fois le membre vérifié.
      if (isModuleEnabled(guild.id, 'verification') && cfg.verification.verifiedRoleId) return;
      const delay = cfg.autorole.delaySeconds * 1000;
      if (delay > 0) {
        setTimeout(() => {
          void guild.members
            .fetch(member.id)
            .then((m) => grantAutoroles(m, 'member'))
            .catch(() => undefined);
        }, delay).unref();
        return;
      }
      await grantAutoroles(member, 'member');
    }, 45),
  ],
};
