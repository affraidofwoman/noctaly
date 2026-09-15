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
import { emojiPour } from '../../core/brand';
import { embedEnseigne, erreur, ok, refus } from '../../core/embeds';
import { journal, historiser, synchroniserAccesJournaux } from '../../core/logService';
import { lireNiveau, libelleNiveau } from '../../core/permissions';
import { resoudreUtilisateur } from '../../core/resolve';
import { tronquer } from '../../core/text';
import { marqueTemps } from '../../core/time';
import { bouton, rangee } from '../../core/ui';
import { Niveau, type GestionnaireComposant, type CommandePrefixe } from '../../core/types';
import {
  ajouterWhitelist,
  peutGererWhitelist,
  lireWhitelist,
  estProprietaireFixe,
  estWhitelist,
  membresListe,
  retirerWhitelist,
  whitelistsMembre,
  entreeWhitelist,
  WHITELISTS,
  type DefinitionWhitelist,
  type WhitelistId,
} from '../../core/whitelists';

const LIEES_AUX_JOURNAUX: WhitelistId[] = ['streamer', 'admin', 'sys', 'staff', 'logs'];

function peutGerer(membre: GuildMember, definition: DefinitionWhitelist): boolean {
  return peutGererWhitelist(lireNiveau(membre), definition, estProprietaireFixe(membre.id), membre.id === membre.guild.ownerId);
}

function optionsWhitelists(serveurId: string, cibleId?: string) {
  return WHITELISTS.map((w) => {
    const possede = cibleId ? estWhitelist(w.id, cibleId, serveurId) : false;
    return {
      label: tronquer(`${w.groupe} · ${w.libelle}`, 100),
      value: w.id,
      emoji: cibleId ? (possede ? '✅' : w.emoji) : w.emoji,
      description: tronquer(cibleId ? `${possede ? 'Oui — choisir pour retirer' : 'Non — choisir pour donner'} · ${w.description}` : w.description, 100),
    };
  });
}

/** Écran d'accueil : choisir une whitelist pour voir sa liste. */
export function accueilWhitelists(serveur: Guild, note?: string) {
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'whitelist')} Whitelists`)
    .setDescription(
      note ??
        [
          'Choisis une whitelist pour en voir la liste.',
          '-# Relance avec quelqu’un (`/wl personne:`) pour l’ajouter ou le retirer.',
        ].join('\n'),
    );
  const groupes = new Map<string, DefinitionWhitelist[]>();
  for (const w of WHITELISTS) groupes.set(w.groupe, [...(groupes.get(w.groupe) ?? []), w]);
  for (const [groupe, liste] of groupes) {
    embed.addFields({
      name: groupe,
      value: liste.map((w) => `${w.emoji} **${w.libelle}** — \`${membresListe(w.id, serveur.id).length}\``).join('\n'),
      inline: true,
    });
  }
  const menu = new StringSelectMenuBuilder().setCustomId('wl:list').setPlaceholder('Quelle whitelist ?').addOptions(optionsWhitelists(serveur.id));
  return { embeds: [embed], components: [rangee(menu)] };
}

