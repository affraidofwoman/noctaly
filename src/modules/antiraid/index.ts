import { EmbedBuilder, GuildVerificationLevel, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Message } from 'discord.js';
import { couleurPour, info, ok } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, historiser, resoudreSalonTexte } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { estExempte } from '../../core/permissions';
import { LimiteurFenetre } from '../../core/rateLimit';
import type { PageReglage } from '../../core/setup';
import { joursDepuis, formaterDuree, marqueTemps } from '../../core/time';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { membresListe } from '../../core/whitelists';
import { serveurVerrouille, verrouiller } from '../../services/lockdown';

const registre = creerRegistre('antiraid');

const arrivees = new Map<string, number[]>();
const membresRecents = new Map<string, GuildMember[]>();
const derniereAlerte = new Map<string, number>();
const limiteurMentions = new Map<string, LimiteurFenetre>();
const modeRaid = new Map<string, { jusqua: number; niveauPrecedent: GuildVerificationLevel }>();
const DUREE_MODE_RAID_MS = 30 * 60_000;

function enregistrerArrivee(membre: GuildMember, fenetreMs: number): number {
  const maintenant = Date.now();
  const liste = (arrivees.get(membre.guild.id) ?? []).filter((t) => maintenant - t < fenetreMs);
  liste.push(maintenant);
  arrivees.set(membre.guild.id, liste);
  const membres = (membresRecents.get(membre.guild.id) ?? []).filter((m) => maintenant - (m.joinedTimestamp ?? maintenant) < fenetreMs).slice(-60);
  membres.push(membre);
  membresRecents.set(membre.guild.id, membres);
  return liste.length;
}

/** Alerte : salon de sécurité + MP au propriétaire et aux streamers (sans spam : 10 min entre deux alertes). */
async function alerter(serveur: Guild, titre: string, lignes: string[]): Promise<void> {
  void journal(serveur, 'security', { titre, ton: 'alerte', lignes });
  if ((derniereAlerte.get(serveur.id) ?? 0) > Date.now()) return;
  derniereAlerte.set(serveur.id, Date.now() + 10 * 60_000);
  const embed = new EmbedBuilder().setColor(couleurPour(serveur, 'error')).setTitle(`🚨 ${titre}`).setDescription(lignes.join('\n')).setFooter({ text: serveur.name }).setTimestamp();
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).antiraid.salonAlerteId);
  if (salon) await salon.send({ embeds: [embed] }).catch(() => undefined);
  const destinataires = new Set([serveur.ownerId, ...membresListe('streamer', serveur.id)]);
  for (const id of destinataires) {
    const utilisateur = await serveur.client.users.fetch(id).catch(() => null);
    await utilisateur?.send({ embeds: [embed] }).catch(() => undefined);
  }
}

