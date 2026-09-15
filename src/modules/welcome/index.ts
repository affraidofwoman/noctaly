import { AttachmentBuilder, ChannelType, EmbedBuilder, type Guild, type GuildMember } from 'discord.js';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, couleurPour } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { resoudreSalonTexte } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { estLienHttp } from '../../core/ui';
import { remplirModele, aideVariables } from '../../core/variables';
import { sur, type ModuleBot } from '../../core/types';
import { construireCarteBienvenue } from '../../services/welcomeCard';

const registre = creerRegistre('bienvenue');

/** Envoie l'accueil d'un membre. Retourne le salon utilisé, ou null si rien n'a été envoyé. */
export async function envoyerBienvenue(membre: GuildMember): Promise<string | null> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).bienvenue;
  const salon = resoudreSalonTexte(serveur, reglages.channelId);
  if (!salon) return null;

  const texte = remplirModele(reglages.message, { membre, serveur });
  const mentionsAutorisees = { users: [membre.id], roles: [] as string[] };
  let carte: Buffer | null = null;
  if (reglages.modeImage === 'card') carte = await construireCarteBienvenue(membre);
  const fichiers = carte ? [new AttachmentBuilder(carte, { name: 'bienvenue.png' })] : [];

  if (!reglages.utiliserEmbed) {
    await salon.send({ content: tronquer(texte, 2000), files: fichiers, allowedMentions: mentionsAutorisees });
    return salon.id;
  }

  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle(remplirModele(reglages.title || `${emojiPour(serveur.id, 'bienvenue')} Nouveau membre`, { membre, serveur }).slice(0, 256))
    .setDescription(tronquer(texte, 4096))
    .setFooter({ text: `${membre.user.tag} · ${serveur.memberCount}ᵉ membre`, iconURL: membre.user.displayAvatarURL({ size: 64 }) })
    .setTimestamp();
  if (carte) embed.setImage('attachment://bienvenue.png');
  else if (reglages.modeImage === 'url' && estLienHttp(reglages.urlImage)) embed.setImage(reglages.urlImage);
  else embed.setThumbnail(membre.user.displayAvatarURL({ size: 256 }));

  try {
    await salon.send({ embeds: [embed], files: fichiers, allowedMentions: mentionsAutorisees });
  } catch (echec) {
    if (!fichiers.length) throw echec;
    // La carte a été refusée : l'accueil part sans elle.
    embed.setImage(null).setThumbnail(membre.user.displayAvatarURL({ size: 256 }));
    await salon.send({ embeds: [embed], allowedMentions: mentionsAutorisees });
  }
  return salon.id;
}

async function envoyerBienvenueMp(membre: GuildMember): Promise<void> {
  const reglages = lireConfig(membre.guild.id).bienvenue;
  if (!reglages.mpActif || !reglages.messageMp) return;
  const embed = embedEnseigne(membre.guild)
    .setTitle(`${emojiPour(membre.guild.id, 'bienvenue')} ${membre.guild.name}`)
    .setDescription(tronquer(remplirModele(reglages.messageMp, { membre, serveur: membre.guild }), 4096))
    .setThumbnail(membre.guild.iconURL({ size: 128 }));
  await membre.send({ embeds: [embed] }).catch(() => undefined);
}

// ─── Compteur de membres (renommage limité par Discord : 2 fois / 10 min) ──

const compteursEnAttente = new Set<string>();
const dernierRenommage = new Map<string, number>();
const INTERVALLE_RENOMMAGE = 5 * 60_000 + 10_000;

async function actualiserCompteur(serveur: Guild): Promise<void> {
  const reglages = lireConfig(serveur.id).bienvenue;
  if (!reglages.salonCompteurId) return;
  const salon = serveur.channels.cache.get(reglages.salonCompteurId);
  if (!salon || salon.type === ChannelType.GuildCategory || !('setName' in salon)) return;
  const nom = remplirModele(reglages.formatCompteur, { serveur }).slice(0, 100);
  if (salon.name === nom) return;
  if (Date.now() - (dernierRenommage.get(serveur.id) ?? 0) < INTERVALLE_RENOMMAGE) {
    compteursEnAttente.add(serveur.id);
    return;
  }
  dernierRenommage.set(serveur.id, Date.now());
  compteursEnAttente.delete(serveur.id);
  await salon.setName(nom, 'Compteur de membres').catch((echec: Error) => registre.avertir(`Compteur non renommé : ${echec.message}`));
}

export function planifierCompteur(serveur: Guild): void {
  void actualiserCompteur(serveur);
}

