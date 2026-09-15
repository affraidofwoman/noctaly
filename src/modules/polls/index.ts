import { ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, type ButtonInteraction, type Client, type Guild } from 'discord.js';
import { lireTout, lire, lireJson, executer } from '../../database/db';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { historiser } from '../../core/logService';
import { aNiveau } from '../../core/permissions';
import { neutraliserMentions, barreProgression, tronquer } from '../../core/text';
import { lireDuree, marqueTemps } from '../../core/time';
import { bouton, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

interface LigneSondage {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  auteur_id: string;
  question: string;
  propositions: string;
  multiple: number;
  fin_le: number | null;
  statut: 'open' | 'closed';
  cree_le: number;
}

const NUMEROS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function decompte(sondage: LigneSondage): { counts: number[]; voters: number } {
  const propositions = lireJson<string[]>(sondage.propositions, []);
  const comptes = propositions.map(() => 0);
  for (const r of lireTout<{ choix: number; n: number }>('SELECT choix, COUNT(*) AS n FROM votes_sondages WHERE sondage_id = ? GROUP BY choix', sondage.id)) {
    if (comptes[r.choix] !== undefined) comptes[r.choix] = r.n;
  }
  const votants = lire<{ n: number }>('SELECT COUNT(DISTINCT utilisateur_id) AS n FROM votes_sondages WHERE sondage_id = ?', sondage.id)?.n ?? 0;
  return { counts: comptes, voters: votants };
}

function afficher(serveur: Guild, sondage: LigneSondage) {
  const propositions = lireJson<string[]>(sondage.propositions, []);
  const { counts: comptes, voters: votants } = decompte(sondage);
  const total = comptes.reduce((a, b) => a + b, 0);
  const ferme = sondage.statut === 'closed';
  const max = Math.max(...comptes);
  const lignes = propositions.map((c, i) => {
    const pourcentage = total ? Math.round((comptes[i]! / total) * 100) : 0;
    const victoire = ferme && max > 0 && comptes[i] === max ? ' 🏆' : '';
    return `${NUMEROS[i]} **${tronquer(c, 80)}**${victoire}\n${barreProgression(total ? comptes[i]! / total : 0, 14)} ${pourcentage}% · ${comptes[i]} vote${comptes[i]! > 1 ? 's' : ''}`;
  });
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, ferme ? 'info' : 'primary'))
    .setAuthor({ name: ferme ? '📊 SONDAGE TERMINÉ' : '📊 SONDAGE' })
    .setTitle(tronquer(sondage.question, 256))
    .setDescription(lignes.join('\n\n'))
    .setFooter({ text: `${votants} participant${votants > 1 ? 's' : ''} · ${sondage.multiple ? 'plusieurs choix possibles' : 'un seul choix'} · #${sondage.id}` });
  if (sondage.fin_le && !ferme) embed.addFields({ name: 'Fin', value: `${marqueTemps(sondage.fin_le, 'R')}`, inline: true });
  const boutons = propositions.map((_, i) => bouton(`poll:vote:${sondage.id}:${i}`, String(comptes[i]), ButtonStyle.Secondary, NUMEROS[i]).setDisabled(ferme));
  const rangees = [];
  for (let i = 0; i < boutons.length; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  if (!ferme) rangees.push(rangee(bouton(`poll:end:${sondage.id}`, 'Terminer', ButtonStyle.Danger, '⏹️')));
  return { embeds: [embed], components: rangees };
}

