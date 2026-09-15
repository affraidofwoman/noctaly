import {
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type TextChannel,
} from 'discord.js';
import { emojiPour } from '../../core/brand';
import { demanderConfirmation } from '../../core/confirm';
import { embedEnseigne, nomEnseigne, couleurPour, info, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig, modifierConfig, type StyleBoutonTicket, type MotifTicket } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { lignesEnPages, paginer } from '../../core/pagination';
import { aNiveau } from '../../core/permissions';
import { lirePageReglage, afficherPage, type PageReglage } from '../../core/setup';
import { identifiantDepuisTexte, tronquer } from '../../core/text';
import { marqueTemps } from '../../core/time';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { remplirModele } from '../../core/variables';
import { sur, Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import {
  archiverTranscript,
  motifDe,
  creerTicket,
  estStaffTicket,
  listerTickets,
  chargerSalonsTickets,
  verrouillerCreateur,
  marquerPris,
  marquerFerme,
  marquerSupprime,
  marquerRouvert,
  rolesAuDessusDuBot,
  stockerMessageTicket,
  ticketDuSalon,
  salonsTickets,
  type LigneTicket,
} from '../../services/tickets';
import { construireTranscript, recupererMessages } from '../../services/transcript';
import { AttachmentBuilder } from 'discord.js';

const STYLES: Record<StyleBoutonTicket, ButtonStyle> = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

// ─── Panneau ───────────────────────────────────────────────────────────────

function variables(serveur: Guild) {
  return { guild: serveur, extra: { enseigne: nomEnseigne(serveur) } };
}

export function construirePanneau(serveur: Guild): MessageCreateOptions {
  const reglages = lireConfig(serveur.id).tickets;
  const titre = remplirModele(reglages.titrePanneau, variables(serveur));
  const intro = remplirModele(reglages.introPanneau, variables(serveur));
  const pied = remplirModele(reglages.piedPanneau, variables(serveur));
  const categories = reglages.categories.slice(0, 20);

  if (reglages.stylePanneau === 'v2') {
    const conteneur = new ContainerBuilder().setAccentColor(couleurPour(serveur));
    conteneur.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${titre}`), new TextDisplayBuilder().setContent(intro));
    conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    categories.forEach((motif, i) => {
      if (i > 0) conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
      conteneur.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${motif.emoji} **${motif.libelle}**\n-# ${motif.description || '—'}`))
          .setButtonAccessory(new ButtonBuilder().setCustomId(`tk:open:${motif.id}`).setLabel('Ouvrir').setStyle(STYLES[motif.style] ?? ButtonStyle.Secondary)),
      );
    });
    conteneur.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    conteneur.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${pied}`));
    return { components: [conteneur], flags: MessageFlags.IsComponentsV2 };
  }

  const embed = embedEnseigne(serveur)
    .setTitle(titre.slice(0, 256))
    .setDescription(tronquer([intro, '', ...categories.map((c) => `${c.emoji} **${c.libelle}** — ${c.description}`)].join('\n'), 4096))
    .setFooter({ text: pied.slice(0, 2048) });

  if (reglages.stylePanneau === 'menu') {
    return { embeds: [embed], components: [rangee(bouton('tk:menu', 'Ouvrir un ticket', ButtonStyle.Primary, emojiPour(serveur.id, 'ticket')))] };
  }
  const boutons = categories.map((c) => bouton(`tk:open:${c.id}`, c.libelle, STYLES[c.style] ?? ButtonStyle.Secondary, c.emoji));
  const rangees: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < boutons.length && rangees.length < 5; i += 3) rangees.push(rangee(...boutons.slice(i, i + 3)));
  return { embeds: [embed], components: rangees };
}

async function publierPanneau(salon: GuildTextBasedChannel): Promise<string> {
  const envoye = await salon.send(construirePanneau(salon.guild));
  modifierConfig(salon.guild.id, (c) => void (c.tickets.salonPanneauId = salon.id));
  return envoye.url;
}

function menuMotifs(serveur: Guild) {
  const motifs = lireConfig(serveur.id).tickets.categories.slice(0, 25);
  return rangee(
    new StringSelectMenuBuilder()
      .setCustomId('tk:pick')
      .setPlaceholder('Quel est le sujet ?')
      .addOptions(motifs.map((c) => ({ label: c.libelle, value: c.id, emoji: c.emoji, description: tronquer(c.description || c.libelle, 100) }))),
  );
}

// ─── Contrôles dans le ticket ──────────────────────────────────────────────

function controlesOuvert(serveurId: string, pris: boolean) {
  return [
    rangee(
      bouton('tk:close', 'Fermer', ButtonStyle.Danger, '🔒'),
      bouton('tk:claim', pris ? 'Libérer' : 'Claim', ButtonStyle.Success, '📌'),
      bouton('tk:add', 'Ajouter', ButtonStyle.Secondary, '👤'),
      bouton('tk:remove', 'Retirer', ButtonStyle.Secondary, '❌'),
      bouton('tk:transcript', '', ButtonStyle.Secondary, emojiPour(serveurId, 'message')),
    ),
  ];
}

function controlesFerme() {
  return [
    rangee(
      bouton('tk:reopen', 'Rouvrir', ButtonStyle.Success, '🔓'),
      bouton('tk:transcript', 'Transcript', ButtonStyle.Secondary, '📄'),
      bouton('tk:delete', 'Supprimer', ButtonStyle.Danger, '🗑️'),
    ),
  ];
}

async function ouvrirTicket(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, categorieId: string) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { salon, categorie, rolesMentionnes, ticket } = await creerTicket(interaction.member, categorieId);
  const reglages = lireConfig(interaction.guild.id).tickets;
  const embed = embedEnseigne(interaction.guild)
    .setTitle(remplirModele(reglages.titreBienvenue, variables(interaction.guild)).slice(0, 256))
    .setDescription(tronquer(remplirModele(reglages.messageBienvenue, { membre: interaction.member, serveur: interaction.guild, extra: { brand: nomEnseigne(interaction.guild) } }), 4096))
    .addFields({ name: `${emojiPour(interaction.guild.id, 'ticket')} Motif`, value: `${categorie.emoji} ${categorie.libelle}`, inline: true }, { name: 'Numéro', value: `#${ticket.numero}`, inline: true })
    .setFooter({ text: reglages.piedBienvenue || nomEnseigne(interaction.guild) })
    .setTimestamp();
  await salon.send({
    content: [`<@${interaction.user.id}>`, ...rolesMentionnes.map((id) => `<@&${id}>`)].join(' '),
    embeds: [embed],
    components: controlesOuvert(interaction.guild.id, false),
    allowedMentions: { users: [interaction.user.id], roles: rolesMentionnes },
  });
  await interaction.editReply({ embeds: [ok(interaction.guild, `Ticket créé : <#${salon.id}>`, { titre: 'Ticket', sujet: emojiPour(interaction.guild.id, 'ticket') })] });
}

