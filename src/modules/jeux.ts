import { randomInt } from 'node:crypto';
import { type ButtonInteraction, ButtonStyle, EmbedBuilder, type Guild, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { bouton, couleurPour, rangee, repondre } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import type { CommandeSlash, ModuleBot } from '../coeur/noyau';
import { ErreurUtilisateur, neutraliserMentions, tronquer } from '../coeur/outils';
import { lireConfig } from '../coeur/reglages';

type Jeu = 'bouleMagique' | 'pileOuFace' | 'des' | 'pierreFeuilleCiseaux';

function exigerJeu(serveurId: string, jeu: Jeu): void {
  if (!lireConfig(serveurId).jeux[jeu]) throw new ErreurUtilisateur('Ce mini-jeu est désactivé sur ce serveur.');
}

const REPONSES = [
  'Oui, clairement.', 'C’est certain.', 'Sans aucun doute.', 'Tu peux compter dessus.', 'Très probablement.', 'Les signes disent oui.',
  'Réponse floue, réessaie.', 'Redemande plus tard.', 'Mieux vaut ne pas te le dire maintenant.', 'Concentre-toi et redemande.',
  'N’y compte pas.', 'Ma réponse est non.', 'Mes sources disent non.', 'Très peu probable.', 'Chat a dit non. 🐈',
];

const embed = (serveur: Guild) => new EmbedBuilder().setColor(couleurPour(serveur));

const bouleMagique: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Boule magique')
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true).setMaxLength(200)),
  async executer(i) {
    exigerJeu(i.guildId, 'bouleMagique');
    const q = neutraliserMentions(i.options.getString('question', true));
    await repondre(i, { embeds: [embed(i.guild).setTitle('🎱 Boule magique').setDescription(`**${tronquer(q, 200)}**\n\n${REPONSES[randomInt(REPONSES.length)]}`)] });
  },
};

const pileOuFace: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder().setName('coinflip').setDescription('Pile ou face'),
  async executer(i) {
    exigerJeu(i.guildId, 'pileOuFace');
    const pile = randomInt(2) === 0;
    await repondre(i, { embeds: [embed(i.guild).setTitle('🪙 Pile ou face').setDescription(`La pièce tombe sur… **${pile ? 'Pile' : 'Face'}** !`)] });
  },
};

const des: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Lancer des dés')
    .addIntegerOption((o) => o.setName('faces').setDescription('Nombre de faces').setMinValue(2).setMaxValue(1000))
    .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre de dés').setMinValue(1).setMaxValue(20)),
  async executer(i) {
    exigerJeu(i.guildId, 'des');
    const faces = i.options.getInteger('faces') ?? 6;
    const nombre = i.options.getInteger('nombre') ?? 1;
    const lancers = Array.from({ length: nombre }, () => randomInt(1, faces + 1));
    await repondre(i, {
      embeds: [embed(i.guild).setTitle('🎲 Lancer de dés').setDescription(`${nombre} d${faces} : ${lancers.map((r) => `**${r}**`).join(' · ')}${nombre > 1 ? `\nTotal : **${lancers.reduce((a, b) => a + b, 0)}**` : ''}`)],
    });
  },
};

const COUPS: Record<string, { label: string; emoji: string; bat: string }> = {
  pierre: { label: 'Pierre', emoji: '🪨', bat: 'ciseaux' },
  feuille: { label: 'Feuille', emoji: '📄', bat: 'pierre' },
  ciseaux: { label: 'Ciseaux', emoji: '✂️', bat: 'feuille' },
};

const pierreFeuilleCiseaux: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Pierre, feuille, ciseaux')
    .addUserOption((o) => o.setName('adversaire').setDescription('Adversaire')),
  async executer(i) {
    exigerJeu(i.guildId, 'pierreFeuilleCiseaux');
    const adversaire = i.options.getUser('adversaire');
    if (adversaire && (adversaire.bot || adversaire.id === i.user.id)) throw new ErreurUtilisateur('Choisis un autre membre (pas un bot, pas toi).');
    const adversaireId = adversaire?.id ?? 'bot';
    await repondre(i, {
      embeds: [embed(i.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(adversaire ? `<@${i.user.id}> défie <@${adversaire.id}> ! Chacun choisit en secret.` : 'Choisis ton coup !')],
      components: [rangee(...Object.entries(COUPS).map(([cle, v]) => bouton(`rps:${i.user.id}:${adversaireId}:${cle}`, v.label, ButtonStyle.Secondary, v.emoji)))],
      allowedMentions: { users: adversaire ? [adversaire.id] : [] },
    });
  },
};