function exigerSondage(serveurId: string, id: string | undefined): LigneSondage {
  const sondage = lire<LigneSondage>('SELECT * FROM sondages WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!sondage) throw new ErreurUtilisateur('Sondage introuvable.');
  return sondage;
}

async function cloreSondage(client: Client, sondage: LigneSondage): Promise<void> {
  executer("UPDATE sondages SET statut = 'closed' WHERE id = ?", sondage.id);
  const serveur = client.guilds.cache.get(sondage.serveur_id);
  const salon = serveur?.channels.cache.get(sondage.salon_id);
  if (!serveur || !salon?.isTextBased() || !sondage.message_id) return;
  const message = await salon.messages.fetch(sondage.message_id).catch(() => null);
  await message?.edit(afficher(serveur, { ...sondage, statut: 'closed' })).catch(() => undefined);
}

const sondage: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.MEMBRE,
  delaiSecondes: 20,
  donnees: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Créer un sondage')
    .addStringOption((o) => o.setName('question').setDescription('La question').setRequired(true).setMaxLength(250))
    .addStringOption((o) => o.setName('choix').setDescription('Les choix séparés par | (2 à 10). Vide = Oui | Non').setMaxLength(1000))
    .addStringOption((o) => o.setName('duree').setDescription('Ex : 1h, 2j (vide = sans fin)'))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Autoriser plusieurs choix')),
  async executer(interaction) {
    const brut = interaction.options.getString('choix');
    const propositions = (brut ? brut.split('|') : ['Oui', 'Non']).map((c) => neutraliserMentions(c.trim())).filter(Boolean).slice(0, 10);
    if (propositions.length < 2) throw new ErreurUtilisateur('Il faut au moins 2 choix, séparés par `|`.');
    const dureeBrute = interaction.options.getString('duree');
    const duree = dureeBrute ? lireDuree(dureeBrute) : null;
    if (dureeBrute && (!duree || duree > 30 * 86_400_000)) throw new ErreurUtilisateur('Durée invalide (ex : `1h`, `2j`, 30 jours max).');
    const r = executer(
      'INSERT INTO sondages (serveur_id, salon_id, auteur_id, question, propositions, multiple, fin_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      neutraliserMentions(interaction.options.getString('question', true)),
      JSON.stringify(propositions),
      interaction.options.getBoolean('multiple') ? 1 : 0,
      duree ? Date.now() + duree : null,
      Date.now(),
    );
    const cree = exigerSondage(interaction.guildId, String(r.lastInsertRowid));
    const message = await interaction.reply({ ...afficher(interaction.guild, cree), withResponse: true });
    executer('UPDATE sondages SET message_id = ? WHERE id = ?', message.resource?.message?.id ?? null, cree.id);
    historiser(interaction.guildId, 'community', 'poll', null, interaction.user.id, { id: cree.id });
  },
};

export const moduleSondages: ModuleBot = {
  id: 'polls',
  nom: 'Sondages',
  emoji: '📊',
  description: 'Sondages à boutons avec résultats en direct',
  desactivable: true,
  actifParDefaut: true,
  commandes: [sondage],
  composants: [
    {
      prefixe: 'poll',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, choix]) {
        const p = exigerSondage(interaction.guildId, id);
        if (p.statut === 'closed') throw new ErreurUtilisateur('Ce sondage est terminé.');
        if (action === 'end') {
          if (p.auteur_id !== interaction.user.id && !aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Seul l’auteur ou le staff peut terminer ce sondage.');
          await interaction.deferUpdate();
          await cloreSondage(interaction.client, p);
          return;
        }
        const indice = Number(choix);
        const nombre = lireJson<string[]>(p.propositions, []).length;
        if (!Number.isInteger(indice) || indice < 0 || indice >= nombre) return;
        const deja = lire('SELECT 1 FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ? AND choix = ?', p.id, interaction.user.id, indice);
        if (deja) executer('DELETE FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ? AND choix = ?', p.id, interaction.user.id, indice);
        else {
          if (!p.multiple) executer('DELETE FROM votes_sondages WHERE sondage_id = ? AND utilisateur_id = ?', p.id, interaction.user.id);
          executer('INSERT OR IGNORE INTO votes_sondages (sondage_id, utilisateur_id, choix) VALUES (?, ?, ?)', p.id, interaction.user.id, indice);
        }
        await interaction.update(afficher(interaction.guild, p));
        if (!deja) await interaction.followUp({ embeds: [ok(interaction.guild, `Vote enregistré : **${tronquer(lireJson<string[]>(p.propositions, [])[indice] ?? '', 80)}**`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  taches: [
    {
      nom: 'polls-end',
      intervalleMs: 30_000,
      auDemarrage: true,
      async executer(client) {
        for (const p of lireTout<LigneSondage>("SELECT * FROM sondages WHERE statut = 'open' AND fin_le IS NOT NULL AND fin_le <= ? LIMIT 20", Date.now())) {
          await cloreSondage(client, p);
        }
      },
    },
  ],
};
