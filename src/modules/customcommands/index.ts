import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client, type Guild, type Message } from 'discord.js';
import { lireTout, lire, executer } from '../../database/db';
import { lireAiguilleur } from '../../core/bot';
import { embedEnseigne, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { creerRegistre } from '../../core/logger';
import { moduleActif } from '../../core/moduleManager';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { construireFormulaire } from '../../core/ui';
import { remplirModele, aideVariables } from '../../core/variables';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

const registre = creerRegistre('commandes-perso');

interface LigneCommandePerso {
  serveur_id: string;
  nom: string;
  description: string;
  reponse: string;
  en_embed: number;
  commande_discord_id: string | null;
  utilisations: number;
}

const MOTIF_NOM = /^[a-z0-9_-]{1,32}$/;

function trouverCommande(serveurId: string, nom: string): LigneCommandePerso | undefined {
  return lire<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? AND nom = ?', serveurId, nom.toLowerCase());
}

function charge(serveur: Guild, rangee: LigneCommandePerso, contexte: Parameters<typeof remplirModele>[1]) {
  executer('UPDATE commandes_perso SET utilisations = utilisations + 1 WHERE serveur_id = ? AND nom = ?', rangee.serveur_id, rangee.nom);
  const texte = remplirModele(rangee.reponse, contexte);
  if (rangee.en_embed) return { embeds: [embedEnseigne(serveur).setDescription(tronquer(texte, 4096))], allowedMentions: { parse: [] as [] } };
  return { content: tronquer(texte, 2000), allowedMentions: { parse: [] as [] } };
}

/** Enregistre la commande comme commande slash du serveur (sans toucher aux commandes globales). */
async function enregistrerCommandeServeur(serveur: Guild, rangee: LigneCommandePerso): Promise<string | null> {
  if (lireAiguilleur().commandes.has(rangee.nom)) return null;
  try {
    const cree = await serveur.commands.create({ name: rangee.nom, description: tronquer(rangee.description || `Commande personnalisée /${rangee.nom}`, 100) });
    executer('UPDATE commandes_perso SET commande_discord_id = ? WHERE serveur_id = ? AND nom = ?', cree.id, serveur.id, rangee.nom);
    return cree.id;
  } catch (echec) {
    registre.avertir(`Commande /${rangee.nom} non enregistrée sur ${serveur.id} : ${(echec as Error).message}`);
    return null;
  }
}

async function retirerCommandeServeur(serveur: Guild, rangee: LigneCommandePerso): Promise<void> {
  if (rangee.commande_discord_id) await serveur.commands.delete(rangee.commande_discord_id).catch(() => undefined);
}

const commandePerso: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('customcommand')
    .setDescription('Commandes personnalisées')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Créer ou modifier une commande')
        .addStringOption((o) => o.setName('nom').setDescription('Ex : twitter (lettres, chiffres, - et _)').setRequired(true).setMaxLength(32))
        .addBooleanOption((o) => o.setName('embed').setDescription('Répondre dans un embed')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Supprimer une commande')
        .addStringOption((o) => o.setName('nom').setDescription('La commande').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les commandes personnalisées')),
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    const rangees = lireTout<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? ORDER BY nom', interaction.guildId);
    await interaction.respond(rangees.filter((r) => r.nom.includes(saisie)).slice(0, 25).map((r) => ({ name: r.nom, value: r.nom })));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    const prefixe = lireConfig(serveur.id).commandesPerso.prefixe;
    if (sousCommande === 'list') {
      const rangees = lireTout<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? ORDER BY nom', serveur.id);
      const lignes = rangees.map((r) => `**${prefixe}${r.nom}**${r.commande_discord_id ? ` · /${r.nom}` : ''} — ${tronquer(r.description || r.reponse, 60)} \`${r.utilisations}×\``);
      return repondre(interaction, { embeds: [info(serveur, lignes.join('\n') || 'Aucune commande personnalisée.', { titre: 'Commandes personnalisées', sujet: '🧩' })], ephemeral: true });
    }
    const nom = interaction.options.getString('nom', true).toLowerCase();
    if (sousCommande === 'remove') {
      const rangee = trouverCommande(serveur.id, nom);
      if (!rangee) throw new ErreurUtilisateur('Commande introuvable.');
      await retirerCommandeServeur(serveur, rangee);
      executer('DELETE FROM commandes_perso WHERE serveur_id = ? AND nom = ?', serveur.id, nom);
      return repondre(interaction, { embeds: [ok(serveur, `Commande **${nom}** supprimée.`)], ephemeral: true });
    }
    if (!MOTIF_NOM.test(nom)) throw new ErreurUtilisateur('Nom invalide : 1 à 32 caractères parmi a-z, 0-9, - et _.');
    const existant = trouverCommande(serveur.id, nom);
    await interaction.showModal(
      construireFormulaire(`cc:save:${nom}:${interaction.options.getBoolean('embed') ? 1 : existant?.en_embed ?? 0}`, `Commande ${prefixe}${nom}`.slice(0, 45), [
        { id: 'response', libelle: 'Réponse', long: true, valeur: existant?.reponse, longueurMax: 2000, indication: '🐦 Twitter : https://x.com/…  ({user}, {server}, {membercount})' },
        { id: 'description', libelle: 'Description (pour /help et la commande slash)', valeur: existant?.description, obligatoire: false, longueurMax: 100 },
      ]),
    );
  },
};

async function traiterSlash(interaction: ChatInputCommandInteraction<'cached'>): Promise<boolean> {
  if (!moduleActif(interaction.guildId, 'customcommands')) return false;
  const rangee = trouverCommande(interaction.guildId, interaction.commandName);
  if (!rangee) return false;
  await interaction.reply(charge(interaction.guild, rangee, { membre: interaction.member, serveur: interaction.guild, salon: interaction.channel }));
  return true;
}

async function traiterMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const prefixe = lireConfig(message.guildId).commandesPerso.prefixe;
  if (!prefixe || !message.content.startsWith(prefixe)) return;
  const nom = message.content.slice(prefixe.length).split(/\s+/)[0]?.toLowerCase();
  if (!nom || !MOTIF_NOM.test(nom)) return;
  const rangee = trouverCommande(message.guildId, nom);
  if (!rangee) return;
  await message.reply({ ...charge(message.guild, rangee, { membre: message.member, serveur: message.guild, salon: message.channel }), allowedMentions: { parse: [], repliedUser: false } });
}

