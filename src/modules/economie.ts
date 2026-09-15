import { EmbedBuilder, type GuildMember, type Message, MessageType, SlashCommandBuilder } from 'discord.js';
import { botPeutGererRole, emojiPour } from '../coeur/acces';
import { couleurPour, embedEnseigne, info, ok, remplirModele, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import { executer, lire, lireTout, transaction } from '../coeur/base';
import { historiser, journal, resoudreSalonTexte } from '../coeur/journaux';
import { type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import { cleJour, cleJourPrecedent, ErreurUtilisateur, formaterNombre, medaille, Niveau, tronquer } from '../coeur/outils';
import { lireConfig, modifierConfig, moduleActif } from '../coeur/reglages';
import { donnerBadge, emettreActivite, lireBadge, noterActivite } from './niveaux';

// - Porte-monnaie -

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

// Les transferts, remboursements et corrections ne comptent pas comme des gains.
const HORS_GAINS = new Set(['give', 'refund', 'admin', 'coffre']);

export function ajouterPieces(serveurId: string, utilisateurId: string, montant: number, raison = 'gain'): number {
  const valeur = Math.trunc(montant);
  return transaction(() => {
    const actuel = portefeuille(serveurId, utilisateurId);
    const suivant = actuel.solde + valeur;
    if (suivant < 0) throw new Error('solde insuffisant');
    const gain = valeur > 0 && !HORS_GAINS.has(raison) ? valeur : 0;
    executer(
      `INSERT INTO economie (serveur_id, utilisateur_id, solde, total_gagne) VALUES (?, ?, ?, ?)
       ON CONFLICT(serveur_id, utilisateur_id) DO UPDATE SET solde = excluded.solde, total_gagne = economie.total_gagne + ?`,
      serveurId,
      utilisateurId,
      suivant,
      gain,
      gain,
    );
    if (gain) noterActivite(serveurId, utilisateurId, { gold: gain });
    if (Math.abs(valeur) >= 1000) historiser(serveurId, 'community', `coins-${raison}`, utilisateurId, null, { amount: valeur });
    return suivant;
  });
}

export function transferer(serveurId: string, depuis: string, vers: string, montant: number): { depuis: number; vers: number } {
  if (!Number.isInteger(montant) || montant <= 0) throw new Error('montant invalide');
  return transaction(() => ({ depuis: ajouterPieces(serveurId, depuis, -montant, 'give'), vers: ajouterPieces(serveurId, vers, montant, 'give') }));
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

export function montantGold(serveurId: string, montant: number): string {
  const economie = lireConfig(serveurId).economie;
  return `**${formaterNombre(montant)}** ${economie.emojiMonnaie} ${economie.nomMonnaie}`;
}

export function recupererQuotidien(membre: GuildMember): string {
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
  emettreActivite({ serveurId: serveur.id, utilisateurId: membre.id, type: 'quotidien', montant: 1 });
  return `🎁 Tu reçois ${montantGold(serveur.id, montant)} !\n🔥 Série : **${serie}** jour${serie > 1 ? 's' : ''}${serie > 1 ? ` (+${Math.min(serie - 1, 30) * economie.bonusSerie} de bonus)` : ''}\n-# Nouveau solde : ${formaterNombre(solde)}`;
}

// - Articles du serveur -

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

export async function livrer(membre: GuildMember, article: ArticleBoutique): Promise<string> {
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

export function rembourser(serveurId: string, utilisateurId: string, article: ArticleBoutique): void {
  ajouterPieces(serveurId, utilisateurId, article.prix, 'refund');
  executer('DELETE FROM inventaire WHERE id = (SELECT MAX(id) FROM inventaire WHERE serveur_id = ? AND utilisateur_id = ? AND article_id = ?)', serveurId, utilisateurId, article.id);
  if (article.stock !== null) executer('UPDATE articles_boutique SET stock = stock + 1 WHERE id = ?', article.id);
}

// - Boosts -

const TYPES_BOOST = new Set([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);
const boostsRecents = new Map<string, number>();

async function appliquerRecompenses(membre: GuildMember, nombre: number): Promise<string[]> {
  const serveur = membre.guild;
  const donnes: string[] = [];
  for (const r of lireConfig(serveur.id).boosts.recompenses.filter((x) => x.nombre === nombre)) {
    const role = r.roleId ? serveur.roles.cache.get(r.roleId) : null;
    if (role && botPeutGererRole(serveur, role)) {
      await membre.roles.add(role, `Récompense de ${nombre} boost(s)`).catch(() => undefined);
      donnes.push(`<@&${role.id}>`);
    }
    if (r.badgeId && donnerBadge(serveur.id, membre.id, r.badgeId)) donnes.push(`${lireBadge(serveur.id, r.badgeId)?.emoji ?? '🏅'} badge`);
    if (r.pieces > 0 && moduleActif(serveur.id, 'progression')) {
      ajouterPieces(serveur.id, membre.id, r.pieces, 'boost');
      donnes.push(`${r.pieces} ${lireConfig(serveur.id).economie.emojiMonnaie}`);
    }
  }
  return donnes;
}

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
  const salon = resoudreSalonTexte(serveur, reglages.salonId);
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
        .setDescription('Nouvelle récompense')
        .addIntegerOption((o) => o.setName('boosts').setDescription('Nombre de boosts').setRequired(true).setMinValue(1).setMaxValue(100))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle donné'))
        .addStringOption((o) => o.setName('badge').setDescription('Badge donné (identifiant)').setMaxLength(32))
        .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces données').setMinValue(0).setMaxValue(10_000_000)),
    )
    .addSubcommand((s) => s.setName('recompenses').setDescription('Les récompenses'))
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un palier')
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
        embeds: [info(serveur, recompenses.map((r) => `**${r.nombre} boost(s)** → ${[r.roleId ? `<@&${r.roleId}>` : null, r.badgeId ? `badge \`${r.badgeId}\`` : null, r.pieces ? `${r.pieces} pièces` : null].filter(Boolean).join(', ')}`).join('\n') || 'Aucune récompense.', { titre: 'Récompenses de boost', sujet: '🚀' })],
        ephemeral: true,
      });
    }
    const nombre = interaction.options.getInteger('boosts', true);
    if (sousCommande === 'retirer') {
      modifierConfig(serveur.id, (c) => void (c.boosts.recompenses = c.boosts.recompenses.filter((r) => r.nombre !== nombre)));
      return repondre(interaction, { embeds: [ok(serveur, `Récompenses du palier ${nombre} retirées.`)], ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    const badgeId = interaction.options.getString('badge');
    const pieces = interaction.options.getInteger('pieces') ?? 0;
    if (!role && !badgeId && !pieces) throw new ErreurUtilisateur('Choisis au moins un rôle, un badge ou des pièces.');
    if (role && !botPeutGererRole(serveur, serveur.roles.cache.get(role.id)!)) throw new ErreurUtilisateur('Je ne peux pas donner ce rôle.');
    if (badgeId && !lireBadge(serveur.id, badgeId)) throw new ErreurUtilisateur('Badge introuvable (voir `/badge liste`).');
    modifierConfig(serveur.id, (c) => c.boosts.recompenses.push({ nombre, roleId: role?.id ?? null, badgeId, pieces }));
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
    { genre: 'channel', cle: 'channel', libelle: 'Salon des remerciements', lire: (c) => c.boosts.salonId, ecrire: (c, v) => void (c.boosts.salonId = v) },
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
        const salon = resoudreSalonTexte(interaction.guild, reglages.salonId);
        if (!salon) return '⚠️ Aucun salon de remerciements utilisable.';
        await salon.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🚀 NOUVEAU BOOST ! (test)').setDescription(remplirModele(reglages.message, { membre: interaction.member, serveur: interaction.guild }))], allowedMentions: { parse: [] } });
        return `✅ Message de test posté dans <#${salon.id}>.`;
      },
    },
  ],
};
