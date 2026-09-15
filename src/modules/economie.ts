import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  MessageFlags,
  MessageType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type User,
} from 'discord.js';
import { botPeutGererRole, emojiPour } from '../coeur/acces';
import { bouton, couleurPour, embedEnseigne, info, lignesEnPages, ok, paginer, rangee, remplirModele, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout, transaction } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import {
  barreProgression,
  cleJour,
  cleJourPrecedent,
  ErreurUtilisateur,
  formaterNombre,
  marqueTemps,
  medaille,
  tronquer, Niveau } from '../coeur/outils';
import { type DefinitionQuete, lireConfig, modifierConfig, moduleActif } from '../coeur/reglages';
import { ajouterXp, donnerBadge, emettreActivite, lireBadge, surActivite, surTempsVocal, type TypeActivite } from './niveaux';

export interface Portefeuille {
  solde: number;
  total_gagne: number;
  dernier_quotidien: number;
  serie_quotidien: number;
}

export function portefeuille(serveurId: string, utilisateurId: string): Portefeuille {
  return (
    lire<Portefeuille>('SELECT solde, total_gagne, dernier_quotidien, serie_quotidien FROM economie WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId) ?? {
      solde: 0,
      total_gagne: 0,
      dernier_quotidien: 0,
      serie_quotidien: 0,
    }
  );
}

/** Ajoute (ou retire si négatif) des pièces. Refuse de passer sous zéro. Retourne le nouveau solde. */
export function ajouterPieces(serveurId: string, utilisateurId: string, montant: number, raison = 'gain'): number {
  const valeur = Math.trunc(montant);
  return transaction(() => {
    const actuel = portefeuille(serveurId, utilisateurId);
    const suivant = actuel.solde + valeur;
    if (suivant < 0) throw new Error('solde insuffisant');
    executer(
      `INSERT INTO economie (serveur_id, utilisateur_id, solde, total_gagne) VALUES (?, ?, ?, ?)
       ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET solde = excluded.solde, total_gagne = economie.total_gagne + ?`,
      serveurId,
      utilisateurId,
      suivant,
      Math.max(0, valeur),
      Math.max(0, valeur),
    );
    if (Math.abs(valeur) >= 1000) historiser(serveurId, 'community', `coins-${raison}`, utilisateurId, null, { amount: valeur });
    return suivant;
  });
}

export function transferer(serveurId: string, depuis: string, vers: string, montant: number): { from: number; to: number } {
  if (!Number.isInteger(montant) || montant <= 0) throw new Error('montant invalide');
  return transaction(() => ({ from: ajouterPieces(serveurId, depuis, -montant, 'give'), to: ajouterPieces(serveurId, vers, montant, 'give') }));
}

export function noterQuotidien(serveurId: string, utilisateurId: string, instant: number, serie: number): void {
  executer(
    `INSERT INTO economie (serveur_id, utilisateur_id, dernier_quotidien, serie_quotidien) VALUES (?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET dernier_quotidien = excluded.dernier_quotidien, serie_quotidien = excluded.serie_quotidien`,
    serveurId,
    utilisateurId,
    instant,
    serie,
  );
}

export function plusRiches(serveurId: string, limite = 100): { utilisateur_id: string; solde: number }[] {
  return lireTout('SELECT utilisateur_id, solde FROM economie WHERE serveur_id = ? AND solde > 0 ORDER BY solde DESC LIMIT ?', serveurId, limite);
}

export interface ArticleBoutique {
  id: number;
  serveur_id: string;
  nom: string;
  description: string;
  emoji: string;
  prix: number;
  type: 'role' | 'badge' | 'item';
  valeur: string | null;
  stock: number | null;
}

export function articlesBoutique(serveurId: string): ArticleBoutique[] {
  return lireTout<ArticleBoutique>('SELECT * FROM articles_boutique WHERE serveur_id = ? ORDER BY prix', serveurId);
}