function exigerTicket(salonId: string | null): LigneTicket {
  const ticket = salonId ? ticketDuSalon(salonId) : undefined;
  if (!ticket) throw new ErreurUtilisateur('Cette action se fait dans un salon de ticket.');
  return ticket;
}

function exigerStaff(membre: GuildMember, ticket: LigneTicket): void {
  if (!estStaffTicket(membre, ticket)) throw new ErreurUtilisateur('Réservé au staff des tickets.');
}

async function fermerTicket(interaction: ButtonInteraction<'cached'> | import('discord.js').ChatInputCommandInteraction<'cached'>, ticket: LigneTicket) {
  const salon = interaction.channel as TextChannel;
  const serveur = interaction.guild;
  const mode = lireConfig(serveur.id).tickets.modeFermeture;
  if (ticket.utilisateur_id !== interaction.user.id && !estStaffTicket(interaction.member, ticket)) throw new ErreurUtilisateur('Seul le créateur ou le staff peut fermer ce ticket.');
  if (ticket.statut === 'closed') throw new ErreurUtilisateur('Ce ticket est déjà fermé.');

  const executer = async (i: RepliableInteraction) => {
    await repondre(i, { embeds: [info(serveur, 'Fermeture du ticket en cours…', { emoji: emojiPour(serveur.id, 'ticket') })] });
    marquerFerme(ticket, interaction.user.id);
    const { messages, mpEnvoye } = await archiverTranscript(serveur, salon, ticket, interaction.user);
    if (mode === 'delete') {
      await salon.send({ embeds: [info(serveur, `Transcript enregistré (${messages} messages)${mpEnvoye ? ', envoyé en MP' : ''}. Suppression du salon…`)] }).catch(() => undefined);
      setTimeout(() => {
        marquerSupprime(salon.id);
        void salon.delete(`Ticket fermé par ${interaction.user.tag}`).catch(() => undefined);
      }, 3_000).unref();
      return;
    }
    await verrouillerCreateur(salon, ticket, false);
    await salon.setName(`fermé-${salon.name}`.slice(0, 100)).catch(() => undefined);
    await salon.send({
      embeds: [
        embedEnseigne(serveur)
          .setTitle('🔒 Ticket fermé')
          .setDescription(`Fermé par <@${interaction.user.id}> · ${messages} messages archivés${mpEnvoye ? ' · transcript envoyé en MP' : ''}.`),
      ],
      components: controlesFerme(),
    });
  };

  await demanderConfirmation(interaction, {
    titre: 'Fermer le ticket ?',
    description: mode === 'delete' ? 'Le transcript est enregistré puis le salon est supprimé.' : 'Le transcript est enregistré et le salon est archivé.',
    libelleConfirmation: 'Fermer',
    surConfirmation: async (i) => {
      await i.update({ embeds: [info(serveur, 'C’est parti.')], components: [] });
      await executer(i);
    },
  });
}

