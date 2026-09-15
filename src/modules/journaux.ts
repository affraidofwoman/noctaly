import {
  AttachmentBuilder,
  AuditLogEvent,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  SlashCommandBuilder,
  type VoiceState,
} from 'discord.js';
import { embedEnseigne, lignesEnPages, ok, paginer, suiviReponse } from '../coeur/affichage';
import { lireJson, lireTout } from '../coeur/base';
import { creerSalonsJournal, definitionJournal, journal, type TypeJournal, TYPES_JOURNAUX } from '../coeur/journaux';
import { type CommandePrefixe, type CommandeSlash, type ModuleBot, sur } from '../coeur/noyau';
import { formaterDuree, formaterNombre, joursDepuis, marqueTemps, tronquer, Niveau } from '../coeur/outils';
import { lireConfig } from '../coeur/reglages';

function ignore(serveur: Guild, salonId: string | null | undefined): boolean {
  return !!salonId && lireConfig(serveur.id).journaux.salonsIgnores.includes(salonId);
}

function citer(texte: string | null | undefined, max = 1000): string {
  if (!texte) return '*vide*';
  return tronquer(texte.replace(/```/g, 'ˋˋˋ'), max);
}

// - Membres -

async function surArrivee(membre: GuildMember) {
  const age = joursDepuis(membre.user.createdTimestamp);
  await journal(membre.guild, 'member', {
    titre: membre.user.bot ? 'Bot ajouté' : 'Arrivée',
    ton: 'ok',
    miniature: membre.user.displayAvatarURL({ size: 128 }),
    lignes: [
      `**Membre** : <@${membre.id}> \`${membre.user.tag}\``,
      `**Compte créé** : ${marqueTemps(membre.user.createdTimestamp, 'D')} (${marqueTemps(membre.user.createdTimestamp, 'R')})${age < 7 ? ' ⚠️ **compte récent**' : ''}`,
      `**Membres** : ${formaterNombre(membre.guild.memberCount)}`,
    ],
  });
}

async function surDepart(membre: GuildMember | PartialGuildMember) {
  const roles = membre.roles?.cache.filter((r) => r.id !== membre.guild.id).map((r) => `<@&${r.id}>`) ?? [];
  await journal(membre.guild, 'member', {
    titre: 'Départ',
    ton: 'alerte',
    miniature: membre.user?.displayAvatarURL({ size: 128 }),
    lignes: [
      `**Membre** : <@${membre.id}> \`${membre.user?.tag ?? membre.id}\``,
      membre.joinedTimestamp ? `**Resté** : ${formaterDuree(Date.now() - membre.joinedTimestamp)}` : null,
      roles.length ? `**Rôles** : ${tronquer(roles.join(' '), 900)}` : null,
      `**Membres** : ${formaterNombre(membre.guild.memberCount)}`,
    ],
  });
}

// - Messages -

async function surMessageSupprime(message: Message | PartialMessage) {
  if (!message.guild || message.author?.bot || ignore(message.guild, message.channelId)) return;
  if (message.partial && !message.content) {
    await journal(message.guild, 'message', {
      titre: 'Message supprimé',
      ton: 'alerte',
      lignes: [`**Salon** : <#${message.channelId}>`, '*Contenu inconnu (message trop ancien pour être en mémoire).*'],
    });
    return;
  }
  const attachments = [...message.attachments.values()].map((a) => `[${a.name}](${a.url})`);
  await journal(message.guild, 'message', {
    titre: 'Message supprimé',
    ton: 'alerte',
    lignes: [
      `**Auteur** : <@${message.author?.id}> \`${message.author?.tag}\``,
      `**Salon** : <#${message.channelId}>`,
      `**Envoyé** : ${marqueTemps(message.createdTimestamp, 'R')}`,
      '',
      citer(message.content, 3000),
      attachments.length ? `\n**Pièces jointes** : ${attachments.join(' · ')}` : null,
    ],
  });
}

async function surMessageModifie(avant: Message | PartialMessage, apres: Message | PartialMessage) {
  if (!apres.guild || apres.author?.bot || ignore(apres.guild, apres.channelId)) return;
  if (avant.content === apres.content || !apres.content) return;
  await journal(apres.guild, 'message', {
    titre: 'Message modifié',
    ton: 'info',
    lignes: [`**Auteur** : <@${apres.author?.id}> \`${apres.author?.tag}\``, `**Salon** : <#${apres.channelId}> · [aller au message](${apres.url})`],
    champs: [
      { name: 'Avant', value: avant.partial ? '*inconnu*' : citer(avant.content), inline: false },
      { name: 'Après', value: citer(apres.content), inline: false },
    ],
  });
}