/** Mode raid (comme sur Airline) : vérification Discord renforcée pendant 30 min, puis retour au niveau habituel. */
async function activerModeRaid(serveur: Guild): Promise<boolean> {
  if (modeRaid.has(serveur.id)) return false;
  if (!serveur.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return false;
  const niveauPrecedent = serveur.verificationLevel;
  if (niveauPrecedent < GuildVerificationLevel.High) {
    await serveur.setVerificationLevel(GuildVerificationLevel.High, 'Anti-raid : salve d’arrivées anormale').catch(() => undefined);
  }
  modeRaid.set(serveur.id, { jusqua: Date.now() + DUREE_MODE_RAID_MS, niveauPrecedent });
  return true;
}

async function surArrivee(membre: GuildMember): Promise<'stop' | void> {
  if (membre.user.bot) return;
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).antiraid;
  const nombre = enregistrerArrivee(membre, reglages.fenetreArriveesSecondes * 1000);
  const age = joursDepuis(membre.user.createdTimestamp);

  if (reglages.ageCompteMinJours && age < reglages.ageCompteMinJours && reglages.actionSuspects !== 'none') {
    const raison = `Anti-raid : compte de ${age} jour(s)`;
    if (reglages.actionSuspects === 'kick' && membre.kickable) {
      await membre.send({ embeds: [info(serveur, `Ton compte est trop récent pour rejoindre **${serveur.name}** pour le moment. Réessaie dans quelques jours.`)] }).catch(() => undefined);
      await membre.kick(raison).catch(() => undefined);
      void journal(serveur, 'security', { titre: 'Compte suspect expulsé', ton: 'alerte', lignes: [`<@${membre.id}> \`${membre.user.tag}\` — compte de ${age} j`] });
      return 'stop';
    }
    if (reglages.actionSuspects === 'timeout' && membre.moderatable) {
      await membre.timeout(60 * 60_000, raison).catch(() => undefined);
      void journal(serveur, 'security', { titre: 'Compte suspect en timeout', ton: 'alerte', lignes: [`<@${membre.id}> \`${membre.user.tag}\` — compte de ${age} j (1 h)`] });
    }
  }

  if (nombre < reglages.seuilArrivees) return;
  const recents = membresRecents.get(serveur.id) ?? [];
  const jeunes = recents.filter((m) => joursDepuis(m.user.createdTimestamp) < 7).length;
  const modeRaidActive = await activerModeRaid(serveur);
  let texteVerrouillage = '';
  if (reglages.verrouillageAuto && !serveurVerrouille(serveur.id) && serveur.members.me) {
    const r = await verrouiller(serveur, 'server', serveur.id, serveur.members.me.user, 'Anti-raid automatique').catch(() => null);
    if (r) texteVerrouillage = `🔒 Lockdown automatique : **${r.verrouilles}** salon(s) fermés (\`/lockdown end\` pour rouvrir).`;
  }
  historiser(serveur.id, 'security', 'raid', null, null, { joins: nombre, young: jeunes });
  await alerter(serveur, 'Anti-raid — arrivées massives', [
    `**${nombre}** arrivées en **${reglages.fenetreArriveesSecondes} s** (seuil : ${reglages.seuilArrivees}).`,
    `Comptes de moins de 7 jours : **${jeunes}**`,
    modeRaidActive ? `🛡️ Niveau de vérification monté à « Élevé » pendant ${formaterDuree(DUREE_MODE_RAID_MS)}.` : '',
    texteVerrouillage,
    '',
    `Derniers arrivés : ${recents.slice(-10).map((m) => `<@${m.id}>`).join(' ')}`,
  ].filter(Boolean));
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member || estExempte(message.member)) return;
  const reglages = lireConfig(message.guildId).antiraid;
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  if (!mentions || !reglages.seuilMentions) return;
  const cle = `${message.guildId}:${reglages.seuilMentions}`;
  let limiteur = limiteurMentions.get(cle);
  if (!limiteur) limiteurMentions.set(cle, (limiteur = new LimiteurFenetre(reglages.seuilMentions, 30_000)));
  let bloques = false;
  for (let i = 0; i < mentions; i++) if (!limiteur.compter(message.author.id)) bloques = true;
  if (!bloques) return;
  limiteur.reinitialiser(message.author.id);
  await message.delete().catch(() => undefined);
  if (message.member.moderatable) await message.member.timeout(30 * 60_000, 'Anti-raid : mentions massives').catch(() => undefined);
  await alerter(message.guild, 'Anti-raid — mentions massives', [`<@${message.author.id}> a mentionné plus de **${reglages.seuilMentions}** personnes/rôles en 30 s.`, 'Message supprimé et membre mis en timeout 30 min.']);
}

const antiraid: CommandeSlash = {
  categorie: 'moderation',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Protection contre les raids')
    .addSubcommand((s) => s.setName('status').setDescription('État de la protection'))
    .addSubcommand((s) => s.setName('panique').setDescription('Mode raid immédiat : vérification élevée et lockdown'))
    .addSubcommand((s) => s.setName('fin').setDescription('Terminer le mode raid')),
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'panique') {
      await interaction.deferReply({ flags: 64 });
      await activerModeRaid(serveur);
      const r = serveurVerrouille(serveur.id) ? null : await verrouiller(serveur, 'server', serveur.id, interaction.user, 'Mode panique anti-raid').catch(() => null);
      return interaction.editReply({ embeds: [ok(serveur, `🚨 Mode raid activé : vérification élevée${r ? `, **${r.verrouilles}** salon(s) verrouillés` : ''}.\n-# \`/antiraid fin\` puis \`/lockdown end portee:Serveur\` pour revenir à la normale.`)] });
    }
    if (sousCommande === 'fin') {
      const etat = modeRaid.get(serveur.id);
      if (etat) {
        await serveur.setVerificationLevel(etat.niveauPrecedent, 'Fin du mode raid').catch(() => undefined);
        modeRaid.delete(serveur.id);
      }
      return repondre(interaction, { embeds: [ok(serveur, etat ? 'Mode raid terminé, vérification remise à son niveau habituel.' : 'Aucun mode raid en cours.')], ephemeral: true });
    }
    const reglages = lireConfig(serveur.id).antiraid;
    const etat = modeRaid.get(serveur.id);
    return repondre(interaction, {
      embeds: [
        info(
          serveur,
          [
            `• Seuil — **${reglages.seuilArrivees}** arrivées en **${reglages.fenetreArriveesSecondes} s**`,
            `• Comptes suspects — moins de **${reglages.ageCompteMinJours} j** → ${reglages.actionSuspects === 'none' ? 'rien' : reglages.actionSuspects}`,
            `• Lockdown automatique — **${reglages.verrouillageAuto ? 'oui' : 'non'}**`,
            `• Mentions massives — **${reglages.seuilMentions}** en 30 s`,
            `• Mode raid — ${etat ? `actif jusqu’à ${marqueTemps(etat.jusqua, 'R')}` : 'inactif'}`,
            `• Lockdown serveur — ${serveurVerrouille(serveur.id) ? '🔒 en cours' : 'non'}`,
          ].join('\n'),
          { titre: 'Anti-raid', sujet: '🚨' },
        ),
      ],
      ephemeral: true,
    });
  },
};