async function envoyerTranscriptPrive(interaction: RepliableInteraction, salon: TextChannel) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = await recupererMessages(salon);
  const html = construireTranscript(salon, messages);
  await interaction.editReply({
    embeds: [ok(interaction.guild, `${messages.length} message(s).`, { titre: 'Transcript' })],
    files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${salon.name}.html` })],
  });
}

// ─── Catégories & rôles (« Qui voit les tickets ») ─────────────────────────

function ecranMotifs(serveur: Guild, note?: string) {
  const motifs = lireConfig(serveur.id).tickets.categories;
  const embed = embedEnseigne(serveur)
    .setTitle(`${emojiPour(serveur.id, 'cle')} Qui voit les tickets`)
    .setDescription(note ?? 'Choisis une catégorie pour changer ses rôles, son texte ou la supprimer.\n-# Sans rôle, ce sont les rôles staff des tickets puis les rôles d’accès du bot qui prennent le relais.');
  for (const c of motifs.slice(0, 24)) {
    const bloques = rolesAuDessusDuBot(serveur, c.roles);
    embed.addFields({
      name: `${c.emoji} ${c.libelle}`,
      value: tronquer(`${c.roles.length ? c.roles.map((r) => `<@&${r}>`).join(' ') : '*rôles par défaut*'}${bloques.length ? '\n⚠️ rôle(s) introuvable(s) ou au-dessus du bot' : ''}\n-# \`${c.id}\` · ${c.style}`, 1024),
      inline: true,
    });
  }
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (motifs.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('tkc:open')
          .setPlaceholder('Catégorie de ticket à configurer')
          .addOptions(motifs.slice(0, 25).map((c) => ({ label: c.libelle, value: c.id, emoji: c.emoji, description: `${c.roles.length} rôle(s)` }))),
      ),
    );
  }
  composants.push(
    rangee(
      bouton('tkc:new', 'Ajouter une catégorie', ButtonStyle.Success, '➕').setDisabled(motifs.length >= 20),
      bouton('tkc:back', 'Retour aux réglages', ButtonStyle.Secondary, '⬅️'),
    ),
  );
  return { embeds: [embed], components: composants };
}

