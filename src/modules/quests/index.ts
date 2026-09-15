import { EmbedBuilder, SlashCommandBuilder, type Client, type Guild, type User } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { embedEnseigne, couleurPour } from '../../core/embeds';
import { lireConfig, type DefinitionQuete } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { moduleActif } from '../../core/moduleManager';
import type { PageReglage } from '../../core/setup';
import { formaterNombre, barreProgression } from '../../core/text';
import { cleJour, cleJourPrecedent } from '../../core/time';
import { sur, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { surActivite, type TypeActivite } from '../../services/activity';
import { ajouterPieces } from '../../services/economy';
import { surTempsVocal } from '../../services/voice';
import { ajouterXp } from '../../services/xp';

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

const commandesPrefixe: CommandePrefixe[] = [
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

const pageReglage: PageReglage = {
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
  commandesPrefixe,
  pagesReglage: [pageReglage],
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
