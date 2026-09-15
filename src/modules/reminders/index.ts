import { EmbedBuilder, SlashCommandBuilder, type Client } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { lignesEnPages, paginer } from '../../core/pagination';
import { neutraliserMentions, tronquer } from '../../core/text';
import { formaterDuree, lireDuree, marqueTemps } from '../../core/time';
import type { ModuleBot, CommandePrefixe, CommandeSlash } from '../../core/types';

interface LigneRappel {
  id: number;
  serveur_id: string | null;
  salon_id: string | null;
  utilisateur_id: string;
  contenu: string;
  rappel_le: number;
  cree_le: number;
}

const DELAI_MAX = 365 * 86_400_000;

function creer(serveurId: string, salonId: string, utilisateurId: string, delai: number, contenu: string): LigneRappel {
  if (delai < 10_000 || delai > DELAI_MAX) throw new ErreurUtilisateur('Durée entre 10 secondes et 1 an (ex : `2h30`, `1j`, `45m`).');
  const max = lireConfig(serveurId).rappels.maxParMembre;
  const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM rappels WHERE utilisateur_id = ? AND envoye = 0', utilisateurId)?.n ?? 0;
  if (nombre >= max) throw new ErreurUtilisateur(`Tu as déjà ${nombre} rappels en attente (maximum ${max}).`);
  const r = executer(
    'INSERT INTO rappels (serveur_id, salon_id, utilisateur_id, contenu, rappel_le, cree_le) VALUES (?, ?, ?, ?, ?, ?)',
    serveurId,
    salonId,
    utilisateurId,
    tronquer(neutraliserMentions(contenu.trim() || 'Rappel'), 1000),
    Date.now() + delai,
    Date.now(),
  );
  return lire<LigneRappel>('SELECT * FROM rappels WHERE id = ?', r.lastInsertRowid)!;
}

/** « 2h30 live Twitch » → durée + texte ; la durée peut contenir plusieurs morceaux (« 1j 2h »). */
export function decouperRappel(saisie: string): { delay: number; text: string } | null {
  const mots = saisie.trim().split(/\s+/);
  for (let n = Math.min(3, mots.length); n >= 1; n--) {
    const delai = lireDuree(mots.slice(0, n).join(' '));
    if (delai && !/^\d+$/.test(mots[0]!)) return { delay: delai, text: mots.slice(n).join(' ') };
  }
  return null;
}

async function livrer(client: Client, r: LigneRappel): Promise<void> {
  executer('UPDATE rappels SET envoye = 1 WHERE id = ?', r.id);
  const serveur = r.serveur_id ? client.guilds.cache.get(r.serveur_id) : null;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur ?? null))
    .setTitle(`${emojiPour(r.serveur_id, 'rappel')} RAPPEL`)
    .setDescription(`Tu avais demandé un rappel :\n\n**${r.contenu}**`)
    .setFooter({ text: `Programmé ${serveur ? `sur ${serveur.name} ` : ''}` })
    .setTimestamp(r.cree_le);
  const utilisateur = await client.users.fetch(r.utilisateur_id).catch(() => null);
  const mp = await utilisateur?.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (mp) return;
  // MP fermés : on rappelle dans le salon d'origine.
  const salon = serveur && r.salon_id ? serveur.channels.cache.get(r.salon_id) : null;
  if (salon?.isTextBased()) await salon.send({ content: `<@${r.utilisateur_id}>`, embeds: [embed], allowedMentions: { users: [r.utilisateur_id] } }).catch(() => undefined);
}

const rappel: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Les rappels')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Programmer un rappel')
        .addStringOption((o) => o.setName('duree').setDescription('Dans combien de temps (ex : 2h30, 1j)').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('De quoi te rappeler').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Tes rappels en attente'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un rappel')
        .addIntegerOption((o) => o.setName('rappel').setDescription('Le rappel').setRequired(true).setAutocomplete(true)),
    ),
  async autocompletion(interaction) {
    const rangees = lireTout<LigneRappel>('SELECT * FROM rappels WHERE utilisateur_id = ? AND envoye = 0 ORDER BY rappel_le LIMIT 25', interaction.user.id);
    await interaction.respond(rangees.map((r) => ({ name: tronquer(`#${r.id} · ${r.contenu}`, 100), value: r.id })));
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    if (sousCommande === 'set') {
      const delai = lireDuree(interaction.options.getString('duree', true));
      if (!delai) throw new ErreurUtilisateur('Durée incomprise : exemples `2h30`, `45m`, `1j 2h`.');
      const r = creer(serveur.id, interaction.channelId, interaction.user.id, delai, interaction.options.getString('texte', true));
      return repondre(interaction, { embeds: [ok(serveur, `⏰ Rappel **#${r.id}** programmé ${marqueTemps(r.rappel_le, 'R')} (${formaterDuree(delai)}).\n> ${r.contenu}`)], ephemeral: true });
    }
    if (sousCommande === 'cancel') {
      const reponse = executer('DELETE FROM rappels WHERE id = ? AND utilisateur_id = ? AND envoye = 0', interaction.options.getInteger('rappel', true), interaction.user.id);
      return repondre(interaction, { embeds: [ok(serveur, reponse.changes ? 'Rappel annulé.' : 'Rappel introuvable.')], ephemeral: true });
    }
    const rangees = lireTout<LigneRappel>('SELECT * FROM rappels WHERE utilisateur_id = ? AND envoye = 0 ORDER BY rappel_le', interaction.user.id);
    const lignes = rangees.map((r) => `**#${r.id}** ${marqueTemps(r.rappel_le, 'R')} — ${tronquer(r.contenu, 100)}`);
    if (!lignes.length) lignes.push('*Aucun rappel en attente.*');
    return paginer(interaction, lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('⏰ Tes rappels').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` })), true);
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'remind',
    alias: ['rappel', 'rm'],
    domaine: 'general',
    categorie: 'community',
    description: 'Programmer un rappel',
    usage: '<durée> <texte>',
    async executer(message, parametres) {
      const lu = decouperRappel(parametres.join(' '));
      if (!lu) throw new ErreurUtilisateur('Usage : `=remind 2h30 live Twitch`.');
      const r = creer(message.guildId, message.channelId, message.author.id, lu.delay, lu.text);
      await message.reply({ embeds: [ok(message.guild, `⏰ Rappel **#${r.id}** ${marqueTemps(r.rappel_le, 'R')}.`)], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleRappels: ModuleBot = {
  id: 'reminders',
  nom: 'Rappels',
  emoji: '⏰',
  description: 'Rappels persistants en MP (ou dans le salon)',
  desactivable: true,
  actifParDefaut: true,
  commandes: [rappel],
  commandesPrefixe,
  taches: [
    {
      nom: 'reminders',
      intervalleMs: 10_000,
      auDemarrage: true,
      async executer(client) {
        for (const r of lireTout<LigneRappel>('SELECT * FROM rappels WHERE envoye = 0 AND rappel_le <= ? ORDER BY rappel_le LIMIT 50', Date.now())) {
          await livrer(client, r);
        }
        executer('DELETE FROM rappels WHERE envoye = 1 AND rappel_le < ?', Date.now() - 7 * 86_400_000);
      },
    },
  ],
};
