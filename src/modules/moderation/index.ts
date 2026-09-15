import {
  ButtonStyle,
  ChannelType,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Collection,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type User,
} from 'discord.js';
import { lire, executer } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { demanderConfirmation } from '../../core/confirm';
import { embedEnseigne, erreur, info, ok, refus } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { repondre } from '../../core/interactions';
import { journal, historiser } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { lignesEnPages, paginer } from '../../core/pagination';
import { aNiveau } from '../../core/permissions';
import { resoudreUtilisateur, membreCible } from '../../core/resolve';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { formaterDuree, lireDuree, marqueTemps } from '../../core/time';
import { bouton, rangee } from '../../core/ui';
import { sur, Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { verrousActifs, verrouiller, deverrouiller, type PorteeVerrou } from '../../services/lockdown';
import {
  avertissementsActifs,
  appliquerSanction,
  entreesListeNoire,
  decrireResultat,
  formaterActionsAuto,
  estEnListeNoire,
  TIMEOUT_MAX_MS,
  lireActionsAuto,
  type TypeSanction,
} from '../../services/moderation';

const registre = creerRegistre('moderation');

async function sanctionParCommande(interaction: ChatInputCommandInteraction<'cached'>, type: TypeSanction, cible: User, raison: string | null, dureeMs?: number, avertissementId?: number) {
  await interaction.deferReply();
  const resultat = await appliquerSanction({ serveur: interaction.guild, auteur: interaction.member, cible, type, raison, dureeMs, avertissementId });
  await interaction.editReply({ embeds: [ok(interaction.guild, decrireResultat(resultat), { titre: 'Sanction', sujet: emojiPour(interaction.guildId, 'sanction') })] });
}

async function sanctionParMessage(message: Message<true>, type: TypeSanction, cible: User, raison: string | null, dureeMs?: number, avertissementId?: number) {
  if (!message.member) return;
  const resultat = await appliquerSanction({ serveur: message.guild, auteur: message.member, cible, type, raison, dureeMs, avertissementId });
  await message.reply({ embeds: [ok(message.guild, decrireResultat(resultat), { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') })], allowedMentions: { repliedUser: false } });
}

function pagesAvertissements(serveur: Guild, utilisateur: User) {
  const liste = avertissementsActifs(serveur.id, utilisateur.id);
  const lignes = liste.map((w, i) => `**${i + 1}.** \`n°${w.id}\` ${marqueTemps(w.cree_le, 'd')} — ${tronquer(w.raison, 120)}\n-# par <@${w.moderateur_id}>`);
  if (!lignes.length) lignes.push('*Aucun avertissement actif.*');
  return lignesEnPages(lignes, 8, (contenu, page, total) =>
    embedEnseigne(serveur)
      .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
      .setTitle(`⚠️ Avertissements — ${liste.length}`)
      .setDescription(contenu)
      .setFooter({ text: `Page ${page}/${total} · /unwarn pour en retirer un` }),
  );
}

// ─── Nettoyage ─────────────────────────────────────────────────────────────

async function effacerMessages(salon: GuildTextBasedChannel, montant: number, filtreMembreId: string | null, auteur: User): Promise<number> {
  const max = Math.min(Math.max(montant, 1), 1000);
  let supprimes = 0;
  let avant: string | undefined;
  const limite = Date.now() - 14 * 86_400_000 + 60_000;
  while (supprimes < max) {
    const lot: Collection<string, Message> = await salon.messages.fetch({ limit: 100, before: avant });
    if (!lot.size) break;
    avant = lot.last()?.id;
    const candidats = lot.filter((m) => m.createdTimestamp > limite && !m.pinned && (!filtreMembreId || m.author.id === filtreMembreId));
    const aSupprimer = [...candidats.values()].slice(0, max - supprimes);
    if (aSupprimer.length) {
      const retiree = await salon.bulkDelete(aSupprimer, true);
      supprimes += retiree.size;
    }
    if (lot.size < 100 || lot.last()!.createdTimestamp < limite) break;
  }
  historiser(salon.guild.id, 'clear', 'clear', filtreMembreId, auteur.id, { channelId: salon.id, deleted: supprimes });
  void journal(salon.guild, 'clear', {
    titre: 'Salon nettoyé',
    ton: 'alerte',
    lignes: [`**Salon** : <#${salon.id}>`, `**Messages supprimés** : ${supprimes}`, filtreMembreId ? `**Filtre** : <@${filtreMembreId}>` : null],
    par: auteur,
  });
  return supprimes;
}

// ─── Commandes slash ───────────────────────────────────────────────────────

const optionRaison = (o: import('discord.js').SlashCommandStringOption) => o.setName('raison').setDescription('Pourquoi').setMaxLength(400);

const avertir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o).setRequired(true)),
  async executer(i) {
    await sanctionParCommande(i, 'warn', i.options.getUser('membre', true), i.options.getString('raison', true));
  },
};

const retirerAvertissement: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Retirer un avertissement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addIntegerOption((o) => o.setName('numero').setDescription('Numéro du warn (le dernier par défaut)').setMinValue(1))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'unwarn', i.options.getUser('membre', true), i.options.getString('raison'), undefined, i.options.getInteger('numero') ?? undefined);
  },
};

