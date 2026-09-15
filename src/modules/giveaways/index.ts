import {
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from 'discord.js';
import { lireJson } from '../../database/db';
import { emojiPour } from '../../core/brand';
import { embedEnseigne, erreur, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { resoudreSalonTexte } from '../../core/logService';
import { lignesEnPages, paginer } from '../../core/pagination';
import { aAcces } from '../../core/permissions';
import { resoudreRole } from '../../core/resolve';
import type { PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { lireDuree, marqueTemps } from '../../core/time';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import {
  construireMessageTirage,
  decrireConditions,
  tiragesEchus,
  terminerTirage,
  lireTirage,
  tiragesDuServeur,
  participerTirage,
  quitterTirage,
  nombreParticipants,
  mettreTirageEnPause,
  rafraichirMessage,
  conditionsDe,
  relancerTirage,
  reprendreTirage,
  lancerTirage,
  type ConditionsTirage,
  type LigneTirage,
} from '../../services/giveaways';

const DUREE_MAX = 60 * 86_400_000;
const aRafraichir = new Set<number>();

function exigerTirage(serveurId: string, id: number | string | null | undefined): LigneTirage {
  const g = lireTirage(Number(id));
  if (!g || g.serveur_id !== serveurId) throw new ErreurUtilisateur('Giveaway introuvable.');
  return g;
}

function libelle(g: LigneTirage): string {
  const etat = g.statut === 'running' ? '🟢' : g.statut === 'paused' ? '⏸️' : '⚫';
  return tronquer(`${etat} #${g.id} · ${g.lot}`, 100);
}

// ─── Menu façon Airline ────────────────────────────────────────────────────

function menu(serveur: Guild, note?: string) {
  const lireTout = tiragesDuServeur(serveur.id);
  const enCours = lireTout.filter((g) => g.statut === 'running').length;
  const termine = lireTout.filter((g) => g.statut === 'ended').length;
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'cadeau')} Giveaways`)
    .setDescription(
      [
        note,
        '**Lancer** — tu écris le lot, le nombre de gagnants et la durée.',
        '**Arrêter** — tire les gagnants tout de suite, sans attendre la fin.',
        '**Retirer au sort** — refait le tirage d’un giveaway déjà fini.',
        '',
        `${enCours} en cours · ${termine} terminé${termine > 1 ? 's' : ''} sur ce serveur.`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      rangee(
        bouton('gwm:create', 'Lancer', ButtonStyle.Success, emojiPour(serveur.id, 'cadeau')),
        bouton('gwm:end', 'Arrêter', ButtonStyle.Danger, '⏹️'),
        bouton('gwm:reroll', 'Retirer au sort', ButtonStyle.Secondary, '🔁'),
        bouton('gwm:list', 'Liste', ButtonStyle.Secondary, '📋'),
      ),
    ],
  };
}

function menuChoix(serveur: Guild, action: 'end' | 'reroll') {
  const liste = tiragesDuServeur(serveur.id).filter((g) => (action === 'end' ? g.statut !== 'ended' : g.statut === 'ended' && nombreParticipants(g.id) > 0));
  if (!liste.length) return null;
  return rangee(
    new StringSelectMenuBuilder()
      .setCustomId(`gwm:pick:${action}`)
      .setPlaceholder(action === 'end' ? 'Lequel arrêter maintenant ?' : 'Lequel retirer au sort ?')
      .addOptions(liste.slice(0, 25).map((g) => ({ label: libelle(g), value: String(g.id), description: `${nombreParticipants(g.id)} participant(s) · ${g.nombre_gagnants} gagnant(s)` }))),
  );
}

function pagesListe(serveur: Guild) {
  const lignes = tiragesDuServeur(serveur.id).map((g) => {
    const gagnants = lireJson<string[]>(g.gagnants, []);
    const etat = g.statut === 'running' ? `fin ${marqueTemps(g.fin_le, 'R')}` : g.statut === 'paused' ? 'en pause' : gagnants.length ? `gagné par ${gagnants.map((w) => `<@${w}>`).join(', ')}` : 'sans gagnant';
    return `${libelle(g)}\n-# ${nombreParticipants(g.id)} participant(s) · ${etat}${g.message_id ? ` · [message](https://discord.com/channels/${g.serveur_id}/${g.salon_id}/${g.message_id})` : ''}`;
  });
  if (!lignes.length) lignes.push('*Aucun giveaway.*');
  return lignesEnPages(lignes, 8, (contenu, page, total) => embedEnseigne(serveur).setTitle('🎉 Giveaways').setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }));
}

