import { PermissionFlagsBits, type Guild, type GuildMember, type PermissionResolvable, type Role } from 'discord.js';
import { lireConfig, type ConfigServeur } from './guildConfig';
import { LIBELLES_NIVEAUX, Niveau } from './types';
import { estProprietaireBot, estWhitelist, niveauWhitelist, type WhitelistId } from './whitelists';

export interface ProfilMembre {
  id: string;
  guildOwnerId: string;
  roleIds: string[];
  isAdministrator: boolean;
  canManageGuild: boolean;
  /** Niveau accordé par les whitelists (par ID). */
  whitelistLevel: Niveau;
  isBotOwner: boolean;
}

/**
 * Calcul pur (testable) du niveau d'accès.
 * Sources cumulées : owner bot, propriétaire du serveur, whitelists par ID, rôles configurés, permissions Discord.
 */
export function calculerNiveau(membre: ProfilMembre, permissions: ConfigServeur['permissions']): Niveau {
  if (membre.isBotOwner) return Niveau.PROPRIETAIRE_BOT;
  let niveau = membre.whitelistLevel;
  const monter = (l: Niveau) => {
    if (l > niveau) niveau = l;
  };
  const possede = (ids: string[]) => ids.some((id) => membre.roleIds.includes(id));
  if (membre.id === membre.guildOwnerId) monter(Niveau.STREAMER);
  if (possede(permissions.streamer)) monter(Niveau.STREAMER);
  if (membre.isAdministrator || membre.canManageGuild || possede(permissions.admin)) monter(Niveau.ADMIN);
  if (possede(permissions.moderateur)) monter(Niveau.MODERATEUR);
  if (possede(permissions.staff)) monter(Niveau.STAFF);
  if (possede(permissions.support)) monter(Niveau.SUPPORT);
  return niveau;
}

export function lireNiveau(membre: GuildMember): Niveau {
  const permissions = lireConfig(membre.guild.id).permissions;
  return calculerNiveau(
    {
      id: membre.id,
      guildOwnerId: membre.guild.ownerId,
      roleIds: [...membre.roles.cache.keys()],
      isAdministrator: membre.permissions.has(PermissionFlagsBits.Administrator),
      canManageGuild: membre.permissions.has(PermissionFlagsBits.ManageGuild),
      whitelistLevel: niveauWhitelist(membre.id, membre.guild.id),
      isBotOwner: estProprietaireBot(membre.id),
    },
    permissions,
  );
}

export function aNiveau(membre: GuildMember, niveau: Niveau): boolean {
  return lireNiveau(membre) >= niveau;
}

/** Accès à une fonction : niveau suffisant OU whitelist ciblée. */
export function aAcces(membre: GuildMember, niveau: Niveau, whitelist?: string): boolean {
  if (lireNiveau(membre) >= niveau) return true;
  return !!whitelist && estWhitelist(whitelist as WhitelistId, membre.id, membre.guild.id);
}

/** Membre ignoré par les protections automatiques (bypass ou staff). */
export function estExempte(membre: GuildMember | null | undefined): boolean {
  if (!membre) return false;
  return estWhitelist('bypass', membre.id, membre.guild.id) || lireNiveau(membre) >= Niveau.MODERATEUR;
}

export function libelleNiveau(niveau: Niveau): string {
  return LIBELLES_NIVEAUX[niveau];
}

/** Le bot peut-il attribuer ce rôle ? (hiérarchie + rôle géré) */
export function botPeutGererRole(serveur: Guild, role: Role): boolean {
  const moi = serveur.members.me;
  if (!moi || !moi.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (role.managed || role.id === serveur.id) return false;
  return moi.roles.highest.comparePositionTo(role) > 0;
}

export function rolesAttribuables(serveur: Guild, rolesIds: string[]): Role[] {
  return rolesIds
    .map((id) => serveur.roles.cache.get(id))
    .filter((r): r is Role => !!r && botPeutGererRole(serveur, r));
}

export type VerificationModeration = { ok: true } | { ok: false; reason: string };

/** Vérifie qu'un modérateur peut agir sur une cible (hiérarchie Discord et niveaux du bot respectés). */
export function verifierModerable(auteur: GuildMember, cible: GuildMember): VerificationModeration {
  const serveur = auteur.guild;
  if (cible.id === auteur.id) return { ok: false, reason: 'Tu ne peux pas faire ça sur toi-même.' };
  if (cible.id === serveur.ownerId) return { ok: false, reason: 'Impossible de sanctionner le propriétaire du serveur.' };
  if (cible.id === serveur.members.me?.id) return { ok: false, reason: 'Je ne peux pas me sanctionner moi-même.' };
  const moi = serveur.members.me;
  // Les sanctions automatiques (AutoMod, anti-raid) viennent du bot : seule la hiérarchie des rôles compte.
  if (auteur.id === moi?.id) {
    return moi.roles.highest.comparePositionTo(cible.roles.highest) > 0 ? { ok: true } : { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  const niveauAuteur = lireNiveau(auteur);
  if (niveauAuteur < Niveau.PROPRIETAIRE_BOT && lireNiveau(cible) >= niveauAuteur) {
    return { ok: false, reason: 'Ce membre a un accès égal ou supérieur au tien.' };
  }
  if (auteur.id !== serveur.ownerId && niveauAuteur < Niveau.STREAMER && auteur.roles.highest.comparePositionTo(cible.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au tien.' };
  }
  if (moi && moi.roles.highest.comparePositionTo(cible.roles.highest) <= 0) {
    return { ok: false, reason: 'Ce membre a un rôle supérieur ou égal au mien.' };
  }
  return { ok: true };
}

export function botAPermissions(serveur: Guild, permissions: PermissionResolvable): boolean {
  return serveur.members.me?.permissions.has(permissions) ?? false;
}
