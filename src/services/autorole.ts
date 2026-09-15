import type { GuildMember } from 'discord.js';
import { lireConfig } from '../core/guildConfig';
import { journal } from '../core/logService';
import { creerRegistre } from '../core/logger';
import { rolesAttribuables } from '../core/permissions';

const registre = creerRegistre('autorole');

/** Donne les rôles automatiques configurés (membres ou bots). Ignore les rôles au-dessus du bot. */
export async function donnerRolesAuto(membre: GuildMember, genre: 'member' | 'bot', raison = 'Rôle automatique'): Promise<string[]> {
  const reglages = lireConfig(membre.guild.id).rolesAuto;
  const voulus = genre === 'bot' ? reglages.rolesBots : reglages.rolesMembres;
  if (!voulus.length) return [];
  const roles = rolesAttribuables(membre.guild, voulus).filter((r) => !membre.roles.cache.has(r.id));
  const ignores = voulus.length - rolesAttribuables(membre.guild, voulus).length;
  if (ignores > 0) registre.avertir(`${ignores} rôle(s) automatique(s) au-dessus du bot sur ${membre.guild.id}`);
  if (!roles.length) return [];
  try {
    await membre.roles.add(roles, raison);
  } catch (echec) {
    registre.avertir(`Rôles automatiques non donnés à ${membre.id} : ${(echec as Error).message}`);
    return [];
  }
  void journal(membre.guild, 'autorole', {
    titre: genre === 'bot' ? 'Rôle automatique (bot)' : 'Rôle automatique (arrivée)',
    ton: 'ok',
    lignes: [`**Membre** : <@${membre.id}> \`${membre.id}\``, `**Rôles** : ${roles.map((r) => `<@&${r.id}>`).join(' ')}`],
  });
  return roles.map((r) => r.id);
}
