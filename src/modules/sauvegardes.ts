import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder, type Guild, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { oublierEnseignes, viderCacheWhitelists } from '../coeur/acces';
import { demanderConfirmation, info, ok, repondre } from '../coeur/affichage';
import { executer, lire, lireTout, transaction } from '../coeur/base';
import { journal } from '../coeur/journaux';
import { type CommandeSlash, type ModuleBot } from '../coeur/noyau';
import { creerRegistre, environnement, ErreurUtilisateur, marqueTemps, Niveau } from '../coeur/outils';
import { moduleActif, viderCacheConfig, viderCacheModules } from '../coeur/reglages';

export const TABLES: { table: string; filtre: string }[] = [
  { table: 'reglages_serveurs', filtre: 'serveur_id = ?' },
  { table: 'modules_serveurs', filtre: 'serveur_id = ?' },
  { table: 'whitelists', filtre: 'portee = ?' },
  { table: 'chaines_twitch', filtre: 'serveur_id = ?' },
  { table: 'panneaux_roles', filtre: 'serveur_id = ?' },
  { table: 'commandes_perso', filtre: 'serveur_id = ?' },
  { table: 'reponses_auto', filtre: 'serveur_id = ?' },
  { table: 'roles_niveaux', filtre: 'serveur_id = ?' },
  { table: 'badges', filtre: 'serveur_id = ?' },
  { table: 'articles_boutique', filtre: 'serveur_id = ?' },
  { table: 'formulaires', filtre: 'serveur_id = ?' },
  { table: 'liste_noire', filtre: 'portee = ?' },
];

export interface FichierSauvegarde {
  version: 1;
  serveurId: string;
  nomServeur: string;
  createdAt: number;
  tables: Record<string, Record<string, unknown>[]>;
  entrees: Record<string, unknown>[];
  structure: { roles: { nom: string; couleur: number; position: number }[]; salons: { nom: string; type: number; parent: string | null }[] };
}

function dossierDe(serveurId: string): string {
  const dossier = path.join(environnement.dossierSauvegardes, serveurId);
  fs.mkdirSync(dossier, { recursive: true });
  return dossier;
}

export function creerSauvegarde(serveur: Guild, creePar: string, nom = 'manuelle'): { id: number; file: string; size: number; data: FichierSauvegarde } {
  const tables: FichierSauvegarde['tables'] = {};
  for (const { table, filtre } of TABLES) tables[table] = lireTout<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${filtre}`, serveur.id);
  const panneauxIds = (tables.panneaux_roles ?? []).map((r) => Number(r.id));
  const entrees = panneauxIds.length ? lireTout<Record<string, unknown>>(`SELECT * FROM roles_panneaux WHERE panneau_id IN (${panneauxIds.map(() => '?').join(',')})`, ...panneauxIds) : [];
  const donnees: FichierSauvegarde = {
    version: 1,
    serveurId: serveur.id,
    nomServeur: serveur.name,
    createdAt: Date.now(),
    tables,
    entrees,
    structure: {
      roles: serveur.roles.cache.filter((r) => r.id !== serveur.id && !r.managed).map((r) => ({ nom: r.name, couleur: r.color, position: r.position })),
      salons: serveur.channels.cache.map((c) => ({ nom: c.name, type: c.type, parent: c.parent?.name ?? null })),
    },
  };
  const json = JSON.stringify(donnees);
  const fichier = path.join(dossierDe(serveur.id), `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(fichier, json, { mode: 0o600 });
  const r = executer('INSERT INTO sauvegardes (serveur_id, nom, fichier, taille, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?)', serveur.id, nom, fichier, json.length, creePar, Date.now());
  return { id: r.lastInsertRowid, file: fichier, size: json.length, data: donnees };
}

export function listerSauvegardes(serveurId: string): { id: number; nom: string; fichier: string; taille: number; cree_par: string; cree_le: number }[] {
  return lireTout('SELECT id, nom, fichier, taille, cree_par, cree_le FROM sauvegardes WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 25', serveurId);
}

export function purgerSauvegardesAuto(serveurId: string, garder = 7): void {
  const autos = lireTout<{ id: number; fichier: string }>("SELECT id, fichier FROM sauvegardes WHERE serveur_id = ? AND nom = 'automatique' ORDER BY cree_le DESC", serveurId);
  for (const ancien of autos.slice(garder)) {
    fs.rmSync(ancien.fichier, { force: true });
    executer('DELETE FROM sauvegardes WHERE id = ?', ancien.id);
  }
}

export function restaurerSauvegarde(serveurId: string, sauvegardeId: number): { tables: number; rows: number } {
  const rangee = lire<{ fichier: string }>('SELECT fichier FROM sauvegardes WHERE id = ? AND serveur_id = ?', sauvegardeId, serveurId);
  if (!rangee || !fs.existsSync(rangee.fichier)) throw new Error('Sauvegarde introuvable');
  const donnees = JSON.parse(fs.readFileSync(rangee.fichier, 'utf8')) as FichierSauvegarde;
  if (donnees.version !== 1 || donnees.serveurId !== serveurId) throw new Error('Cette sauvegarde ne correspond pas à ce serveur');
  let rangees = 0;
  transaction(() => {
    const anciensPanneaux = lireTout<{ id: number }>('SELECT id FROM panneaux_roles WHERE serveur_id = ?', serveurId).map((p) => p.id);
    for (const id of anciensPanneaux) executer('DELETE FROM roles_panneaux WHERE panneau_id = ?', id);
    for (const { table, filtre } of TABLES) {
      executer(`DELETE FROM ${table} WHERE ${filtre}`, serveurId);
      for (const enregistrer of donnees.tables[table] ?? []) {
        const cles = Object.keys(enregistrer);
        if (!cles.length || cles.some((k) => !/^[a-z_]+$/.test(k))) continue;
        executer(`INSERT INTO ${table} (${cles.join(', ')}) VALUES (${cles.map(() => '?').join(', ')})`, ...cles.map((k) => enregistrer[k] as string | number | null));
        rangees++;
      }
    }
    for (const enregistrer of donnees.entrees ?? []) {
      const cles = Object.keys(enregistrer);
      if (cles.some((k) => !/^[a-z_]+$/.test(k))) continue;
      executer(`INSERT OR IGNORE INTO roles_panneaux (${cles.join(', ')}) VALUES (${cles.map(() => '?').join(', ')})`, ...cles.map((k) => enregistrer[k] as string | number | null));
      rangees++;
    }
  });
  viderCacheConfig(serveurId);
  viderCacheModules(serveurId);
  viderCacheWhitelists();
  return { tables: TABLES.length, rows: rangees };
}