export function articleBoutique(serveurId: string, id: number): ArticleBoutique | undefined {
  return lire<ArticleBoutique>('SELECT * FROM articles_boutique WHERE serveur_id = ? AND id = ?', serveurId, id);
}

export function inventaire(serveurId: string, utilisateurId: string): { article_nom: string; prix: number; achete_le: number }[] {
  return lireTout('SELECT article_nom, prix, achete_le FROM inventaire WHERE serveur_id = ? AND utilisateur_id = ? ORDER BY achete_le DESC LIMIT 50', serveurId, utilisateurId);
}

/** Achat atomique : stock, solde et inventaire sont mis à jour ensemble. */
export function acheter(serveurId: string, utilisateurId: string, article: ArticleBoutique): number {
  return transaction(() => {
    const frais = articleBoutique(serveurId, article.id);
    if (!frais) throw new Error('article introuvable');
    if (frais.stock !== null && frais.stock <= 0) throw new Error('rupture de stock');
    const solde = ajouterPieces(serveurId, utilisateurId, -frais.prix, 'shop');
    if (frais.stock !== null) executer('UPDATE articles_boutique SET stock = stock - 1 WHERE id = ?', frais.id);
    executer('INSERT INTO inventaire (serveur_id, utilisateur_id, article_id, article_nom, prix, achete_le) VALUES (?, ?, ?, ?, ?, ?)', serveurId, utilisateurId, frais.id, frais.nom, frais.prix, Date.now());
    return solde;
  });
}

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
    { genre: 'text', cle: 'name', libelle: 'Nom de la monnaie', longueurMax: 30, obligatoire: true, lire: (c) => c.economie.nomMonnaie, ecrire: (c, v) => void (c.economie.nomMonnaie = v) },
    { genre: 'text', cle: 'emoji', libelle: 'Émoji de la monnaie', longueurMax: 64, obligatoire: true, lire: (c) => c.economie.emojiMonnaie, ecrire: (c, v) => void (c.economie.emojiMonnaie = v) },
    { genre: 'number', cle: 'daily', libelle: 'Récompense /daily', min: 0, max: 1_000_000, lire: (c) => c.economie.montantQuotidien, ecrire: (c, v) => void (c.economie.montantQuotidien = v) },
    { genre: 'number', cle: 'bonus', libelle: 'Bonus par jour de série', min: 0, max: 100_000, lire: (c) => c.economie.bonusSerie, ecrire: (c, v) => void (c.economie.bonusSerie = v) },
    { genre: 'number', cle: 'message', libelle: 'Pièces par message (cooldown 60 s)', min: 0, max: 1000, lire: (c) => c.economie.parMessage, ecrire: (c, v) => void (c.economie.parMessage = v) },
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

const aujourdhui = (serveurId: string) => cleJour(Date.now(), lireConfig(serveurId).general.fuseau);

async function prevenir(client: Client | null, serveurId: string, utilisateurId: string, texte: string): Promise<void> {
  if (!client || !lireConfig(serveurId).quetes.annonce) return;
  const serveur = client.guilds.cache.get(serveurId);
  const utilisateur = await client.users.fetch(utilisateurId).catch(() => null);
  if (!serveur || !utilisateur) return;
  await utilisateur.send({ embeds: [new EmbedBuilder().setColor(couleurPour(serveur, 'success')).setAuthor({ name: serveur.name, iconURL: serveur.iconURL() ?? undefined }).setDescription(texte)] }).catch(() => undefined);
}

function recompense(serveurId: string, utilisateurId: string, xp: number, pieces: number): string {
  const parties: string[] = [];
  if (xp > 0 && moduleActif(serveurId, 'xp')) {
    ajouterXp(serveurId, utilisateurId, xp);
    parties.push(`+${formaterNombre(xp)} XP`);
  }
  if (pieces > 0 && moduleActif(serveurId, 'economy')) {
    ajouterPieces(serveurId, utilisateurId, pieces, 'quest');
    const economie = lireConfig(serveurId).economie;
    parties.push(`+${formaterNombre(pieces)} ${economie.emojiMonnaie} ${economie.nomMonnaie}`);
  }
  return parties.join(' · ') || 'la gloire éternelle';
}

