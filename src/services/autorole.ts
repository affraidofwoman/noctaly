import type { GuildMember } from 'discord.js';
import { getConfig } from '../core/guildConfig';
import { journal } from '../core/logService';
import { createLogger } from '../core/logger';
import { assignableRoles } from '../core/permissions';

const log = createLogger('autorole');

/** Donne les rôles automatiques configurés (membres ou bots). Ignore les rôles au-dessus du bot. */
export async function grantAutoroles(member: GuildMember, kind: 'member' | 'bot', reason = 'Rôle automatique'): Promise<string[]> {
  const cfg = getConfig(member.guild.id).autorole;
  const wanted = kind === 'bot' ? cfg.botRoles : cfg.memberRoles;
  if (!wanted.length) return [];
  const roles = assignableRoles(member.guild, wanted).filter((r) => !member.roles.cache.has(r.id));
  const skipped = wanted.length - assignableRoles(member.guild, wanted).length;
  if (skipped > 0) log.warn(`${skipped} rôle(s) automatique(s) au-dessus du bot sur ${member.guild.id}`);
  if (!roles.length) return [];
  try {
    await member.roles.add(roles, reason);
  } catch (err) {
    log.warn(`Rôles automatiques non donnés à ${member.id} : ${(err as Error).message}`);
    return [];
  }
  void journal(member.guild, 'autorole', {
    title: kind === 'bot' ? 'Rôle automatique (bot)' : 'Rôle automatique (arrivée)',
    tone: 'ok',
    lines: [`**Membre** : <@${member.id}> \`${member.id}\``, `**Rôles** : ${roles.map((r) => `<@&${r.id}>`).join(' ')}`],
  });
  return roles.map((r) => r.id);
}