async function surSuppressionMasse(messages: Map<string, Message | PartialMessage>, salonId: string, serveur: Guild) {
  if (ignore(serveur, salonId)) return;
  const liste = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const extrait = liste
    .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.tag ?? 'inconnu'} : ${m.content ?? ''}${m.attachments.size ? ` [${m.attachments.size} pièce(s) jointe(s)]` : ''}`)
    .join('\n');
  await journal(serveur, 'clear', {
    titre: 'Suppression en masse',
    ton: 'alerte',
    lignes: [`**Salon** : <#${salonId}>`, `**Messages** : ${liste.length}`],
    fichiers: extrait ? [new AttachmentBuilder(Buffer.from(extrait, 'utf8'), { name: `suppression-${salonId}.txt` })] : [],
  });
}

// - Vocal -

async function surVocal(avant: VoiceState, apres: VoiceState) {
  const membre = apres.member ?? avant.member;
  if (!membre || membre.user.bot) return;
  const serveur = apres.guild;
  if (avant.channelId === apres.channelId) return;
  if (!avant.channelId && apres.channelId) {
    await journal(serveur, 'voice', { titre: 'Connexion vocale', ton: 'ok', lignes: [`<@${membre.id}> a rejoint <#${apres.channelId}>`] });
  } else if (avant.channelId && !apres.channelId) {
    await journal(serveur, 'voice', { titre: 'Déconnexion vocale', ton: 'alerte', lignes: [`<@${membre.id}> a quitté <#${avant.channelId}>`] });
  } else {
    await journal(serveur, 'voice', { titre: 'Déplacement vocal', ton: 'info', lignes: [`<@${membre.id}> : <#${avant.channelId}> → <#${apres.channelId}>`] });
  }
}


type Changement = { key: string; old?: unknown; new?: unknown };

function decrireChangements(changements: Changement[]): string[] {
  const libelles: Record<string, string> = {
    name: 'Nom',
    topic: 'Sujet',
    nsfw: 'NSFW',
    rate_limit_per_user: 'Mode lent',
    color: 'Couleur',
    hoist: 'Affiché séparément',
    mentionable: 'Mentionnable',
    permissions: 'Permissions',
    bitrate: 'Débit',
    user_limit: 'Limite',
    parent_id: 'Catégorie',
    nick: 'Pseudo',
  };
  return changements
    .filter((c) => libelles[c.key])
    .map((c) => `• ${libelles[c.key]} — \`${tronquer(String(c.old ?? '—'), 80)}\` → \`${tronquer(String(c.new ?? '—'), 80)}\``);
}