const avertissements: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Les avertissements d’un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
  async executer(i) {
    await paginer(i, pagesAvertissements(i.guild, i.options.getUser('membre', true)), true);
  },
};

const exclure: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Rendre muet temporairement')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 10m, 2h, 1j (28 j max)').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const duree = lireDuree(i.options.getString('duree', true));
    if (!duree || duree > TIMEOUT_MAX_MS) throw new ErreurUtilisateur('Durée invalide : exemples `10m`, `2h`, `1j` (28 jours maximum).');
    await sanctionParCommande(i, 'timeout', i.options.getUser('membre', true), i.options.getString('raison'), duree);
  },
};

const leverTimeout: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Lever un timeout')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'untimeout', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const expulser: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulser un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'kick', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const bannir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un compte')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (même hors du serveur)').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    await sanctionParCommande(i, 'ban', i.options.getUser('membre', true), i.options.getString('raison'));
  },
};

const debannir: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un compte')
    .addStringOption((o) => o.setName('id').setDescription('Identifiant Discord').setRequired(true))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const utilisateur = await resoudreUtilisateur(i.client, i.options.getString('id', true));
    if (!utilisateur) throw new ErreurUtilisateur('Identifiant Discord attendu.');
    await sanctionParCommande(i, 'unban', utilisateur, i.options.getString('raison'));
  },
};

const listeNoire: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Blacklist du serveur (re-ban automatique)')
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Blacklister un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant ou mention').setRequired(true))
        .addStringOption((o) => optionRaison(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer de la blacklist')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Détail d’un compte')
        .addStringOption((o) => o.setName('id').setDescription('Identifiant').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('La blacklist')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    if (sousCommande === 'liste') return paginer(i, pagesListeNoire(i.guild), true);
    const utilisateur = await resoudreUtilisateur(i.client, i.options.getString('id', true));
    if (!utilisateur) throw new ErreurUtilisateur('Identifiant Discord attendu.');
    if (sousCommande === 'info') return repondre(i, { embeds: [ficheListeNoire(i.guild, utilisateur)], ephemeral: true });
    return sanctionParCommande(i, sousCommande === 'ajouter' ? 'blacklist' : 'unblacklist', utilisateur, i.options.getString('raison'));
  },
};

function pagesListeNoire(serveur: Guild) {
  const local = entreesListeNoire(serveur.id);
  const lignes = local.map((b) => `• <@${b.utilisateur_id}> \`${b.utilisateur_id}\` — ${tronquer(b.raison, 80)}\n-# ${marqueTemps(b.ajoute_le, 'd')} par <@${b.ajoute_par}>`);
  if (!lignes.length) lignes.push('*La blacklist est vide.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) =>
    embedEnseigne(serveur).setTitle(`⛔ Blacklist (${local.length})`).setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }),
  );
}

