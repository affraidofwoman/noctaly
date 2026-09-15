import { SlashCommandBuilder } from 'discord.js';
import { embedEnseigne } from '../../core/embeds';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { moduleActif } from '../../core/moduleManager';
import { botPeutGererRole } from '../../core/permissions';
import { lirePageReglage, afficherPage, type PageReglage } from '../../core/setup';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { donnerRolesAuto } from '../../services/autorole';

const pageReglage: PageReglage = {
  id: 'autorole',
  section: 'welcome',
  titre: 'Rôles automatiques',
  emoji: '🎭',
  moduleId: 'autorole',
  ordre: 3,
  description:
    'Rôles donnés automatiquement à l’arrivée. Les rôles placés au-dessus du bot sont ignorés.\n-# Si la vérification est active, les rôles membres sont donnés après vérification.',
  champs: [
    { kind: 'roles', cle: 'members', libelle: 'Rôles des membres', attribuable: true, max: 10, get: (c) => c.rolesAuto.rolesMembres, set: (c, v) => void (c.rolesAuto.rolesMembres = v) },
    { kind: 'roles', cle: 'bots', libelle: 'Rôles des bots', attribuable: true, max: 10, get: (c) => c.rolesAuto.rolesBots, set: (c, v) => void (c.rolesAuto.rolesBots = v) },
    { kind: 'number', cle: 'delay', libelle: 'Délai avant attribution', min: 0, max: 600, unit: 's', get: (c) => c.rolesAuto.delaiSecondes, set: (c, v) => void (c.rolesAuto.delaiSecondes = v) },
  ],
};

const rolesAuto: CommandeSlash = {
  categorie: 'roles',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder().setName('autorole').setDescription('Rôles donnés à l’arrivée'),
  async executer(interaction) {
    const page = lirePageReglage('autorole');
    if (page) return repondre(interaction, { ...afficherPage(interaction.guild, page), ephemeral: true });
    const reglages = lireConfig(interaction.guildId).rolesAuto;
    const liste = (ids: string[]) =>
      ids.map((id) => {
        const role = interaction.guild.roles.cache.get(id);
        return `• <@&${id}>${role && !botPeutGererRole(interaction.guild, role) ? ' ⚠️ au-dessus du bot' : ''}`;
      });
    return repondre(interaction, {
      embeds: [embedEnseigne(interaction.guild).setTitle('🎭 Rôles automatiques').setDescription([...liste(reglages.rolesMembres), ...liste(reglages.rolesBots)].join('\n') || '—')],
      ephemeral: true,
    });
  },
};

export const moduleRolesAuto: ModuleBot = {
  id: 'autorole',
  nom: 'Rôles automatiques',
  emoji: '🎭',
  description: 'Rôles donnés à l’arrivée (membres et bots)',
  desactivable: true,
  actifParDefaut: true,
  commandes: [rolesAuto],
  pagesReglage: [pageReglage],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      const serveur = membre.guild;
      const reglages = lireConfig(serveur.id);
      if (membre.user.bot) {
        await donnerRolesAuto(membre, 'bot');
        return;
      }
      // La vérification donne elle-même les rôles membres une fois le membre vérifié.
      if (moduleActif(serveur.id, 'verification') && reglages.verification.roleVerifieId) return;
      const delai = reglages.rolesAuto.delaiSecondes * 1000;
      if (delai > 0) {
        setTimeout(() => {
          void serveur.members
            .fetch(membre.id)
            .then((m) => donnerRolesAuto(m, 'member'))
            .catch(() => undefined);
        }, delai).unref();
        return;
      }
      await donnerRolesAuto(membre, 'member');
    }, 45),
  ],
};
