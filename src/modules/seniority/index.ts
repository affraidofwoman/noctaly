import type { Client, Guild } from 'discord.js';
import { getConfig } from '../../core/guildConfig';
import { journal } from '../../core/logService';
import { createLogger } from '../../core/logger';
import { isModuleEnabled } from '../../core/moduleManager';
import { assignableRoles } from '../../core/permissions';
import type { SetupField, SetupPage } from '../../core/setup';
import { daysSince } from '../../core/time';
import type { BotModule } from '../../core/types';
import { grantBadge } from '../../services/badges';

const log = createLogger('anciennete');
const DEFAULT_DAYS = [30, 90, 180];

/** Rôles d'ancienneté : exemple 30 j → membre régulier, 90 j → ancien, 180 j → OG. */
export async function syncSeniority(guild: Guild): Promise<number> {
  const cfg = getConfig(guild.id).seniority;
  const tiers = cfg.tiers.filter((t) => t.roleId && t.days > 0).sort((a, b) => a.days - b.days);
  if (!tiers.length) return 0;
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  let changes = 0;
  const top = tiers[tiers.length - 1]!;
  for (const member of members.values()) {
    if (member.user.bot || !member.joinedTimestamp) continue;
    const days = daysSince(member.joinedTimestamp);
    const earned = tiers.filter((t) => days >= t.days);
    const target = cfg.stack ? earned : earned.slice(-1);
    const targetIds = new Set(target.map((t) => t.roleId));
    const add = assignableRoles(guild, [...targetIds]).filter((r) => !member.roles.cache.has(r.id));
    const remove = cfg.stack ? [] : assignableRoles(guild, tiers.map((t) => t.roleId)).filter((r) => !targetIds.has(r.id) && member.roles.cache.has(r.id));
    if (add.length) await member.roles.add(add, 'Ancienneté').then(() => changes++).catch(() => undefined);
    if (remove.length) await member.roles.remove(remove, 'Ancienneté').catch(() => undefined);
    if (days >= top.days) grantBadge(guild.id, member.id, 'og');
  }
  if (changes) void journal(guild, 'autorole', { title: 'Rôles d’ancienneté', tone: 'ok', lines: [`**${changes}** membre(s) ont reçu un nouveau rôle d’ancienneté.`] });
  return changes;
}

function tierFields(index: number): SetupField[] {
  return [
    {
      kind: 'role',
      key: `role${index}`,
      label: `Palier ${index + 1} : rôle`,
      assignable: true,
      get: (c) => c.seniority.tiers[index]?.roleId || null,
      set: (c, v) => {
        const tiers = [...c.seniority.tiers];
        while (tiers.length <= index) tiers.push({ days: DEFAULT_DAYS[tiers.length] ?? 365, roleId: '' });
        tiers[index] = { ...tiers[index]!, roleId: v ?? '' };
        c.seniority.tiers = tiers;
      },
    },
  ];
}

function dayField(index: number): SetupField {
  return {
    kind: 'number',
    key: `days${index}`,
    label: `Palier ${index + 1} : jours`,
    min: 1,
    max: 3650,
    unit: 'j',
    get: (c) => c.seniority.tiers[index]?.days ?? DEFAULT_DAYS[index] ?? 365,
    set: (c, v) => {
      const tiers = [...c.seniority.tiers];
      while (tiers.length <= index) tiers.push({ days: DEFAULT_DAYS[tiers.length] ?? 365, roleId: '' });
      tiers[index] = { ...tiers[index]!, days: v };
      c.seniority.tiers = tiers;
    },
  };
}

const setupPage: SetupPage = {
  id: 'seniority',
  section: 'roles',
  title: 'Ancienneté',
  emoji: '🏆',
  moduleId: 'seniority',
  order: 3,
  description: 'Des rôles donnés automatiquement selon le temps passé sur le serveur (vérifié toutes les 6 heures).\n-# Par défaut : 30 j, 90 j, 180 j (OG).',
  fields: [
    ...tierFields(0),
    ...tierFields(1),
    ...tierFields(2),
    { kind: 'toggle', key: 'stack', label: 'Cumuler les paliers', get: (c) => c.seniority.stack, set: (c, v) => void (c.seniority.stack = v) },
    dayField(0),
    dayField(1),
    dayField(2),
  ],
  actions: [
    {
      id: 'sync',
      label: 'Appliquer maintenant',
      emoji: '🔄',
      async run(interaction) {
        await interaction.deferReply({ flags: 64 });
        const n = await syncSeniority(interaction.guild);
        await interaction.editReply({ content: `✅ ${n} membre(s) mis à jour.` });
      },
    },
  ],
};

export const seniorityModule: BotModule = {
  id: 'seniority',
  name: 'Ancienneté',
  emoji: '🏆',
  description: 'Rôles automatiques selon l’ancienneté (régulier, ancien, OG)',
  toggleable: true,
  defaultEnabled: true,
  setupPages: [setupPage],
  tasks: [
    {
      name: 'seniority-sync',
      intervalMs: 6 * 3_600_000,
      async run(client: Client<true>) {
        for (const guild of client.guilds.cache.values()) {
          if (!isModuleEnabled(guild.id, 'seniority') || !getConfig(guild.id).seniority.tiers.some((t) => t.roleId)) continue;
          await syncSeniority(guild).catch((err: Error) => log.warn(`Ancienneté ${guild.id} : ${err.message}`));
        }
      },
    },
  ],
};