function ecranMotif(serveur: Guild, id: string, note?: string) {
  const motif = lireConfig(serveur.id).tickets.categories.find((c) => c.id === id);
  if (!motif) return ecranMotifs(serveur, '⚠️ Cette catégorie n’existe plus.');
  const embed = embedEnseigne(serveur)
    .setTitle(`${motif.emoji} ${motif.libelle}`)
    .setDescription(
      [
        note,
        motif.description,
        '',
        `**Rôles** : ${motif.roles.length ? motif.roles.map((r) => `<@&${r}>`).join(' ') : '*par défaut*'}`,
        '-# Eux et le membre, personne d’autre. Ils sont mentionnés à l’ouverture.',
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  const menu = new RoleSelectMenuBuilder().setCustomId(`tkc:roles:${motif.id}`).setPlaceholder('Rôles ayant accès (aucun = par défaut)').setMinValues(0).setMaxValues(10);
  const valides = motif.roles.filter((r) => serveur.roles.cache.has(r));
  if (valides.length) menu.setDefaultRoles(...valides);
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`tkc:edit:${motif.id}`, 'Modifier', ButtonStyle.Primary, '✏️'),
        bouton(`tkc:del:${motif.id}`, 'Supprimer', ButtonStyle.Danger, '🗑️'),
        bouton('tkc:home', 'Toutes les catégories', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function lireStyle(brut: string): StyleBoutonTicket {
  const v = brut.trim().toLowerCase();
  if (['rouge', 'danger', 'red'].includes(v)) return 'Danger';
  if (['vert', 'success', 'green'].includes(v)) return 'Success';
  if (['bleu', 'primary', 'blue', 'violet', 'blurple'].includes(v)) return 'Primary';
  return 'Secondary';
}

const LIBELLE_STYLE: Record<StyleBoutonTicket, string> = { Primary: 'bleu', Secondary: 'gris', Success: 'vert', Danger: 'rouge' };

// ─── Setup ─────────────────────────────────────────────────────────────────

const pages: PageReglage[] = [
  {
    id: 'tickets',
    section: 'tickets',
    titre: 'Tickets',
    emoji: '🎫',
    moduleId: 'tickets',
    ordre: 1,
    description: 'Le panneau, la catégorie Discord des tickets et le staff qui les voit.\n-# Les transcripts partent dans `#ticket-logs`.',
    champs: [
      { kind: 'channel', cle: 'panel', libelle: 'Salon du panneau', get: (c) => c.tickets.salonPanneauId, set: (c, v) => void (c.tickets.salonPanneauId = v) },
      {
        kind: 'channel',
        cle: 'parent',
        libelle: 'Catégorie des tickets',
        channelTypes: [ChannelType.GuildCategory],
        get: (c) => c.tickets.categorieParenteId,
        set: (c, v) => void (c.tickets.categorieParenteId = v),
      },
      { kind: 'roles', cle: 'staff', libelle: 'Rôles staff (tous les tickets)', max: 10, get: (c) => c.tickets.rolesStaff, set: (c, v) => void (c.tickets.rolesStaff = v) },
      { kind: 'toggle', cle: 'dm', libelle: 'Transcript en MP', get: (c) => c.tickets.transcriptAuMembre, set: (c, v) => void (c.tickets.transcriptAuMembre = v) },
      {
        kind: 'toggle',
        cle: 'delete',
        libelle: 'Supprimer à la fermeture',
        get: (c) => c.tickets.modeFermeture === 'delete',
        set: (c, v) => void (c.tickets.modeFermeture = v ? 'delete' : 'archive'),
      },
      { kind: 'number', cle: 'max', libelle: 'Tickets ouverts max par membre', min: 1, max: 10, get: (c) => c.tickets.ouvertsMaxParMembre, set: (c, v) => void (c.tickets.ouvertsMaxParMembre = v) },
      { kind: 'text', cle: 'wfooter', libelle: 'Pied du message d’ouverture', maxLength: 200, get: (c) => c.tickets.piedBienvenue, set: (c, v) => void (c.tickets.piedBienvenue = v) },
    ],
    actions: [
      {
        id: 'publish',
        libelle: 'Publier le panneau',
        emoji: '📤',
        async executer(interaction) {
          const salon = resoudreSalonTexte(interaction.guild, lireConfig(interaction.guildId).tickets.salonPanneauId);
          if (!salon) throw new ErreurUtilisateur('Choisis d’abord le salon du panneau (et vérifie que je peux y écrire).');
          const url = await publierPanneau(salon);
          await interaction.reply({ embeds: [ok(interaction.guild, `Panneau posté : ${url}`)], flags: MessageFlags.Ephemeral });
        },
      },
      {
        id: 'cats',
        libelle: 'Catégories & rôles',
        emoji: '🔑',
        async executer(interaction) {
          await interaction.update(ecranMotifs(interaction.guild));
        },
      },
    ],
  },
  {
    id: 'tickets-look',
    section: 'tickets',
    titre: 'Tickets — textes',
    emoji: '📝',
    ordre: 2,
    description: 'L’apparence du panneau et du message d’ouverture.\n-# Variables : `{brand}` `{server}` `{mention}` `{user}`',
    champs: [
      {
        kind: 'choice',
        cle: 'style',
        libelle: 'Style du panneau',
        options: [
          { value: 'buttons', label: 'Un bouton par motif', emoji: '🔘' },
          { value: 'v2', label: 'Sections avec bouton « Ouvrir »', emoji: '🧩' },
          { value: 'menu', label: 'Un bouton puis « Quel est le sujet ? »', emoji: '📋' },
        ],
        get: (c) => c.tickets.stylePanneau,
        set: (c, v) => void (c.tickets.stylePanneau = v as 'buttons' | 'v2' | 'menu'),
      },
      { kind: 'text', cle: 'ptitle', libelle: 'Titre du panneau', maxLength: 200, required: true, get: (c) => c.tickets.titrePanneau, set: (c, v) => void (c.tickets.titrePanneau = v) },
      { kind: 'text', cle: 'pintro', libelle: 'Phrase du panneau', long: true, maxLength: 1000, get: (c) => c.tickets.introPanneau, set: (c, v) => void (c.tickets.introPanneau = v) },
      { kind: 'text', cle: 'pfooter', libelle: 'Pied du panneau', maxLength: 200, get: (c) => c.tickets.piedPanneau, set: (c, v) => void (c.tickets.piedPanneau = v) },
      { kind: 'text', cle: 'wtitle', libelle: 'Titre à l’ouverture', maxLength: 200, required: true, get: (c) => c.tickets.titreBienvenue, set: (c, v) => void (c.tickets.titreBienvenue = v) },
      { kind: 'text', cle: 'wmessage', libelle: 'Message à l’ouverture', long: true, maxLength: 2000, required: true, get: (c) => c.tickets.messageBienvenue, set: (c, v) => void (c.tickets.messageBienvenue = v) },
    ],
  },
];

// ─── Commandes ─────────────────────────────────────────────────────────────

function pagesTickets(serveur: Guild, statut: 'open' | 'closed' | 'all') {
  const rangees = listerTickets(serveur.id, statut);
  const lignes = rangees.map((t) => {
    const motif = motifDe(serveur.id, t.categorie);
    const etat = t.statut === 'open' ? '🟢' : '🔒';
    return `${etat} **#${t.numero}** <#${t.salon_id}> — ${motif.emoji} ${motif.libelle} · <@${t.utilisateur_id}> · ${marqueTemps(t.cree_le, 'R')}${t.pris_par ? ` · 📌 <@${t.pris_par}>` : ''}`;
  });
  if (!lignes.length) lignes.push('*Aucun ticket.*');
  return lignesEnPages(lignes, 10, (contenu, page, total) =>
    embedEnseigne(serveur).setTitle(`🎫 Tickets (${rangees.length})`).setDescription(contenu).setFooter({ text: `Page ${page}/${total}` }),
  );
}

const commandeTicket: CommandeSlash = {
  categorie: 'tickets',
  niveau: Niveau.MEMBRE,
  donnees: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Les tickets')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les tickets'))
    .addSubcommand((s) => s.setName('config').setDescription('Catégories et qui voit les tickets'))
    .addSubcommand((s) =>
      s
        .setName('panneau')
        .setDescription('Poster le panneau')
        .addChannelOption((o) => o.setName('salon').setDescription('Où (ici par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('close').setDescription('Fermer ce ticket'))
    .addSubcommand((s) => s.setName('reopen').setDescription('Rouvrir ce ticket'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Ajouter quelqu’un au ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Retirer quelqu’un du ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Qui').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('claim').setDescription('Prendre ce ticket en charge'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Le transcript de ce ticket'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Les tickets du serveur')
        .addStringOption((o) => o.setName('etat').setDescription('Lesquels').addChoices({ name: 'Ouverts', value: 'open' }, { name: 'Fermés', value: 'closed' }, { name: 'Tous', value: 'all' })),
    ),
  niveauxSousCommandes: {
    setup: Niveau.ADMIN,
    config: Niveau.ADMIN,
    panneau: Niveau.ADMIN,
    reopen: Niveau.SUPPORT,
    add: Niveau.SUPPORT,
    remove: Niveau.SUPPORT,
    claim: Niveau.SUPPORT,
    transcript: Niveau.SUPPORT,
    list: Niveau.SUPPORT,
  },
  async executer(interaction) {
    const sousCommande = interaction.options.getSubcommand();
    const serveur = interaction.guild;
    switch (sousCommande) {
      case 'setup':
        return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('tickets')!), ephemeral: true });
      case 'config':
        return repondre(interaction, { ...ecranMotifs(serveur), ephemeral: true });
      case 'panneau': {
        const salon = (interaction.options.getChannel('salon') ?? interaction.channel) as GuildTextBasedChannel | null;
        if (!salon) return;
        const url = await publierPanneau(salon);
        return repondre(interaction, { embeds: [ok(serveur, `Panneau posté : ${url}`)], ephemeral: true });
      }
      case 'list':
        return paginer(interaction, pagesTickets(serveur, (interaction.options.getString('etat') ?? 'open') as 'open' | 'closed' | 'all'), true);
    }
    const ticket = exigerTicket(interaction.channelId);
    const salon = interaction.channel as TextChannel;
    switch (sousCommande) {
      case 'close':
        return fermerTicket(interaction, ticket);
      case 'reopen':
        return rouvrir(interaction, ticket, salon);
      case 'claim':
        return prendreEnCharge(interaction, ticket);
      case 'transcript':
        return envoyerTranscriptPrive(interaction, salon);
      case 'add':
      case 'remove': {
        const utilisateur = interaction.options.getUser('membre', true);
        await reglerAccesMembre(serveur, salon, ticket, utilisateur.id, sousCommande === 'add', interaction.member);
        return repondre(interaction, { embeds: [ok(serveur, `<@${utilisateur.id}> ${sousCommande === 'add' ? 'ajouté au' : 'retiré du'} ticket.`)] });
      }
    }
  },
};

async function rouvrir(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: LigneTicket, salon: TextChannel) {
  exigerStaff(interaction.member, ticket);
  if (ticket.statut !== 'closed') throw new ErreurUtilisateur('Ce ticket est déjà ouvert.');
  marquerRouvert(ticket);
  salonsTickets.add(salon.id);
  await verrouillerCreateur(salon, ticket, true);
  if (salon.name.startsWith('fermé-')) await salon.setName(salon.name.slice('fermé-'.length)).catch(() => undefined);
  void journal(interaction.guild, 'ticket', { titre: 'Ticket rouvert', ton: 'ok', lignes: [`**Ticket** : <#${salon.id}>`], par: interaction.user });
  await repondre(interaction, { embeds: [ok(interaction.guild, `🔓 Ticket rouvert par <@${interaction.user.id}>.`)], components: controlesOuvert(interaction.guild.id, !!ticket.pris_par) });
}

async function prendreEnCharge(interaction: RepliableInteraction & { member: GuildMember; guild: Guild }, ticket: LigneTicket) {
  exigerStaff(interaction.member, ticket);
  if (ticket.pris_par && ticket.pris_par !== interaction.user.id && !aNiveau(interaction.member, Niveau.ADMIN)) {
    throw new ErreurUtilisateur(`Ce ticket est déjà pris en charge par <@${ticket.pris_par}>.`);
  }
  const liberer = ticket.pris_par === interaction.user.id;
  marquerPris(ticket, liberer ? null : interaction.user.id);
  void journal(interaction.guild, 'ticket', {
    titre: liberer ? 'Ticket libéré' : 'Ticket pris en charge',
    ton: 'info',
    lignes: [`**Ticket** : <#${ticket.salon_id}>`, `**Staff** : <@${interaction.user.id}>`],
    par: interaction.user,
  });
  await repondre(interaction, {
    embeds: [info(interaction.guild, liberer ? `📌 <@${interaction.user.id}> a libéré ce ticket.` : `📌 Ticket pris en charge par <@${interaction.user.id}>.`)],
    allowedMentions: { parse: [] },
  });
}

async function reglerAccesMembre(serveur: Guild, salon: TextChannel, ticket: LigneTicket, utilisateurId: string, ajouter: boolean, auteur: GuildMember) {
  exigerStaff(auteur, ticket);
  if (!ajouter && utilisateurId === ticket.utilisateur_id) throw new ErreurUtilisateur('Impossible de retirer le créateur du ticket.');
  if (ajouter) await salon.permissionOverwrites.edit(utilisateurId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  else await salon.permissionOverwrites.delete(utilisateurId);
  void journal(serveur, 'ticket', {
    titre: ajouter ? 'Membre ajouté au ticket' : 'Membre retiré du ticket',
    ton: 'info',
    lignes: [`**Ticket** : <#${salon.id}>`, `**Membre** : <@${utilisateurId}>`],
    par: auteur.user,
  });
}

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'ticket',
    domaine: 'general',
    categorie: 'tickets',
    description: 'Poster le panneau ici',
    niveau: Niveau.ADMIN,
    async executer(message) {
      await publierPanneau(message.channel);
      await message.delete().catch(() => undefined);
    },
  },
  {
    nom: 'tickets',
    domaine: 'general',
    categorie: 'tickets',
    description: 'Les tickets ouverts',
    niveau: Niveau.SUPPORT,
    async executer(message) {
      await message.reply({ embeds: [pagesTickets(message.guild, 'open')[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

// ─── Composants ────────────────────────────────────────────────────────────

export const moduleTickets: ModuleBot = {
  id: 'tickets',
  nom: 'Tickets',
  emoji: '🎫',
  description: 'Panneau, salons privés, claim, transcripts HTML',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeTicket],
  commandesPrefixe,
  pagesReglage: pages,
  composants: [
    {
      prefixe: 'tk',
      async bouton(interaction: ButtonInteraction<'cached'>, [action, argument]) {
        const serveur = interaction.guild;
        if (action === 'open' && argument) return ouvrirTicket(interaction, argument);
        if (action === 'menu') return interaction.reply({ components: [menuMotifs(serveur)], flags: MessageFlags.Ephemeral });
        const ticket = exigerTicket(interaction.channelId);
        const salon = interaction.channel as TextChannel;
        switch (action) {
          case 'close':
            return fermerTicket(interaction, ticket);
          case 'claim':
            return prendreEnCharge(interaction, ticket);
          case 'reopen':
            return rouvrir(interaction, ticket, salon);
          case 'transcript':
            exigerStaff(interaction.member, ticket);
            return envoyerTranscriptPrive(interaction, salon);
          case 'add':
          case 'remove':
            exigerStaff(interaction.member, ticket);
            return interaction.reply({
              components: [
                rangee(
                  new UserSelectMenuBuilder()
                    .setCustomId(`tk:${action}sel`)
                    .setPlaceholder(action === 'add' ? 'Qui ajouter ?' : 'Qui retirer ?')
                    .setMinValues(1)
                    .setMaxValues(5),
                ),
              ],
              flags: MessageFlags.Ephemeral,
            });
          case 'delete':
            exigerStaff(interaction.member, ticket);
            return demanderConfirmation(interaction, {
              titre: 'Supprimer le ticket ?',
              description: 'Le salon est supprimé définitivement (le transcript a déjà été enregistré à la fermeture).',
              libelleConfirmation: 'Supprimer',
              surConfirmation: async (i) => {
                await i.update({ embeds: [info(serveur, 'Suppression…')], components: [] });
                marquerSupprime(salon.id);
                void journal(serveur, 'ticket', { titre: 'Ticket supprimé', ton: 'alerte', lignes: [`**Ticket** : \`#${salon.name}\``], par: i.user });
                setTimeout(() => void salon.delete(`Ticket supprimé par ${i.user.tag}`).catch(() => undefined), 2_000).unref();
              },
            });
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action]) {
        if (action === 'pick' && interaction.isStringSelectMenu()) return ouvrirTicket(interaction, interaction.values[0]!);
        if ((action === 'addsel' || action === 'removesel') && interaction.isUserSelectMenu()) {
          const ticket = exigerTicket(interaction.channelId);
          const salon = interaction.channel as TextChannel;
          const ajouter = action === 'addsel';
          const fait: string[] = [];
          for (const utilisateur of interaction.users.values()) {
            if (utilisateur.bot) continue;
            await reglerAccesMembre(interaction.guild, salon, ticket, utilisateur.id, ajouter, interaction.member).then(() => fait.push(`<@${utilisateur.id}>`)).catch(() => undefined);
          }
          await interaction.update({ embeds: [ok(interaction.guild, fait.length ? `${fait.join(', ')} ${ajouter ? 'ajouté(s)' : 'retiré(s)'}.` : 'Personne n’a été modifié.')], components: [] });
          if (fait.length) await salon.send({ embeds: [info(interaction.guild, `${fait.join(', ')} ${ajouter ? 'ajouté(s) au' : 'retiré(s) du'} ticket par <@${interaction.user.id}>.`)], allowedMentions: { parse: [] } });
        }
      },
    },
    {
      prefixe: 'tkc',
      niveau: Niveau.ADMIN,
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        switch (action) {
          case 'home':
            return interaction.update(ecranMotifs(serveur));
          case 'back':
            return interaction.update(afficherPage(serveur, lirePageReglage('tickets')!));
          case 'new':
            return interaction.showModal(
              construireFormulaire('tkc:newm', 'Nouvelle catégorie', [
                { id: 'label', libelle: 'Nom', indication: 'ex : Support', longueurMax: 40 },
                { id: 'emoji', libelle: 'Émoji', indication: '🎫', longueurMax: 64, obligatoire: false },
                { id: 'description', libelle: 'Description', indication: 'Une question ou un souci ? On t’aide.', longueurMax: 100, obligatoire: false },
                { id: 'style', libelle: 'Couleur du bouton (bleu, vert, rouge, gris)', valeur: 'gris', longueurMax: 10, obligatoire: false },
              ]),
            );
          case 'edit': {
            const motif = lireConfig(serveur.id).tickets.categories.find((c) => c.id === id);
            if (!motif) return interaction.update(ecranMotifs(serveur));
            return interaction.showModal(
              construireFormulaire(`tkc:editm:${motif.id}`, `Catégorie ${motif.libelle}`.slice(0, 45), [
                { id: 'label', libelle: 'Nom', valeur: motif.libelle, longueurMax: 40 },
                { id: 'emoji', libelle: 'Émoji', valeur: motif.emoji, longueurMax: 64, obligatoire: false },
                { id: 'description', libelle: 'Description', valeur: motif.description, longueurMax: 100, obligatoire: false },
                { id: 'style', libelle: 'Couleur du bouton (bleu, vert, rouge, gris)', valeur: LIBELLE_STYLE[motif.style], longueurMax: 10, obligatoire: false },
              ]),
            );
          }
          case 'del': {
            if (lireConfig(serveur.id).tickets.categories.length <= 1) throw new ErreurUtilisateur('Il faut garder au moins une catégorie.');
            modifierConfig(serveur.id, (c) => void (c.tickets.categories = c.tickets.categories.filter((x) => x.id !== id)));
            return interaction.update(ecranMotifs(serveur, '✅ Catégorie supprimée. Pense à republier le panneau.'));
          }
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(ecranMotif(serveur, interaction.values[0]!));
        if (action === 'roles' && interaction.isRoleSelectMenu() && id) {
          modifierConfig(serveur.id, (c) => {
            const motif = c.tickets.categories.find((x) => x.id === id);
            if (motif) motif.roles = [...interaction.values];
          });
          return interaction.update(ecranMotif(serveur, id, `✅ C’est enregistré.`));
        }
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        const libelle = interaction.fields.getTextInputValue('label').trim();
        const emoji = interaction.fields.getTextInputValue('emoji').trim() || '🎫';
        const description = interaction.fields.getTextInputValue('description').trim();
        const style = lireStyle(interaction.fields.getTextInputValue('style'));
        if (!libelle) throw new ErreurUtilisateur('Le nom est obligatoire.');
        let cible = id;
        modifierConfig(serveur.id, (c) => {
          if (action === 'newm') {
            let identifiantTexte = identifiantDepuisTexte(libelle, 20);
            while (c.tickets.categories.some((x) => x.id === identifiantTexte)) identifiantTexte = `${identifiantDepuisTexte(libelle, 16)}-${Math.random().toString(36).slice(2, 4)}`;
            c.tickets.categories.push({ id: identifiantTexte, libelle, emoji, description, style, roles: [] } satisfies MotifTicket);
            cible = identifiantTexte;
          } else {
            const motif = c.tickets.categories.find((x) => x.id === id);
            if (motif) Object.assign(motif, { label: libelle, emoji, description, style });
          }
        });
        const charge = ecranMotif(serveur, cible!, '✅ C’est enregistré. Pense à republier le panneau.');
        if (interaction.isFromMessage()) await interaction.update(charge);
        else await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('messageCreate', (message) => {
      if (!message.inGuild() || !salonsTickets.has(message.channelId) || message.author.bot) return;
      const ticket = ticketDuSalon(message.channelId);
      if (!ticket) return;
      stockerMessageTicket(ticket.id, message.id, message.author.id, message.author.tag, message.content, [...message.attachments.values()].map((a) => a.url));
    }, 300),
    sur('channelDelete', (salon) => {
      if (salonsTickets.has(salon.id)) marquerSupprime(salon.id);
    }),
  ],
  async auDemarrage() {
    chargerSalonsTickets();
  },
  tests: [
    {
      id: 'panel',
      libelle: 'Aperçu du panneau',
      emoji: '🎫',
      description: 'Poster le panneau ici, en privé',
      async executer(interaction) {
        const panneauBoutons = construirePanneau(interaction.guild);
        const v2 = panneauBoutons.flags !== undefined;
        await interaction.followUp({
          embeds: panneauBoutons.embeds,
          components: panneauBoutons.components,
          flags: v2 ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : MessageFlags.Ephemeral,
        } as Parameters<typeof interaction.followUp>[0]);
        return '✅ Aperçu envoyé juste en dessous (les boutons fonctionnent vraiment).';
      },
    },
  ],
};