const pageReglage: PageReglage = {
  id: 'welcome',
  section: 'welcome',
  titre: 'Bienvenue',
  emoji: '👋',
  moduleId: 'welcome',
  ordre: 1,
  description: `Le message posté à chaque arrivée, avec la carte aux couleurs de l’enseigne.\n-# Variables : ${['mention', 'user', 'username', 'server', 'membercount', 'createdat'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    { kind: 'channel', cle: 'channel', libelle: 'Salon de bienvenue', get: (c) => c.bienvenue.channelId, set: (c, v) => void (c.bienvenue.channelId = v) },
    {
      kind: 'channel',
      cle: 'counter',
      libelle: 'Salon compteur de membres',
      channelTypes: [ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildStageVoice],
      get: (c) => c.bienvenue.salonCompteurId,
      set: (c, v) => void (c.bienvenue.salonCompteurId = v),
    },
    {
      kind: 'choice',
      cle: 'image',
      libelle: 'Image',
      options: [
        { value: 'card', label: 'Carte de bienvenue générée', emoji: '🖼️' },
        { value: 'url', label: 'Image fixe (lien)', emoji: '🔗' },
        { value: 'none', label: 'Juste l’avatar', emoji: '👤' },
      ],
      get: (c) => c.bienvenue.modeImage,
      set: (c, v) => void (c.bienvenue.modeImage = v as 'card' | 'url' | 'none'),
    },
    { kind: 'toggle', cle: 'embed', libelle: 'Embed', get: (c) => c.bienvenue.utiliserEmbed, set: (c, v) => void (c.bienvenue.utiliserEmbed = v) },
    { kind: 'toggle', cle: 'dm', libelle: 'Message privé', get: (c) => c.bienvenue.mpActif, set: (c, v) => void (c.bienvenue.mpActif = v) },
    { kind: 'text', cle: 'title', libelle: 'Titre', maxLength: 200, get: (c) => c.bienvenue.title, set: (c, v) => void (c.bienvenue.title = v) },
    { kind: 'text', cle: 'message', libelle: 'Message', long: true, maxLength: 2000, required: true, get: (c) => c.bienvenue.message, set: (c, v) => void (c.bienvenue.message = v) },
    { kind: 'text', cle: 'dmmessage', libelle: 'Message privé', long: true, maxLength: 2000, get: (c) => c.bienvenue.messageMp, set: (c, v) => void (c.bienvenue.messageMp = v) },
    {
      kind: 'text',
      cle: 'imageurl',
      libelle: 'Lien de l’image fixe',
      maxLength: 500,
      get: (c) => c.bienvenue.urlImage,
      set: (c, v) => void (c.bienvenue.urlImage = v),
      validate: (v) => (!v || estLienHttp(v) ? null : 'Lien http(s) attendu.'),
    },
    { kind: 'text', cle: 'counterformat', libelle: 'Nom du compteur', maxLength: 90, get: (c) => c.bienvenue.formatCompteur, set: (c, v) => void (c.bienvenue.formatCompteur = v) },
  ],
};

export const moduleBienvenue: ModuleBot = {
  id: 'welcome',
  nom: 'Bienvenue',
  emoji: '👋',
  description: 'Message, carte, message privé et compteur de membres',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglage],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      if (membre.user.bot) {
        planifierCompteur(membre.guild);
        return;
      }
      // En premier : rien de ce qui suit ne doit pouvoir empêcher un accueil.
      await envoyerBienvenue(membre).catch((echec: Error) => registre.avertir(`${membre.id} non accueilli : ${echec.message}`));
      await envoyerBienvenueMp(membre);
      planifierCompteur(membre.guild);
    }, 40),
    sur('guildMemberRemove', (membre) => {
      planifierCompteur(membre.guild);
    }),
  ],
  taches: [
    {
      nom: 'welcome-counter',
      intervalleMs: 60_000,
      async executer(client) {
        for (const serveurId of [...compteursEnAttente]) {
          const serveur = client.guilds.cache.get(serveurId);
          if (!serveur || !moduleActif(serveurId, 'welcome')) {
            compteursEnAttente.delete(serveurId);
            continue;
          }
          await actualiserCompteur(serveur);
        }
      },
    },
  ],
  tests: [
    {
      id: 'message',
      libelle: 'Message de bienvenue',
      emoji: '👋',
      description: 'Poster ton propre accueil dans le salon réglé',
      async executer(interaction) {
        const salonId = await envoyerBienvenue(interaction.member);
        return salonId ? `✅ Accueil posté dans <#${salonId}>.` : '⚠️ Aucun salon de bienvenue utilisable (réglage ou permissions).';
      },
    },
    {
      id: 'variables',
      libelle: 'Variables disponibles',
      emoji: '🧩',
      description: 'La liste des variables des messages',
      async executer() {
        return aideVariables(['user', 'mention', 'username', 'userid', 'server', 'membercount', 'createdat', 'date', 'time', 'brand']);
      },
    },
  ],
};
