import { randomInt } from 'node:crypto';
import { ChannelType, SlashCommandBuilder, type Guild, type GuildMember, type Message, type User } from 'discord.js';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { moduleActif } from '../../core/moduleManager';
import { lignesEnPages, paginer } from '../../core/pagination';
import { rolesAttribuables } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { formaterNombre, medaille, barreProgression } from '../../core/text';
import { remplirModele } from '../../core/variables';
import { sur, Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { donnerBadge } from '../../services/badges';
import { surTempsVocal } from '../../services/voice';
import { ajouterXp, lireXp, classement, niveauDepuisXp, rolesNiveau, rangDe, retirerRoleNiveau, poserRoleNiveau, poserXp, xpTotalePourNiveau } from '../../services/xp';

const delais = new Map<string, number>();

/** Rôles de niveau : empilés ou seulement le plus haut atteint. */
export async function synchroniserRolesNiveau(membre: GuildMember, niveau: number): Promise<void> {
  const recompenses = rolesNiveau(membre.guild.id);
  if (!recompenses.length) return;
  const cumuler = lireConfig(membre.guild.id).xp.cumulerRoles;
  const obtenus = recompenses.filter((r) => r.niveau <= niveau);
  const cible = cumuler ? obtenus : obtenus.filter((r) => r.niveau === Math.max(...obtenus.map((e) => e.niveau), -1));
  const ciblesIds = new Set(cible.map((r) => r.role_id));
  const aAjouter = rolesAttribuables(membre.guild, [...ciblesIds]).filter((r) => !membre.roles.cache.has(r.id));
  const aRetirer = rolesAttribuables(membre.guild, recompenses.map((r) => r.role_id)).filter((r) => !ciblesIds.has(r.id) && membre.roles.cache.has(r.id));
  if (aAjouter.length) await membre.roles.add(aAjouter, `Niveau ${niveau}`).catch(() => undefined);
  if (aRetirer.length) await membre.roles.remove(aRetirer, `Niveau ${niveau}`).catch(() => undefined);
  if (aAjouter.length) {
    void journal(membre.guild, 'autorole', { titre: 'Rôle de niveau', ton: 'ok', lignes: [`**Membre** : <@${membre.id}>`, `**Niveau** : ${niveau}`, `**Rôles** : ${aAjouter.map((r) => `<@&${r.id}>`).join(' ')}`] });
  }
}

async function annoncerNiveau(membre: GuildMember, niveau: number, source: Message | null): Promise<void> {
  const reglages = lireConfig(membre.guild.id).xp;
  if (niveau >= 10) donnerBadge(membre.guild.id, membre.id, 'actif');
  await synchroniserRolesNiveau(membre, niveau);
  if (reglages.annonce === 'off') return;
  const texte = remplirModele(reglages.messageNiveau, { membre, serveur: membre.guild, extra: { level: niveau } });
  const embed = embedEnseigne(membre.guild).setDescription(`${emojiPour(membre.guild.id, 'niveau')} ${texte}`).setThumbnail(membre.user.displayAvatarURL({ size: 128 }));
  if (reglages.annonce === 'dm') {
    await membre.send({ embeds: [embed] }).catch(() => undefined);
    return;
  }
  const salon = reglages.annonce === 'channel' ? resoudreSalonTexte(membre.guild, reglages.salonAnnonceId) : source?.channel;
  if (salon && 'send' in salon) await salon.send({ content: `<@${membre.id}>`, embeds: [embed], allowedMentions: { users: [membre.id] } }).catch(() => undefined);
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const reglages = lireConfig(message.guildId).xp;
  if (reglages.salonsSansXp.includes(message.channelId) || (message.channel.isThread() && message.channel.parentId && reglages.salonsSansXp.includes(message.channel.parentId))) return;
  if (message.member.roles.cache.some((r) => reglages.rolesSansXp.includes(r.id))) return;
  const cle = `${message.guildId}:${message.author.id}`;
  const maintenant = Date.now();
  if ((delais.get(cle) ?? 0) > maintenant) return;
  delais.set(cle, maintenant + reglages.delaiSecondes * 1000);
  if (delais.size > 20_000) for (const [k, v] of delais) if (v < maintenant) delais.delete(k);
  const gain = randomInt(Math.min(reglages.min, reglages.max), Math.max(reglages.min, reglages.max) + 1);
  const { ancienNiveau, nouveauNiveau } = ajouterXp(message.guildId, message.author.id, gain, true);
  if (nouveauNiveau > ancienNiveau) await annoncerNiveau(message.member, nouveauNiveau, message);
}

surTempsVocal((credit, client) => {
  if (credit.inactif || !moduleActif(credit.serveurId, 'xp')) return;
  const parMinute = lireConfig(credit.serveurId).xp.xpVocalParMinute;
  if (parMinute <= 0) return;
  const gain = Math.floor((credit.secondes / 60) * parMinute);
  if (gain <= 0) return;
  const { ancienNiveau, nouveauNiveau } = ajouterXp(credit.serveurId, credit.utilisateurId, gain);
  if (nouveauNiveau > ancienNiveau) {
    const membre = client.guilds.cache.get(credit.serveurId)?.members.cache.get(credit.utilisateurId);
    if (membre) void annoncerNiveau(membre, nouveauNiveau, null);
  }
});

function embedRang(serveur: Guild, utilisateur: User) {
  const rangee = lireXp(serveur.id, utilisateur.id);
  const progression = niveauDepuisXp(rangee.xp);
  const rang = rangDe(serveur.id, utilisateur.id);
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle(`⭐ NIVEAU DE ${utilisateur.displayName.toUpperCase()}`)
    .setThumbnail(utilisateur.displayAvatarURL({ size: 256 }))
    .setDescription(
      [
        `## Niveau ${progression.niveau}`,
        `**XP :** ${formaterNombre(progression.actuel)} / ${formaterNombre(progression.requis)}`,
        barreProgression(progression.actuel / progression.requis, 16),
        '',
        `• XP totale — **${formaterNombre(rangee.xp)}**`,
        `• Classement — **${rang ? `#${rang}` : '—'}**`,
      ].join('\n'),
    );
}

function pagesClassement(serveur: Guild) {
  const rangees = classement(serveur.id, 200);
  const lignes = rangees.map((r, i) => `${medaille(i + 1)} <@${r.utilisateur_id}> — Niveau **${r.niveau}** · ${formaterNombre(r.xp)} XP`);
  if (!lignes.length) lignes.push('*Personne n’a encore d’XP.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('🏆 CLASSEMENT').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

const optionMembre = (o: import('discord.js').SlashCommandUserOption) => o.setName('membre').setDescription('Qui (toi par défaut)');

const rang: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('rank').setDescription('Ton niveau').addUserOption(optionMembre),
  async executer(i) {
    await repondre(i, { embeds: [embedRang(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const niveau: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('level').setDescription('Le niveau d’un membre').addUserOption(optionMembre),
  async executer(i) {
    await repondre(i, { embeds: [embedRang(i.guild, i.options.getUser('membre') ?? i.user)] });
  },
};

const commandeClassement: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder().setName('leaderboard').setDescription('Le classement XP'),
  async executer(i) {
    await paginer(i, pagesClassement(i.guild));
  },
};

const commandeXp: CommandeSlash = {
  categorie: 'community',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Gérer l’XP et les rôles de niveau')
    .addSubcommand((s) =>
      s
        .setName('donner')
        .setDescription('Donner ou retirer de l’XP')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('quantite').setDescription('XP (négatif pour retirer)').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000)),
    )
    .addSubcommand((s) =>
      s
        .setName('niveau')
        .setDescription('Fixer le niveau d’un membre')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((s) => s.setName('reset').setDescription('Remettre à zéro un membre').addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('role-ajouter')
        .setDescription('Récompenser un niveau par un rôle')
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('role-retirer').setDescription('Retirer une récompense de niveau').addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('roles').setDescription('Les rôles de niveau')),
  async executer(i) {
    const sousCommande = i.options.getSubcommand();
    const serveur = i.guild;
    if (sousCommande === 'roles') {
      const rangees = rolesNiveau(serveur.id);
      return repondre(i, { embeds: [info(serveur, rangees.map((r) => `Niveau **${r.niveau}** → <@&${r.role_id}>`).join('\n') || 'Aucun rôle de niveau.', { titre: 'Rôles de niveau', sujet: '🏆' })], ephemeral: true });
    }
    if (sousCommande === 'role-ajouter') {
      const role = i.options.getRole('role', true);
      if (!rolesAttribuables(serveur, [role.id]).length) throw new ErreurUtilisateur('Je ne peux pas attribuer ce rôle (il est au-dessus du mien ou géré par une intégration).');
      poserRoleNiveau(serveur.id, i.options.getInteger('niveau', true), role.id);
      return repondre(i, { embeds: [ok(serveur, `Niveau **${i.options.getInteger('niveau', true)}** → <@&${role.id}>`)], ephemeral: true });
    }
    if (sousCommande === 'role-retirer') {
      const n = retirerRoleNiveau(serveur.id, i.options.getRole('role', true).id);
      return repondre(i, { embeds: [n ? ok(serveur, 'Récompense retirée.') : info(serveur, 'Ce rôle n’était pas une récompense de niveau.')], ephemeral: true });
    }
    const utilisateur = i.options.getUser('membre', true);
    let nouveauNiveau: number;
    if (sousCommande === 'donner') nouveauNiveau = ajouterXp(serveur.id, utilisateur.id, i.options.getInteger('quantite', true)).nouveauNiveau;
    else if (sousCommande === 'niveau') nouveauNiveau = poserXp(serveur.id, utilisateur.id, xpTotalePourNiveau(i.options.getInteger('niveau', true)));
    else nouveauNiveau = poserXp(serveur.id, utilisateur.id, 0);
    const membre = await serveur.members.fetch(utilisateur.id).catch(() => null);
    if (membre) await synchroniserRolesNiveau(membre, nouveauNiveau);
    return repondre(i, { embeds: [ok(serveur, `<@${utilisateur.id}> est maintenant niveau **${nouveauNiveau}** (${formaterNombre(lireXp(serveur.id, utilisateur.id).xp)} XP).`)], ephemeral: true });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'rank',
    alias: ['level', 'niveau'],
    domaine: 'general',
    categorie: 'community',
    description: 'Ton niveau',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const utilisateur = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [embedRang(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'top',
    alias: ['leaderboard', 'lb'],
    domaine: 'general',
    categorie: 'community',
    description: 'Le classement XP',
    async executer(message) {
      await message.reply({ embeds: [pagesClassement(message.guild)[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'xp',
  section: 'community',
  titre: 'XP & niveaux',
  emoji: '⭐',
  moduleId: 'xp',
  ordre: 1,
  description: 'Gain d’XP par message (avec cooldown) et en vocal (à plusieurs, non sourd).\n-# Rôles de niveau : `/xp role-ajouter`. Variables du message : `{mention}` `{user}` `{level}`',
  champs: [
    {
      genre: 'choice',
      cle: 'announce',
      libelle: 'Annonce des niveaux',
      options: [
        { valeur: 'same', libelle: 'Dans le salon du message', emoji: '💬' },
        { valeur: 'channel', libelle: 'Dans un salon dédié', emoji: '📢' },
        { valeur: 'dm', libelle: 'En message privé', emoji: '✉️' },
        { valeur: 'off', libelle: 'Aucune annonce', emoji: '🔕' },
      ],
      lire: (c) => c.xp.annonce,
      ecrire: (c, v) => void (c.xp.annonce = v as 'off' | 'same' | 'channel' | 'dm'),
    },
    { genre: 'channel', cle: 'channel', libelle: 'Salon des annonces de niveau', lire: (c) => c.xp.salonAnnonceId, ecrire: (c, v) => void (c.xp.salonAnnonceId = v) },
    {
      genre: 'channels',
      cle: 'noxp',
      libelle: 'Salons sans XP',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
      lire: (c) => c.xp.salonsSansXp,
      ecrire: (c, v) => void (c.xp.salonsSansXp = v),
    },
    { genre: 'toggle', cle: 'stack', libelle: 'Cumuler les rôles de niveau', lire: (c) => c.xp.cumulerRoles, ecrire: (c, v) => void (c.xp.cumulerRoles = v) },
    { genre: 'text', cle: 'message', libelle: 'Message de niveau', long: true, longueurMax: 500, obligatoire: true, lire: (c) => c.xp.messageNiveau, ecrire: (c, v) => void (c.xp.messageNiveau = v) },
    { genre: 'number', cle: 'min', libelle: 'XP min par message', min: 1, max: 500, lire: (c) => c.xp.min, ecrire: (c, v) => void (c.xp.min = v) },
    { genre: 'number', cle: 'max', libelle: 'XP max par message', min: 1, max: 1000, lire: (c) => c.xp.max, ecrire: (c, v) => void (c.xp.max = v) },
    { genre: 'number', cle: 'cooldown', libelle: 'Cooldown entre deux gains', min: 0, max: 3600, unite: 's', lire: (c) => c.xp.delaiSecondes, ecrire: (c, v) => void (c.xp.delaiSecondes = v) },
    { genre: 'number', cle: 'voice', libelle: 'XP par minute de vocal', min: 0, max: 100, lire: (c) => c.xp.xpVocalParMinute, ecrire: (c, v) => void (c.xp.xpVocalParMinute = v) },
  ],
};

export const moduleNiveaux: ModuleBot = {
  id: 'xp',
  nom: 'XP & niveaux',
  emoji: '⭐',
  description: 'XP messages et vocal, niveaux, rôles de niveau, classement',
  desactivable: true,
  actifParDefaut: false,
  commandes: [rang, niveau, commandeClassement, commandeXp],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  evenements: [sur('messageCreate', (m) => surMessage(m), 150)],
};
