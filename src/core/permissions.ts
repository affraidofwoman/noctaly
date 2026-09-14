import { PermissionFlagsBits, type Guild, type GuildMember, type PermissionResolvable, type Role } from 'discord.js';
import { getConfig, type GuildConfig } from './guildConfig';
import { PERM_LEVEL_LABELS, PermLevel } from './types';
import { isBotOwner, isWhitelisted, whitelistLevel, type WhitelistId } from './whitelists';

export interface MemberLike {
  id: string;
  guildOwnerId: string;
  roleIds: string[];
  isAdministrator: boolean;
  canManageGuild: boolean;
  /** Niveau accordé par les whitelists (par ID). */
  whitelistLevel: PermLevel;
  isBotOwner: boolean;
}

/**
 * Calcul pur (testable) du niveau d'accès.
 * Sources cumulées : owner bot, propriétaire du serveur, whitelists par ID, rôles configurés, permissions Discord.
 */
export function computeLevel(member: MemberLike, perms: GuildConfig['permissions']): PermLevel {
  if (member.isBotOwner) return PermLevel.BOT_OWNER;
  let level = member.whitelistLevel;
  const raise = (l: PermLevel) => {
    if (l > level) level = l;
  };
  const has = (ids: string[]) => ids.some((id) => member.roleIds.includes(id));
  if (member.id === member.guildOwnerId) raise(PermLevel.STREAMER);
  if (has(perms.streamer)) raise(PermLevel.STREAMER);
  if (member.isAdministrator || member.canManageGuild || has(perms.admin)) raise(PermLevel.ADMIN);
  if (has(perms.moderator)) raise(PermLevel.MODERATOR);
  if (has(perms.staff)) raise(PermLevel.STAFF);
  if (has(perms.support)) raise(PermLevel.SUPPORT);
  return level;
}

export function getLevel(member: GuildMember): PermLevel {
  const perms = getConfig(member.guild.id).permissions;
  return computeLevel(
    {
      id: member.id,
      guildOwnerId: member.guild.ownerId,
      roleIds: [...member.roles.cache.keys()],
      isAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
      canManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
      whitelistLevel: whitelistLevel(member.id, member.guild.id),
      isBotOwner: isBotOwner(member.id),
    },
    perms,
  );
}

export function hasLevel(member: GuildMember, level: PermLevel): boolean {
  return getLevel(member) >= level;
}

/** Accès à une fonction : niveau suffisant OU whitelist ciblée. */
export function hasAccess(member: GuildMember, level: PermLevel, whitelist?: string): boolean {
  if (getLevel(member) >= level) return true;
  return !!whitelist && isWhitelisted(whitelist as WhitelistId, member.id, member.guild.id);
}

/** Membre ignoré par les protections automatiques (bypass ou staff). */
export function isBypassed(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  return isWhitelisted('bypass', member.id, member.guild.id) || getLevel(member) >= PermLevel.MODERATOR;
}

export function levelLabel(level: PermLevel): string {
  return PERM_LEVEL_LABELS[level];
}

/** Le bot peut-il attribuer ce rôle ? (hiérarchie + rôle géré) */
export function canBotManageRole(guild: Guild, role: Role): boolean {
  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (role.managed || role.id === guild.id) return false;
  return me.roles.highest.comparePositionTo(role) > 0;
}

export function assignableRoles(guild: Guild, roleIds: string[]): Role[] {
  return roleIds
    .map((id) => guild.roles.cache.get(id))
    .filter((r): r is Role => !!r && canBotManageRole(guild, r));
}

export type ModerationCheck = { ok: true } | { ok: false; reason: string };

/** Vérifie qu'un modérateur peut agir sur une cible (hiérarchie Discord et niveaux du bot respectés). */
export function checkModeratable(actor: GuildMember, target: GuildMember): ModerationCheck {
  const guild = actor.guild;
  if (target.id === actor.id) return { ok: false, reason: 'Tu ne peux pas faire ça sur toi-même.' };
  if (target.id === guild.ownerId) return { ok: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  if (target.id === guild.members.me?.id) return { ok: false, reason: 'Je ne peux pas me sanctionner moi-même.' };
  const me = guild.members.me;
  // Les sanctions automatiques (AutoMod, anti-raid) viennent du bot : seule la hiérarchie des rôles compte.
  if (actor.id === me?.id) {
    return me.roles.highest.comparePositionTo(target.roles.highest) > 0 ? { ok: true } : { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  const actorLevel = getLevel(actor);
  if (actorLevel < PermLevel.BOT_OWNER && getLevel(target) >= actorLevel) {
    return { ok: false, reason: 'Ce membre a un accès égal ou supérieur au tien.' };
  }
  if (actor.id !== guild.ownerId && actorLevel < PermLevel.STREAMER && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au tien.' };
  }
  if (me && me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  return { ok: true };
}

export function botHasPermissions(guild: Guild, perms: PermissionResolvable): boolean {
  return guild.members.me?.permissions.has(perms) ?? false;
}