/** La liste d'une whitelist, avec ajout/retrait si l'on a le droit. */
export function listeWhitelist(membre: GuildMember, listeId: WhitelistId, note?: string) {
  const serveur = membre.guild;
  const definition = lireWhitelist(listeId)!;
  const ids = membresListe(listeId, serveur.id);
  const lignes = ids.slice(0, 40).map((id) => {
    const entree = entreeWhitelist(listeId, id, serveur.id);
    const extra = entree ? ` · ${marqueTemps(entree.ajoute_le, 'R')}${entree.ajoute_par ? ` par <@${entree.ajoute_par}>` : ''}` : estProprietaireFixe(id) ? ' · *fixe (.env)*' : '';
    return `• <@${id}> \`${id}\`${extra}`;
  });
  const embed = embedEnseigne(serveur)
    .setTitle(`${definition.emoji} Whitelist ${definition.libelle} (${ids.length})`)
    .setDescription(
      [
        `-# ${definition.description}`,
        definition.portee === 'global' ? '-# Portée : **tous les serveurs**' : '',
        note ? `\n${note}` : '',
        '',
        lignes.length ? lignes.join('\n') : '*Personne pour l’instant.*',
        ids.length > 40 ? `-# … +${ids.length - 40} autre(s)` : '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const composants = [];
  if (peutGerer(membre, definition)) {
    composants.push(rangee(new UserSelectMenuBuilder().setCustomId(`wl:add:${listeId}`).setPlaceholder('Ajouter quelqu’un').setMinValues(1).setMaxValues(5)));
    const retirables = ids.filter((id) => !(listeId === 'owner' && estProprietaireFixe(id))).slice(0, 25);
    if (retirables.length) {
      composants.push(
        rangee(
          new StringSelectMenuBuilder()
            .setCustomId(`wl:rm:${listeId}`)
            .setPlaceholder('Retirer quelqu’un')
            .setMinValues(1)
            .setMaxValues(retirables.length)
            .addOptions(
              retirables.map((id) => {
                const m = serveur.members.cache.get(id);
                return { label: tronquer(m?.user.tag ?? id, 100), value: id, description: m ? id : 'hors du serveur' };
              }),
            ),
        ),
      );
    }
  } else {
    embed.setFooter({ text: `Tu peux voir cette liste, pas la modifier (accès requis : ${libelleNiveau(definition.gerePar)})` });
  }
  composants.push(rangee(bouton('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  return { embeds: [embed], components: composants };
}

/** Les whitelists d'une personne : choisir pour donner ou retirer. */
export function whitelistsDe(membre: GuildMember, cible: User, note?: string) {
  const serveur = membre.guild;
  const actuel = whitelistsMembre(cible.id, serveur.id);
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: cible.tag, iconURL: cible.displayAvatarURL({ size: 64 }) })
    .setTitle(`${emojiPour(serveur.id, 'whitelist')} Whitelists — ${cible.displayName}`)
    .setDescription(
      [
        `Choisis la whitelist à donner ou retirer à <@${cible.id}>.`,
        note ? `\n${note}` : '',
        '',
        `**Actuellement :** ${actuel.length ? actuel.map((w) => `${w.emoji} ${w.libelle}`).join(' · ') : '*aucune*'}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`wl:user:${cible.id}`)
    .setPlaceholder('Quelle whitelist ?')
    .addOptions(optionsWhitelists(serveur.id, cible.id).filter((o) => peutGerer(membre, lireWhitelist(o.value)!)));
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = menu.options.length ? [rangee(menu)] : [];
  composants.push(rangee(bouton('wl:home', 'Toutes les whitelists', ButtonStyle.Secondary, '⬅️')));
  if (!menu.options.length) embed.setFooter({ text: 'Tu n’as le droit de modifier aucune whitelist.' });
  return { embeds: [embed], components: composants };
}

export type ResultatBascule = { ok: true; ajoute: boolean; texte: string } | { ok: false; texte: string };

/** Donne ou retire une whitelist, avec contrôle d'accès, journal et resynchronisation des logs. */
export async function basculerWhitelist(auteur: GuildMember, listeId: WhitelistId, cible: User, forcer?: 'add' | 'remove'): Promise<ResultatBascule> {
  const definition = lireWhitelist(listeId);
  if (!definition) return { ok: false, texte: 'Whitelist inconnue.' };
  const serveur = auteur.guild;
  if (!peutGerer(auteur, definition)) return { ok: false, texte: `Tu ne peux pas modifier la whitelist **${definition.libelle}**.` };
  if (cible.bot) return { ok: false, texte: 'Les bots ne vont pas en whitelist.' };
  if (listeId === 'owner' && estProprietaireFixe(cible.id)) return { ok: false, texte: 'Cet owner est fixé dans la configuration du bot.' };

  const possede = estWhitelist(listeId, cible.id, serveur.id);
  const ajouter = forcer ? forcer === 'add' : !possede;
  if (ajouter === possede) return { ok: true, ajoute: ajouter, texte: `<@${cible.id}> ${ajouter ? 'est déjà' : 'n’est pas'} dans **${definition.libelle}**.` };

  if (ajouter) ajouterWhitelist(listeId, cible.id, serveur.id, auteur.id);
  else retirerWhitelist(listeId, cible.id, serveur.id);

  historiser(serveur.id, 'whitelist', ajouter ? 'add' : 'remove', cible.id, auteur.id, { list: listeId });
  void journal(serveur, 'whitelist', {
    titre: ajouter ? 'Whitelist accordée' : 'Whitelist retirée',
    ton: ajouter ? 'ok' : 'alerte',
    lignes: [`**Whitelist** : ${definition.emoji} ${definition.libelle}${definition.portee === 'global' ? ' *(globale)*' : ''}`, `**Membre** : <@${cible.id}> \`${cible.id}\``],
    par: auteur.user,
  });
  if (LIEES_AUX_JOURNAUX.includes(listeId)) void synchroniserAccesJournaux(serveur).catch(() => undefined);

  return { ok: true, ajoute: ajouter, texte: `<@${cible.id}> ${ajouter ? 'ajouté à' : 'retiré de'} la whitelist **${definition.libelle}**.` };
}

export const composantWhitelists: GestionnaireComposant = {
  prefixe: 'wl',
  niveau: Niveau.STAFF,
  async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
    if (action === 'home') await interaction.update(accueilWhitelists(interaction.guild));
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, argument]) {
    const membre = interaction.member;
    if (action === 'list' && interaction.isStringSelectMenu()) {
      const listeId = interaction.values[0] as WhitelistId;
      if (!lireWhitelist(listeId)) return;
      await interaction.update(listeWhitelist(membre, listeId));
      return;
    }
    if (action === 'add' && interaction.isUserSelectMenu() && argument) {
      const resultats: string[] = [];
      for (const utilisateur of interaction.users.values()) {
        const r = await basculerWhitelist(membre, argument as WhitelistId, utilisateur, 'add');
        resultats.push(`${r.ok ? '✅' : '⛔'} ${r.texte}`);
      }
      await interaction.update(listeWhitelist(membre, argument as WhitelistId, resultats.join('\n')));
      return;
    }
    if (action === 'rm' && interaction.isStringSelectMenu() && argument) {
      const resultats: string[] = [];
      for (const id of interaction.values) {
        const utilisateur = await resoudreUtilisateur(interaction.client, id);
        if (!utilisateur) {
          retirerWhitelist(argument as WhitelistId, id, interaction.guildId);
          resultats.push(`✅ \`${id}\` retiré.`);
          continue;
        }
        const r = await basculerWhitelist(membre, argument as WhitelistId, utilisateur, 'remove');
        resultats.push(`${r.ok ? '✅' : '⛔'} ${r.texte}`);
      }
      await interaction.update(listeWhitelist(membre, argument as WhitelistId, resultats.join('\n')));
      return;
    }
    if (action === 'user' && interaction.isStringSelectMenu() && argument) {
      const cible = await resoudreUtilisateur(interaction.client, argument);
      if (!cible) {
        await interaction.update({ embeds: [erreur(interaction.guild, 'Utilisateur introuvable.')], components: [] });
        return;
      }
      const r = await basculerWhitelist(membre, interaction.values[0] as WhitelistId, cible);
      await interaction.update(whitelistsDe(membre, cible, `${r.ok ? '✅' : '⛔'} ${r.texte}`));
    }
  },
};

