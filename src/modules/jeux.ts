import { randomInt } from 'node:crypto';
import { type ButtonInteraction, ButtonStyle, EmbedBuilder, type Guild, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { bouton, construireFormulaire, couleurPour, rangee } from '../coeur/affichage';
import type { PageReglage } from '../coeur/assistant';
import type { CommandePrefixe, CommandeSlash, ModuleBot } from '../coeur/noyau';
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

function boule(serveur: Guild, question: string) {
  exigerJeu(serveur.id, 'bouleMagique');
  if (!question.trim()) throw new ErreurUtilisateur('Pose ta question après la commande.');
  return { embeds: [embed(serveur).setTitle('🎱 Boule magique').setDescription(`**${tronquer(neutraliserMentions(question), 200)}**\n\n${REPONSES[randomInt(REPONSES.length)]}`)] };
}

function piece(serveur: Guild) {
  exigerJeu(serveur.id, 'pileOuFace');
  return { embeds: [embed(serveur).setTitle('🪙 Pile ou face').setDescription(`La pièce tombe sur… **${randomInt(2) === 0 ? 'Pile' : 'Face'}** !`)] };
}

// - Dés à la façon 3d20 -
export function lireDes(parametres: string[]): { nombre: number; faces: number } {
  const m = /^(\d*)d(\d+)$/i.exec(parametres[0] ?? '') ?? /^()(\d+)$/.exec(parametres[0] ?? '');
  const borne = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  if (!m) return { nombre: 1, faces: 6 };
  return { nombre: borne(Number(m[1]) || 1, 1, 20), faces: borne(Number(m[2]) || 6, 2, 1000) };
}

function lancerDes(serveur: Guild, nombre: number, faces: number) {
  exigerJeu(serveur.id, 'des');
  const lancers = Array.from({ length: nombre }, () => randomInt(1, faces + 1));
  return {
    embeds: [embed(serveur).setTitle('🎲 Lancer de dés').setDescription(`${nombre}d${faces} : ${lancers.map((r) => `**${r}**`).join(' · ')}${nombre > 1 ? `\nTotal : **${lancers.reduce((a, b) => a + b, 0)}**` : ''}`)],
  };
}

// - /jeux : les mini-jeux au clic -
const jeux: CommandeSlash = {
  categorie: 'economy',
  donnees: new SlashCommandBuilder().setName('jeux').setDescription('Les mini-jeux'),
  async executer(i) {
    const actifs = lireConfig(i.guildId).jeux;
    const prefixe = lireConfig(i.guildId).prefixes.general;
    const liste = [
      { id: 'boule', actif: actifs.bouleMagique, libelle: 'Boule magique', emoji: '🎱', quoi: 'Pose une question, elle répond' },
      { id: 'piece', actif: actifs.pileOuFace, libelle: 'Pile ou face', emoji: '🪙', quoi: 'La pièce décide' },
      { id: 'des', actif: actifs.des, libelle: 'Dés', emoji: '🎲', quoi: 'De 1 à 20 dés, jusqu’à 1000 faces' },
      { id: 'duel', actif: actifs.pierreFeuilleCiseaux, libelle: 'Chifoumi', emoji: '✊', quoi: 'Contre le bot, ou `=rps @membre`' },
    ].filter((j) => j.actif);
    if (!liste.length) throw new ErreurUtilisateur('Aucun mini-jeu n’est activé sur ce serveur.');
    await i.reply({
      embeds: [embed(i.guild).setTitle('🎲 Mini-jeux').setDescription([...liste.map((j) => `${j.emoji} **${j.libelle}** — ${j.quoi}`), '', `-# Au clavier : \`${prefixe}8ball\`, \`${prefixe}pf\`, \`${prefixe}de 3d20\`, \`${prefixe}rps\``].join('\n'))],
      components: [rangee(...liste.map((j) => bouton(`jeu:${j.id}`, j.libelle, ButtonStyle.Secondary, j.emoji)))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const COUPS: Record<string, { label: string; emoji: string; bat: string }> = {
  pierre: { label: 'Pierre', emoji: '🪨', bat: 'ciseaux' },
  feuille: { label: 'Feuille', emoji: '📄', bat: 'pierre' },
  ciseaux: { label: 'Ciseaux', emoji: '✂️', bat: 'feuille' },
};


function duel(serveur: Guild, joueurId: string, adversaire: { id: string; bot: boolean } | null) {
  exigerJeu(serveur.id, 'pierreFeuilleCiseaux');
  if (adversaire && (adversaire.bot || adversaire.id === joueurId)) throw new ErreurUtilisateur('Choisis un autre membre (pas un bot, pas toi).');
  return {
    embeds: [embed(serveur).setTitle('✊ Pierre, feuille, ciseaux').setDescription(adversaire ? `<@${joueurId}> défie <@${adversaire.id}> ! Chacun choisit en secret.` : 'Choisis ton coup !')],
    components: [rangee(...Object.entries(COUPS).map(([cle, v]) => bouton(`rps:${joueurId}:${adversaire?.id ?? 'bot'}:${cle}`, v.label, ButtonStyle.Secondary, v.emoji)))],
    allowedMentions: { users: adversaire ? [adversaire.id] : [] },
  };
}

// - Les mini-jeux au clavier -
const jeu = (nom: string, alias: string[], description: string, usage: string | undefined, charge: (message: import('discord.js').Message<true>, parametres: string[]) => Promise<object> | object): CommandePrefixe => ({
  nom,
  alias,
  domaine: 'general',
  categorie: 'economy',
  description,
  usage,
  async executer(message, parametres) {
    await message.reply({ ...(await charge(message, parametres)), allowedMentions: { repliedUser: false } });
  },
});

const prefixesJeux: CommandePrefixe[] = [
  jeu('8ball', ['boule'], 'Boule magique', '<question>', (m, p) => boule(m.guild, p.join(' '))),
  jeu('pf', ['coinflip', 'pileface'], 'Pile ou face', undefined, (m) => piece(m.guild)),
  jeu('de', ['des', 'dice'], 'Lancer des dés', '[3d20]', (m, p) => {
    const { nombre, faces } = lireDes(p);
    return lancerDes(m.guild, nombre, faces);
  }),
  jeu('rps', ['chifoumi', 'pfc'], 'Pierre, feuille, ciseaux', '[membre]', async (m) => duel(m.guild, m.author.id, m.mentions.users.first() ?? null)),
];

const enAttente = new Map<string, Map<string, string>>();

async function surPierreFeuille(interaction: ButtonInteraction<'cached'>, [defieur, adversaire, coup]: string[]) {
  if (!coup || !COUPS[coup]) return;
  const joueurs = [defieur, adversaire];
  if (adversaire === 'bot') {
    if (interaction.user.id !== defieur) throw new ErreurUtilisateur('Lance ta propre partie avec `/jeux`.');
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
  commandes: [jeux],
  commandesPrefixe: prefixesJeux,
  pagesReglage: [pageReglage],
  composants: [
    { prefixe: 'rps', bouton: (i, parametres) => surPierreFeuille(i, parametres) },
    {
      prefixe: 'jeu',
      async bouton(i, [id]) {
        if (id === 'boule') return i.showModal(construireFormulaire('jeu:boule', 'Boule magique', [{ id: 'question', libelle: 'Ta question', indication: 'Est-ce que le live sera long ce soir ?', longueurMax: 200 }]));
        if (id === 'des') return i.showModal(construireFormulaire('jeu:des', 'Lancer des dés', [{ id: 'des', libelle: 'Combien de dés, combien de faces', valeur: '1d6', indication: '3d20', longueurMax: 8 }]));
        if (id === 'piece') return i.reply(piece(i.guild));
        if (id === 'duel') return i.reply(duel(i.guild, i.user.id, null));
      },
      async fenetre(i, [id]) {
        if (id === 'boule') return i.reply(boule(i.guild, i.fields.getTextInputValue('question')));
        const { nombre, faces } = lireDes([i.fields.getTextInputValue('des').trim()]);
        return i.reply(lancerDes(i.guild, nombre, faces));
      },
    },
  ],
};
