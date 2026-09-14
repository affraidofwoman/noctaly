import {
  ApplicationCommandOptionType,
  StringSelectMenuBuilder,
  type APIApplicationCommandOption,
  type AnySelectMenuInteraction,
  type GuildMember,
} from 'discord.js';
import { getDispatcher } from '../../core/bot';
import { requiredLevel } from '../../core/dispatcher';
import { brandEmbed, brandName } from '../../core/embeds';
import { getConfig } from '../../core/guildConfig';
import { isModuleEnabled } from '../../core/moduleManager';
import { getLevel, hasAccess, levelLabel } from '../../core/permissions';
import { truncate } from '../../core/text';
import { trashButton } from '../../core/trash';
import { row } from '../../core/ui';
import { HELP_CATEGORIES, PermLevel, type HelpCategory } from '../../core/types';

export interface HelpLine {
  text: string;
  sort: string;
}

/** Lignes d'aide d'une section : uniquement ce que le membre peut lancer, slash et préfixes. */
export function helpLines(member: GuildMember, category: HelpCategory): HelpLine[] {
  const dispatcher = getDispatcher();
  const guildId = member.guild.id;
  const prefixes = getConfig(guildId).prefixes;
  const lines: HelpLine[] = [];

  for (const { command, module } of dispatcher.commands.values()) {
    if (command.category !== category || !isModuleEnabled(guildId, module.id)) continue;
    const json = command.data.toJSON();
    const subs = (json.options ?? []).filter(
      (o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    const allowed = (group: string | null, sub: string | null) => hasAccess(member, requiredLevel(command, group, sub), command.whitelist);
    if (subs.length === 0) {
      if (allowed(null, null)) lines.push({ text: `**/${json.name}** — ${json.description}`, sort: `/${json.name}` });
      continue;
    }
    for (const sub of subs) {
      if (sub.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const inner of (sub.options ?? []) as APIApplicationCommandOption[]) {
          if (allowed(sub.name, inner.name)) {
            lines.push({ text: `**/${json.name} ${sub.name} ${inner.name}** — ${inner.description}`, sort: `/${json.name} ${sub.name} ${inner.name}` });
          }
        }
      } else if (allowed(null, sub.name)) {
        lines.push({ text: `**/${json.name} ${sub.name}** — ${sub.description}`, sort: `/${json.name} ${sub.name}` });
      }
    }
  }

  const seen = new Set<string>();
  for (const { command, module } of dispatcher.prefixCommands.values()) {
    if (command.category !== category || !isModuleEnabled(guildId, module.id)) continue;
    const key = `${command.domain}:${command.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hasAccess(member, command.level ?? PermLevel.MEMBER, command.whitelist)) continue;
    const trigger = `${prefixes[command.domain]}${command.name}`;
    const usage = command.usage ? ` \`${command.usage}\`` : '';
    lines.push({ text: `**${trigger}**${usage} — ${command.description}`, sort: `~${trigger}` });
  }

  return lines.sort((a, b) => a.sort.localeCompare(b.sort, 'fr'));
}

function sectionsFor(member: GuildMember): { category: HelpCategory; lines: HelpLine[] }[] {
  return (Object.keys(HELP_CATEGORIES) as HelpCategory[])
    .map((category) => ({ category, lines: helpLines(member, category) }))
    .filter((s) => s.lines.length > 0);
}

function menu(member: GuildMember, sections: { category: HelpCategory; lines: HelpLine[] }[], selected?: HelpCategory) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`help:cat:${member.id}`)
    .setPlaceholder('Ouvrir une section')
    .addOptions([
      { label: 'Vue d’ensemble', value: 'home', emoji: '📚', default: !selected },
      ...sections.slice(0, 24).map((s) => ({
        label: HELP_CATEGORIES[s.category].label,
        value: s.category,
        emoji: HELP_CATEGORIES[s.category].emoji,
        description: `${s.lines.length} commande${s.lines.length > 1 ? 's' : ''}`,
        default: s.category === selected,
      })),
    ]);
  return [row(select), row(trashButton(member.guild.id, member.id))];
}

/** Écran d'accueil : le tableau des sections, comme sur Airline. */
export function helpHome(member: GuildMember) {
  const sections = sectionsFor(member);
  const embed = brandEmbed(member.guild)
    .setTitle('📚 Tes commandes')
    .setDescription(`Uniquement celles que tu peux lancer — la liste change avec tes accès.\n-# Ton accès : **${levelLabel(getLevel(member))}**`)
    .setFooter({ text: `${brandName(member.guild)} · choisis une section pour tout voir` });

  let size = 0;
  for (const s of sections.slice(0, 24)) {
    const info = HELP_CATEGORIES[s.category];
    const preview = s.lines.slice(0, 4).map((l) => l.text.split(' — ')[0]).join('\n');
    const more = s.lines.length > 4 ? `\n-# +${s.lines.length - 4} autre${s.lines.length - 4 > 1 ? 's' : ''}` : '';
    const value = truncate(`${preview}${more}`, 1024);
    size += value.length;
    if (size > 5000) break;
    embed.addFields({ name: `${info.emoji} ${info.label}`, value, inline: true });
  }
  return { embeds: [embed], components: menu(member, sections) };
}

export function helpSection(member: GuildMember, category: HelpCategory) {
  const sections = sectionsFor(member);
  const current = sections.find((s) => s.category === category);
  if (!current) return helpHome(member);
  const info = HELP_CATEGORIES[category];
  const embed = brandEmbed(member.guild)
    .setTitle(`${info.emoji} ${info.label}`)
    .setDescription(truncate(current.lines.map((l) => l.text).join('\n'), 4000))
    .setFooter({ text: `${current.lines.length} commande(s) · ${brandName(member.guild)}` });
  return { embeds: [embed], components: menu(member, sections, category) };
}

export async function onHelpSelect(interaction: AnySelectMenuInteraction<'cached'>, ownerId: string | undefined): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;
  if (ownerId && ownerId !== interaction.user.id) {
    await interaction.reply({ ...helpHome(interaction.member), flags: 64 });
    return;
  }
  const value = interaction.values[0];
  if (!value || value === 'home') {
    await interaction.update(helpHome(interaction.member));
    return;
  }
  await interaction.update(helpSection(interaction.member, value as HelpCategory));
}