function ficheListeNoire(serveur: Guild, utilisateur: User) {
  const entree = estEnListeNoire(serveur.id, utilisateur.id);
  if (!entree) return info(serveur, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiPour(serveur.id, 'sanction') });
  return info(
    serveur,
    [
      `**Compte** — ${utilisateur.tag} (\`${utilisateur.id}\`)`,
      `**Raison** — ${entree.raison}`,
      `**Par** — <@${entree.ajoute_par}>`,
      `**Le** — ${marqueTemps(entree.ajoute_le, 'f')}`,
      `-# ${entree.portee === 'global' ? 'Blacklist globale : tous les serveurs du bot' : 'Blacklist de ce serveur'}`,
    ].join('\n'),
    { titre: 'Sanction', sujet: emojiPour(serveur.id, 'sanction') },
  );
}

const effacer: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Effacer des messages')
    .addIntegerOption((o) => o.setName('nombre').setDescription('Combien (1 à 1000)').setMinValue(1).setMaxValue(1000).setRequired(true))
    .addUserOption((o) => o.setName('membre').setDescription('Seulement ses messages')),
  async executer(i) {
    if (!i.channel) return;
    await i.deferReply({ flags: 64 });
    const supprimes = await effacerMessages(i.channel, i.options.getInteger('nombre', true), i.options.getUser('membre')?.id ?? null, i.user);
    await i.editReply({ embeds: [ok(i.guild, `**${supprimes}** message(s) supprimé(s).\n-# Les messages de plus de 14 jours et épinglés sont conservés.`)] });
  },
};

const modeLent: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Mode lent du salon')
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 5s, 1m, 0 pour couper (6 h max)').setRequired(true))
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)),
  async executer(i) {
    const brut = i.options.getString('duree', true).trim();
    const secondes = brut === '0' ? 0 : Math.round((lireDuree(/^\d+$/.test(brut) ? `${brut}s` : brut) ?? -1000) / 1000);
    if (secondes < 0 || secondes > 21_600) throw new ErreurUtilisateur('Durée invalide : de `0` à `6h`.');
    const salon = (i.options.getChannel('salon') ?? i.channel) as GuildTextBasedChannel | null;
    if (!salon || !('setRateLimitPerUser' in salon)) throw new ErreurUtilisateur('Ce salon ne gère pas le mode lent.');
    await salon.setRateLimitPerUser(secondes, `Mode lent par ${i.user.tag}`);
    void journal(i.guild, 'channel', { titre: 'Mode lent', ton: 'info', lignes: [`**Salon** : <#${salon.id}>`, `**Délai** : ${secondes ? formaterDuree(secondes * 1000) : 'coupé'}`], par: i.user });
    await repondre(i, { embeds: [ok(i.guild, secondes ? `Mode lent de **${formaterDuree(secondes * 1000)}** sur <#${salon.id}>.` : `Mode lent coupé sur <#${salon.id}>.`)], ephemeral: true });
  },
};

const commandeVerrouiller: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Fermer un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)'))
    .addStringOption((o) => optionRaison(o)),
  async executer(i) {
    const salon = i.options.getChannel('salon') ?? i.channel;
    if (!salon) return;
    const r = await verrouiller(i.guild, 'channel', salon.id, i.user, i.options.getString('raison') ?? 'Aucune raison');
    await repondre(i, { embeds: [ok(i.guild, `🔒 <#${salon.id}> fermé (${r.verrouilles} salon).`)] });
  },
};

const commandeDeverrouiller: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.MODERATEUR,
  donnees: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Rouvrir un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon (celui-ci par défaut)')),
  async executer(i) {
    const salon = i.options.getChannel('salon') ?? i.channel;
    if (!salon) return;
    await deverrouiller(i.guild, 'channel', salon.id, i.user);
    await repondre(i, { embeds: [ok(i.guild, `🔓 <#${salon.id}> rouvert.`)] });
  },
};

