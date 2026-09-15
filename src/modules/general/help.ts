import {
  ApplicationCommandOptionType,
  StringSelectMenuBuilder,
  type APIApplicationCommandOption,
  type AnySelectMenuInteraction,
  type GuildMember,
} from 'discord.js';
import { lireAiguilleur } from '../../core/bot';
import { niveauRequis } from '../../core/dispatcher';
import { embedEnseigne, nomEnseigne } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { moduleActif } from '../../core/moduleManager';
import { lireNiveau, aAcces, libelleNiveau } from '../../core/permissions';
import { tronquer } from '../../core/text';
import { boutonCorbeille } from '../../core/trash';
import { rangee } from '../../core/ui';
import { CATEGORIES_AIDE, Niveau, type CategorieAide } from '../../core/types';

export interface LigneAide {
  texte: string;
  tri: string;
}

/** Lignes d'aide d'une section : uniquement ce que le membre peut lancer, slash et préfixes. */
export function lignesAide(membre: GuildMember, categorie: CategorieAide): LigneAide[] {
  const aiguilleur = lireAiguilleur();
  const serveurId = membre.guild.id;
  const prefixes = lireConfig(serveurId).prefixes;
  const lignes: LigneAide[] = [];

  for (const { commande, module } of aiguilleur.commandes.values()) {
    if (commande.categorie !== categorie || !moduleActif(serveurId, module.id)) continue;
    const json = commande.donnees.toJSON();
    const sousCommandes = (json.options ?? []).filter(
      (o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    const autorise = (groupe: string | null, sousCommande: string | null) => aAcces(membre, niveauRequis(commande, groupe, sousCommande), commande.whitelist);
    if (sousCommandes.length === 0) {
      if (autorise(null, null)) lignes.push({ texte: `**/${json.name}** — ${json.description}`, tri: `/${json.name}` });
      continue;
    }
    for (const sousCommande of sousCommandes) {
      if (sousCommande.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const interne of (sousCommande.options ?? []) as APIApplicationCommandOption[]) {
          if (autorise(sousCommande.name, interne.name)) {
            lignes.push({ texte: `**/${json.name} ${sousCommande.name} ${interne.name}** — ${interne.description}`, tri: `/${json.name} ${sousCommande.name} ${interne.name}` });
          }
        }
      } else if (autorise(null, sousCommande.name)) {
        lignes.push({ texte: `**/${json.name} ${sousCommande.name}** — ${sousCommande.description}`, tri: `/${json.name} ${sousCommande.name}` });
      }
    }
  }

  const vu = new Set<string>();
  for (const { commande, module } of aiguilleur.commandesPrefixe.values()) {
    if (commande.categorie !== categorie || !moduleActif(serveurId, module.id)) continue;
    const cle = `${commande.domaine}:${commande.nom}`;
    if (vu.has(cle)) continue;
    vu.add(cle);
    if (!aAcces(membre, commande.niveau ?? Niveau.MEMBRE, commande.whitelist)) continue;
    const declencheur = `${prefixes[commande.domaine]}${commande.nom}`;
    const usage = commande.usage ? ` \`${commande.usage}\`` : '';
    lignes.push({ texte: `**${declencheur}**${usage} — ${commande.description}`, tri: `~${declencheur}` });
  }

  return lignes.sort((a, b) => a.tri.localeCompare(b.tri, 'fr'));
}

function sectionsPour(membre: GuildMember): { categorie: CategorieAide; lines: LigneAide[] }[] {
  return (Object.keys(CATEGORIES_AIDE) as CategorieAide[])
    .map((categorie) => ({ categorie, lines: lignesAide(membre, categorie) }))
    .filter((s) => s.lines.length > 0);
}

function menu(membre: GuildMember, sections: { categorie: CategorieAide; lines: LigneAide[] }[], selectionne?: CategorieAide) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`help:cat:${membre.id}`)
    .setPlaceholder('Ouvrir une section')
    .addOptions([
      { label: 'Vue d’ensemble', value: 'home', emoji: '📚', default: !selectionne },
      ...sections.slice(0, 24).map((s) => ({
        label: CATEGORIES_AIDE[s.categorie].label,
        value: s.categorie,
        emoji: CATEGORIES_AIDE[s.categorie].emoji,
        description: `${s.lines.length} commande${s.lines.length > 1 ? 's' : ''}`,
        default: s.categorie === selectionne,
      })),
    ]);
  return [rangee(menu), rangee(boutonCorbeille(membre.guild.id, membre.id))];
}

/** Écran d'accueil : le tableau des sections, comme sur Airline. */
export function accueilAide(membre: GuildMember) {
  const sections = sectionsPour(membre);
  const embed = embedEnseigne(membre.guild)
    .setTitle('📚 Tes commandes')
    .setDescription(`Uniquement celles que tu peux lancer — la liste change avec tes accès.\n-# Ton accès : **${libelleNiveau(lireNiveau(membre))}**`)
    .setFooter({ text: `${nomEnseigne(membre.guild)} · choisis une section pour tout voir` });

  let taille = 0;
  for (const s of sections.slice(0, 24)) {
    const info = CATEGORIES_AIDE[s.categorie];
    const apercu = s.lines.slice(0, 4).map((l) => l.texte.split(' — ')[0]).join('\n');
    const plus = s.lines.length > 4 ? `\n-# +${s.lines.length - 4} autre${s.lines.length - 4 > 1 ? 's' : ''}` : '';
    const valeur = tronquer(`${apercu}${plus}`, 1024);
    taille += valeur.length;
    if (taille > 5000) break;
    embed.addFields({ name: `${info.emoji} ${info.label}`, value: valeur, inline: true });
  }
  return { embeds: [embed], components: menu(membre, sections) };
}

export function sectionAide(membre: GuildMember, categorie: CategorieAide) {
  const sections = sectionsPour(membre);
  const actuel = sections.find((s) => s.categorie === categorie);
  if (!actuel) return accueilAide(membre);
  const info = CATEGORIES_AIDE[categorie];
  const embed = embedEnseigne(membre.guild)
    .setTitle(`${info.emoji} ${info.label}`)
    .setDescription(tronquer(actuel.lines.map((l) => l.texte).join('\n'), 4000))
    .setFooter({ text: `${actuel.lines.length} commande(s) · ${nomEnseigne(membre.guild)}` });
  return { embeds: [embed], components: menu(membre, sections, categorie) };
}

export async function surMenuAide(interaction: AnySelectMenuInteraction<'cached'>, proprietaireId: string | undefined): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;
  if (proprietaireId && proprietaireId !== interaction.user.id) {
    await interaction.reply({ ...accueilAide(interaction.member), flags: 64 });
    return;
  }
  const valeur = interaction.values[0];
  if (!valeur || valeur === 'home') {
    await interaction.update(accueilAide(interaction.member));
    return;
  }
  await interaction.update(sectionAide(interaction.member, valeur as CategorieAide));
}
