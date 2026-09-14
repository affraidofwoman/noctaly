import {
  ButtonStyle,
  type ActionRowBuilder,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type User,
} from 'discord.js';
import { emojiFor } from '../../core/brand';
import { brandEmbed, erreur, ok, refus } from '../../core/embeds';
import { journal, recordLog, syncLogPermissions } from '../../core/logService';
import { getLevel, levelLabel } from '../../core/permissions';
import { resolveUser } from '../../core/resolve';
import { truncate } from '../../core/text';
import { ts } from '../../core/time';
import { button, row } from '../../core/ui';
import { PermLevel, type ComponentHandler, type PrefixCommand } from '../../core/types';
import {
  addToWhitelist,
  canManageWhitelist,
  getWhitelist,
  isEnvOwner,
  isWhitelisted,
  listMembers,
  removeFromWhitelist,
  userWhitelists,
  whitelistEntry,
  WHITELISTS,
  type WhitelistDefinition,
  type WhitelistId,
} from '../../core/whitelists';

const LOG_RELATED: WhitelistId[] = ['streamer', 'admin', 'sys', 'staff', 'logs'];

function canManage(member: GuildMember, def: WhitelistDefinition): boolean {
  return canManageWhitelist(getLevel(member), def, isEnvOwner(member.id), member.id === member.guild.ownerId);
}

function whitelistOptions(guildId: string, targetId?: string) {
  return WHITELISTS.map((w) => {
    const has = targetId ? isWhitelisted(w.id, targetId, guildId) : false;
    return {
      label: truncate(`${w.group} · ${w.label}`, 100),
      value: w.id,
      emoji: targetId ? (has ? '✅' : w.emoji) : w.emoji,
      description: truncate(targetId ? `${has ? 'Oui — choisir pour retirer' : 'Non — choisir pour donner'} · ${w.description}` : w.description, 100),
    };
  });
}

/** Écran d'accueil : choisir une whitelist pour voir sa liste. */
export function wlHome(guild: Guild, note?: string) {
  const embed = brandEmbed(guild)
    .setTitle(`${emojiFor(guild.id, 'whitelist')} Whitelists`)
    .setDescription(
      note ??
        [
          'Choisis une whitelist pour en voir la liste.',
          '-# Relance avec quelqu’un (`/wl personne:`) pour l’ajouter ou le retirer.',
        ].join('\n'),
    );
  const groups = new Map<string, WhitelistDefinition[]>();
  for (const w of WHITELISTS) groups.set(w.group, [...(groups.get(w.group) ?? []), w]);
  for (const [group, list] of groups) {
    embed.addFields({
      name: group,
      value: list.map((w) => `${w.emoji} **${w.label}** — \`${listMembers(w.id, guild.id).length}\``).join('\n'),
      inline: true,
    });
  }
  const select = new StringSelectMenuBuilder().setCustomId('wl:list').setPlaceholder('Quelle whitelist ?').addOptions(whitelistOptions(guild.id));
  return { embeds: [embed], components: [row(select)] };
}

