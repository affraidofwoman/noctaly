import { PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type User } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { embedEnseigne } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import { lignesEnPages, paginer } from '../../core/pagination';
import type { PageReglage } from '../../core/setup';
import { medaille } from '../../core/text';
import { joursDepuis } from '../../core/time';
import { sur, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';

const registre = creerRegistre('invitations');

/** Nombre d'utilisations connu par code, par serveur. */
const instantanes = new Map<string, Map<string, { uses: number; inviterId: string | null }>>();

async function instantane(serveur: Guild): Promise<Map<string, { uses: number; inviterId: string | null }> | null> {
  if (!serveur.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invitations = await serveur.invites.fetch().catch(() => null);
  if (!invitations) return null;
  const correspondance = new Map<string, { uses: number; inviterId: string | null }>();
  for (const invitationDiscord of invitations.values()) correspondance.set(invitationDiscord.code, { uses: invitationDiscord.uses ?? 0, inviterId: invitationDiscord.inviterId });
  if (serveur.vanityURLCode) {
    const lienPerso = await serveur.fetchVanityData().catch(() => null);
    if (lienPerso) correspondance.set(`vanity:${lienPerso.code}`, { uses: lienPerso.uses, inviterId: null });
  }
  return correspondance;
}

function comptes(serveurId: string, utilisateurId: string): { total: number; valid: number; faux: number; left: number } {
  const r = lire<{ total: number; faux: number; partis: number }>(
    'SELECT COUNT(*) AS total, SUM(faux) AS faux, SUM(CASE WHEN parti_le IS NOT NULL AND faux = 0 THEN 1 ELSE 0 END) AS partis FROM invitations WHERE serveur_id = ? AND parrain_id = ?',
    serveurId,
    utilisateurId,
  );
  const total = r?.total ?? 0;
  const faux = r?.faux ?? 0;
  const partis = r?.partis ?? 0;
  return { total, valid: total - faux - partis, faux, left: partis };
}

async function surArrivee(membre: GuildMember): Promise<void> {
  if (membre.user.bot) return;
  const serveur = membre.guild;
  const avant = instantanes.get(serveur.id);
  const apres = await instantane(serveur);
  if (!apres) return;
  instantanes.set(serveur.id, apres);
  let code: string | null = null;
  let parrainId: string | null = null;
  if (avant) {
    for (const [c, donnees] of apres) {
      if (donnees.uses > (avant.get(c)?.uses ?? 0)) {
        code = c;
        parrainId = donnees.inviterId;
        break;
      }
    }
    // Invitation à usage unique supprimée après utilisation.
    if (!code) {
      const disparues = [...avant.entries()].filter(([c]) => !apres.has(c));
      if (disparues.length === 1) {
        code = disparues[0]![0];
        parrainId = disparues[0]![1].inviterId;
      }
    }
  }
  const faux = joursDepuis(membre.user.createdTimestamp) < lireConfig(serveur.id).invitations.joursCompteFaux || parrainId === membre.id ? 1 : 0;
  executer(
    `INSERT INTO invitations (serveur_id, invite_id, parrain_id, code, arrive_le, faux) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(serveur_id, invite_id) DO UPDATE SET parrain_id = excluded.parrain_id, code = excluded.code, arrive_le = excluded.arrive_le, parti_le = NULL, faux = excluded.faux`,
    serveur.id,
    membre.id,
    parrainId,
    code,
    Date.now(),
    faux,
  );
  const texte = code?.startsWith('vanity:')
    ? `<@${membre.id}> a rejoint via le lien personnalisé **${code.slice(7)}**.`
    : parrainId
      ? `<@${membre.id}> a été invité par <@${parrainId}> (\`${code}\`) — **${comptes(serveur.id, parrainId).valid}** invitation(s) valides.`
      : `<@${membre.id}> a rejoint, invitation inconnue.`;
  void journal(serveur, 'invite', { titre: 'Invitation utilisée', ton: faux ? 'alerte' : 'ok', lignes: [texte, faux ? '⚠️ Compte récent : compté comme **fake**.' : null] });
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).invitations.channelId);
  if (salon) await salon.send({ content: `📨 ${texte}`, allowedMentions: { parse: [] } }).catch(() => undefined);
}

