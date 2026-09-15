import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from 'discord.js';
import { lireTout, lire, lireJson, executer } from '../../database/db';
import { couleurPour, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, historiser, resoudreSalonTexte } from '../../core/logService';
import { aNiveau } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { neutraliserMentions, identifiantDepuisTexte, tronquer } from '../../core/text';
import { bouton, construireFormulaire, rangee, type ChampFenetre } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';

interface Question {
  libelle: string;
  long: boolean;
  obligatoire: boolean;
}

interface DefinitionFormulaire {
  nom: string;
  titre: string;
  description: string;
  questions: Question[];
  salonId: string | null;
  integre?: boolean;
}

interface LigneFormulaire {
  id: number;
  nom: string;
  titre: string;
  description: string;
  questions: string;
  salon_id: string | null;
}

/** Formulaires intégrés : partenariat et candidature staff. */
function integre(serveur: Guild, nom: string): DefinitionFormulaire | null {
  const reglages = lireConfig(serveur.id);
  if (nom === 'partenariat') {
    return {
      nom,
      titre: '🤝 Candidature partenariat',
      description: 'Propose un partenariat avec la communauté.',
      salonId: reglages.formulaires.salonPartenariatsId ?? reglages.general.salonStaffId,
      integre: true,
      questions: [
        { libelle: 'Ton nom / pseudo', long: false, obligatoire: true },
        { libelle: 'Nom du serveur ou de la chaîne', long: false, obligatoire: true },
        { libelle: 'Description', long: true, obligatoire: true },
        { libelle: 'Lien (invitation, chaîne…)', long: false, obligatoire: true },
        { libelle: 'Pourquoi un partenariat ?', long: true, obligatoire: true },
      ],
    };
  }
  if (nom === 'staff') {
    return {
      nom,
      titre: '📋 Candidature staff',
      description: 'Rejoindre l’équipe de modération.',
      salonId: reglages.formulaires.salonCandidaturesId ?? reglages.general.salonStaffId,
      integre: true,
      questions: [
        { libelle: 'Âge', long: false, obligatoire: true },
        { libelle: 'Disponibilités', long: true, obligatoire: true },
        { libelle: 'Expérience de modération', long: true, obligatoire: true },
        { libelle: 'Motivation', long: true, obligatoire: true },
      ],
    };
  }
  return null;
}

function lireFormulaire(serveur: Guild, nom: string): DefinitionFormulaire | null {
  const b = integre(serveur, nom);
  if (b) return b;
  const r = lire<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? AND nom = ?', serveur.id, nom);
  return r ? { nom: r.nom, titre: r.titre, description: r.description, questions: lireJson<Question[]>(r.questions, []), salonId: r.salon_id } : null;
}

function fenetreFormulaire(formulaire: DefinitionFormulaire) {
  const champs: ChampFenetre[] = formulaire.questions.slice(0, 5).map((q, i) => ({ id: `q${i}`, libelle: q.libelle, long: q.long, obligatoire: q.obligatoire, longueurMax: q.long ? 1500 : 200 }));
  return construireFormulaire(`form:submit:${formulaire.nom}`, formulaire.titre, champs);
}

/** Questions en texte : une par ligne, « * » à la fin pour une réponse longue, « ? » au début pour facultative. */
export function lireQuestions(saisie: string): Question[] {
  return saisie
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => {
      const facultatif = l.startsWith('?');
      const long = l.endsWith('*');
      return { libelle: l.replace(/^\?/, '').replace(/\*$/, '').trim().slice(0, 45), long, obligatoire: !facultatif };
    })
    .filter((q) => q.libelle.length > 0);
}

async function soumettre(interaction: ModalSubmitInteraction<'cached'>, formulaire: DefinitionFormulaire) {
  const serveur = interaction.guild;
  const salon = resoudreSalonTexte(serveur, formulaire.salonId ?? lireConfig(serveur.id).general.salonStaffId);
  if (!salon) throw new ErreurUtilisateur('Ce formulaire n’a pas de salon de réception. Préviens le staff.');
  const answers = formulaire.questions.slice(0, 5).map((q, i) => ({ q: q.libelle, a: neutraliserMentions(interaction.fields.getTextInputValue(`q${i}`).trim()) }));
  const r = executer('INSERT INTO reponses_formulaires (serveur_id, formulaire, utilisateur_id, reponses, cree_le) VALUES (?, ?, ?, ?, ?)', serveur.id, formulaire.nom, interaction.user.id, JSON.stringify(answers), Date.now());
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur, 'info'))
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${formulaire.titre} — #${r.lastInsertRowid}`)
    .setDescription(`<@${interaction.user.id}> \`${interaction.user.id}\``)
    .addFields(answers.map((x) => ({ name: tronquer(x.q, 256), value: tronquer(x.a || '—', 1024), inline: false })))
    .setTimestamp();
  await salon.send({
    embeds: [embed],
    components: [rangee(bouton(`form:ok:${r.lastInsertRowid}`, 'Accepter', ButtonStyle.Success, '✅'), bouton(`form:no:${r.lastInsertRowid}`, 'Refuser', ButtonStyle.Danger, '❌'))],
    allowedMentions: { parse: [] },
  });
  historiser(serveur.id, 'community', `form-${formulaire.nom}`, interaction.user.id, interaction.user.id, { id: r.lastInsertRowid });
  void journal(serveur, 'community', { titre: 'Formulaire reçu', ton: 'info', lignes: [`**${formulaire.titre}** de <@${interaction.user.id}>`] });
  await interaction.reply({ embeds: [ok(serveur, 'Merci ! Ta réponse a bien été envoyée au staff. Tu recevras un message privé quand elle sera traitée.')], flags: MessageFlags.Ephemeral });
}