async function surAudit(entree: GuildAuditLogsEntry, serveur: Guild) {
  const executantId = entree.executorId;
  if (executantId && executantId === serveur.members.me?.id) return;
  const par = executantId ? `<@${executantId}>` : '*inconnu*';
  const executant = executantId ? (serveur.client.users.cache.get(executantId) ?? null) : null;
  const cible = entree.targetId;
  const raison = entree.reason ? `**Raison** : ${tronquer(entree.reason, 500)}` : null;
  const changements = (entree.changes ?? []) as Changement[];
  const envoyer = (type: TypeJournal, titre: string, ton: 'ok' | 'alerte' | 'info' | 'neutre', lignes: (string | null)[]) =>
    journal(serveur, type, { titre, ton, lignes: [...lignes, `**Par** : ${par}`, raison], par: executant });

  switch (entree.action) {
    case AuditLogEvent.ChannelCreate:
      return envoyer('channel', 'Salon créé', 'ok', [`**Salon** : <#${cible}> \`${changements.find((c) => c.key === 'name')?.new ?? ''}\``]);
    case AuditLogEvent.ChannelDelete:
      return envoyer('channel', 'Salon supprimé', 'alerte', [`**Salon** : \`#${changements.find((c) => c.key === 'name')?.old ?? cible}\``]);
    case AuditLogEvent.ChannelUpdate: {
      const lignes = decrireChangements(changements);
      if (!lignes.length) return;
      return envoyer('channel', 'Salon modifié', 'info', [`**Salon** : <#${cible}>`, ...lignes]);
    }
    case AuditLogEvent.ChannelOverwriteCreate:
    case AuditLogEvent.ChannelOverwriteUpdate:
    case AuditLogEvent.ChannelOverwriteDelete:
      return envoyer('channel', 'Permissions de salon modifiées', 'info', [`**Salon** : <#${cible}>`]);
    case AuditLogEvent.RoleCreate:
      return envoyer('role', 'Rôle créé', 'ok', [`**Rôle** : <@&${cible}> \`${changements.find((c) => c.key === 'name')?.new ?? ''}\``]);
    case AuditLogEvent.RoleDelete:
      return envoyer('role', 'Rôle supprimé', 'alerte', [`**Rôle** : \`@${changements.find((c) => c.key === 'name')?.old ?? cible}\``]);
    case AuditLogEvent.RoleUpdate: {
      const lignes = decrireChangements(changements);
      if (!lignes.length) return;
      return envoyer('role', 'Rôle modifié', 'info', [`**Rôle** : <@&${cible}>`, ...lignes]);
    }
    case AuditLogEvent.MemberRoleUpdate: {
      const ajoute = (changements.find((c) => c.key === '$add')?.new as { id: string }[] | undefined) ?? [];
      const retiree = (changements.find((c) => c.key === '$remove')?.new as { id: string }[] | undefined) ?? [];
      return envoyer('role', 'Rôles modifiés', ajoute.length && !retiree.length ? 'ok' : 'info', [
        `**Membre** : <@${cible}>`,
        ajoute.length ? `**Donnés** : ${ajoute.map((r) => `<@&${r.id}>`).join(' ')}` : null,
        retiree.length ? `**Retirés** : ${retiree.map((r) => `<@&${r.id}>`).join(' ')}` : null,
      ]);
    }
    case AuditLogEvent.MemberUpdate: {
      const exclure = changements.find((c) => c.key === 'communication_disabled_until');
      if (exclure) {
        const jusqua = exclure.new ? Date.parse(String(exclure.new)) : null;
        return envoyer('sanction', jusqua ? 'Timeout (manuel)' : 'Timeout retiré (manuel)', jusqua ? 'alerte' : 'ok', [
          `**Membre** : <@${cible}>`,
          jusqua ? `**Jusqu’à** : ${marqueTemps(jusqua, 'f')}` : null,
        ]);
      }
      const surnom = changements.find((c) => c.key === 'nick');
      if (surnom) return envoyer('member', 'Pseudo modifié', 'info', [`**Membre** : <@${cible}>`, ...decrireChangements([surnom])]);
      return;
    }
    case AuditLogEvent.MemberBanAdd:
      return envoyer('sanction', 'Bannissement (manuel)', 'alerte', [`**Membre** : <@${cible}> \`${cible}\``]);
    case AuditLogEvent.MemberBanRemove:
      return envoyer('sanction', 'Débannissement (manuel)', 'ok', [`**Membre** : <@${cible}> \`${cible}\``]);
    case AuditLogEvent.MemberKick:
      return envoyer('sanction', 'Expulsion (manuelle)', 'alerte', [`**Membre** : <@${cible}> \`${cible}\``]);
    case AuditLogEvent.GuildUpdate: {
      const lignes = decrireChangements(changements);
      if (!lignes.length) return;
      return envoyer('channel', 'Serveur modifié', 'info', lignes);
    }
    default:
      return;
  }
}

// - Commandes -

interface LigneJournal {
  categorie: string;
  type: string;
  utilisateur_id: string | null;
  acteur_id: string | null;
  donnees: string;
  cree_le: number;
}

function pagesHistorique(serveur: Guild, utilisateurId: string | null, type: string | null) {
  const rangees = lireTout<LigneJournal>(
    `SELECT categorie, type, utilisateur_id, acteur_id, donnees, cree_le FROM journaux
     WHERE serveur_id = ? AND (? IS NULL OR utilisateur_id = ? OR acteur_id = ?) AND (? IS NULL OR categorie = ?)
     ORDER BY cree_le DESC LIMIT 500`,
    serveur.id,
    utilisateurId,
    utilisateurId,
    utilisateurId,
    type,
    type,
  );
  const lignes = rangees.map((r) => {
    const donnees = lireJson<Record<string, unknown>>(r.donnees, {});
    const detail = typeof donnees.reason === 'string' ? ` — ${tronquer(donnees.reason, 60)}` : typeof donnees.list === 'string' ? ` — ${donnees.list}` : '';
    return `${marqueTemps(r.cree_le, 'd')} \`${r.categorie}·${r.type}\`${r.utilisateur_id ? ` <@${r.utilisateur_id}>` : ''}${r.acteur_id ? ` par <@${r.acteur_id}>` : ''}${detail}`;
  });
  if (!lignes.length) lignes.push('*Rien d’enregistré.*');
  return lignesEnPages(lignes, 15, (contenu, page, total) =>
    embedEnseigne(serveur)
      .setTitle(`🔎 Historique${utilisateurId ? '' : ' du serveur'}`)
      .setDescription(`${utilisateurId ? `<@${utilisateurId}>\n` : ''}${contenu}`)
      .setFooter({ text: `Page ${page}/${total} · ${rangees.length} entrée(s)` }),
  );
}

