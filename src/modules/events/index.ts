import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import type { PageReglage } from '../../core/setup';
import { listeMentionsCourte, neutralizeMentions, truncate } from './helpers';
import { lireDateHeure, marqueTemps } from '../../core/time';
import { bouton, estLienHttp, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

interface LigneEvenement {
  id: number;
  serveur_id: string;
  salon_id: string;
  message_id: string | null;
  createur_id: string;
  nom: string;
  description: string;
  jeu: string | null;
  image: string | null;
  debut_le: number;
  statut: 'scheduled' | 'started' | 'cancelled' | 'ended';
  rappele: number;
  cree_le: number;
}

type ReponseRsvp = 'yes' | 'maybe' | 'no';
const RSVP: Record<ReponseRsvp, { label: string; emoji: string }> = {
  yes: { label: 'Présent', emoji: '✅' },
  maybe: { label: 'Peut-être', emoji: '❓' },
  no: { label: 'Absent', emoji: '❌' },
};

function reponsesRsvp(evenementId: number): Record<ReponseRsvp, string[]> {
  const sortie: Record<ReponseRsvp, string[]> = { yes: [], maybe: [], no: [] };
  for (const r of lireTout<{ utilisateur_id: string; statut: ReponseRsvp }>('SELECT utilisateur_id, statut FROM reponses_evenements WHERE evenement_id = ? ORDER BY modifie_le', evenementId)) {
    sortie[r.statut]?.push(r.utilisateur_id);
  }
  return sortie;
}

function afficher(serveur: Guild, e: LigneEvenement) {
  const liste = reponsesRsvp(e.id);
  const ferme = e.statut === 'cancelled' || e.statut === 'ended';
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, e.statut === 'cancelled' ? 'error' : 'primary'))
    .setTitle(`🎮 ${truncate(e.nom.toUpperCase(), 240)}`)
    .setDescription(
      [
        e.jeu ? `**${e.jeu}**` : null,
        e.description || null,
        '',
        `📅 ${marqueTemps(e.debut_le, 'F')}`,
        `🕘 ${marqueTemps(e.debut_le, 'R')}`,
        e.statut === 'cancelled' ? '\n**❌ Événement annulé**' : e.statut === 'started' ? '\n**🔴 C’est parti !**' : null,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .addFields(
      (Object.keys(RSVP) as ReponseRsvp[]).map((k) => ({
        name: `${RSVP[k].emoji} ${RSVP[k].label} (${liste[k].length})`,
        value: liste[k].length ? listeMentionsCourte(liste[k], 15) : '—',
        inline: true,
      })),
    )
    .setFooter({ text: `Événement #${e.id} · organisé par ${serveur.members.cache.get(e.createur_id)?.displayName ?? 'le staff'}` });
  if (e.image) embed.setImage(e.image);
  return {
    embeds: [embed],
    components: ferme
      ? []
      : [
          rangee(
            bouton(`ev:rsvp:${e.id}:yes`, 'Je participe', ButtonStyle.Success, '✅'),
            bouton(`ev:rsvp:${e.id}:maybe`, 'Peut-être', ButtonStyle.Secondary, '❓'),
            bouton(`ev:rsvp:${e.id}:no`, 'Absent', ButtonStyle.Secondary, '❌'),
          ),
        ],
  };
}

function exigerEvenement(serveurId: string, id: number | string | undefined): LigneEvenement {
  const e = lire<LigneEvenement>('SELECT * FROM evenements WHERE id = ? AND serveur_id = ?', Number(id), serveurId);
  if (!e) throw new ErreurUtilisateur('Événement introuvable.');
  return e;
}

async function rafraichir(client: Client, e: LigneEvenement): Promise<void> {
  const serveur = client.guilds.cache.get(e.serveur_id);
  const salon = serveur ? resoudreSalonTexte(serveur, e.salon_id) : null;
  if (!serveur || !salon || !e.message_id) return;
  const message = await salon.messages.fetch(e.message_id).catch(() => null);
  await message?.edit(afficher(serveur, e)).catch(() => undefined);
}

const commandeEvenement: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Les événements communautaires')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un événement')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : Soirée communautaire').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('date').setDescription('JJ/MM ou JJ/MM/AAAA').setRequired(true))
        .addStringOption((o) => o.setName('heure').setDescription('Ex : 21h ou 21:30').setRequired(true))
        .addStringOption((o) => o.setName('jeu').setDescription('Ex : Minecraft').setMaxLength(100))
        .addStringOption((o) => o.setName('description').setDescription('Détails').setMaxLength(1500))
        .addChannelOption((o) => o.setName('salon').setDescription('Où l’annoncer').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('image').setDescription('Lien d’une image').setMaxLength(500)),
    )
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Annuler un événement')
        .addIntegerOption((o) => o.setName('evenement').setDescription('L’événement').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les événements à venir')),
  niveauxSousCommandes: { list: Niveau.MEMBRE },
  async autocompletion(interaction) {
    const rangees = lireTout<LigneEvenement>("SELECT * FROM evenements WHERE serveur_id = ? AND statut IN ('scheduled','started') ORDER BY debut_le LIMIT 25", interaction.guildId);
    await interaction.respond(rangees.map((e) => ({ name: truncate(`#${e.id} · ${e.nom}`, 100), value: e.id })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'list') {
      const rangees = lireTout<LigneEvenement>("SELECT * FROM evenements WHERE serveur_id = ? AND statut IN ('scheduled','started') ORDER BY debut_le LIMIT 20", serveur.id);
      const lignes = rangees.map((e) => `🎮 **${truncate(e.nom, 80)}** — ${marqueTemps(e.debut_le, 'f')} (${marqueTemps(e.debut_le, 'R')}) · ✅ ${reponsesRsvp(e.id).yes.length}${e.message_id ? ` · [voir](https://discord.com/channels/${e.serveur_id}/${e.salon_id}/${e.message_id})` : ''}`);
      return repondre(interaction, { embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setTitle('📅 Événements à venir').setDescription(lignes.join('\n') || '*Aucun événement prévu.*')], ephemeral: true });
    }
    if (sousCommande === 'cancel') {
      const e = exigerEvenement(serveur.id, interaction.options.getInteger('evenement', true));
      executer("UPDATE evenements SET statut = 'cancelled' WHERE id = ?", e.id);
      await rafraichir(interaction.client, { ...e, statut: 'cancelled' });
      return repondre(interaction, { embeds: [ok(serveur, `Événement **${e.nom}** annulé.`)], ephemeral: true });
    }
    const fuseau = lireConfig(serveur.id).general.fuseau;
    const debutLe = lireDateHeure(interaction.options.getString('date', true), interaction.options.getString('heure', true), fuseau);
    if (!debutLe) throw new ErreurUtilisateur('Date ou heure invalide : exemples `25/12` et `21h`.');
    if (debutLe < Date.now()) throw new ErreurUtilisateur('Cette date est déjà passée.');
    const image = interaction.options.getString('image');
    if (image && !estLienHttp(image)) throw new ErreurUtilisateur('Lien d’image invalide.');
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(serveur, lireConfig(serveur.id).evenements.salonDefautId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const r = executer(
      'INSERT INTO evenements (serveur_id, salon_id, createur_id, nom, description, jeu, image, debut_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serveur.id,
      salon.id,
      interaction.user.id,
      neutralizeMentions(interaction.options.getString('nom', true)),
      neutralizeMentions(interaction.options.getString('description') ?? ''),
      interaction.options.getString('jeu'),
      image,
      debutLe,
      Date.now(),
    );
    const e = exigerEvenement(serveur.id, r.lastInsertRowid);
    const ping = lireConfig(serveur.id).evenements.roleMentionId;
    const message = await salon.send({ content: ping ? `<@&${ping}>` : undefined, ...afficher(serveur, e), allowedMentions: { roles: ping ? [ping] : [] } });
    executer('UPDATE evenements SET message_id = ? WHERE id = ?', message.id, e.id);
    void journal(serveur, 'community', { titre: 'Événement créé', ton: 'info', lignes: [`**${e.nom}** — ${marqueTemps(debutLe, 'F')}`, `[voir](${message.url})`], par: interaction.user });
    return repondre(interaction, { embeds: [ok(serveur, `Événement publié : ${message.url}`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'events',
  section: 'community',
  titre: 'Événements',
  emoji: '📅',
  moduleId: 'events',
  ordre: 4,
  description: 'Les événements communautaires avec inscription ✅ / ❓ / ❌ et rappel aux participants avant le début.',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon des événements', lire: (c) => c.evenements.salonDefautId, ecrire: (c, v) => void (c.evenements.salonDefautId = v) },
    { genre: 'role', cle: 'ping', libelle: 'Rôle mentionné', lire: (c) => c.evenements.roleMentionId, ecrire: (c, v) => void (c.evenements.roleMentionId = v) },
    { genre: 'number', cle: 'reminder', libelle: 'Rappel avant le début', min: 0, max: 1440, unite: 'min', lire: (c) => c.evenements.rappelMinutes, ecrire: (c, v) => void (c.evenements.rappelMinutes = v) },
  ],
};

export const moduleEvenements: ModuleBot = {
  id: 'events',
  nom: 'Événements',
  emoji: '📅',
  description: 'Événements communautaires avec RSVP et rappels',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeEvenement],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'ev',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, statut]) {
        if (action !== 'rsvp') return;
        const e = exigerEvenement(interaction.guildId, id);
        if (e.statut === 'cancelled' || e.statut === 'ended') throw new ErreurUtilisateur('Cet événement est terminé.');
        if (!(statut! in RSVP)) return;
        executer('INSERT OR REPLACE INTO reponses_evenements (evenement_id, utilisateur_id, statut, modifie_le) VALUES (?, ?, ?, ?)', e.id, interaction.user.id, statut, Date.now());
        await interaction.update(afficher(interaction.guild, e));
        await interaction.followUp({ embeds: [ok(interaction.guild, `${RSVP[statut as ReponseRsvp].emoji} Réponse enregistrée : **${RSVP[statut as ReponseRsvp].label}** pour **${e.nom}**.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  taches: [
    {
      nom: 'events',
      intervalleMs: 30_000,
      auDemarrage: true,
      async executer(client) {
        const maintenant = Date.now();
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'scheduled' AND rappele = 0 LIMIT 50")) {
          const minutes = lireConfig(e.serveur_id).evenements.rappelMinutes;
          if (!minutes || e.debut_le - minutes * 60_000 > maintenant) continue;
          executer('UPDATE evenements SET rappele = 1 WHERE id = ?', e.id);
          for (const utilisateurId of [...reponsesRsvp(e.id).yes, ...reponsesRsvp(e.id).maybe].slice(0, 100)) {
            const utilisateur = await client.users.fetch(utilisateurId).catch(() => null);
            await utilisateur?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(e.serveur_id)).setTitle('📅 Ça commence bientôt !').setDescription(`**${e.nom}** commence ${marqueTemps(e.debut_le, 'R')}.`)] }).catch(() => undefined);
          }
        }
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'scheduled' AND debut_le <= ? LIMIT 20", maintenant)) {
          executer("UPDATE evenements SET statut = 'started' WHERE id = ?", e.id);
          await rafraichir(client, { ...e, statut: 'started' });
        }
        for (const e of lireTout<LigneEvenement>("SELECT * FROM evenements WHERE statut = 'started' AND debut_le <= ? LIMIT 20", maintenant - 6 * 3_600_000)) {
          executer("UPDATE evenements SET statut = 'ended' WHERE id = ?", e.id);
          await rafraichir(client, { ...e, statut: 'ended' });
        }
      },
    },
  ],
};