/** Avance les quêtes du jour d'un type donné et distribue les récompenses une seule fois. */
function progression(client: Client | null, serveurId: string, utilisateurId: string, type: TypeActivite, montant: number): void {
  if (!moduleActif(serveurId, 'quests') || montant <= 0) return;
  const jour = aujourdhui(serveurId);
  for (const quete of lireConfig(serveurId).quetes.list.filter((q) => q.type === type)) {
    const rangee = lire<{ progression: number; terminee: number }>('SELECT progression, terminee FROM quetes WHERE serveur_id = ? AND utilisateur_id = ? AND jour = ? AND quete_id = ?', serveurId, utilisateurId, jour, quete.id);
    if (rangee?.terminee) continue;
    const valeur = Math.min(quete.cible, (rangee?.progression ?? 0) + montant);
    const fait = valeur >= quete.cible;
    executer(
      `INSERT INTO quetes (serveur_id, utilisateur_id, jour, quete_id, progression, terminee) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(serveur_id, utilisateur_id, jour, quete_id) DO UPDATE SET progression = excluded.progression, terminee = excluded.terminee`,
      serveurId,
      utilisateurId,
      jour,
      quete.id,
      valeur,
      fait ? 1 : 0,
    );
    if (fait) {
      const gains = recompense(serveurId, utilisateurId, quete.recompenseXp, quete.recompensePieces);
      void prevenir(client, serveurId, utilisateurId, `🎯 **Quête du jour terminée !**\n${quete.libelle}\n\nRécompense : **${gains}**`);
    }
  }
}