const pageReglage: PageReglage = {
  id: 'antiraid',
  section: 'security',
  titre: 'Anti-raid',
  emoji: '🚨',
  moduleId: 'antiraid',
  ordre: 3,
  description: 'Arrivées massives → alerte (salon + MP au propriétaire et aux streamers), vérification Discord renforcée 30 min, lockdown en option.',
  champs: [
    { genre: 'channel', cle: 'alert', libelle: 'Salon d’alerte (en plus de securite-log)', lire: (c) => c.antiraid.salonAlerteId, ecrire: (c, v) => void (c.antiraid.salonAlerteId = v) },
    {
      genre: 'choice',
      cle: 'suspicious',
      libelle: 'Comptes trop récents',
      options: [
        { valeur: 'none', libelle: 'Ne rien faire (alerte seulement)', emoji: '👀' },
        { valeur: 'timeout', libelle: 'Timeout 1 h', emoji: '⏳' },
        { valeur: 'kick', libelle: 'Expulser', emoji: '👢' },
      ],
      lire: (c) => c.antiraid.actionSuspects,
      ecrire: (c, v) => void (c.antiraid.actionSuspects = v as 'none' | 'timeout' | 'kick'),
    },
    { genre: 'toggle', cle: 'lock', libelle: 'Lockdown automatique', lire: (c) => c.antiraid.verrouillageAuto, ecrire: (c, v) => void (c.antiraid.verrouillageAuto = v) },
    { genre: 'number', cle: 'threshold', libelle: 'Arrivées déclenchant l’alerte', min: 3, max: 500, lire: (c) => c.antiraid.seuilArrivees, ecrire: (c, v) => void (c.antiraid.seuilArrivees = v) },
    { genre: 'number', cle: 'window', libelle: 'Fenêtre', min: 5, max: 3600, unite: 's', lire: (c) => c.antiraid.fenetreArriveesSecondes, ecrire: (c, v) => void (c.antiraid.fenetreArriveesSecondes = v) },
    { genre: 'number', cle: 'age', libelle: 'Compte suspect si moins de', min: 0, max: 365, unite: 'j', lire: (c) => c.antiraid.ageCompteMinJours, ecrire: (c, v) => void (c.antiraid.ageCompteMinJours = v) },
    { genre: 'number', cle: 'mentions', libelle: 'Mentions max en 30 s', min: 5, max: 500, lire: (c) => c.antiraid.seuilMentions, ecrire: (c, v) => void (c.antiraid.seuilMentions = v) },
  ],
};

export const moduleAntiraid: ModuleBot = {
  id: 'antiraid',
  nom: 'Anti-raid',
  emoji: '🚨',
  description: 'Arrivées massives, comptes suspects, mentions massives',
  desactivable: true,
  actifParDefaut: true,
  commandes: [antiraid],
  pagesReglage: [pageReglage],
  evenements: [sur('guildMemberAdd', (m) => surArrivee(m), 2), sur('messageCreate', (m) => surMessage(m), 11)],
  taches: [
    {
      nom: 'antiraid-restore',
      intervalleMs: 60_000,
      async executer(client) {
        for (const [serveurId, etat] of modeRaid) {
          if (etat.jusqua > Date.now()) continue;
          modeRaid.delete(serveurId);
          const serveur = client.guilds.cache.get(serveurId);
          if (!serveur) continue;
          await serveur.setVerificationLevel(etat.niveauPrecedent, 'Anti-raid : retour au niveau habituel').catch(() => undefined);
          void journal(serveur, 'security', { titre: 'Anti-raid — retour à la normale', ton: 'ok', lignes: ['Le niveau de vérification est revenu à son réglage habituel.'] });
          registre.info(`Mode raid terminé sur ${serveurId}`);
        }
      },
    },
  ],
};