// ─── Commande ──────────────────────────────────────────────────────────────

const optionId = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('id').setDescription('Le giveaway').setRequired(true).setAutocomplete(true);

const tirage: CommandeSlash = {
  categorie: 'giveaways',
  niveau: Niveau.STAFF,
  whitelist: 'giveaway',
  donnees: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Les giveaways')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lancer un giveaway')
        .addStringOption((o) => o.setName('recompense').setDescription('Ce qu’on gagne').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duree').setDescription('Ex : 30m, 1h, 2j, 1h30m').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Combien de gagnants (1 par défaut)').setMinValue(1).setMaxValue(50))
        .addChannelOption((o) => o.setName('salon').setDescription('Où (salon giveaways par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle obligatoire'))
        .addIntegerOption((o) => o.setName('niveau').setDescription('Niveau XP minimum').setMinValue(1).setMaxValue(500))
        .addIntegerOption((o) => o.setName('compte').setDescription('Âge minimum du compte Discord (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('anciennete').setDescription('Présence minimum sur le serveur (jours)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('participants').setDescription('Participants minimum pour tirer au sort').setMinValue(2).setMaxValue(100000))
        .addStringOption((o) => o.setName('condition').setDescription('Condition personnalisée affichée (ex : suivre la chaîne)').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('end').setDescription('Arrêter et tirer au sort').addIntegerOption(optionId))
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Refaire le tirage')
        .addIntegerOption(optionId)
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de nouveaux gagnants').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Mettre en pause').addIntegerOption(optionId))
    .addSubcommand((s) => s.setName('resume').setDescription('Reprendre').addIntegerOption(optionId))
    .addSubcommand((s) => s.setName('list').setDescription('Les giveaways du serveur'))
    .addSubcommand((s) => s.setName('menu').setDescription('Le menu Lancer / Arrêter / Retirer au sort')),
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    const sousCommande = interaction.options.getSubcommand();
    const liste = tiragesDuServeur(interaction.guildId).filter((g) =>
      sousCommande === 'reroll' ? g.statut === 'ended' : sousCommande === 'resume' ? g.statut === 'paused' : sousCommande === 'pause' ? g.statut === 'running' : g.statut !== 'ended',
    );
    await interaction.respond(liste.filter((g) => libelle(g).toLowerCase().includes(saisie)).slice(0, 25).map((g) => ({ name: libelle(g), value: g.id })));
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    const client = interaction.client;
    switch (sousCommande) {
      case 'start': {
        const duree = lireDuree(interaction.options.getString('duree', true));
        if (!duree || duree < 10_000 || duree > DUREE_MAX) throw new ErreurUtilisateur('Durée incomprise : écris par exemple `30m`, `1h`, `2j`, `1h30m` (60 jours max).');
        const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(serveur, lireConfig(serveur.id).tirages.salonDefautId) ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
        const conditions: ConditionsTirage = {
          roleId: interaction.options.getRole('role')?.id ?? null,
          niveauMin: interaction.options.getInteger('niveau'),
          joursCompteMin: interaction.options.getInteger('compte'),
          joursServeurMin: interaction.options.getInteger('anciennete'),
          participantsMin: interaction.options.getInteger('participants'),
          note: interaction.options.getString('condition'),
        };
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const g = await lancerTirage({
          salon,
          organisateur: interaction.member,
          lot: interaction.options.getString('recompense', true),
          gagnants: interaction.options.getInteger('gagnants') ?? 1,
          dureeMs: duree,
          conditions,
        });
        return interaction.editReply({ embeds: [ok(serveur, `Giveaway **#${g.id}** lancé dans <#${salon.id}>, tirage ${marqueTemps(g.fin_le, 'R')}.`)] });
      }
      case 'list':
        return paginer(interaction, pagesListe(serveur), true);
      case 'menu':
        return repondre(interaction, { ...menu(serveur), ephemeral: true });
    }
    const g = exigerTirage(serveur.id, interaction.options.getInteger('id', true));
    switch (sousCommande) {
      case 'end': {
        if (g.statut === 'ended') throw new ErreurUtilisateur('Ce giveaway est déjà terminé.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gagnants = await terminerTirage(client, g.id, interaction.user.id);
        return interaction.editReply({ embeds: [ok(serveur, gagnants.length ? `Tirage fait : ${gagnants.map((w) => `<@${w}>`).join(', ')}.` : 'Tirage fait, sans gagnant.')] });
      }
      case 'reroll': {
        if (g.statut !== 'ended') throw new ErreurUtilisateur('Le giveaway doit être terminé pour refaire le tirage.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gagnants = await relancerTirage(client, g, interaction.user.id, interaction.options.getInteger('gagnants') ?? undefined);
        return interaction.editReply({ embeds: [gagnants.length ? ok(serveur, 'C’est retiré au sort.') : erreur(serveur, 'Personne n’a participé à ce giveaway.')] });
      }
      case 'pause':
        if (g.statut !== 'running') throw new ErreurUtilisateur('Ce giveaway n’est pas en cours.');
        mettreTirageEnPause(g);
        await rafraichirMessage(client, lireTirage(g.id)!);
        return repondre(interaction, { embeds: [ok(serveur, `⏸️ Giveaway **#${g.id}** en pause.`)], ephemeral: true });
      case 'resume':
        if (g.statut !== 'paused') throw new ErreurUtilisateur('Ce giveaway n’est pas en pause.');
        reprendreTirage(g);
        await rafraichirMessage(client, lireTirage(g.id)!);
        return repondre(interaction, { embeds: [ok(serveur, `▶️ Giveaway **#${g.id}** repris, tirage ${marqueTemps(lireTirage(g.id)!.fin_le, 'R')}.`)], ephemeral: true });
    }
  },
};