/** Raccourcis à préfixe, comme =wlbot / =sys / .owner sur Airline : sans argument, affiche la liste. */
export function raccourcisWhitelists(): CommandePrefixe[] {
  return WHITELISTS.map((definition) => ({
    nom: definition.raccourci,
    domaine: definition.id === 'owner' ? 'owner' : 'general',
    categorie: definition.id === 'owner' ? 'owner' : 'admin',
    description: `Whitelist ${definition.libelle} (seul : liste)`,
    usage: '[membre]',
    niveau: definition.id === 'owner' ? Niveau.PROPRIETAIRE_BOT : Niveau.STAFF,
    async executer(message: Message<true>, parametres: string[]) {
      if (!message.member) return;
      if (!parametres[0]) {
        await message.reply({ ...listeWhitelist(message.member, definition.id), components: [], allowedMentions: { repliedUser: false } });
        return;
      }
      const cible = await resoudreUtilisateur(message.client, parametres[0]);
      if (!cible) {
        await message.reply({ embeds: [erreur(message.guild, 'Identifiant Discord attendu.')], allowedMentions: { repliedUser: false } });
        return;
      }
      const r = await basculerWhitelist(message.member, definition.id, cible);
      const embed = r.ok ? ok(message.guild, r.texte, { titre: 'Whitelist', sujet: definition.emoji }) : refus(message.guild, r.texte);
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  }));
}
