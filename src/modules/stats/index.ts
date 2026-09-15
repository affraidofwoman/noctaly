import { SlashCommandBuilder } from 'discord.js';
import { lire } from '../../database/db';
import { embedEnseigne } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { moduleActif } from '../../core/moduleManager';
import { formaterNombre } from '../../core/text';
import { cleJour, formaterDuree } from '../../core/time';
import { sur, type ModuleBot, type CommandeSlash } from '../../core/types';
import { COLONNES_JOUR, incrementerJour, incrementerMembre } from '../../services/stats';
import { surTempsVocal } from '../../services/voice';

surTempsVocal((credit) => {
  if (!moduleActif(credit.serveurId, 'stats') || !lireConfig(credit.serveurId).statistiques.suivreVocal) return;
  incrementerJour(credit.serveurId, 'secondes_vocal', credit.secondes);
  incrementerMembre(credit.serveurId, credit.utilisateurId, 'secondes_vocal', credit.secondes);
});

function sommeJours(serveurId: string, colonne: (typeof COLONNES_JOUR)[number], depuisJour: string | null): number {
  const rangee = depuisJour
    ? lire<{ n: number }>(`SELECT COALESCE(SUM(${colonne}), 0) AS n FROM statistiques_jour WHERE serveur_id = ? AND jour >= ?`, serveurId, depuisJour)
    : lire<{ n: number }>(`SELECT COALESCE(SUM(${colonne}), 0) AS n FROM statistiques_jour WHERE serveur_id = ?`, serveurId);
  return rangee?.n ?? 0;
}

const nombre = (requete: string, ...parametres: string[]) => lire<{ n: number }>(requete, ...parametres)?.n ?? 0;

const statistiques: CommandeSlash = {
  categorie: 'general',
  delaiSecondes: 10,
  donnees: new SlashCommandBuilder().setName('stats').setDescription('Les statistiques du serveur'),
  async executer(interaction) {
    const serveur = interaction.guild;
    const fuseau = lireConfig(serveur.id).general.fuseau;
    const aujourdhui = cleJour(Date.now(), fuseau);
    const semaine = cleJour(Date.now() - 6 * 86_400_000, fuseau);
    const bots = serveur.members.cache.filter((m) => m.user.bot).size;
    const enVocal = serveur.voiceStates.cache.filter((v) => !!v.channelId && !v.member?.user.bot).size;
    const embed = embedEnseigne(serveur)
      .setTitle(`📈 Statistiques — ${serveur.name}`)
      .setThumbnail(serveur.iconURL({ size: 256 }))
      .addFields(
        { name: '👥 Membres', value: `${formaterNombre(serveur.memberCount - bots)}\n-# +${sommeJours(serveur.id, 'arrivees', semaine)} / -${sommeJours(serveur.id, 'departs', semaine)} sur 7 j`, inline: true },
        { name: '🤖 Bots', value: formaterNombre(bots), inline: true },
        { name: '💬 Messages', value: `${formaterNombre(sommeJours(serveur.id, 'messages', aujourdhui))} aujourd’hui\n-# ${formaterNombre(sommeJours(serveur.id, 'messages', semaine))} sur 7 j · ${formaterNombre(sommeJours(serveur.id, 'messages', null))} au total`, inline: true },
        { name: '🎙️ Vocal', value: `${enVocal} en ce moment\n-# ${formaterDuree(sommeJours(serveur.id, 'secondes_vocal', semaine) * 1000) || '0 s'} sur 7 j`, inline: true },
        { name: '🎫 Tickets', value: `${nombre("SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ? AND statut = 'open'", serveur.id)} ouverts\n-# ${nombre('SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ?', serveur.id)} au total`, inline: true },
        { name: '🎉 Giveaways', value: `${nombre("SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ? AND statut = 'running'", serveur.id)} en cours\n-# ${nombre('SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ?', serveur.id)} au total`, inline: true },
        { name: '⭐ XP', value: `${formaterNombre(nombre('SELECT COALESCE(SUM(xp), 0) AS n FROM xp WHERE serveur_id = ?', serveur.id))} XP\n-# ${nombre('SELECT COUNT(*) AS n FROM xp WHERE serveur_id = ? AND xp > 0', serveur.id)} membres classés`, inline: true },
        { name: '🔴 Twitch', value: `${nombre('SELECT COUNT(*) AS n FROM chaines_twitch WHERE serveur_id = ? AND live_id IS NOT NULL', serveur.id)} en live\n-# ${nombre('SELECT COUNT(*) AS n FROM chaines_twitch WHERE serveur_id = ?', serveur.id)} chaîne(s) suivie(s)`, inline: true },
        { name: '⌨️ Commandes', value: `${formaterNombre(sommeJours(serveur.id, 'commandes', aujourdhui))} aujourd’hui\n-# ${formaterNombre(sommeJours(serveur.id, 'commandes', semaine))} sur 7 j`, inline: true },
      );
    await repondre(interaction, { embeds: [embed] });
  },
};

export const moduleStatistiques: ModuleBot = {
  id: 'stats',
  nom: 'Statistiques',
  emoji: '📈',
  description: 'Messages, vocal, arrivées et activité du serveur',
  desactivable: true,
  actifParDefaut: true,
  commandes: [statistiques],
  evenements: [
    sur('messageCreate', (message) => {
      if (!message.inGuild() || message.author.bot) return;
      incrementerJour(message.guildId, 'messages');
      incrementerMembre(message.guildId, message.author.id, 'messages');
    }, 250),
    sur('guildMemberAdd', (membre) => {
      if (!membre.user.bot) incrementerJour(membre.guild.id, 'arrivees');
    }, 250),
    sur('guildMemberRemove', (membre) => {
      if (!membre.user?.bot) incrementerJour(membre.guild.id, 'departs');
    }, 250),
  ],
};