/** La liste d'une whitelist, avec ajout/retrait si l'on a le droit. */
export function wlList(member: GuildMember, listId: WhitelistId, note?: string) {
  const guild = member.guild;
  const def = getWhitelist(listId)!;
  const ids = listMembers(listId, guild.id);
  const lines = ids.slice(0, 40).map((id) => {
    const entry = whitelistEntry(listId, id, guild.id);
    const extra = entry ? ` · ${ts(entry.added_at, 'R')}${entry.added_by ? ` par <@${entry.added_by}>` : ''}` : isEnvOwner(id) ? ' · *fixe (.env)*' : '';
    return `• <@${id}> \`${id}\`${extra}`;
  });
  const embed = brandEmbed(guild)
    .setTitle(`${def.emoji} Whitelist ${def.label} (${ids.length})`)
    .setDescription(
      [
        `-# ${def.description}`,
        def.scope === 'global' ? '-# Portée : **tous les serveurs**' : '',
        note ? `\n${note}` : '',
        '',
        lines.length ? lines.join('\n') : '*Personne pour l’instant.*',
        ids.length > 40 ? `-# … +${ids.length - 40} autre(s)` : '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const components = [];
  if (canManage(member, def)) {
    components.push(row(new UserSelectMenuBuilder().setCustomId(`wl:add:${listId}`).setPlaceholder('Ajouter quelqu’un').setMinValues(1).setMaxValues(5)));
    const removable = ids.filter((id) => !(listId === 'owner' && isEnvOwner(id))).slice(0, 25);
    if (removable.length) {
      components.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`wl:rm:${listId}`)
            .setPlaceholder('Retirer quelqu’un')
            .setMinValues(1)
            .setMaxValues(removable.length)
            .addOptions(
              removable.map((id) => {
                const m = guild.members.cache.get(id);
                return { label: truncate(m?.user.tag ?? id, 100), value: id, description: m ? id : 'hors du serveur' };
              }),
            ),
        ),
      );
    }
  } else {
    embed.setFooter({ text: `Tu peux voir cette liste, pas la modifier (accès requis : ${levelLabel(def.managedBy)})` });
  }
  components.push(row(button('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  return { embeds: [embed], components };
}

/** Les whitelists d'une personne : choisir pour donner ou retirer. */
export function wlUser(member: GuildMember, target: User, note?: string) {
  const guild = member.guild;
  const current = userWhitelists(target.id, guild.id);
  const embed = brandEmbed(guild)
    .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiFor(guild.id, 'whitelist')} Whitelists — ${target.displayName}`)
    .setDescription(
      [
        `Choisis la whitelist à donner ou retirer à <@${target.id}>.`,
        note ? `\n${note}` : '',
        '',
        `**Actuellement :** ${current.length ? current.map((w) => `${w.emoji} ${w.label}`).join(' · ') : '*aucune*'}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wl:user:${target.id}`)
    .setPlaceholder('Quelle whitelist ?')
    .addOptions(whitelistOptions(guild.id, target.id).filter((o) => canManage(member, getWhitelist(o.value)!)));
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = select.options.length ? [row(select)] : [];
  components.push(row(button('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  if (!select.options.length) embed.setFooter({ text: 'Tu n’as le droit de modifier aucune whitelist.' });
  return { embeds: [embed], components };
}

export type ToggleResult = { ok: true; added: boolean; text: string } | { ok: false; text: string };

/** Donne ou retire une whitelist, avec contrôle d'accès, journal et resynchronisation des logs. */
export async function toggleWhitelist(actor: GuildMember, listId: WhitelistId, target: User, force?: 'add' | 'remove'): Promise<ToggleResult> {
  const def = getWhitelist(listId);
  if (!def) return { ok: false, text: 'Whitelist inconnue.' };
  const guild = actor.guild;
  if (!canManage(actor, def)) return { ok: false, text: `Tu ne peux pas modifier la whitelist **${def.label}**.` };
  if (target.bot) return { ok: false, text: 'Les bots ne vont pas en whitelist.' };
  if (listId === 'owner' && isEnvOwner(target.id)) return { ok: false, text: 'Cet owner est fixé dans la configuration du bot.' };

  const has = isWhitelisted(listId, target.id, guild.id);
  const add = force ? force === 'add' : !has;
  if (add === has) return { ok: true, added: add, text: `<@${target.id}> ${add ? 'est déjà' : 'n’est pas'} dans **${def.label}**.` };

  if (add) addToWhitelist(listId, target.id, guild.id, actor.id);
  else removeFromWhitelist(listId, target.id, guild.id);

  recordLog(guild.id, 'whitelist', add ? 'add' : 'remove', target.id, actor.id, { list: listId });
  void journal(guild, 'whitelist', {
    title: add ? 'Whitelist accordée' : 'Whitelist retirée',
    tone: add ? 'ok' : 'alerte',
    lines: [`**Whitelist** : ${def.emoji} ${def.label}${def.scope === 'global' ? ' *(globale)*' : ''}`, `**Membre** : <@${target.id}> \`${target.id}\``],
    by: actor.user,
  });
  if (LOG_RELATED.includes(listId)) void syncLogPermissions(guild).catch(() => undefined);

  return { ok: true, added: add, text: `<@${target.id}> ${add ? 'ajouté à' : 'retiré de'} la whitelist **${def.label}**.` };
}