const pageReglage: PageReglage = {
  id: 'customcommands',
  section: 'community',
  titre: 'Commandes personnalisées',
  emoji: '🧩',
  moduleId: 'customcommands',
  ordre: 8,
  description: `Des réponses rapides créées avec \`/customcommand add\`, utilisables avec le préfixe choisi et en commande slash du serveur.\n-# Variables : ${['user', 'username', 'server', 'membercount', 'brand', 'twitch'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    {
      kind: 'text',
      cle: 'prefix',
      libelle: 'Préfixe des commandes perso',
      maxLength: 5,
      required: true,
      get: (c) => c.commandesPerso.prefixe,
      set: (c, v) => void (c.commandesPerso.prefixe = v),
      validate: (v) => (/^\S{1,5}$/.test(v) ? null : '1 à 5 caractères sans espace.'),
    },
  ],
};

export const moduleCommandesPerso: ModuleBot = {
  id: 'customcommands',
  nom: 'Commandes personnalisées',
  emoji: '🧩',
  description: 'Réponses personnalisées en préfixe et en slash',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandePerso],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'cc',
      niveau: Niveau.ADMIN,
      async fenetre(interaction, [, nom, enEmbed]) {
        const serveur = interaction.guild;
        if (!nom || !MOTIF_NOM.test(nom)) throw new ErreurUtilisateur('Nom invalide.');
        const reponse = interaction.fields.getTextInputValue('response').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const nombre = lire<{ n: number }>('SELECT COUNT(*) AS n FROM commandes_perso WHERE serveur_id = ?', serveur.id)?.n ?? 0;
        const existant = trouverCommande(serveur.id, nom);
        if (!existant && nombre >= 100) throw new ErreurUtilisateur('100 commandes personnalisées maximum.');
        executer(
          `INSERT INTO commandes_perso (serveur_id, nom, description, reponse, en_embed, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(serveur_id, nom) DO UPDATE SET description = excluded.description, reponse = excluded.reponse, en_embed = excluded.en_embed`,
          serveur.id,
          nom,
          description,
          reponse,
          enEmbed === '1' ? 1 : 0,
          interaction.user.id,
          Date.now(),
        );
        const rangee = trouverCommande(serveur.id, nom)!;
        const slashId = rangee.commande_discord_id ?? (await enregistrerCommandeServeur(serveur, rangee));
        if (rangee.commande_discord_id && description !== existant?.description) {
          await serveur.commands.edit(rangee.commande_discord_id, { description: tronquer(description || `Commande personnalisée /${nom}`, 100) }).catch(() => undefined);
        }
        const prefixe = lireConfig(serveur.id).commandesPerso.prefixe;
        await interaction.reply({
          embeds: [ok(serveur, `Commande **${prefixe}${nom}** ${existant ? 'modifiée' : 'créée'}${slashId ? ` · aussi disponible en **/${nom}**` : ''}.\n\n**Variables :**\n${aideVariables(['user', 'username', 'server', 'membercount'])}`)],
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
  evenements: [sur('messageCreate', (m) => traiterMessage(m), 160)],
  async auDemarrage(client: Client<true>) {
    lireAiguilleur().surCommandeInconnue(traiterSlash);
    // Les commandes perso d'un serveur où le bot est revenu sont réenregistrées si besoin.
    for (const serveur of client.guilds.cache.values()) {
      for (const rangee of lireTout<LigneCommandePerso>('SELECT * FROM commandes_perso WHERE serveur_id = ? AND commande_discord_id IS NULL', serveur.id).slice(0, 20)) {
        await enregistrerCommandeServeur(serveur, rangee);
      }
    }
  },
};