/** Série quotidienne : +1 par jour d'activité consécutif, remise à 1 après un jour manqué. */
function avancerSerie(client: Client | null, serveurId: string, utilisateurId: string): void {
  if (!moduleActif(serveurId, 'quests')) return;
  const jour = aujourdhui(serveurId);
  const rangee = lire<{ actuelle: number; record: number; dernier_jour: string | null }>('SELECT actuelle, record, dernier_jour FROM series WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId);
  if (rangee?.dernier_jour === jour) return;
  const actuel = rangee?.dernier_jour === cleJourPrecedent(jour) ? rangee.actuelle + 1 : 1;
  const record = Math.max(actuel, rangee?.record ?? 0);
  executer(
    `INSERT INTO series (serveur_id, utilisateur_id, actuelle, record, dernier_jour) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET actuelle = excluded.actuelle, record = excluded.record, dernier_jour = excluded.dernier_jour`,
    serveurId,
    utilisateurId,
    actuel,
    record,
    jour,
  );
  const palier = lireConfig(serveurId).quetes.paliersSerie.find((m) => m.days === actuel);
  if (palier) {
    const gains = recompense(serveurId, utilisateurId, palier.xp, palier.pieces);
    void prevenir(client, serveurId, utilisateurId, `🔥 **Série de ${actuel} jours !**\nMerci pour ta fidélité. Récompense : **${gains}**`);
  }
}

surActivite((evenement, client) => progression(client, evenement.serveurId, evenement.utilisateurId, evenement.type, evenement.montant));
surTempsVocal((credit, client) => {
  if (credit.inactif) return;
  progression(client, credit.serveurId, credit.utilisateurId, 'voice_minutes', Math.floor(credit.secondes / 60));
});

function embedQuetes(serveur: Guild, utilisateur: User) {
  const jour = aujourdhui(serveur.id);
  const rangees = lireTout<{ quete_id: string; progression: number; terminee: number }>('SELECT quete_id, progression, terminee FROM quetes WHERE serveur_id = ? AND utilisateur_id = ? AND jour = ?', serveur.id, utilisateur.id, jour);
  const serie = lire<{ actuelle: number; record: number }>('SELECT actuelle, record FROM series WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, utilisateur.id);
  const economie = lireConfig(serveur.id).economie;
  const lignes = lireConfig(serveur.id).quetes.list.map((q: DefinitionQuete) => {
    const r = rangees.find((x) => x.quete_id === q.id);
    const valeur = r?.progression ?? 0;
    const recompenses = [q.recompenseXp ? `+${q.recompenseXp} XP` : null, q.recompensePieces ? `+${q.recompensePieces} ${economie.emojiMonnaie}` : null].filter(Boolean).join(' · ');
    return `${r?.terminee ? '✅' : '🎯'} **${q.libelle}**\n${barreProgression(valeur / q.cible, 12)} ${valeur}/${q.cible}${recompenses ? ` · ${recompenses}` : ''}`;
  });
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle('🎯 QUÊTES DU JOUR')
    .setDescription(lignes.join('\n\n') || '*Aucune quête configurée.*')
    .addFields({ name: '🔥 Série actuelle', value: `${serie?.actuelle ?? 0} jour(s) · record ${serie?.record ?? 0}`, inline: false })
    .setFooter({ text: 'Les quêtes se renouvellent chaque jour à minuit.' });
}

const quete: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('quest')
    .setDescription('Tes quêtes du jour et ta série')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)')),
  async executer(interaction) {
    await repondre(interaction, { embeds: [embedQuetes(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const commandesPrefixeQuetes: CommandePrefixe[] = [
  {
    nom: 'quetes',
    alias: ['quests', 'quest', 'streak'],
    domaine: 'general',
    categorie: 'economy',
    description: 'Tes quêtes et ta série',
    async executer(message) {
      await message.reply({ embeds: [embedQuetes(message.guild, message.author)], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglageQuetes: PageReglage = {
  id: 'quests',
  section: 'community',
  titre: 'Quêtes & séries',
  emoji: '🎯',
  moduleId: 'quests',
  ordre: 10,
  description:
    'Quêtes quotidiennes (messages, vocal, giveaways, /daily) et série de jours actifs.\n-# Format des quêtes : `type:objectif:xp:pièces:texte` séparées par des retours à la ligne.\n-# Paliers de série : `jours:pièces:xp` séparés par des virgules.',
  champs: [
    { genre: 'toggle', cle: 'announce', libelle: 'Prévenir en MP', lire: (c) => c.quetes.annonce, ecrire: (c, v) => void (c.quetes.annonce = v) },
    {
      genre: 'text',
      cle: 'list',
      libelle: 'Quêtes du jour',
      long: true,
      longueurMax: 1500,
      lire: (c) => c.quetes.list.map((q) => `${q.type}:${q.cible}:${q.recompenseXp}:${q.recompensePieces}:${q.libelle}`).join('\n'),
      ecrire: (c, v) => {
        const lu = lireQuetes(v);
        if (lu) c.quetes.list = lu;
      },
      validate: (v) => (lireQuetes(v) ? null : 'Format : `messages:20:100:50:Envoyer 20 messages` (types : messages, voice_minutes, giveaways, daily).'),
    },
    {
      genre: 'text',
      cle: 'milestones',
      libelle: 'Paliers de série',
      longueurMax: 300,
      lire: (c) => c.quetes.paliersSerie.map((m) => `${m.days}:${m.pieces}:${m.xp}`).join(', '),
      ecrire: (c, v) => {
        const lu = lirePaliers(v);
        if (lu) c.quetes.paliersSerie = lu;
      },
      validate: (v) => (lirePaliers(v) ? null : 'Format : `7:200:200, 30:1000:1000`.'),
    },
  ],
};

export function lireQuetes(saisie: string): DefinitionQuete[] | null {
  const sortie: DefinitionQuete[] = [];
  for (const ligne of saisie.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(messages|voice_minutes|giveaways|daily)\s*:\s*(\d{1,6})\s*:\s*(\d{1,7})\s*:\s*(\d{1,7})\s*:\s*(.{2,100})$/.exec(ligne);
    if (!m) return null;
    sortie.push({ id: `${m[1]}${m[2]}-${sortie.length}`, type: m[1] as DefinitionQuete['type'], cible: Math.max(1, Number(m[2])), recompenseXp: Number(m[3]), recompensePieces: Number(m[4]), libelle: m[5]!.trim() });
  }
  return sortie.slice(0, 10);
}

export function lirePaliers(saisie: string): { days: number; pieces: number; xp: number }[] | null {
  if (!saisie.trim()) return [];
  const sortie: { days: number; pieces: number; xp: number }[] = [];
  for (const partie of saisie.split(',')) {
    const m = /^\s*(\d{1,4})\s*:\s*(\d{1,7})\s*:\s*(\d{1,7})\s*$/.exec(partie);
    if (!m) return null;
    sortie.push({ days: Number(m[1]), pieces: Number(m[2]), xp: Number(m[3]) });
  }
  return sortie.sort((a, b) => a.days - b.days).slice(0, 10);
}

export const moduleQuetes: ModuleBot = {
  id: 'quests',
  nom: 'Quêtes & séries',
  emoji: '🎯',
  description: 'Quêtes quotidiennes et récompenses de série',
  desactivable: true,
  actifParDefaut: false,
  commandes: [quete],
  commandesPrefixe: commandesPrefixeQuetes,
  pagesReglage: [pageReglageQuetes],
  evenements: [
    sur('messageCreate', (message) => {
      if (!message.inGuild() || message.author.bot) return;
      avancerSerie(message.client, message.guildId, message.author.id);
      progression(message.client, message.guildId, message.author.id, 'messages', 1);
    }, 190),
  ],
  taches: [
    {
      nom: 'quests-cleanup',
      intervalleMs: 12 * 3_600_000,
      async executer() {
        executer('DELETE FROM quetes WHERE jour < ?', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
      },
    },
  ],
};

const TYPES_BOOST = new Set([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);
const boostsRecents = new Map<string, number>();

async function appliquerRecompenses(membre: GuildMember, nombre: number): Promise<string[]> {
  const serveur = membre.guild;
  const donnes: string[] = [];
  for (const r of lireConfig(serveur.id).boosts.recompenses.filter((x) => x.count === nombre)) {
    const role = r.roleId ? serveur.roles.cache.get(r.roleId) : null;
    if (role && botPeutGererRole(serveur, role)) {
      await membre.roles.add(role, `Récompense de ${nombre} boost(s)`).catch(() => undefined);
      donnes.push(`<@&${role.id}>`);
    }
    if (r.badgeId && donnerBadge(serveur.id, membre.id, r.badgeId)) donnes.push(`${lireBadge(serveur.id, r.badgeId)?.emoji ?? '🏅'} badge`);
    if (r.pieces > 0 && moduleActif(serveur.id, 'economy')) {
      ajouterPieces(serveur.id, membre.id, r.pieces, 'boost');
      donnes.push(`${r.pieces} ${lireConfig(serveur.id).economie.emojiMonnaie}`);
    }
  }
  return donnes;
}

/** Un boost : compteur, rôle booster, badge VIP, récompenses et annonce. */
async function enregistrerBoost(membre: GuildMember): Promise<void> {
  const serveur = membre.guild;
  const cle = `${serveur.id}:${membre.id}`;
  if ((boostsRecents.get(cle) ?? 0) > Date.now()) return;
  boostsRecents.set(cle, Date.now() + 30_000);
  const maintenant = Date.now();
  executer(
    `INSERT INTO boosts (serveur_id, utilisateur_id, nombre, premier_boost_le, dernier_boost_le) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET nombre = nombre + 1, dernier_boost_le = excluded.dernier_boost_le`,
    serveur.id,
    membre.id,
    maintenant,
    maintenant,
  );
  const nombre = lire<{ nombre: number }>('SELECT nombre FROM boosts WHERE serveur_id = ? AND utilisateur_id = ?', serveur.id, membre.id)?.nombre ?? 1;
  const reglages = lireConfig(serveur.id).boosts;
  const roleBooster = reglages.roleBoosterId ? serveur.roles.cache.get(reglages.roleBoosterId) : null;
  if (roleBooster && botPeutGererRole(serveur, roleBooster)) await membre.roles.add(roleBooster, 'Booster').catch(() => undefined);
  donnerBadge(serveur.id, membre.id, 'vip');
  const recompenses = await appliquerRecompenses(membre, nombre);
  void journal(serveur, 'boost', { titre: 'Nouveau boost', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Boosts de ce membre** : ${nombre}`, `**Boosts du serveur** : ${serveur.premiumSubscriptionCount ?? 0}`, recompenses.length ? `**Récompenses** : ${recompenses.join(', ')}` : null] });
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
  if (!salon) return;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(`${emojiPour(serveur.id, 'boost')} NOUVEAU BOOST !`)
    .setDescription(tronquer(remplirModele(reglages.message, { membre, serveur }), 4000) + (recompenses.length ? `\n\n🎁 Récompenses : ${recompenses.join(', ')}` : ''))
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }));
  await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
}

const boost: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('boost')
    .setDescription('Les boosts du serveur')
    .addSubcommand((s) => s.setName('top').setDescription('Les boosters du serveur'))
    .addSubcommand((s) =>
      s
        .setName('recompense')
        .setDescription('Ajouter une récompense de boosts')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Au bout de combien de boosts').setRequired(true).setMinValue(1).setMaxValue(100))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle donné'))
        .addStringOption((o) => o.setName('badge').setDescription('Badge donné (identifiant)').setMaxLength(32))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces données').setMinValue(0).setMaxValue(10_000_000)),
    )
    .addSubcommand((s) => s.setName('recompenses').setDescription('Les récompenses configurées'))
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer les récompenses d’un palier')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Le palier').setRequired(true).setMinValue(1).setMaxValue(100)),
    ),
  niveauxSousCommandes: { recompense: Niveau.ADMIN, retirer: Niveau.ADMIN, recompenses: Niveau.STAFF },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'top') {
      const rangees = lireTout<{ utilisateur_id: string; nombre: number }>('SELECT utilisateur_id, nombre FROM boosts WHERE serveur_id = ? ORDER BY nombre DESC, premier_boost_le LIMIT 25', serveur.id);
      return repondre(interaction, {
        embeds: [embedEnseigne(serveur).setTitle('🚀 Boosters').setDescription(rangees.map((r, i) => `${medaille(i + 1)} <@${r.utilisateur_id}> — **${r.nombre}** boost(s)`).join('\n') || '*Aucun boost enregistré.*').setFooter({ text: `${serveur.premiumSubscriptionCount ?? 0} boosts · niveau ${serveur.premiumTier}` })],
      });
    }
    if (sousCommande === 'recompenses') {
      const recompenses = lireConfig(serveur.id).boosts.recompenses;
      return repondre(interaction, {
        embeds: [info(serveur, recompenses.map((r) => `**${r.count} boost(s)** → ${[r.roleId ? `<@&${r.roleId}>` : null, r.badgeId ? `badge \`${r.badgeId}\`` : null, r.pieces ? `${r.pieces} pièces` : null].filter(Boolean).join(', ')}`).join('\n') || 'Aucune récompense.', { titre: 'Récompenses de boost', sujet: '🚀' })],
        ephemeral: true,
      });
    }
    const nombre = interaction.options.getInteger('boosts', true);
    if (sousCommande === 'retirer') {
      modifierConfig(serveur.id, (c) => void (c.boosts.recompenses = c.boosts.recompenses.filter((r) => r.count !== nombre)));
      return repondre(interaction, { embeds: [ok(serveur, `Récompenses du palier ${nombre} retirées.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    const badgeId = interaction.options.getString('badge');
    const pieces = interaction.options.getInteger('pieces') ?? 0;
    if (!role && !badgeId && !pieces) throw new ErreurUtilisateur('Choisis au moins un rôle, un badge ou des pièces.');
    if (role && !botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle.');
    if (badgeId && !lireBadge(serveur.id, badgeId)) throw new ErreurUtilisateur('Badge introuvable (voir `/badge liste`).');
    modifierConfig(serveur.id, (c) => c.boosts.recompenses.push({ count: nombre, roleId: role?.id ?? null, badgeId, pieces }));
    return repondre(interaction, { embeds: [ok(serveur, `Récompense ajoutée au palier **${nombre} boost(s)**.`)], ephemeral: true });
  },
};

const pageReglageBoosts: PageReglage = {
  id: 'boosts',
  section: 'community',
  titre: 'Boosts',
  emoji: '🚀',
  moduleId: 'boosts',
  ordre: 13,
  description: 'Remercier les boosters, leur donner un rôle et des récompenses par palier (`/boost recompense`).\n-# Variables : `{mention}` `{user}` `{boosts}`',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des remerciements', lire: (c) => c.boosts.channelId, ecrire: (c, v) => void (c.boosts.channelId = v) },
    { genre: 'role', cle: 'role', libelle: 'Rôle booster', attribuable: true, lire: (c) => c.boosts.roleBoosterId, ecrire: (c, v) => void (c.boosts.roleBoosterId = v) },
    { genre: 'text', cle: 'message', libelle: 'Message', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.boosts.message, ecrire: (c, v) => void (c.boosts.message = v) },
  ],
};

export const moduleBoosts: ModuleBot = {
  id: 'boosts',
  nom: 'Boosts',
  emoji: '🚀',
  description: 'Remerciements, rôle booster et récompenses de boost',
  desactivable: true,
  actifParDefaut: true,
  commandes: [boost],
  pagesReglage: [pageReglageBoosts],
  evenements: [
    sur('messageCreate', async (message: Message) => {
      if (!message.inGuild() || !TYPES_BOOST.has(message.type) || !message.member) return;
      await enregistrerBoost(message.member);
    }, 20),
    sur('guildMemberUpdate', async (avant, apres) => {
      const reglages = lireConfig(apres.guild.id).boosts;
      if (!avant.premiumSince && apres.premiumSince) {
        // Laisse le message système arriver en premier (il compte chaque boost) avant d'utiliser ce repli.
        setTimeout(() => void enregistrerBoost(apres), 5_000).unref();
      } else if (avant.premiumSince && !apres.premiumSince) {
        const role = reglages.roleBoosterId ? apres.guild.roles.cache.get(reglages.roleBoosterId) : null;
        if (role && botPeutGererRole(apres.guild, role)) await apres.roles.remove(role, 'Ne booste plus').catch(() => undefined);
        void journal(apres.guild, 'boost', { titre: 'Fin de boost', ton: 'alerte', lignes: [`<@${apres.id}> ne booste plus le serveur.`] });
      }
    }),
  ],
  tests: [
    {
      id: 'thanks',
      libelle: 'Remerciement de boost',
      emoji: '🚀',
      description: 'Voir le message de remerciement à ton nom (sans compter de boost)',
      async executer(interaction) {
        const reglages = lireConfig(interaction.guildId).boosts;
        const salon = resoudreSalonTexte(interaction.guild, reglages.channelId);
        if (!salon) return '⚠️ Aucun salon de remerciements utilisable.';
        await salon.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🚀 NOUVEAU BOOST ! (test)').setDescription(remplirModele(reglages.message, { membre: interaction.member, serveur: interaction.guild }))], allowedMentions: { parse: [] } });
        return `✅ Message de test posté dans <#${salon.id}>.`;
      },
    },
  ],
};