const verrouillage: CommandeSlash = {
  categorie: 'salons',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Bloquer les messages des membres')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé').addChannelTypes(ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice))
        .addStringOption((o) => optionRaison(o)),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Terminer un lockdown')
        .addStringOption((o) =>
          o
            .setName('portee')
            .setDescription('Où')
            .setRequired(true)
            .addChoices({ name: 'Serveur entier', value: 'server' }, { name: 'Une catégorie', value: 'category' }, { name: 'Un salon', value: 'channel' }),
        )
        .addChannelOption((o) => o.setName('cible').setDescription('Catégorie ou salon visé')),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Les verrouillages en cours')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    if (sousCommande === 'status') {
      const verrous = verrousActifs(i.guildId);
      const lignes = verrous.map((l) => `• ${l.portee === 'server' ? '**Serveur entier**' : `<#${l.cible_id}>`} — ${marqueTemps(l.cree_le, 'R')}${l.raison ? ` · ${tronquer(l.raison, 60)}` : ''}`);
      return repondre(i, { embeds: [info(i.guild, lignes.join('\n') || 'Aucun verrouillage en cours.', { titre: 'Lockdown', sujet: '🔒' })], ephemeral: true });
    }
    const portee = i.options.getString('portee', true) as PorteeVerrou;
    const cible = portee === 'server' ? i.guildId : (i.options.getChannel('cible')?.id ?? i.channelId);
    const raison = i.options.getString('raison') ?? 'Aucune raison';
    const filtre = portee === 'server' ? 'tout le serveur' : `<#${cible}>`;
    if (sousCommande === 'end') {
      const restaures = await deverrouiller(i.guild, portee, cible, i.user);
      return repondre(i, { embeds: [ok(i.guild, `🔓 Lockdown terminé sur ${filtre} — **${restaures}** salon(s) rouvert(s).`)] });
    }
    return demanderConfirmation(i, {
      titre: '🔒 LOCKDOWN',
      description: `Les membres ne pourront plus écrire sur ${filtre}.\nLes permissions d’origine seront restaurées avec \`/lockdown end\`.`,
      libelleConfirmation: 'Verrouiller',
      surConfirmation: async (b) => {
        await b.update({ embeds: [info(b.guild, 'Verrouillage en cours…')], components: [] });
        const r = await verrouiller(b.guild, portee, cible, b.user, raison);
        await b.editReply({ embeds: [ok(b.guild, `🔒 **${r.verrouilles}** salon(s) verrouillé(s) sur ${filtre}.${r.ignores ? `\n-# ${r.ignores} ignoré(s) (déjà fermés ou inaccessibles).` : ''}`)] });
        if (b.channel && 'send' in b.channel) {
          await b.channel.send({ embeds: [refus(b.guild, `**LOCKDOWN** — ${raison}\nLes messages sont temporairement bloqués.`)] }).catch(() => undefined);
        }
      },
    });
  },
};

// ─── Commandes à préfixe (façon Airline) ───────────────────────────────────

async function exigerCible(message: Message<true>, argument: string | undefined): Promise<User> {
  const membre = await membreCible(message, argument);
  if (membre) return membre.user;
  const utilisateur = await resoudreUtilisateur(message.client, argument);
  if (!utilisateur) throw new ErreurUtilisateur('Mention ou identifiant Discord attendu.');
  return utilisateur;
}

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'ban',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Bannit / débannit',
    usage: '<membre|id> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const banni = await message.guild.bans.fetch(utilisateur.id).catch(() => null);
      await sanctionParMessage(message, banni ? 'unban' : 'ban', utilisateur, parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'kick',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Expulse',
    usage: '<membre> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'kick', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'mute',
    alias: ['timeout', 'to'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Timeout',
    usage: '<membre> <durée> [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const duree = lireDuree(parametres[1] ?? '');
      if (!duree || duree > TIMEOUT_MAX_MS) throw new ErreurUtilisateur('Durée attendue : `10m`, `2h`, `1j`…');
      await sanctionParMessage(message, 'timeout', utilisateur, parametres.slice(2).join(' ') || null, duree);
    },
  },
  {
    nom: 'unmute',
    alias: ['untimeout'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Lève un timeout',
    usage: '<membre>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'untimeout', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'warn',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Avertit',
    usage: '<membre> <raison>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const raison = parametres.slice(1).join(' ');
      if (!raison) throw new ErreurUtilisateur('Une raison est attendue.');
      await sanctionParMessage(message, 'warn', utilisateur, raison);
    },
  },
  {
    nom: 'unwarn',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Retire un warn',
    usage: '<membre> [numéro]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      await sanctionParMessage(message, 'unwarn', utilisateur, null, undefined, parametres[1] ? Number(parametres[1]) || undefined : undefined);
    },
  },
  {
    nom: 'warns',
    alias: ['warnings'],
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Les warns d’un membre',
    usage: '<membre>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      const pages = pagesAvertissements(message.guild, await exigerCible(message, parametres[0]));
      await message.reply({ embeds: [pages[0]!], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'baninfo',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Détail d’un ban',
    usage: '<id>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const bannir = await message.guild.bans.fetch(utilisateur.id).catch(() => null);
      const dernier = lire<{ acteur_id: string; donnees: string; cree_le: number }>(
        "SELECT acteur_id, donnees, cree_le FROM journaux WHERE serveur_id = ? AND utilisateur_id = ? AND type IN ('ban','blacklist') ORDER BY cree_le DESC LIMIT 1",
        message.guildId,
        utilisateur.id,
      );
      const embed = bannir
        ? info(
            message.guild,
            [
              `**Compte** — ${utilisateur.tag} (\`${utilisateur.id}\`)`,
              `**Raison** — ${bannir.reason ?? '*aucune raison enregistrée*'}`,
              dernier ? `**Par** — <@${dernier.acteur_id}>` : null,
              dernier ? `**Le** — ${marqueTemps(dernier.cree_le, 'f')}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') },
          )
        : info(message.guild, 'Rien pour ce compte.', { titre: 'Sanction', sujet: emojiPour(message.guildId, 'sanction') });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'unbanall',
    domaine: 'sanction',
    categorie: 'moderation',
    description: 'Débannit tout',
    niveau: Niveau.STREAMER,
    async executer(message) {
      const bannissements = await message.guild.bans.fetch();
      const enListeNoire = new Set(entreesListeNoire(message.guildId).map((b) => b.utilisateur_id));
      const nombre = bannissements.filter((b) => !enListeNoire.has(b.user.id)).size;
      await message.reply({
        embeds: [info(message.guild, `Débannir **${nombre}** compte(s) ?\n-# Les comptes blacklistés restent bannis.`, { titre: 'Confirmation', sujet: '⚠️' })],
        components: [rangee(bouton(`modconf:unbanall:${message.author.id}`, 'Tout débannir', ButtonStyle.Danger, '🕊️'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    nom: 'clear',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Efface',
    usage: '[n] [membre]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const n = Number(parametres[0] ?? 50);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ErreurUtilisateur('Nombre entre 1 et 1000.');
      const cible = parametres[1] ? await exigerCible(message, parametres[1]) : null;
      await message.delete().catch(() => undefined);
      const supprimes = await effacerMessages(message.channel, n, cible?.id ?? null, message.author);
      const note = await message.channel.send({ embeds: [ok(message.guild, `**${supprimes}** message(s) supprimé(s).`)] });
      setTimeout(() => void note.delete().catch(() => undefined), 5_000).unref();
    },
  },
  {
    nom: 'lock',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Ce salon',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await verrouiller(message.guild, 'channel', message.channelId, message.author, parametres.join(' ') || 'Aucune raison');
      await message.reply({ embeds: [ok(message.guild, '🔒 Salon fermé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'unlock',
    domaine: 'salon',
    categorie: 'salons',
    description: 'Ce salon',
    niveau: Niveau.MODERATEUR,
    async executer(message) {
      await deverrouiller(message.guild, 'channel', message.channelId, message.author);
      await message.reply({ embeds: [ok(message.guild, '🔓 Salon rouvert.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'l0all',
    alias: ['lockall'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Tout le serveur',
    niveau: Niveau.ADMIN,
    async executer(message, parametres) {
      await message.reply({
        embeds: [info(message.guild, 'Verrouiller **tout le serveur** ?\n-# `&unl0all` pour tout rouvrir.', { titre: 'LOCKDOWN', sujet: '🔒' })],
        components: [rangee(bouton(`modconf:lockall:${message.author.id}:${encodeURIComponent(parametres.join(' ').slice(0, 60))}`, 'Verrouiller', ButtonStyle.Danger, '🔒'))],
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    nom: 'unl0all',
    alias: ['unlockall'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Rouvre tout le serveur',
    niveau: Niveau.ADMIN,
    async executer(message) {
      const restaures = await deverrouiller(message.guild, 'server', message.guildId, message.author);
      await message.reply({ embeds: [ok(message.guild, `🔓 **${restaures}** salon(s) rouvert(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'slowmode',
    alias: ['slow'],
    domaine: 'salon',
    categorie: 'salons',
    description: 'Mode lent',
    usage: '<durée|0>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      const brut = parametres[0] ?? '0';
      const secondes = brut === '0' ? 0 : Math.round((lireDuree(/^\d+$/.test(brut) ? `${brut}s` : brut) ?? -1000) / 1000);
      if (secondes < 0 || secondes > 21_600 || !('setRateLimitPerUser' in message.channel)) throw new ErreurUtilisateur('Durée de `0` à `6h`.');
      await message.channel.setRateLimitPerUser(secondes, `Mode lent par ${message.author.tag}`);
      await message.reply({ embeds: [ok(message.guild, secondes ? `Mode lent : **${formaterDuree(secondes * 1000)}**.` : 'Mode lent coupé.')], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'bl',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Blacklist (seul : liste)',
    usage: '[id] [raison]',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      if (!parametres[0]) {
        await message.reply({ embeds: [pagesListeNoire(message.guild)[0]!], allowedMentions: { repliedUser: false } });
        return;
      }
      await sanctionParMessage(message, 'blacklist', await exigerCible(message, parametres[0]), parametres.slice(1).join(' ') || null);
    },
  },
  {
    nom: 'unbl',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Retire de la blacklist',
    usage: '<id>',
    niveau: Niveau.MODERATEUR,
    async executer(message, parametres) {
      await sanctionParMessage(message, 'unblacklist', await exigerCible(message, parametres[0]), null);
    },
  },
  {
    nom: 'blinfo',
    domaine: 'salon',
    categorie: 'moderation',
    description: 'Détail blacklist',
    usage: '<id>',
    niveau: Niveau.STAFF,
    async executer(message, parametres) {
      await message.reply({ embeds: [ficheListeNoire(message.guild, await exigerCible(message, parametres[0]))], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'gbl',
    domaine: 'owner',
    categorie: 'owner',
    description: 'Blacklist globale (seul : liste)',
    usage: '[id] [raison]',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message, parametres) {
      if (!parametres[0]) {
        const lignes = entreesListeNoire('global').map((b) => `• <@${b.utilisateur_id}> \`${b.utilisateur_id}\` — ${tronquer(b.raison, 80)}`);
        await message.reply({ embeds: [info(message.guild, tronquer(lignes.join('\n') || 'Vide.', 4000), { titre: 'Blacklist globale', sujet: '⛔' })], allowedMentions: { repliedUser: false } });
        return;
      }
      const utilisateur = await exigerCible(message, parametres[0]);
      const raison = parametres.slice(1).join(' ') || 'Aucune raison';
      executer(
        `INSERT INTO liste_noire (portee, utilisateur_id, raison, ajoute_par, ajoute_le) VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(portee, utilisateur_id) DO UPDATE SET raison = excluded.raison`,
        utilisateur.id,
        raison,
        message.author.id,
        Date.now(),
      );
      let banni = 0;
      for (const serveur of message.client.guilds.cache.values()) {
        const reussi = await serveur.members.ban(utilisateur.id, { reason: `Blacklist globale : ${raison}`.slice(0, 500) }).then(() => true).catch(() => false);
        if (reussi) {
          banni++;
          historiser(serveur.id, 'blacklist', 'global', utilisateur.id, message.author.id, { reason: raison });
          void journal(serveur, 'blacklist', { titre: 'Blacklist globale', ton: 'alerte', lignes: [`**Cible** : <@${utilisateur.id}> \`${utilisateur.id}\``, `**Raison** : ${raison}`], par: message.author });
        }
      }
      await message.reply({ embeds: [ok(message.guild, `<@${utilisateur.id}> blacklisté partout — banni de **${banni}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'ungbl',
    domaine: 'owner',
    categorie: 'owner',
    description: 'Retire de la blacklist globale',
    usage: '<id>',
    niveau: Niveau.PROPRIETAIRE_BOT,
    async executer(message, parametres) {
      const utilisateur = await exigerCible(message, parametres[0]);
      const r = executer("DELETE FROM liste_noire WHERE portee = 'global' AND utilisateur_id = ?", utilisateur.id);
      if (!r.changes) throw new ErreurUtilisateur('Ce compte n’est pas dans la blacklist globale.');
      let debannis = 0;
      for (const serveur of message.client.guilds.cache.values()) {
        if (estEnListeNoire(serveur.id, utilisateur.id)) continue;
        if (await serveur.bans.remove(utilisateur.id, 'Retrait de la blacklist globale').then(() => true).catch(() => false)) debannis++;
      }
      await message.reply({ embeds: [ok(message.guild, `<@${utilisateur.id}> retiré de la blacklist globale — débanni de **${debannis}** serveur(s).`)], allowedMentions: { repliedUser: false } });
    },
  },
];

async function surConfirmationModeration(interaction: ButtonInteraction<'cached'>, [action, proprietaireId, extra]: string[]) {
  if (interaction.user.id !== proprietaireId) {
    await interaction.reply({ embeds: [erreur(interaction.guild, 'Seul l’auteur de la commande peut confirmer.')], flags: 64 });
    return;
  }
  if (action === 'lockall') {
    await interaction.update({ embeds: [info(interaction.guild, 'Verrouillage en cours…')], components: [] });
    const r = await verrouiller(interaction.guild, 'server', interaction.guildId, interaction.user, decodeURIComponent(extra ?? '') || 'Aucune raison');
    await interaction.editReply({ embeds: [ok(interaction.guild, `🔒 **${r.verrouilles}** salon(s) verrouillé(s).`)] });
    return;
  }
  if (action === 'unbanall') {
    if (!aNiveau(interaction.member, Niveau.STREAMER)) throw new ErreurUtilisateur('Accès Streamer requis.');
    await interaction.update({ embeds: [info(interaction.guild, 'Débannissement en cours…')], components: [] });
    const bannissements = await interaction.guild.bans.fetch();
    const enListeNoire = new Set(entreesListeNoire(interaction.guildId).map((b) => b.utilisateur_id));
    let fait = 0;
    for (const b of bannissements.values()) {
      if (enListeNoire.has(b.user.id) || estEnListeNoire(interaction.guildId, b.user.id)) continue;
      if (await interaction.guild.bans.remove(b.user.id, `+unbanall par ${interaction.user.tag}`).then(() => true).catch(() => false)) fait++;
    }
    historiser(interaction.guildId, 'sanction', 'unbanall', null, interaction.user.id, { count: fait });
    void journal(interaction.guild, 'sanction', { titre: 'Débannissement général', ton: 'ok', lignes: [`**Comptes débannis** : ${fait}`], par: interaction.user });
    await interaction.editReply({ embeds: [ok(interaction.guild, `🕊️ **${fait}** compte(s) débanni(s).`)] });
  }
}

const pageReglage: PageReglage = {
  id: 'moderation',
  section: 'moderation',
  titre: 'Sanctions',
  emoji: '🛡️',
  moduleId: 'moderation',
  ordre: 1,
  description: 'Avertissements, actions automatiques et messages privés de sanction.\n-# Actions automatiques : `3:timeout:60, 5:kick, 7:ban` (nombre de warns : action : minutes).',
  champs: [
    { genre: 'toggle', cle: 'dm', libelle: 'Prévenir en MP', lire: (c) => c.moderation.mpSanction, ecrire: (c, v) => void (c.moderation.mpSanction = v) },
    {
      genre: 'text',
      cle: 'auto',
      libelle: 'Actions automatiques',
      longueurMax: 200,
      lire: (c) => formaterActionsAuto(c.moderation.actionsAuto),
      ecrire: (c, v) => void (c.moderation.actionsAuto = lireActionsAuto(v) ?? c.moderation.actionsAuto),
      validate: (v) => (lireActionsAuto(v) ? null : 'Format attendu : `3:timeout:60, 5:kick, 7:ban`.'),
    },
    { genre: 'text', cle: 'contact', libelle: 'Phrase de contact (MP)', long: true, longueurMax: 300, lire: (c) => c.moderation.texteContact, ecrire: (c, v) => void (c.moderation.texteContact = v) },
    { genre: 'number', cle: 'timeout', libelle: 'Timeout par défaut', min: 1, max: 40_320, unite: 'min', lire: (c) => c.moderation.minutesTimeoutDefaut, ecrire: (c, v) => void (c.moderation.minutesTimeoutDefaut = v) },
    { genre: 'number', cle: 'bandelete', libelle: 'Messages effacés au ban', min: 0, max: 168, unite: 'h', lire: (c) => c.moderation.heuresEffaceesBan, ecrire: (c, v) => void (c.moderation.heuresEffaceesBan = v) },
  ],
};

export const moduleModeration: ModuleBot = {
  id: 'moderation',
  nom: 'Modération',
  emoji: '🛡️',
  description: 'Warns, timeouts, bans, blacklist, lock et lockdown',
  desactivable: true,
  actifParDefaut: true,
  commandes: [avertir, retirerAvertissement, avertissements, exclure, leverTimeout, expulser, bannir, debannir, listeNoire, effacer, modeLent, commandeVerrouiller, commandeDeverrouiller, verrouillage],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [{ prefixe: 'modconf', niveau: Niveau.MODERATEUR, bouton: (i, parametres) => surConfirmationModeration(i, parametres) }],
  evenements: [
    // Blacklist : re-ban immédiat, avant tout accueil.
    sur('guildMemberAdd', async (membre: GuildMember) => {
      const entree = estEnListeNoire(membre.guild.id, membre.id);
      if (!entree) return;
      try {
        await membre.ban({ reason: `Blacklist${entree.portee === 'global' ? ' globale' : ''} : tentative de retour (${entree.raison})`.slice(0, 500) });
        void journal(membre.guild, 'blacklist', {
          titre: 'Retour bloqué',
          ton: 'alerte',
          lignes: [`**Compte** : <@${membre.id}> \`${membre.id}\``, `**Blacklist** : ${entree.portee === 'global' ? 'globale' : 'serveur'}`, `**Raison** : ${entree.raison}`],
        });
        return 'stop';
      } catch (echec) {
        registre.avertir(`Re-ban impossible de ${membre.id} : ${(echec as Error).message}`);
      }
    }, 1),
  ],
};
