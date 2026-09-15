import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type User,
} from 'discord.js';
import { embedEnseigne, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { lignesEnPages, paginer } from '../../core/pagination';
import { botPeutGererRole } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { formaterNombre, medaille, tronquer } from '../../core/text';
import { cleJour, cleJourPrecedent, marqueTemps } from '../../core/time';
import { bouton, rangee } from '../../core/ui';
import { sur, Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { emettreActivite } from '../../services/activity';
import { lireBadge, donnerBadge } from '../../services/badges';
import { ajouterPieces, acheter, inventaire, plusRiches, noterQuotidien, articleBoutique, articlesBoutique, transferer, portefeuille, type ArticleBoutique } from '../../services/economy';
import { executer } from '../../database/db';

const delaisMessages = new Map<string, number>();

function pieces(serveurId: string, montant: number): string {
  const economie = lireConfig(serveurId).economie;
  return `**${formaterNombre(montant)}** ${economie.emojiMonnaie} ${economie.nomMonnaie}`;
}

function embedSolde(serveur: Guild, utilisateur: User) {
  const w = portefeuille(serveur.id, utilisateur.id);
  const economie = lireConfig(serveur.id).economie;
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`${economie.emojiMonnaie} Porte-monnaie`)
    .setDescription(
      [
        `• Solde — ${pieces(serveur.id, w.solde)}`,
        `• Gagné au total — **${formaterNombre(w.total_gagne)}**`,
        `• Série de /daily — **${w.serie_quotidien}** jour${w.serie_quotidien > 1 ? 's' : ''}`,
        '',
        '-# Monnaie purement virtuelle, sans aucune valeur réelle.',
      ].join('\n'),
    );
}

function recupererQuotidien(membre: GuildMember): string {
  const serveur = membre.guild;
  const economie = lireConfig(serveur.id).economie;
  const fuseau = lireConfig(serveur.id).general.fuseau;
  const w = portefeuille(serveur.id, membre.id);
  const aujourdhui = cleJour(Date.now(), fuseau);
  const dernier = w.dernier_quotidien ? cleJour(w.dernier_quotidien, fuseau) : null;
  if (dernier === aujourdhui) throw new ErreurUtilisateur('Tu as déjà récupéré ta récompense aujourd’hui. Reviens demain !');
  const serie = dernier === cleJourPrecedent(aujourdhui) ? w.serie_quotidien + 1 : 1;
  const montant = economie.montantQuotidien + Math.min(serie - 1, 30) * economie.bonusSerie;
  const solde = ajouterPieces(serveur.id, membre.id, montant, 'daily');
  noterQuotidien(serveur.id, membre.id, Date.now(), serie);
  emettreActivite({ serveurId: serveur.id, utilisateurId: membre.id, type: 'daily', montant: 1 });
  return `🎁 Tu reçois ${pieces(serveur.id, montant)} !\n🔥 Série : **${serie}** jour${serie > 1 ? 's' : ''}${serie > 1 ? ` (+${Math.min(serie - 1, 30) * economie.bonusSerie} de bonus)` : ''}\n-# Nouveau solde : ${formaterNombre(solde)}`;
}

function pagesRiches(serveur: Guild) {
  const lignes = plusRiches(serveur.id, 200).map((r, i) => `${medaille(i + 1)} <@${r.utilisateur_id}> — ${pieces(serveur.id, r.solde)}`);
  if (!lignes.length) lignes.push('*Personne n’a encore de pièces.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('🏆 Les plus riches').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

// ─── Boutique ──────────────────────────────────────────────────────────────

const LIBELLE_TYPE: Record<ArticleBoutique['type'], string> = { role: 'Rôle', badge: 'Badge', item: 'Article' };

function affichageBoutique(serveur: Guild, utilisateurId: string, note?: string) {
  const articles = articlesBoutique(serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🛒 Boutique communautaire')
    .setDescription(
      [
        note,
        `Ton solde : ${pieces(serveur.id, portefeuille(serveur.id, utilisateurId).solde)}`,
        '',
        articles.length
          ? articles.map((i) => `${i.emoji} **${i.nom}** — ${pieces(serveur.id, i.prix)}${i.stock !== null ? ` · stock ${i.stock}` : ''}\n-# ${LIBELLE_TYPE[i.type]}${i.description ? ` · ${tronquer(i.description, 80)}` : ''}`).join('\n')
          : '*La boutique est vide pour le moment.*',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const composants = articles.length
    ? [
        rangee(
          new StringSelectMenuBuilder()
            .setCustomId(`shop:pick:${utilisateurId}`)
            .setPlaceholder('Acheter un article')
            .addOptions(articles.slice(0, 25).map((i) => ({ label: tronquer(i.nom, 100), value: String(i.id), emoji: i.emoji, description: tronquer(`${i.prix} · ${LIBELLE_TYPE[i.type]}`, 100) }))),
        ),
      ]
    : [];
  return { embeds: [embed], components: composants };
}

async function livrer(membre: GuildMember, article: ArticleBoutique): Promise<string> {
  const serveur = membre.guild;
  if (article.type === 'role' && article.valeur) {
    const role = serveur.roles.cache.get(article.valeur);
    if (!role || !botPeutGererRole(serveur, role)) throw new ErreurUtilisateur('Ce rôle ne peut plus être donné. Préviens le staff.');
    if (membre.roles.cache.has(role.id)) throw new ErreurUtilisateur('Tu as déjà ce rôle.');
    await membre.roles.add(role, `Achat boutique : ${article.nom}`);
    return `Le rôle <@&${role.id}> t’a été donné.`;
  }
  if (article.type === 'badge' && article.valeur) {
    if (!donnerBadge(serveur.id, membre.id, article.valeur)) throw new ErreurUtilisateur('Tu as déjà ce badge.');
    return `Le badge ${lireBadge(serveur.id, article.valeur)?.emoji ?? ''} **${lireBadge(serveur.id, article.valeur)?.nom ?? article.valeur}** est sur ton profil.`;
  }
  const staff = resoudreSalonTexte(serveur, lireConfig(serveur.id).general.salonStaffId);
  await staff?.send({ embeds: [info(serveur, `🛒 <@${membre.id}> a acheté **${article.nom}** (${article.prix}). À livrer !`)], allowedMentions: { parse: [] } }).catch(() => undefined);
  return staff ? 'Le staff a été prévenu pour te le remettre.' : 'Ouvre un ticket pour le récupérer.';
}

// ─── Commandes ─────────────────────────────────────────────────────────────

const solde: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Ton porte-monnaie')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addBooleanOption((o) => o.setName('classement').setDescription('Voir le classement des plus riches')),
  async executer(interaction) {
    if (interaction.options.getBoolean('classement')) return paginer(interaction, pagesRiches(interaction.guild));
    return repondre(interaction, { embeds: [embedSolde(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const quotidien: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder().setName('daily').setDescription('Ta récompense quotidienne'),
  async executer(interaction) {
    await repondre(interaction, { embeds: [ok(interaction.guild, recupererQuotidien(interaction.member), { titre: 'Récompense du jour' })] });
  },
};

const donner: CommandeSlash = {
  categorie: 'economy',
  delaiSecondes: 5,
  donnees: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Donner des pièces')
    .addUserOption((o) => o.setName('membre').setDescription('À qui').setRequired(true))
    .addIntegerOption((o) => o.setName('montant').setDescription('Combien').setRequired(true).setMinValue(1).setMaxValue(1_000_000)),
  async executer(interaction) {
    const cible = interaction.options.getUser('membre', true);
    const montant = interaction.options.getInteger('montant', true);
    if (cible.bot || cible.id === interaction.user.id) throw new ErreurUtilisateur('Choisis un autre membre (pas toi, pas un bot).');
    try {
      transferer(interaction.guildId, interaction.user.id, cible.id, montant);
    } catch {
      throw new ErreurUtilisateur('Solde insuffisant.');
    }
    await repondre(interaction, { embeds: [ok(interaction.guild, `<@${interaction.user.id}> donne ${pieces(interaction.guildId, montant)} à <@${cible.id}>.`)], allowedMentions: { users: [cible.id] } });
  },
};

const boutique: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('La boutique')
    .addSubcommand((s) => s.setName('voir').setDescription('Ouvrir la boutique'))
    .addSubcommand((s) => s.setName('inventaire').setDescription('Tes achats'))
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un article')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Rôle spécial').setRequired(true).setMaxLength(60))
        .addIntegerOption((o) => o.setName('prix').setDescription('Prix').setRequired(true).setMinValue(1).setMaxValue(10_000_000))
        .addStringOption((o) => o.setName('type').setDescription('Ce que ça donne').setRequired(true).addChoices({ name: 'Un rôle', value: 'role' }, { name: 'Un badge', value: 'badge' }, { name: 'Un article à livrer par le staff', value: 'item' }))
        .addRoleOption((o) => o.setName('role').setDescription('Le rôle (type rôle)'))
        .addStringOption((o) => o.setName('badge').setDescription('Identifiant du badge (type badge, voir /badge liste)').setMaxLength(32))
        .addStringOption((o) => o.setName('emoji').setDescription('Émoji').setMaxLength(64))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(150))
        .addIntegerOption((o) => o.setName('stock').setDescription('Stock (vide = illimité)').setMinValue(1).setMaxValue(100000)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un article')
        .addIntegerOption((o) => o.setName('article').setDescription('L’article').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('crediter')
        .setDescription('Donner ou retirer des pièces (admin)')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('montant').setDescription('Négatif pour retirer').setRequired(true).setMinValue(-10_000_000).setMaxValue(10_000_000)),
    ),
  niveauxSousCommandes: { ajouter: Niveau.ADMIN, retirer: Niveau.ADMIN, crediter: Niveau.ADMIN },
  async autocompletion(interaction) {
    await interaction.respond(articlesBoutique(interaction.guildId).slice(0, 25).map((i) => ({ name: tronquer(`${i.nom} — ${i.prix}`, 100), value: i.id })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'voir') return repondre(interaction, { ...affichageBoutique(serveur, interaction.user.id), ephemeral: true });
    if (sousCommande === 'inventaire') {
      const articles = inventaire(serveur.id, interaction.user.id);
      return repondre(interaction, { embeds: [info(serveur, articles.map((i) => `• **${i.article_nom}** — ${i.prix} · ${marqueTemps(i.achete_le, 'd')}`).join('\n') || 'Aucun achat.', { titre: 'Ton inventaire', sujet: '🎒' })], ephemeral: true });
    }
    if (sousCommande === 'retirer') {
      executer('DELETE FROM articles_boutique WHERE serveur_id = ? AND id = ?', serveur.id, interaction.options.getInteger('article', true));
      return repondre(interaction, { embeds: [ok(serveur, 'Article retiré de la boutique.')], ephemeral: true });
    }
    if (sousCommande === 'crediter') {
      const utilisateur = interaction.options.getUser('membre', true);
      const montant = interaction.options.getInteger('montant', true);
      let soldeApres: number;
      try {
        soldeApres = ajouterPieces(serveur.id, utilisateur.id, montant, 'admin');
      } catch {
        throw new ErreurUtilisateur('Le solde ne peut pas devenir négatif.');
      }
      void journal(serveur, 'community', { titre: 'Pièces modifiées', ton: 'info', lignes: [`**Membre** : <@${utilisateur.id}>`, `**Montant** : ${montant}`, `**Nouveau solde** : ${soldeApres}`], par: interaction.user });
      return repondre(interaction, { embeds: [ok(serveur, `<@${utilisateur.id}> : ${montant >= 0 ? '+' : ''}${formaterNombre(montant)} → ${pieces(serveur.id, soldeApres)}.`)], ephemeral: true });
    }
    const type = interaction.options.getString('type', true) as ArticleBoutique['type'];
    let valeur: string | null = null;
    if (type === 'role') {
      const role = interaction.options.getRole('role');
      if (!role) throw new ErreurUtilisateur('Choisis le rôle à vendre (option `role`).');
      if (!botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle : place mon rôle au-dessus.');
      valeur = role.id;
    } else if (type === 'badge') {
      valeur = interaction.options.getString('badge');
      if (!valeur || !lireBadge(serveur.id, valeur)) throw new ErreurUtilisateur('Badge introuvable (voir `/badge liste`).');
    }
    if (articlesBoutique(serveur.id).length >= 25) throw new ErreurUtilisateur('25 articles maximum.');
    executer(
      'INSERT INTO articles_boutique (serveur_id, nom, description, emoji, prix, type, valeur, stock, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serveur.id,
      interaction.options.getString('nom', true),
      interaction.options.getString('description') ?? '',
      interaction.options.getString('emoji') ?? (type === 'role' ? '🎨' : type === 'badge' ? '💎' : '🎟️'),
      interaction.options.getInteger('prix', true),
      type,
      valeur,
      interaction.options.getInteger('stock'),
      Date.now(),
    );
    return repondre(interaction, { embeds: [ok(serveur, 'Article ajouté à la boutique.')], ephemeral: true });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'bal',
    alias: ['balance', 'coins'],
    domaine: 'general',
    categorie: 'economy',
    description: 'Ton porte-monnaie',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const utilisateur = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [embedSolde(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'daily',
    domaine: 'general',
    categorie: 'economy',
    description: 'Ta récompense quotidienne',
    async executer(message) {
      if (!message.member) return;
      await message.reply({ embeds: [ok(message.guild, recupererQuotidien(message.member), { titre: 'Récompense du jour' })], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'economy',
  section: 'community',
  titre: 'Économie',
  emoji: '💰',
  moduleId: 'economy',
  ordre: 9,
  description: 'Une monnaie **purement virtuelle** gagnée en participant (messages, /daily, quêtes), à dépenser dans la boutique (`/shop ajouter`).',
  champs: [
    { kind: 'text', cle: 'name', libelle: 'Nom de la monnaie', maxLength: 30, required: true, get: (c) => c.economie.nomMonnaie, set: (c, v) => void (c.economie.nomMonnaie = v) },
    { kind: 'text', cle: 'emoji', libelle: 'Émoji de la monnaie', maxLength: 64, required: true, get: (c) => c.economie.emojiMonnaie, set: (c, v) => void (c.economie.emojiMonnaie = v) },
    { kind: 'number', cle: 'daily', libelle: 'Récompense /daily', min: 0, max: 1_000_000, get: (c) => c.economie.montantQuotidien, set: (c, v) => void (c.economie.montantQuotidien = v) },
    { kind: 'number', cle: 'bonus', libelle: 'Bonus par jour de série', min: 0, max: 100_000, get: (c) => c.economie.bonusSerie, set: (c, v) => void (c.economie.bonusSerie = v) },
    { kind: 'number', cle: 'message', libelle: 'Pièces par message (cooldown 60 s)', min: 0, max: 1000, get: (c) => c.economie.parMessage, set: (c, v) => void (c.economie.parMessage = v) },
  ],
};

export const moduleEconomie: ModuleBot = {
  id: 'economy',
  nom: 'Économie',
  emoji: '💰',
  description: 'Monnaie virtuelle, /daily, dons et boutique',
  desactivable: true,
  actifParDefaut: false,
  commandes: [solde, quotidien, donner, boutique],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'shop',
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [, proprietaireId]) {
        if (!interaction.isStringSelectMenu()) return;
        if (proprietaireId !== interaction.user.id) return interaction.reply({ ...affichageBoutique(interaction.guild, interaction.user.id), flags: MessageFlags.Ephemeral });
        const article = articleBoutique(interaction.guildId, Number(interaction.values[0]));
        if (!article) throw new ErreurUtilisateur('Cet article n’existe plus.');
        await interaction.update({
          ...affichageBoutique(interaction.guild, interaction.user.id, `Acheter ${article.emoji} **${article.nom}** pour ${pieces(interaction.guildId, article.prix)} ?`),
          components: [rangee(bouton(`shop:buy:${interaction.user.id}:${article.id}`, 'Acheter', ButtonStyle.Success, '🛒'), bouton(`shop:back:${interaction.user.id}`, 'Retour', ButtonStyle.Secondary, '⬅️'))],
        });
      },
      async bouton(interaction: ButtonInteraction<'cached'>, [action, proprietaireId, articleId]) {
        if (proprietaireId !== interaction.user.id) throw new ErreurUtilisateur('Cette boutique appartient à quelqu’un d’autre : lance `/shop voir`.');
        if (action === 'back') return interaction.update(affichageBoutique(interaction.guild, interaction.user.id));
        const article = articleBoutique(interaction.guildId, Number(articleId));
        if (!article) throw new ErreurUtilisateur('Cet article n’existe plus.');
        let soldeApres: number;
        try {
          soldeApres = acheter(interaction.guildId, interaction.user.id, article);
        } catch (echec) {
          throw new ErreurUtilisateur((echec as Error).message === 'rupture de stock' ? 'Rupture de stock.' : 'Solde insuffisant.');
        }
        try {
          const texte = await livrer(interaction.member, article);
          await interaction.update(affichageBoutique(interaction.guild, interaction.user.id, `✅ Acheté : ${article.emoji} **${article.nom}**. ${texte}\n-# Nouveau solde : ${formaterNombre(soldeApres)}`));
        } catch (echec) {
          // Livraison impossible : remboursement.
          ajouterPieces(interaction.guildId, interaction.user.id, article.prix, 'refund');
          executer('DELETE FROM inventaire WHERE id = (SELECT MAX(id) FROM inventaire WHERE serveur_id = ? AND utilisateur_id = ? AND article_id = ?)', interaction.guildId, interaction.user.id, article.id);
          if (article.stock !== null) executer('UPDATE articles_boutique SET stock = stock + 1 WHERE id = ?', article.id);
          await interaction.update(affichageBoutique(interaction.guild, interaction.user.id, `⚠️ ${(echec as Error).message} Tu as été remboursé.`));
        }
      },
    },
  ],
  evenements: [
    sur('messageCreate', (message: Message) => {
      if (!message.inGuild() || message.author.bot) return;
      const economie = lireConfig(message.guildId).economie;
      if (economie.parMessage <= 0) return;
      const cle = `${message.guildId}:${message.author.id}`;
      const maintenant = Date.now();
      if ((delaisMessages.get(cle) ?? 0) > maintenant) return;
      delaisMessages.set(cle, maintenant + economie.delaiMessageSecondes * 1000);
      if (delaisMessages.size > 20_000) for (const [k, v] of delaisMessages) if (v < maintenant) delaisMessages.delete(k);
      ajouterPieces(message.guildId, message.author.id, economie.parMessage, 'message');
    }, 180),
  ],
};
