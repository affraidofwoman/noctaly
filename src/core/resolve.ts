import type { Client, Guild, GuildBasedChannel, GuildMember, Message, Role, User } from 'discord.js';

export function idDepuisMention(valeur: string | undefined): string | null {
  if (!valeur) return null;
  const m = /^<(?:@[!&]?|#)(\d{17,20})>$/.exec(valeur.trim()) ?? /^(\d{17,20})$/.exec(valeur.trim());
  return m ? m[1]! : null;
}

export async function resoudreMembre(serveur: Guild, valeur: string | undefined): Promise<GuildMember | null> {
  const id = idDepuisMention(valeur);
  if (!id) return null;
  return serveur.members.cache.get(id) ?? (await serveur.members.fetch(id).catch(() => null));
}

export async function resoudreUtilisateur(client: Client, valeur: string | undefined): Promise<User | null> {
  const id = idDepuisMention(valeur);
  if (!id) return null;
  return client.users.cache.get(id) ?? (await client.users.fetch(id).catch(() => null));
}

export function resoudreRole(serveur: Guild, valeur: string | undefined): Role | null {
  const id = idDepuisMention(valeur);
  if (id) return serveur.roles.cache.get(id) ?? null;
  if (!valeur) return null;
  const minuscule = valeur.toLowerCase();
  return serveur.roles.cache.find((r) => r.name.toLowerCase() === minuscule) ?? null;
}

export function resoudreSalon(serveur: Guild, valeur: string | undefined): GuildBasedChannel | null {
  const id = idDepuisMention(valeur);
  return id ? (serveur.channels.cache.get(id) ?? null) : null;
}

/** Cible d'une commande à préfixe : mention/ID en argument, sinon la personne à qui l'on répond. */
export async function membreCible(message: Message<true>, argument: string | undefined): Promise<GuildMember | null> {
  const depuisArgument = await resoudreMembre(message.guild, argument);
  if (depuisArgument) return depuisArgument;
  if (message.reference?.messageId) {
    const reference = await message.fetchReference().catch(() => null);
    if (reference?.member) return reference.member;
  }
  return null;
}