const enAttente = new Map<string, Map<string, string>>();

async function surPierreFeuille(interaction: ButtonInteraction<'cached'>, [defieur, adversaire, coup]: string[]) {
  if (!coup || !COUPS[coup]) return;
  const joueurs = [defieur, adversaire];
  if (adversaire === 'bot') {
    if (interaction.user.id !== defieur) throw new ErreurUtilisateur('Lance ta propre partie avec `/rps`.');
    const coupBot = Object.keys(COUPS)[randomInt(3)]!;
    const resultat = coup === coupBot ? 'Égalité !' : COUPS[coup]!.bat === coupBot ? 'Tu gagnes ! 🎉' : 'Le bot gagne ! 🤖';
    await interaction.update({ embeds: [embed(interaction.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(`Toi : ${COUPS[coup]!.emoji} **${COUPS[coup]!.label}**\nBot : ${COUPS[coupBot]!.emoji} **${COUPS[coupBot]!.label}**\n\n**${resultat}**`)], components: [] });
    return;
  }
  if (!joueurs.includes(interaction.user.id)) throw new ErreurUtilisateur('Ce duel ne te concerne pas.');
  const coups = enAttente.get(interaction.message.id) ?? new Map<string, string>();
  coups.set(interaction.user.id, coup);
  enAttente.set(interaction.message.id, coups);
  if (coups.size < 2) {
    await interaction.reply({ content: `Coup enregistré : ${COUPS[coup]!.emoji} — en attente de l’adversaire.`, flags: MessageFlags.Ephemeral });
    return;
  }
  enAttente.delete(interaction.message.id);
  const a = coups.get(defieur!)!;
  const b = coups.get(adversaire!)!;
  const resultat = a === b ? 'Égalité !' : COUPS[a]!.bat === b ? `<@${defieur}> gagne ! 🎉` : `<@${adversaire}> gagne ! 🎉`;
  await interaction.update({
    embeds: [embed(interaction.guild).setTitle('✊ Pierre, feuille, ciseaux').setDescription(`<@${defieur}> : ${COUPS[a]!.emoji} **${COUPS[a]!.label}**\n<@${adversaire}> : ${COUPS[b]!.emoji} **${COUPS[b]!.label}**\n\n**${resultat}**`)],
    components: [],
  });
}

const pageReglage: PageReglage = {
  id: 'games',
  section: 'community',
  titre: 'Mini-jeux',
  emoji: '🎲',
  moduleId: 'games',
  ordre: 11,
  description: 'Chaque mini-jeu peut être activé séparément.',
  champs: [
    { genre: 'toggle', cle: '8ball', libelle: '8ball', lire: (c) => c.jeux.bouleMagique, ecrire: (c, v) => void (c.jeux.bouleMagique = v) },
    { genre: 'toggle', cle: 'coinflip', libelle: 'Pile ou face', lire: (c) => c.jeux.pileOuFace, ecrire: (c, v) => void (c.jeux.pileOuFace = v) },
    { genre: 'toggle', cle: 'dice', libelle: 'Dés', lire: (c) => c.jeux.des, ecrire: (c, v) => void (c.jeux.des = v) },
    { genre: 'toggle', cle: 'rps', libelle: 'Pierre-feuille-ciseaux', lire: (c) => c.jeux.pierreFeuilleCiseaux, ecrire: (c, v) => void (c.jeux.pierreFeuilleCiseaux = v) },
  ],
};

export const moduleJeux: ModuleBot = {
  id: 'games',
  nom: 'Mini-jeux',
  emoji: '🎲',
  description: '8ball, pile ou face, dés, pierre-feuille-ciseaux',
  desactivable: true,
  actifParDefaut: false,
  commandes: [bouleMagique, pileOuFace, des, pierreFeuilleCiseaux],
  pagesReglage: [pageReglage],
  composants: [{ prefixe: 'rps', bouton: (i, parametres) => surPierreFeuille(i, parametres) }],
};
