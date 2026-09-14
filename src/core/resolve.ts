import type { Client, Guild, GuildBasedChannel, GuildMember, Message, Role, User } from 'discord.js';

export function idFromMention(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^<(?:@[!&]?|#)(\d{17,20})>$/.exec(value.trim()) ?? /^(\d{17,20})$/.exec(value.trim());
  return m ? m[1]! : null;
}

export async function resolveMember(guild: Guild, value: string | undefined): Promise<GuildMember | null> {
  const id = idFromMention(value);
  if (!id) return null;
  return guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
}

export async function resolveUser(client: Client, value: string | undefined): Promise<User | null> {
  const id = idFromMention(value);
  if (!id) return null;
  return client.users.cache.get(id) ?? (await client.users.fetch(id).catch(() => null));
}

export function resolveRole(guild: Guild, value: string | undefined): Role | null {
  const id = idFromMention(value);
  if (id) return guild.roles.cache.get(id) ?? null;
  if (!value) return null;
  const lower = value.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === lower) ?? null;
}

export function resolveChannel(guild: Guild, value: string | undefined): GuildBasedChannel | null {
  const id = idFromMention(value);
  return id ? (guild.channels.cache.get(id) ?? null) : null;
}

/** Cible d'une commande à préfixe : mention/ID en argument, sinon la personne à qui l'on répond. */
export async function targetMember(message: Message<true>, arg: string | undefined): Promise<GuildMember | null> {
  const fromArg = await resolveMember(message.guild, arg);
  if (fromArg) return fromArg;
  if (message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => null);
    if (ref?.member) return ref.member;
  }
  return null;
}