export const wlComponent: ComponentHandler = {
  prefix: 'wl',
  level: PermLevel.STAFF,
  async button(interaction: ButtonInteraction<'cached'>, [action]) {
    if (action === 'home') await interaction.update(wlHome(interaction.guild));
  },
  async select(interaction: AnySelectMenuInteraction<'cached'>, [action, arg]) {
    const member = interaction.member;
    if (action === 'list' && interaction.isStringSelectMenu()) {
      const listId = interaction.values[0] as WhitelistId;
      if (!getWhitelist(listId)) return;
      await interaction.update(wlList(member, listId));
      return;
    }
    if (action === 'add' && interaction.isUserSelectMenu() && arg) {
      const results: string[] = [];
      for (const user of interaction.users.values()) {
        const r = await toggleWhitelist(member, arg as WhitelistId, user, 'add');
        results.push(`${r.ok ? '✅' : '⛔'} ${r.text}`);
      }
      await interaction.update(wlList(member, arg as WhitelistId, results.join('\n')));
      return;
    }
    if (action === 'rm' && interaction.isStringSelectMenu() && arg) {
      const results: string[] = [];
      for (const id of interaction.values) {
        const user = await resolveUser(interaction.client, id);
        if (!user) {
          removeFromWhitelist(arg as WhitelistId, id, interaction.guildId);
          results.push(`✅ \`${id}\` retiré.`);
          continue;
        }
        const r = await toggleWhitelist(member, arg as WhitelistId, user, 'remove');
        results.push(`${r.ok ? '✅' : '⛔'} ${r.text}`);
      }
      await interaction.update(wlList(member, arg as WhitelistId, results.join('\n')));
      return;
    }
    if (action === 'user' && interaction.isStringSelectMenu() && arg) {
      const target = await resolveUser(interaction.client, arg);
      if (!target) {
        await interaction.update({ embeds: [erreur(interaction.guild, 'Utilisateur introuvable.')], components: [] });
        return;
      }
      const r = await toggleWhitelist(member, interaction.values[0] as WhitelistId, target);
      await interaction.update(wlUser(member, target, `${r.ok ? '✅' : '⛔'} ${r.text}`));
    }
  },
};

/** Raccourcis à préfixe, comme =wlbot / =sys / .owner sur Airline : sans argument, affiche la liste. */
export function wlPrefixCommands(): PrefixCommand[] {
  return WHITELISTS.map((def) => ({
    name: def.shortcut,
    domain: def.id === 'owner' ? 'owner' : 'general',
    category: def.id === 'owner' ? 'owner' : 'admin',
    description: `Whitelist ${def.label} (seul : liste)`,
    usage: '[membre]',
    level: def.id === 'owner' ? PermLevel.BOT_OWNER : PermLevel.STAFF,
    async execute(message: Message<true>, args: string[]) {
      if (!message.member) return;
      if (!args[0]) {
        await message.reply({ ...wlList(message.member, def.id), components: [], allowedMentions: { repliedUser: false } });
        return;
      }
      const target = await resolveUser(message.client, args[0]);
      if (!target) {
        await message.reply({ embeds: [erreur(message.guild, 'Identifiant Discord attendu.')], allowedMentions: { repliedUser: false } });
        return;
      }
      const r = await toggleWhitelist(message.member, def.id, target);
      const embed = r.ok ? ok(message.guild, r.text, { titre: 'Whitelist', sujet: def.emoji }) : refus(message.guild, r.text);
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  }));
}
