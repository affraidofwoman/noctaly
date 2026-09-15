import { MessageFlags, SlashCommandBuilder, type Message } from 'discord.js';
import { lireTout, executer } from '../../database/db';
import { info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { repondre } from '../../core/interactions';
import { Delais } from '../../core/rateLimit';
import { neutraliserMentions, tronquer } from '../../core/text';
import { construireFormulaire } from '../../core/ui';
import { remplirModele } from '../../core/variables';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

type TypeCorrespondance = 'contains' | 'exact' | 'startswith' | 'word';

interface LigneReponseAuto {
  id: number;
  serveur_id: string;
  declencheur: string;
  correspondance: TypeCorrespondance;
  reponse: string;
}

const LIBELLE_CORRESPONDANCE: Record<TypeCorrespondance, string> = { contains: 'contient', exact: 'exactement', startswith: 'commence par', word: 'mot entier' };

const cache = new Map<string, LigneReponseAuto[]>();
const delais = new Delais();

function liste(serveurId: string): LigneReponseAuto[] {
  let rangees = cache.get(serveurId);
  if (!rangees) {
    rangees = lireTout<LigneReponseAuto>('SELECT id, serveur_id, declencheur, correspondance, reponse FROM reponses_auto WHERE serveur_id = ? ORDER BY id', serveurId);
    cache.set(serveurId, rangees);
  }
  return rangees;
}

function normaliser(texte: string): string {
  return texte.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function correspond(rangee: Pick<LigneReponseAuto, 'declencheur' | 'correspondance'>, contenu: string): boolean {
  const texte = normaliser(contenu);
  const declencheur = normaliser(rangee.declencheur);
  if (!declencheur) return false;
  switch (rangee.correspondance) {
    case 'exact':
      return texte === declencheur;
    case 'startswith':
      return texte.startsWith(declencheur);
    case 'word':
      return ` ${texte.replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${declencheur} `);
    default:
      return texte.includes(declencheur);
  }
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const rangee = liste(message.guildId).find((r) => correspond(r, message.content));
  if (!rangee) return;
  if (delais.prendre(`${message.channelId}:${rangee.id}`, 15_000) > 0) return;
  await message
    .reply({ content: tronquer(remplirModele(rangee.reponse, { membre: message.member, serveur: message.guild, salon: message.channel }), 2000), allowedMentions: { parse: [], repliedUser: false } })
    .catch(() => undefined);
}

const reponseAuto: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('autoresponse')
    .setDescription('Réponses automatiques')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Ajouter une réponse automatique')
        .addStringOption((o) => o.setName('declencheur').setDescription('Ex : youtube').setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Quand répondre')
            .addChoices({ name: 'Le message contient', value: 'contains' }, { name: 'Mot entier', value: 'word' }, { name: 'Commence par', value: 'startswith' }, { name: 'Message exact', value: 'exact' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Supprimer une réponse automatique')
        .addIntegerOption((o) => o.setName('reponse').setDescription('La réponse').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les réponses automatiques')),
  async autocompletion(interaction) {
    await interaction.respond(liste(interaction.guildId).slice(0, 25).map((r) => ({ name: tronquer(`#${r.id} « ${r.declencheur} » → ${r.reponse}`, 100), value: r.id })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'list') {
      const lignes = liste(serveur.id).map((r) => `**#${r.id}** ${LIBELLE_CORRESPONDANCE[r.correspondance]} « ${tronquer(r.declencheur, 40)} » → ${tronquer(r.reponse, 60)}`);
      return repondre(interaction, { embeds: [info(serveur, lignes.join('\n') || 'Aucune réponse automatique.', { titre: 'Réponses automatiques', sujet: '💬' })], ephemeral: true });
    }
    if (sousCommande === 'remove') {
      const r = executer('DELETE FROM reponses_auto WHERE id = ? AND serveur_id = ?', interaction.options.getInteger('reponse', true), serveur.id);
      cache.delete(serveur.id);
      return repondre(interaction, { embeds: [ok(serveur, r.changes ? 'Réponse automatique supprimée.' : 'Introuvable.')], ephemeral: true });
    }
    if (liste(serveur.id).length >= 50) throw new ErreurUtilisateur('50 réponses automatiques maximum.');
    const declencheur = interaction.options.getString('declencheur', true);
    const mode = interaction.options.getString('mode') ?? 'contains';
    await interaction.showModal(
      construireFormulaire(`ar:save:${mode}`, `Réponse à « ${tronquer(declencheur, 25)} »`, [
        { id: 'trigger', libelle: 'Déclencheur', valeur: declencheur, longueurMax: 100 },
        { id: 'response', libelle: 'Réponse', long: true, longueurMax: 2000, indication: '🎥 Tu peux retrouver les vidéos ici !' },
      ]),
    );
  },
};

export const moduleReponsesAuto: ModuleBot = {
  id: 'autoresponses',
  nom: 'Réponses automatiques',
  emoji: '💬',
  description: 'Le bot répond quand un mot-clé est écrit',
  desactivable: true,
  actifParDefaut: true,
  commandes: [reponseAuto],
  composants: [
    {
      prefixe: 'ar',
      niveau: Niveau.ADMIN,
      async fenetre(interaction, [, mode]) {
        const declencheur = interaction.fields.getTextInputValue('trigger').trim();
        const reponse = neutraliserMentions(interaction.fields.getTextInputValue('response').trim());
        if (normaliser(declencheur).length < 2) throw new ErreurUtilisateur('Déclencheur trop court (2 caractères minimum).');
        executer(
          'INSERT INTO reponses_auto (serveur_id, declencheur, correspondance, reponse, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?)',
          interaction.guildId,
          declencheur,
          ['contains', 'exact', 'startswith', 'word'].includes(mode ?? '') ? mode : 'contains',
          reponse,
          interaction.user.id,
          Date.now(),
        );
        cache.delete(interaction.guildId);
        await interaction.reply({ embeds: [ok(interaction.guild, `Quand un message ${LIBELLE_CORRESPONDANCE[(mode as TypeCorrespondance) ?? 'contains']} « **${tronquer(declencheur, 60)}** », je répondrai :\n> ${tronquer(reponse, 300)}`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [sur('messageCreate', (m) => surMessage(m), 170)],
};