const partenariat: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 60,
  donnees: new SlashCommandBuilder().setName('partner').setDescription('Proposer un partenariat'),
  async executer(interaction) {
    await interaction.showModal(fenetreFormulaire(integre(interaction.guild, 'partenariat')!));
  },
};

const candidatureStaff: CommandeSlash = {
  categorie: 'community',
  delaiSecondes: 60,
  donnees: new SlashCommandBuilder().setName('staffapply').setDescription('Candidater pour le staff'),
  async executer(interaction) {
    await interaction.showModal(fenetreFormulaire(integre(interaction.guild, 'staff')!));
  },
};

const commandeFormulaire: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('form')
    .setDescription('Formulaires personnalisés')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Créer un formulaire')
        .addStringOption((o) => o.setName('titre').setDescription('Ex : Recrutement monteur').setRequired(true).setMaxLength(45))
        .addChannelOption((o) => o.setName('salon').setDescription('Où arrivent les réponses').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Poster le bouton d’un formulaire')
        .addStringOption((o) => o.setName('formulaire').setDescription('Le formulaire').setRequired(true).setAutocomplete(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Supprimer un formulaire')
        .addStringOption((o) => o.setName('formulaire').setDescription('Le formulaire').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Les formulaires')),
  async autocompletion(interaction) {
    const rangees = lireTout<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? ORDER BY nom', interaction.guildId);
    const options = [{ name: '🤝 Partenariat (intégré)', value: 'partenariat' }, { name: '📋 Candidature staff (intégré)', value: 'staff' }, ...rangees.map((r) => ({ name: tronquer(r.titre, 100), value: r.nom }))];
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(options.filter((o) => o.name.toLowerCase().includes(saisie)).slice(0, 25));
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    if (sousCommande === 'list') {
      const rangees = lireTout<LigneFormulaire>('SELECT * FROM formulaires WHERE serveur_id = ? ORDER BY nom', serveur.id);
      const lignes = ['🤝 **Partenariat** — intégré (`/partner`)', '📋 **Candidature staff** — intégré (`/staffapply`)', ...rangees.map((r) => `📝 **${r.titre}** \`${r.nom}\` — ${lireJson<Question[]>(r.questions, []).length} question(s) → <#${r.salon_id}>`)];
      return repondre(interaction, { embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setTitle('📝 Formulaires').setDescription(lignes.join('\n'))], ephemeral: true });
    }
    if (sousCommande === 'create') {
      const titre = interaction.options.getString('titre', true);
      const salon = interaction.options.getChannel('salon', true);
      return interaction.showModal(
        construireFormulaire(`form:create:${salon.id}`, `Questions — ${titre}`.slice(0, 45), [
          { id: 'title', libelle: 'Titre', valeur: titre, longueurMax: 45 },
          { id: 'description', libelle: 'Description du formulaire', obligatoire: false, longueurMax: 300 },
          { id: 'questions', libelle: 'Questions (une par ligne, 5 max)', long: true, longueurMax: 400, indication: 'Âge\nDisponibilités*\n?Lien vers ton portfolio\n(* = réponse longue, ? = facultative)' },
        ]),
      );
    }
    const nom = interaction.options.getString('formulaire', true);
    if (sousCommande === 'delete') {
      if (integre(serveur, nom)) throw new ErreurUtilisateur('Les formulaires intégrés se désactivent en coupant le module.');
      const r = executer('DELETE FROM formulaires WHERE serveur_id = ? AND nom = ?', serveur.id, nom);
      return repondre(interaction, { embeds: [ok(serveur, r.changes ? 'Formulaire supprimé.' : 'Introuvable.')], ephemeral: true });
    }
    const formulaire = lireFormulaire(serveur, nom);
    if (!formulaire) throw new ErreurUtilisateur('Formulaire introuvable.');
    const salon = (interaction.options.getChannel('salon') ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) return;
    const envoye = await salon.send({
      embeds: [new EmbedBuilder().setColor(couleurPour(serveur)).setTitle(formulaire.titre).setDescription(formulaire.description || 'Clique sur le bouton pour remplir le formulaire.')],
      components: [rangee(bouton(`form:open:${formulaire.nom}`, 'Remplir le formulaire', ButtonStyle.Primary, '📝'))],
    });
    return repondre(interaction, { embeds: [ok(serveur, `Bouton posté : ${envoye.url}`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'forms',
  section: 'community',
  titre: 'Formulaires',
  emoji: '📝',
  moduleId: 'forms',
  ordre: 15,
  description: 'Où arrivent les candidatures intégrées (`/partner`, `/staffapply`). Les formulaires personnalisés se créent avec `/form create`.',
  champs: [
    { kind: 'channel', cle: 'partner', libelle: 'Salon des partenariats', get: (c) => c.formulaires.salonPartenariatsId, set: (c, v) => void (c.formulaires.salonPartenariatsId = v) },
    { kind: 'channel', cle: 'staff', libelle: 'Salon des candidatures staff', get: (c) => c.formulaires.salonCandidaturesId, set: (c, v) => void (c.formulaires.salonCandidaturesId = v) },
  ],
};

export const moduleFormulaires: ModuleBot = {
  id: 'forms',
  nom: 'Formulaires',
  emoji: '📝',
  description: 'Partenariats, candidatures staff et formulaires personnalisés',
  desactivable: true,
  actifParDefaut: true,
  commandes: [partenariat, candidatureStaff, commandeFormulaire],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'form',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, argument]) {
        if (action === 'open') {
          const formulaire = lireFormulaire(interaction.guild, argument ?? '');
          if (!formulaire) throw new ErreurUtilisateur('Ce formulaire n’existe plus.');
          return interaction.showModal(fenetreFormulaire(formulaire));
        }
        if (!aNiveau(interaction.member, Niveau.STAFF)) throw new ErreurUtilisateur('Réservé au staff.');
        const sousCommande = lire<{ id: number; utilisateur_id: string; formulaire: string; statut: string }>('SELECT id, utilisateur_id, formulaire, statut FROM reponses_formulaires WHERE id = ? AND serveur_id = ?', Number(argument), interaction.guildId);
        if (!sousCommande) throw new ErreurUtilisateur('Réponse introuvable.');
        if (sousCommande.statut !== 'pending') throw new ErreurUtilisateur('Cette réponse a déjà été traitée.');
        const accepte = action === 'ok';
        executer('UPDATE reponses_formulaires SET statut = ?, traite_par = ? WHERE id = ?', accepte ? 'accepted' : 'denied', interaction.user.id, sousCommande.id);
        const formulaire = lireFormulaire(interaction.guild, sousCommande.formulaire);
        const utilisateur = await interaction.client.users.fetch(sousCommande.utilisateur_id).catch(() => null);
        await utilisateur
          ?.send({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild, accepte ? 'success' : 'error')).setDescription(`${accepte ? '✅' : '❌'} Ta réponse au formulaire **${formulaire?.titre ?? sousCommande.formulaire}** sur **${interaction.guild.name}** a été **${accepte ? 'acceptée' : 'refusée'}**.${accepte ? '\nLe staff va te recontacter.' : ''}`)] })
          .catch(() => undefined);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setColor(couleurPour(interaction.guild, accepte ? 'success' : 'error')).setFooter({ text: `${accepte ? 'Acceptée' : 'Refusée'} par ${interaction.user.tag}` });
        await interaction.update({ embeds: [embed], components: [] });
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, argument]) {
        if (action === 'submit') {
          const formulaire = lireFormulaire(interaction.guild, argument ?? '');
          if (!formulaire) throw new ErreurUtilisateur('Ce formulaire n’existe plus.');
          return soumettre(interaction, formulaire);
        }
        if (action === 'create') {
          if (!aNiveau(interaction.member, Niveau.ADMIN)) throw new ErreurUtilisateur('Réservé aux admins.');
          const titre = interaction.fields.getTextInputValue('title').trim();
          const questions = lireQuestions(interaction.fields.getTextInputValue('questions'));
          if (!questions.length) throw new ErreurUtilisateur('Ajoute au moins une question.');
          const nom = identifiantDepuisTexte(titre, 40);
          if (integre(interaction.guild, nom)) throw new ErreurUtilisateur('Ce nom est réservé.');
          executer(
            `INSERT INTO formulaires (serveur_id, nom, titre, description, questions, salon_id, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(serveur_id, nom) DO UPDATE SET titre = excluded.titre, description = excluded.description, questions = excluded.questions, salon_id = excluded.salon_id`,
            interaction.guildId,
            nom,
            titre,
            interaction.fields.getTextInputValue('description').trim(),
            JSON.stringify(questions),
            argument,
            Date.now(),
          );
          await interaction.reply({ embeds: [ok(interaction.guild, `Formulaire **${titre}** enregistré (\`${nom}\`, ${questions.length} question(s)).\nPoste son bouton avec \`/form panel\`.`)], flags: MessageFlags.Ephemeral });
        }
      },
    },
  ],
};
