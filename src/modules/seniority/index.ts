import type { Client, Guild } from 'discord.js';
import { lireConfig } from '../../core/guildConfig';
import { journal } from '../../core/logService';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import { rolesAttribuables } from '../../core/permissions';
import type { ChampReglage, PageReglage } from '../../core/setup';
import { joursDepuis } from '../../core/time';
import type { ModuleBot } from '../../core/types';
import { donnerBadge } from '../../services/badges';

const registre = creerRegistre('anciennete');
const JOURS_DEFAUT = [30, 90, 180];

/** Rôles d'ancienneté : exemple 30 j → membre régulier, 90 j → ancien, 180 j → OG. */
export async function synchroniserAnciennete(serveur: Guild): Promise<number> {
  const reglages = lireConfig(serveur.id).anciennete;
  const paliers = reglages.paliers.filter((t) => t.roleId && t.days > 0).sort((a, b) => a.days - b.days);
  if (!paliers.length) return 0;
  const membres = await serveur.members.fetch().catch(() => serveur.members.cache);
  let changements = 0;
  const meilleurs = paliers[paliers.length - 1]!;
  for (const membre of membres.values()) {
    if (membre.user.bot || !membre.joinedTimestamp) continue;
    const jours = joursDepuis(membre.joinedTimestamp);
    const obtenus = paliers.filter((t) => jours >= t.days);
    const cible = reglages.stack ? obtenus : obtenus.slice(-1);
    const ciblesIds = new Set(cible.map((t) => t.roleId));
    const ajouter = rolesAttribuables(serveur, [...ciblesIds]).filter((r) => !membre.roles.cache.has(r.id));
    const retirer = reglages.stack ? [] : rolesAttribuables(serveur, paliers.map((t) => t.roleId)).filter((r) => !ciblesIds.has(r.id) && membre.roles.cache.has(r.id));
    if (ajouter.length) await membre.roles.add(ajouter, 'Ancienneté').then(() => changements++).catch(() => undefined);
    if (retirer.length) await membre.roles.remove(retirer, 'Ancienneté').catch(() => undefined);
    if (jours >= meilleurs.days) donnerBadge(serveur.id, membre.id, 'og');
  }
  if (changements) void journal(serveur, 'autorole', { titre: 'Rôles d’ancienneté', ton: 'ok', lignes: [`**${changements}** membre(s) ont reçu un nouveau rôle d’ancienneté.`] });
  return changements;
}

function champsPalier(indice: number): ChampReglage[] {
  return [
    {
      kind: 'role',
      cle: `role${indice}`,
      libelle: `Palier ${indice + 1} : rôle`,
      attribuable: true,
      get: (c) => c.anciennete.paliers[indice]?.roleId || null,
      set: (c, v) => {
        const paliers = [...c.anciennete.paliers];
        while (paliers.length <= indice) paliers.push({ days: JOURS_DEFAUT[paliers.length] ?? 365, roleId: '' });
        paliers[indice] = { ...paliers[indice]!, roleId: v ?? '' };
        c.anciennete.paliers = paliers;
      },
    },
  ];
}

function champJours(indice: number): ChampReglage {
  return {
    kind: 'number',
    cle: `days${indice}`,
    libelle: `Palier ${indice + 1} : jours`,
    min: 1,
    max: 3650,
    unit: 'j',
    get: (c) => c.anciennete.paliers[indice]?.days ?? JOURS_DEFAUT[indice] ?? 365,
    set: (c, v) => {
      const paliers = [...c.anciennete.paliers];
      while (paliers.length <= indice) paliers.push({ days: JOURS_DEFAUT[paliers.length] ?? 365, roleId: '' });
      paliers[indice] = { ...paliers[indice]!, days: v };
      c.anciennete.paliers = paliers;
    },
  };
}

const pageReglage: PageReglage = {
  id: 'seniority',
  section: 'roles',
  titre: 'Ancienneté',
  emoji: '🏆',
  moduleId: 'seniority',
  ordre: 3,
  description: 'Des rôles donnés automatiquement selon le temps passé sur le serveur (vérifié toutes les 6 heures).\n-# Par défaut : 30 j, 90 j, 180 j (OG).',
  champs: [
    ...champsPalier(0),
    ...champsPalier(1),
    ...champsPalier(2),
    { kind: 'toggle', cle: 'stack', libelle: 'Cumuler les paliers', get: (c) => c.anciennete.stack, set: (c, v) => void (c.anciennete.stack = v) },
    champJours(0),
    champJours(1),
    champJours(2),
  ],
  actions: [
    {
      id: 'sync',
      libelle: 'Appliquer maintenant',
      emoji: '🔄',
      async executer(interaction) {
        await interaction.deferReply({ flags: 64 });
        const n = await synchroniserAnciennete(interaction.guild);
        await interaction.editReply({ content: `✅ ${n} membre(s) mis à jour.` });
      },
    },
  ],
};

export const moduleAnciennete: ModuleBot = {
  id: 'seniority',
  nom: 'Ancienneté',
  emoji: '🏆',
  description: 'Rôles automatiques selon l’ancienneté (régulier, ancien, OG)',
  desactivable: true,
  actifParDefaut: true,
  pagesReglage: [pageReglage],
  taches: [
    {
      nom: 'seniority-sync',
      intervalleMs: 6 * 3_600_000,
      async executer(client: Client<true>) {
        for (const serveur of client.guilds.cache.values()) {
          if (!moduleActif(serveur.id, 'seniority') || !lireConfig(serveur.id).anciennete.paliers.some((t) => t.roleId)) continue;
          await synchroniserAnciennete(serveur).catch((echec: Error) => registre.avertir(`Ancienneté ${serveur.id} : ${echec.message}`));
        }
      },
    },
  ],
};