// ─── Composants ────────────────────────────────────────────────────────────

async function surArrivee(interaction: ButtonInteraction<'cached'>, id: string | undefined) {
  const g = exigerTirage(interaction.guildId, id);
  const resultat = participerTirage(interaction.member, g);
  const cadeauEmoji = emojiPour(interaction.guildId, 'cadeau');
  if ('dejaInscrit' in resultat) {
    await interaction.reply({
      embeds: [info(interaction.guild, `Tu participes déjà pour **${tronquer(g.lot, 200)}**.`, { emoji: cadeauEmoji })],
      components: [rangee(bouton(`gw:leave:${g.id}`, 'Me retirer', ButtonStyle.Secondary, '🚪'))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!resultat.inscrit) {
    await interaction.reply({ embeds: [erreur(interaction.guild, resultat.raison)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  aRafraichir.add(g.id);
  await interaction.reply({ embeds: [ok(interaction.guild, `C’est noté, tu participes pour **${tronquer(g.lot, 200)}**.`)], flags: MessageFlags.Ephemeral });
}

async function surFenetreCreation(interaction: ModalSubmitInteraction<'cached'>) {
  const serveur = interaction.guild;
  const lot = interaction.fields.getTextInputValue('prize').trim();
  const gagnants = Number(interaction.fields.getTextInputValue('winners').trim());
  const duree = lireDuree(interaction.fields.getTextInputValue('duration'));
  const roleBrut = interaction.fields.getTextInputValue('role').trim();
  const niveauBrut = interaction.fields.getTextInputValue('level').trim();
  if (!Number.isInteger(gagnants) || gagnants < 1 || gagnants > 50) throw new ErreurUtilisateur('Le nombre de gagnants doit être un entier entre 1 et 50.');
  if (!duree || duree < 10_000 || duree > DUREE_MAX) throw new ErreurUtilisateur('Durée incomprise. Écris un nombre suivi de l’unité : `30m`, `1h`, `2j`, `1h30m`.');
  let roleId: string | null = null;
  if (roleBrut) {
    const role = resoudreRole(serveur, roleBrut.replace(/^@/, ''));
    if (!role) throw new ErreurUtilisateur(`Rôle « ${roleBrut} » introuvable. Laisse vide pour ouvrir à tout le monde.`);
    roleId = role.id;
  }
  const niveauMin = niveauBrut ? Number(niveauBrut) : null;
  if (niveauMin !== null && (!Number.isInteger(niveauMin) || niveauMin < 1)) throw new ErreurUtilisateur('Le niveau minimum doit être un entier positif.');
  const salon = resoudreSalonTexte(serveur, lireConfig(serveur.id).tirages.salonDefautId) ?? (interaction.channel as GuildTextBasedChannel | null);
  if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = await lancerTirage({ salon, organisateur: interaction.member, lot, gagnants, dureeMs: duree, conditions: { roleId, niveauMin } });
  await interaction.editReply({ embeds: [ok(serveur, `Giveaway **#${g.id}** lancé dans <#${salon.id}>, tirage ${marqueTemps(g.fin_le, 'R')}.`)] });
}

const composants = [
  {
    prefixe: 'gw',
    async bouton(interaction: ButtonInteraction<'cached'>, [action, id]: string[]) {
      if (action === 'join') return surArrivee(interaction, id);
      const g = exigerTirage(interaction.guildId, id);
      if (action === 'leave') {
        const partis = quitterTirage(interaction.user.id, g);
        if (partis) aRafraichir.add(g.id);
        return interaction.update({ embeds: [partis ? ok(interaction.guild, 'Tu ne participes plus.') : info(interaction.guild, 'Tu ne participais pas.')], components: [] });
      }
      if (action === 'info') {
        const conditions = decrireConditions(conditionsDe(g));
        return interaction.reply({
          embeds: [
            embedEnseigne(interaction.guild)
              .setTitle(`${emojiPour(interaction.guildId, 'cadeau')} ${tronquer(g.lot, 240)}`)
              .setDescription(
                [
                  `• Gagnants — **${g.nombre_gagnants}**`,
                  `• Participants — **${nombreParticipants(g.id)}**`,
                  g.statut === 'running' ? `• Tirage — ${marqueTemps(g.fin_le, 'R')}` : `• État — **${g.statut === 'paused' ? 'en pause' : 'terminé'}**`,
                  conditions.length ? `\n**Conditions**\n${conditions.join('\n')}` : '\n*Ouvert à tout le monde.*',
                  `\n-# Giveaway #${g.id} · lancé par <@${g.organisateur_id}>`,
                ].join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    },
  },
  {
    prefixe: 'gwm',
    level: Niveau.STAFF,
    whitelist: 'giveaway',
    async bouton(interaction: ButtonInteraction<'cached'>, [action]: string[]) {
      const serveur = interaction.guild;
      if (action === 'create') {
        return interaction.showModal(
          construireFormulaire('gwm:createm', 'Nouveau giveaway', [
            { id: 'prize', libelle: 'Ce qu’on gagne', indication: '1 mois de Nitro', longueurMax: 200 },
            { id: 'winners', libelle: 'Combien de gagnants', valeur: '1', longueurMax: 2 },
            { id: 'duration', libelle: 'Ça dure combien de temps', indication: '1h — ou 30m, 2j, 1h30m', longueurMax: 20 },
            { id: 'role', libelle: 'Rôle requis (vide = tout le monde)', indication: 'Présent — ou @Présent, ou son ID', obligatoire: false, longueurMax: 100 },
            { id: 'level', libelle: 'Niveau XP minimum (vide = aucun)', obligatoire: false, longueurMax: 3 },
          ]),
        );
      }
      if (action === 'end' || action === 'reroll') {
        const choisir = menuChoix(serveur, action);
        if (!choisir) return interaction.update(menu(serveur, action === 'end' ? '⚠️ Aucun giveaway en cours sur ce serveur.\n' : '⚠️ Aucun giveaway terminé avec des participants.\n'));
        return interaction.update({ ...menu(serveur), components: [choisir, rangee(bouton('gwm:home', 'Retour', ButtonStyle.Secondary, '⬅️'))] });
      }
      if (action === 'list') return paginer(interaction, pagesListe(serveur), true);
      if (action === 'home') return interaction.update(menu(serveur));
    },
    async select(interaction: AnySelectMenuInteraction<'cached'>, [action, laquelle]: string[]) {
      if (action !== 'pick' || !interaction.isStringSelectMenu()) return;
      const g = exigerTirage(interaction.guildId, interaction.values[0]);
      await interaction.update({ embeds: [info(interaction.guild, 'Tirage en cours…')], components: [] });
      const gagnants = laquelle === 'end' ? (g.statut === 'ended' ? [] : await terminerTirage(interaction.client, g.id, interaction.user.id)) : await relancerTirage(interaction.client, g, interaction.user.id);
      await interaction.editReply(menu(interaction.guild, gagnants.length ? `✅ Gagnant(s) : ${gagnants.map((w) => `<@${w}>`).join(', ')}\n` : '⚠️ Aucun gagnant.\n'));
    },
    async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action]: string[]) {
      if (action === 'createm') return surFenetreCreation(interaction);
    },
  },
];

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'giveaway',
    alias: ['gw'],
    domaine: 'general',
    categorie: 'giveaways',
    description: 'Lancer, arrêter, retirer au sort',
    niveau: Niveau.STAFF,
    whitelist: 'giveaway',
    async executer(message) {
      await message.reply({ ...menu(message.guild), allowedMentions: { repliedUser: false } });
    },
  },
];

const pageReglage: PageReglage = {
  id: 'giveaways',
  section: 'giveaways',
  titre: 'Giveaways',
  emoji: '🎉',
  moduleId: 'giveaways',
  description: 'Où partent les giveaways et qui est prévenu.\n-# Pour les lancer : `/giveaway start` ou le menu `=giveaway` (staff ou whitelist Giveaway).',
  champs: [
    { genre: 'channel', cle: 'channel', libelle: 'Salon par défaut', lire: (c) => c.tirages.salonDefautId, ecrire: (c, v) => void (c.tirages.salonDefautId = v) },
    { genre: 'role', cle: 'ping', libelle: 'Rôle mentionné au lancement', lire: (c) => c.tirages.roleMentionId, ecrire: (c, v) => void (c.tirages.roleMentionId = v) },
    { genre: 'toggle', cle: 'dm', libelle: 'MP aux gagnants', lire: (c) => c.tirages.mpGagnants, ecrire: (c, v) => void (c.tirages.mpGagnants = v) },
    { genre: 'toggle', cle: 'logjoin', libelle: 'Journaliser les participations', lire: (c) => c.tirages.journaliserParticipations, ecrire: (c, v) => void (c.tirages.journaliserParticipations = v) },
  ],
};

export const moduleTirages: ModuleBot = {
  id: 'giveaways',
  nom: 'Giveaways',
  emoji: '🎉',
  description: 'Giveaways avec conditions, pause et tirages persistants',
  desactivable: true,
  actifParDefaut: true,
  commandes: [tirage],
  commandesPrefixe,
  composants,
  pagesReglage: [pageReglage],
  taches: [
    {
      nom: 'giveaways-end',
      intervalleMs: 10_000,
      auDemarrage: true,
      async executer(client) {
        for (const g of tiragesEchus()) await terminerTirage(client, g.id);
      },
    },
    {
      nom: 'giveaways-refresh',
      intervalleMs: 5_000,
      async executer(client) {
        // Les compteurs « Participer (n) » sont regroupés pour ne pas éditer le message à chaque clic.
        const ids = [...aRafraichir].slice(0, 10);
        for (const id of ids) {
          aRafraichir.delete(id);
          const g = lireTirage(id);
          if (g) await rafraichirMessage(client, g);
        }
      },
    },
  ],
  tests: [
    {
      id: 'preview',
      libelle: 'Aperçu d’un giveaway',
      emoji: '🎉',
      description: 'Voir le rendu sans rien lancer',
      async executer(interaction) {
        const faux: LigneTirage = {
          id: 0,
          serveur_id: interaction.guildId,
          salon_id: interaction.channelId,
          message_id: null,
          organisateur_id: interaction.user.id,
          lot: '20€ Steam',
          nombre_gagnants: 1,
          fin_le: Date.now() + 86_400_000,
          statut: 'running',
          restant_pause: null,
          conditions: JSON.stringify({ roleId: null, niveauMin: 5 }),
          gagnants: '[]',
          cree_le: Date.now(),
        };
        const apercu = construireMessageTirage(interaction.guild, faux);
        await interaction.followUp({ embeds: apercu.embeds, flags: MessageFlags.Ephemeral });
        return '✅ Aperçu envoyé juste en dessous.';
      },
    },
  ],
};

export function peutGererTirages(membre: import('discord.js').GuildMember): boolean {
  return aAcces(membre, Niveau.STAFF, 'giveaway');
}