const commandeJournaux: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  whitelist: 'logs',
  donnees: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('L’historique du serveur')
    .addSubcommand((s) =>
      s
        .setName('voir')
        .setDescription('L’historique')
        .addUserOption((o) => o.setName('membre').setDescription('Une personne'))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Un type')
            .addChoices(...TYPES_JOURNAUX.slice(0, 25).map((t) => ({ name: `${t.nom} — ${tronquer(t.description, 60)}`, value: t.type }))),
        ),
    )
    .addSubcommand((s) => s.setName('salons').setDescription('Créer les salons')),
  niveauxSousCommandes: { salons: Niveau.ADMIN },
  async executer(interaction) {
    if (interaction.options.getSubcommand() === 'salons') {
      await interaction.deferReply({ flags: 64 });
      const suivi = suiviReponse(interaction, interaction.guild, 'Salons de logs');
      const { cree, titreLie } = await creerSalonsJournal(interaction.guild, (f, t) => suivi.regler(f, t));
      await suivi.terminer();
      await interaction.editReply({ embeds: [ok(interaction.guild, `**${cree}** créé(s), **${titreLie}** déjà présent(s).`, { titre: 'Salons de logs' })] });
      return;
    }
    const utilisateur = interaction.options.getUser('membre');
    const type = interaction.options.getString('type');
    await paginer(interaction, pagesHistorique(interaction.guild, utilisateur?.id ?? null, type), true);
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'logs',
    domaine: 'general',
    categorie: 'admin',
    description: 'L’historique',
    usage: '[membre]',
    niveau: Niveau.ADMIN,
    whitelist: 'logs',
    async executer(message, parametres) {
      const id = parametres[0]?.replace(/\D/g, '') || null;
      const pages = pagesHistorique(message.guild, id, null);
      await message.reply({ embeds: [pages[0]!], allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleJournaux: ModuleBot = {
  id: 'logs',
  nom: 'Logs',
  emoji: '📜',
  description: 'Un salon par type de log, avec l’auteur de chaque action',
  desactivable: true,
  actifParDefaut: true,
  commandes: [commandeJournaux],
  commandesPrefixe,
  evenements: [
    sur('guildMemberAdd', (m) => surArrivee(m), 200),
    sur('guildMemberRemove', (m) => surDepart(m), 200),
    sur('messageDelete', (m) => surMessageSupprime(m), 200),
    sur('messageUpdate', (a, b) => surMessageModifie(a, b), 200),
    sur('messageDeleteBulk', (messages, salon) => {
      return surSuppressionMasse(messages as unknown as Map<string, Message | PartialMessage>, salon.id, salon.guild);
    }, 200),
    sur('voiceStateUpdate', (a, b) => surVocal(a, b), 200),
    sur('guildAuditLogEntryCreate', (entree, serveur) => surAudit(entree, serveur), 200),
  ],
  tests: [
    {
      id: 'all',
      libelle: 'Écrire dans chaque salon',
      emoji: '📜',
      description: 'Un message de test par type de log',
      async executer(interaction) {
        const resultats: string[] = [];
        const suivi = suiviReponse(interaction, interaction.guild, 'Test des logs', TYPES_JOURNAUX.length);
        for (const t of TYPES_JOURNAUX) {
          suivi.avancer();
          const envoye = await journal(interaction.guild, t.type, { titre: 'Test des logs', ton: 'info', lignes: [definitionJournal(t.type).description], par: interaction.user });
          resultats.push(`${envoye ? '✅' : '❌'} \`${t.nom}\``);
        }
        await suivi.terminer();
        return resultats.join(' · ');
      },
    },
  ],
};
