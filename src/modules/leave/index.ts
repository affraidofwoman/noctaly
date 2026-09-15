import { EmbedBuilder, type GuildMember, type PartialGuildMember } from 'discord.js';
import { emojiPour } from '../../core/brand';
import { couleurPour } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { resoudreSalonTexte } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import type { PageReglage } from '../../core/setup';
import { formaterNombre, tronquer } from '../../core/text';
import { formaterDuree } from '../../core/time';
import { remplirModele } from '../../core/variables';
import { sur, type ModuleBot } from '../../core/types';
import { activiteMembre } from '../../services/stats';

const registre = creerRegistre('depart');

export async function envoyerDepart(membre: GuildMember | PartialGuildMember): Promise<string | null> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).depart;
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
  if (!salon || !membre.user) return null;
  const texte = remplirModele(reglages.message, { utilisateur: membre.user, serveur });
  if (!reglages.utiliserEmbed) {
    await salon.send({ content: tronquer(texte, 2000), allowedMentions: { parse: [] } });
    return salon.id;
  }
  const activite = activiteMembre(serveur.id, membre.id);
  const reste = membre.joinedTimestamp ? Date.now() - membre.joinedTimestamp : null;
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, 'error'))
    .setTitle(`${emojiPour(serveur.id, 'depart')} Départ`)
    .setDescription(tronquer(texte, 4096))
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${membre.user.tag} · ${serveur.memberCount} membres` })
    .setTimestamp();
  const statistiques = [
    reste ? `• Resté — **${formaterDuree(reste)}**` : null,
    activite ? `• Messages — **${formaterNombre(activite.messages)}**` : null,
    activite?.secondes_vocal ? `• Vocal — **${formaterDuree(activite.secondes_vocal * 1000)}**` : null,
  ].filter(Boolean);
  if (statistiques.length) embed.addFields({ name: 'Statistiques', value: statistiques.join('\n') });
  await salon.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return salon.id;
}

const pageReglage: PageReglage = {
  id: 'leave',
  section: 'welcome',
  titre: 'Départ',
  emoji: '🚪',
  moduleId: 'leave',
  ordre: 2,
  description: 'Le message posté quand quelqu’un quitte le serveur.\n-# Variables : `{user}` `{username}` `{server}` `{membercount}`',
  champs: [
    { kind: 'channel', cle: 'channel', libelle: 'Salon des départs', get: (c) => c.depart.channelId, set: (c, v) => void (c.depart.channelId = v) },
    { kind: 'toggle', cle: 'embed', libelle: 'Embed + statistiques', get: (c) => c.depart.utiliserEmbed, set: (c, v) => void (c.depart.utiliserEmbed = v) },
    { kind: 'text', cle: 'message', libelle: 'Message', long: true, maxLength: 2000, required: true, get: (c) => c.depart.message, set: (c, v) => void (c.depart.message = v) },
  ],
};

export const moduleDeparts: ModuleBot = {
  id: 'leave',
  nom: 'Départs',
  emoji: '🚪',
  description: 'Message de départ avec statistiques',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglage],
  evenements: [
    sur('guildMemberRemove', async (membre) => {
      if (membre.user?.bot) return;
      await envoyerDepart(membre).catch((echec: Error) => registre.avertir(`Départ de ${membre.id} non posté : ${echec.message}`));
    }),
  ],
  tests: [
    {
      id: 'message',
      libelle: 'Message de départ',
      emoji: '🚪',
      description: 'Poster un faux départ à ton nom',
      async executer(interaction) {
        const id = await envoyerDepart(interaction.member);
        return id ? `✅ Départ posté dans <#${id}>.` : '⚠️ Aucun salon de départ utilisable.';
      },
    },
  ],
};