function embedInvitations(serveur: Guild, utilisateur: User) {
  const c = comptes(serveur.id, utilisateur.id);
  return embedEnseigne(serveur)
    .setAuthor({ name: utilisateur.tag, iconURL: utilisateur.displayAvatarURL({ size: 64 }) })
    .setTitle('📨 INVITATIONS')
    .setDescription([`• Invitations — **${c.total}**`, `• Validées — **${c.valid}**`, `• Fake / parties — **${c.faux + c.left}**`, `-# ${c.faux} fake · ${c.left} parti(s)`].join('\n'));
}

function pagesClassement(serveur: Guild) {
  const rangees = lireTout<{ parrain_id: string; valides: number }>(
    'SELECT parrain_id, SUM(CASE WHEN faux = 0 AND parti_le IS NULL THEN 1 ELSE 0 END) AS valides FROM invitations WHERE serveur_id = ? AND parrain_id IS NOT NULL GROUP BY parrain_id HAVING valides > 0 ORDER BY valides DESC LIMIT 100',
    serveur.id,
  );
  const lignes = rangees.map((r, i) => `${medaille(i + 1)} <@${r.parrain_id}> — **${r.valides}** invitation(s)`);
  if (!lignes.length) lignes.push('*Aucune invitation suivie pour l’instant.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) => embedEnseigne(serveur).setTitle('🏆 Classement des invitations').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

const invitations: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Tes invitations')
    .addUserOption((o) => o.setName('membre').setDescription('Qui (toi par défaut)'))
    .addBooleanOption((o) => o.setName('classement').setDescription('Voir le classement')),
  async executer(interaction) {
    if (interaction.options.getBoolean('classement')) return paginer(interaction, pagesClassement(interaction.guild));
    return repondre(interaction, { embeds: [embedInvitations(interaction.guild, interaction.options.getUser('membre') ?? interaction.user)] });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'invites',
    alias: ['invs'],
    domaine: 'general',
    categorie: 'community',
    description: 'Tes invitations',
    usage: '[membre]',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '');
      const utilisateur = id ? await message.client.users.fetch(id).catch(() => message.author) : message.author;
      await message.reply({ embeds: [embedInvitations(message.guild, utilisateur)], allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'invites',
  section: 'community',
  titre: 'Invitations',
  emoji: '📨',
  moduleId: 'invites',
  ordre: 12,
  description: 'Qui a invité qui. Nécessite la permission « Gérer le serveur ». Les comptes trop récents comptent comme fake.',
  champs: [
    { kind: 'channel', cle: 'channel', libelle: 'Salon des arrivées (facultatif)', get: (c) => c.invitations.channelId, set: (c, v) => void (c.invitations.channelId = v) },
    { kind: 'number', cle: 'fake', libelle: 'Compte « fake » si plus jeune que', min: 0, max: 365, unit: 'j', get: (c) => c.invitations.joursCompteFaux, set: (c, v) => void (c.invitations.joursCompteFaux = v) },
  ],
};

export const moduleInvitations: ModuleBot = {
  id: 'invites',
  nom: 'Invitations',
  emoji: '📨',
  description: 'Suivi des invitations, fakes et classement',
  desactivable: true,
  actifParDefaut: true,
  commandes: [invitations],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  evenements: [
    sur('guildMemberAdd', (m) => surArrivee(m), 30),
    sur('guildMemberRemove', (m) => {
      executer('UPDATE invitations SET parti_le = ? WHERE serveur_id = ? AND invite_id = ?', Date.now(), m.guild.id, m.id);
    }),
    sur('inviteCreate', (invitation) => {
      if (!invitation.guild) return;
      instantanes.get(invitation.guild.id)?.set(invitation.code, { uses: invitation.uses ?? 0, inviterId: invitation.inviterId });
    }),
    sur('inviteDelete', (invitation) => {
      if (!invitation.guild) return;
      // On garde le code un moment pour détecter les invitations à usage unique.
      setTimeout(() => instantanes.get(invitation.guild!.id)?.delete(invitation.code), 10_000).unref();
    }),
  ],
  async auDemarrage(client) {
    for (const serveur of client.guilds.cache.values()) {
      if (!moduleActif(serveur.id, 'invites')) continue;
      const cliche = await instantane(serveur).catch(() => null);
      if (cliche) instantanes.set(serveur.id, cliche);
    }
    registre.info(`Invitations suivies sur ${instantanes.size} serveur(s).`);
  },
};