const registre = creerRegistre('sauvegarde');

const sauvegarde: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.STREAMER,
  donnees: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegardes')
    .addSubcommand((s) => s.setName('create').setDescription('Sauvegarder'))
    .addSubcommand((s) => s.setName('list').setDescription('Les sauvegardes'))
    .addSubcommand((s) =>
      s
        .setName('restore')
        .setDescription('Restaurer une sauvegarde')
        .addIntegerOption((o) => o.setName('sauvegarde').setDescription('La sauvegarde').setRequired(true).setAutocomplete(true)),
    ),
  niveauxSousCommandes: { list: Niveau.ADMIN, create: Niveau.ADMIN },
  async autocompletion(interaction) {
    await interaction.respond(
      listerSauvegardes(interaction.guildId).map((b) => ({ name: `#${b.id} · ${b.nom} · ${new Date(b.cree_le).toLocaleString('fr-FR')} · ${Math.round(b.taille / 1024)} Ko`.slice(0, 100), value: b.id })),
    );
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const b = creerSauvegarde(serveur, interaction.user.id);
      void journal(serveur, 'backup', {
        titre: 'Sauvegarde créée',
        ton: 'ok',
        lignes: [`**#${b.id}** · ${Math.round(b.size / 1024)} Ko`],
        fichiers: [new AttachmentBuilder(Buffer.from(JSON.stringify(b.data, null, 2)), { name: `sauvegarde-${serveur.id}-${b.id}.json` })],
        par: interaction.user,
      });
      return interaction.editReply({ embeds: [ok(serveur, `Sauvegarde **#${b.id}** créée (${Math.round(b.size / 1024)} Ko).\n-# Réglages, modules, whitelists, Twitch, rôles à choisir, commandes perso, auto-réponses, badges, boutique, formulaires et blacklist.`)] });
    }
    if (sousCommande === 'list') {
      const lignes = listerSauvegardes(serveur.id).map((b) => `**#${b.id}** · ${b.nom} · ${marqueTemps(b.cree_le, 'f')} · ${Math.round(b.taille / 1024)} Ko · <@${b.cree_par}>`);
      return repondre(interaction, { embeds: [info(serveur, lignes.join('\n') || 'Aucune sauvegarde.', { titre: 'Sauvegardes', sujet: '💾' })], ephemeral: true });
    }
    const id = interaction.options.getInteger('sauvegarde', true);
    if (!listerSauvegardes(serveur.id).some((b) => b.id === id)) throw new ErreurUtilisateur('Sauvegarde introuvable.');
    return demanderConfirmation(interaction, {
      titre: 'Restaurer la sauvegarde ?',
      description: `La configuration actuelle du bot sur ce serveur sera **remplacée** par la sauvegarde **#${id}**.\nUne sauvegarde de l’état actuel est créée juste avant. Les salons et rôles Discord ne sont pas modifiés.`,
      libelleConfirmation: 'Restaurer',
      surConfirmation: async (i) => {
        await i.update({ embeds: [info(serveur, 'Restauration en cours…')], components: [] });
        const securite = creerSauvegarde(serveur, i.user.id, 'avant restauration');
        const resultat = restaurerSauvegarde(serveur.id, id);
        oublierEnseignes();
        void journal(serveur, 'backup', { titre: 'Sauvegarde restaurée', ton: 'alerte', lignes: [`**#${id}** restaurée (${resultat.rows} élément(s))`, `Sauvegarde de sécurité : #${securite.id}`], par: i.user });
        await i.editReply({ embeds: [ok(serveur, `Sauvegarde **#${id}** restaurée (${resultat.rows} élément(s)).\n-# Sauvegarde de sécurité créée avant : **#${securite.id}**.`)] });
      },
    });
  },
};

export const moduleSauvegardes: ModuleBot = {
  id: 'backup',
  nom: 'Sauvegardes',
  emoji: '💾',
  description: 'Sauvegardes manuelles et quotidiennes de la configuration',
  desactivable: true,
  actifParDefaut: true,
  commandes: [sauvegarde],
  taches: [
    {
      nom: 'backup-daily',
      intervalleMs: 24 * 3_600_000,
      async executer(client) {
        for (const serveur of client.guilds.cache.values()) {
          if (!moduleActif(serveur.id, 'backup')) continue;
          try {
            creerSauvegarde(serveur, client.user.id, 'automatique');
            purgerSauvegardesAuto(serveur.id);
          } catch (echec) {
            registre.avertir(`Sauvegarde automatique ${serveur.id} en échec : ${(echec as Error).message}`);
          }
        }
      },
    },
  ],
};
