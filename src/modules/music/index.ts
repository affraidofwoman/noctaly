import {
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { emojiPour } from '../../core/brand';
import { nomEnseigne, couleurPour, erreur, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { creerRegistre } from '../../core/logger';
import { aNiveau } from '../../core/permissions';
import type { PageReglage } from '../../core/setup';
import { barreProgression, tronquer } from '../../core/text';
import { formaterHorloge } from '../../core/time';
import { bouton, estLienHttp, rangee } from '../../core/ui';
import { estWhitelist } from '../../core/whitelists';
import { sur, Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { toutesSessions, detruireTout, obtenirSession, lireSession, LIBELLES_BOUCLE, type LecteurServeur, type ModeBoucle, type EvenementsLecteur } from '../../services/music/player';
import { FFMPEG, initialiserSources, resoudre, spotifyActif, type Piste } from '../../services/music/sources';

const registre = creerRegistre('musique');
const derniereAnnonce = new Map<string, Message>();

// ─── Rendu ─────────────────────────────────────────────────────────────────

const titreLie = (t: Piste) => {
  const url = t.urlOrigine ?? t.url;
  return url ? `[${tronquer(t.titre, 200)}](${url})` : tronquer(t.titre, 200);
};

function controles(session: LecteurServeur | undefined, serveurId: string): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const enPause = session?.paused ?? false;
  const boucle = session?.boucle ?? 'off';
  return [
    rangee(
      bouton('mu:prev', '', ButtonStyle.Secondary, '⏮️').setDisabled(!session?.historique.length),
      bouton('mu:toggle', '', enPause ? ButtonStyle.Success : ButtonStyle.Primary, '⏯️'),
      bouton('mu:skip', '', ButtonStyle.Secondary, '⏭️'),
    ),
    rangee(
      bouton('mu:shuffle', '', ButtonStyle.Secondary, '🔀'),
      bouton('mu:loop', boucle === 'off' ? '' : boucle === 'track' ? '1' : '∞', boucle === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success, '🔁'),
      bouton('mu:stop', '', ButtonStyle.Danger, '⏹️'),
      bouton('mu:queue', '', ButtonStyle.Secondary, emojiPour(serveurId, 'message')),
    ),
  ];
}

export function embedLecture(serveur: Guild, session: LecteurServeur | undefined): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(couleurPour(serveur)).setAuthor({ name: '🎵 NOW PLAYING' });
  const piste = session?.actuel;
  if (!session || !piste) {
    return embed.setDescription('💤 **Rien en lecture.** Lance `/play` ou `m!play <titre ou lien>` pour démarrer.');
  }
  const ecoule = Math.min(session.elapsed, piste.duree || session.elapsed);
  embed
    .setDescription(
      [
        `${session.paused ? '⏸️' : '▶️'} **${titreLie(piste)}**`,
        `${barreProgression(piste.duree ? ecoule / piste.duree : 0, 16)}  \`${formaterHorloge(ecoule)} / ${formaterHorloge(piste.duree)}\``,
      ].join('\n'),
    )
    .addFields(
      { name: '🔊 Volume', value: `${Math.round(session.volume * 100)} %`, inline: true },
      { name: '🔁 Boucle', value: LIBELLES_BOUCLE[session.boucle], inline: true },
      { name: '📋 En attente', value: `${session.waiting} morceau${session.waiting > 1 ? 'x' : ''}`, inline: true },
      { name: '👤 Demandé par', value: `<@${piste.demandePar}>`, inline: true },
      { name: '⏳ Restant', value: piste.duree ? formaterHorloge(Math.max(0, piste.duree - ecoule)) : '—', inline: true },
      { name: '🎧 Salon', value: session.channelId ? `<#${session.channelId}>` : '—', inline: true },
    )
    .setFooter({ text: `${nomEnseigne(serveur)} · m!play · m!skip · m!stop · m!panel` });
  if (piste.miniature && estLienHttp(piste.miniature)) embed.setThumbnail(piste.miniature);
  return embed;
}

function embedFile(serveur: Guild, session: LecteurServeur, page = 0): EmbedBuilder {
  const lireTout = [...session.file, ...session.reserve];
  const parPage = 10;
  const pages = Math.max(1, Math.ceil(lireTout.length / parPage));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const lignes = lireTout.slice(p * parPage, (p + 1) * parPage).map((t, i) => `**${p * parPage + i + 1}.** ${tronquer(t.titre, 80)} \`[${formaterHorloge(t.duree)}]\` — <@${t.demandePar}>`);
  return new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setTitle('📋 File d’attente')
    .setDescription(
      `${session.actuel ? `**En cours :** ${titreLie(session.actuel)} \`[${formaterHorloge(session.actuel.duree)}]\`\n\n` : ''}${lignes.length ? lignes.join('\n') : '_Rien après le morceau en cours._'}`,
    )
    .setFooter({ text: `Page ${p + 1}/${pages} · ${lireTout.length} en attente · Boucle : ${LIBELLES_BOUCLE[session.boucle]} · Volume : ${Math.round(session.volume * 100)}%` });
}

// ─── Événements du lecteur ─────────────────────────────────────────────────

function salonTexte(session: LecteurServeur): GuildTextBasedChannel | null {
  const salonVise = session.salonTexteId ? session.serveur.channels.cache.get(session.salonTexteId) : null;
  return salonVise && salonVise.isTextBased() ? (salonVise as GuildTextBasedChannel) : null;
}

async function annonce(session: LecteurServeur, charge: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<MessageActionRowComponentBuilder>[] }) {
  const salon = salonTexte(session);
  if (!salon) return;
  const envoye = await salon.send(charge).catch(() => null);
  const precedent = derniereAnnonce.get(session.serveur.id);
  if (envoye) derniereAnnonce.set(session.serveur.id, envoye);
  // Un seul panneau « Lecture en cours » à la fois, comme sur Airline.
  if (precedent && envoye && precedent.id !== envoye.id) await precedent.delete().catch(() => undefined);
}

const evenements: EvenementsLecteur = {
  surDebut(session) {
    if (!lireConfig(session.serveur.id).musique.annoncerLecture) return;
    void annonce(session, { embeds: [embedLecture(session.serveur, session)], components: controles(session, session.serveur.id) });
  },
  surErreur(session, piste, erreur) {
    void annonce(session, {
      embeds: [new EmbedBuilder().setColor(couleurPour(session.serveur, 'error')).setDescription(`⚠️ Impossible de lire **${tronquer(piste?.titre ?? 'ce morceau', 150)}** : \`${tronquer(erreur.message, 200)}\`. Passage au suivant.`)],
    });
  },
  surFin(session) {
    void annonce(session, { embeds: [new EmbedBuilder().setColor(couleurPour(session.serveur)).setDescription('📭 File terminée. Ajoute un morceau avec `m!play` — je quitte le vocal dans 5 minutes sinon.')] });
  },
};

// ─── Actions partagées (préfixe, slash, boutons) ───────────────────────────

function estDj(membre: GuildMember): boolean {
  const reglages = lireConfig(membre.guild.id).musique;
  return aNiveau(membre, Niveau.STAFF) || estWhitelist('dj', membre.id, membre.guild.id) || membre.roles.cache.some((r) => reglages.rolesDj.includes(r.id));
}

function exigerSession(serveur: Guild, exigerPiste = false): LecteurServeur {
  const session = lireSession(serveur.id);
  if (!session?.connexion) throw new ErreurUtilisateur('Je ne suis pas en vocal.');
  if (exigerPiste && !session.actuel) throw new ErreurUtilisateur('Rien n’est en train de jouer.');
  return session;
}

function exigerMemeSalon(membre: GuildMember, session: LecteurServeur): void {
  if (!session.estDansLeSalon(membre) && !estDj(membre)) throw new ErreurUtilisateur('Rejoins le salon vocal du bot pour contrôler la lecture.');
}

function vocalDe(membre: GuildMember) {
  const salon = membre.voice.channel;
  if (!salon) throw new ErreurUtilisateur('Rejoins un salon vocal d’abord.');
  const permissions = salon.permissionsFor(membre.guild.members.me!);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new ErreurUtilisateur('Je n’ai pas la permission de rejoindre / parler dans ce salon.');
  const occupe = lireSession(membre.guild.id);
  if (occupe?.channelId && occupe.channelId !== salon.id && occupe.actuel && !estDj(membre)) throw new ErreurUtilisateur(`Je joue déjà dans <#${occupe.channelId}>.`);
  return salon;
}

async function lancerLecture(membre: GuildMember, salonTexteId: string, requete: string): Promise<EmbedBuilder> {
  if (!requete.trim()) throw new ErreurUtilisateur('Usage : `m!play <lien ou recherche>`.');
  if (!FFMPEG) throw new ErreurUtilisateur('FFmpeg est introuvable sur la machine du bot : la musique est indisponible.');
  const salon = vocalDe(membre);
  const resultat = await resoudre(requete);
  if (resultat.genre === 'error') throw new ErreurUtilisateur(resultat.raison);
  const session = obtenirSession(membre.guild, evenements);
  session.salonTexteId = salonTexteId;
  session.rejoindre(salon);
  const serveur = membre.guild;

  if (resultat.genre === 'playlist') {
    if (!resultat.pistes.length) throw new ErreurUtilisateur('Cette playlist est vide ou inaccessible.');
    const pistes = resultat.pistes.map((t) => ({ ...t, demandePar: membre.id, depuisPlaylist: true }));
    const { reserves } = session.ajouter(pistes);
    return ok(serveur, `Playlist **${tronquer(resultat.nom, 100)}** ajoutée — **${pistes.length}** morceaux, à partir de **${tronquer(pistes[0]!.titre, 100)}**${reserves ? ` — dont **${reserves}** en réserve, qui remonteront tout seuls` : ''}.`);
  }

  const piste: Piste = { ...resultat.piste, demandePar: membre.id };
  const { position, immediat } = session.ajouter([piste]);
  const embed = new EmbedBuilder()
    .setColor(couleurPour(serveur))
    .setAuthor({ name: immediat ? 'Lecture en cours' : 'Ajouté à la file' })
    .addFields({ name: 'Morceau', value: titreLie(piste) })
    .setFooter({ text: `Demandé par ${membre.user.username}`, iconURL: membre.user.displayAvatarURL({ size: 64 }) });
  if (piste.miniature && estLienHttp(piste.miniature)) embed.setThumbnail(piste.miniature);
  if (immediat) embed.addFields({ name: 'Durée du morceau', value: formaterHorloge(piste.duree), inline: true });
  else {
    embed.addFields(
      { name: 'Avant lecture (estimé)', value: formaterHorloge(session.tempsAvant(position - 1)), inline: true },
      { name: 'Durée du morceau', value: formaterHorloge(piste.duree), inline: true },
      { name: 'Position dans la file', value: String(position), inline: true },
    );
  }
  return embed;
}

type Action = 'pause' | 'resume' | 'toggle' | 'skip' | 'stop' | 'shuffle' | 'prev' | 'join' | 'leave' | 'cancelplaylist';

function executerAction(membre: GuildMember, action: Action, salonTexteId: string | null): string {
  const serveur = membre.guild;
  if (action === 'join') {
    const salon = vocalDe(membre);
    const session = obtenirSession(serveur, evenements);
    if (salonTexteId) session.salonTexteId = salonTexteId;
    session.rejoindre(salon);
    return `✅ Rejoint **${salon.name}**.`;
  }
  const session = exigerSession(serveur, ['pause', 'resume', 'toggle', 'skip', 'prev'].includes(action));
  exigerMemeSalon(membre, session);
  switch (action) {
    case 'pause':
      if (session.paused) return 'ℹ️ Déjà en pause.';
      session.basculerPause();
      return '⏸️ Lecture en pause.';
    case 'resume':
      if (!session.paused) return 'ℹ️ La lecture n’est pas en pause.';
      session.basculerPause();
      return '▶️ Lecture reprise.';
    case 'toggle':
      return session.basculerPause() ? '⏸️ Lecture en pause.' : '▶️ Lecture reprise.';
    case 'skip': {
      const actuel = session.actuel!;
      if (estDj(membre) || actuel.demandePar === membre.id || session.auditeursHumains() <= 2) {
        session.passer();
        return `⏭️ **${tronquer(actuel.titre, 150)}** passé.`;
      }
      session.votesPasser.add(membre.id);
      const requis = session.votesRequis();
      if (session.votesPasser.size < requis) return `🗳️ Vote pour passer **${tronquer(actuel.titre, 120)}** : **${session.votesPasser.size}/${requis}**.`;
      session.passer();
      return `⏭️ **${tronquer(actuel.titre, 150)}** passé (vote majoritaire).`;
    }
    case 'prev': {
      const anterieur = session.precedent();
      return anterieur ? `⏮️ Retour à **${tronquer(anterieur.titre, 150)}**.` : 'ℹ️ Aucun morceau précédent.';
    }
    case 'shuffle':
      if (session.waiting < 2) throw new ErreurUtilisateur('Pas assez de morceaux en attente pour mélanger.');
      return `🔀 File mélangée — **${session.melanger()}** morceaux.`;
    case 'cancelplaylist': {
      const n = session.retirerPistesPlaylist();
      return n ? `✅ Playlist annulée — **${n}** morceau(x) retiré(s).` : 'ℹ️ Aucune playlist en attente.';
    }
    case 'stop':
    case 'leave': {
      if (!estDj(membre) && session.auditeursHumains() > 1 && session.actuel?.demandePar !== membre.id) {
        throw new ErreurUtilisateur('Seul un DJ (ou la personne seule en vocal) peut tout arrêter.');
      }
      const joues = session.joues;
      session.detruire();
      derniereAnnonce.get(serveur.id)?.edit({ components: [] }).catch(() => undefined);
      return `🎵 Merci d’avoir écouté avec **${nomEnseigne(serveur)}** ! La file est vidée et je quitte le vocal.${joues ? ` **${joues}** morceau${joues > 1 ? 'x' : ''} joué${joues > 1 ? 's' : ''} cette session.` : ''}`;
    }
  }
  return '';
}

function reglerVolume(membre: GuildMember, brut: string): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const valeur = Number.parseInt(brut, 10);
  if (!Number.isFinite(valeur) || valeur < 1 || valeur > 200) throw new ErreurUtilisateur('Volume entre 1 et 200.');
  session.reglerVolume(valeur);
  return `🔊 Volume réglé à **${valeur}%**.`;
}

function reglerBoucle(membre: GuildMember, brut: string | null): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const correspondance: Record<string, ModeBoucle> = { off: 'off', non: 'off', piste: 'track', track: 'track', morceau: 'track', file: 'queue', queue: 'queue' };
  const ordre: ModeBoucle[] = ['off', 'track', 'queue'];
  const mode = brut ? correspondance[brut.toLowerCase()] : ordre[(ordre.indexOf(session.boucle) + 1) % ordre.length];
  if (!mode) throw new ErreurUtilisateur('Usage : `m!loop <off|piste|file>`.');
  session.boucle = mode;
  return `🔁 Boucle : **${LIBELLES_BOUCLE[mode]}**.`;
}

function retirerPosition(membre: GuildMember, brut: string): string {
  const session = exigerSession(membre.guild);
  exigerMemeSalon(membre, session);
  const position = Number.parseInt(brut, 10);
  if (!Number.isFinite(position) || position < 1 || position > session.waiting) throw new ErreurUtilisateur(`Usage : \`m!remove <position>\` (1 à ${session.waiting}).`);
  const retiree = session.retirer(position);
  if (!retiree) throw new ErreurUtilisateur('Cette position n’existe plus.');
  if (retiree.demandePar !== membre.id && !estDj(membre)) {
    session.file.splice(position - 1, 0, retiree);
    throw new ErreurUtilisateur('Tu ne peux retirer que tes propres morceaux.');
  }
  return `🗑️ **${tronquer(retiree.titre, 150)}** retiré de la file.`;
}

// ─── Panneau (m!panel) ─────────────────────────────────────────────────────

const OPTIONS_PANNEAU: { value: string; label: string; description: string; emoji: string }[] = [
  { value: 'queue', label: 'File d’attente', description: 'Les morceaux en attente', emoji: '📋' },
  { value: 'shuffle', label: 'Mélanger la file', description: 'Ordre aléatoire', emoji: '🔀' },
  { value: 'loop-off', label: 'Boucle : désactivée', description: 'Lecture normale', emoji: '➡️' },
  { value: 'loop-track', label: 'Boucle : le morceau', description: 'Répète le morceau en cours', emoji: '🔂' },
  { value: 'loop-queue', label: 'Boucle : la file', description: 'Répète toute la file', emoji: '🔁' },
  ...[10, 25, 50, 75, 100, 125, 150, 200].map((v) => ({ value: `vol-${v}`, label: `Volume ${v} %`, description: v <= 25 ? 'Fond sonore' : v <= 75 ? 'Posé' : v === 100 ? 'Normal' : 'Fort', emoji: v <= 25 ? '🔈' : v <= 100 ? '🔉' : '📢' })),
  { value: 'join', label: 'Rejoindre mon salon', description: 'Fait venir le bot', emoji: '📥' },
  { value: 'cancelplaylist', label: 'Annuler la playlist', description: 'Retire les morceaux de playlist', emoji: '🚪' },
];

function affichagePanneau(serveur: Guild) {
  const session = lireSession(serveur.id);
  const menu = new StringSelectMenuBuilder().setCustomId('mu:panel').setPlaceholder('Une action…').addOptions(OPTIONS_PANNEAU);
  return { embeds: [embedLecture(serveur, session)], components: [...controles(session, serveur.id), rangee(menu)] };
}

// ─── Commandes à préfixe m! ────────────────────────────────────────────────

async function repondreTexte(message: Message<true>, texte: string) {
  await message.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(message.guild)).setDescription(texte)], allowedMentions: { repliedUser: false } });
}

const simple = (nom: string, action: Action, description: string, alias: string[] = []): CommandePrefixe => ({
  nom,
  alias,
  domaine: 'music',
  categorie: 'music',
  description,
  async executer(message) {
    if (!message.member) return;
    await repondreTexte(message, executerAction(message.member, action, message.channelId));
  },
});

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'play',
    alias: ['p'],
    domaine: 'music',
    categorie: 'music',
    description: 'Un titre ou un lien',
    usage: '<titre ou lien>',
    async executer(message, parametres) {
      if (!message.member) return;
      const chargement = await message.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(message.guild)).setDescription('🔎 Recherche…')], allowedMentions: { repliedUser: false } });
      try {
        const embed = await lancerLecture(message.member, message.channelId, parametres.join(' '));
        await chargement.edit({ embeds: [embed] });
      } catch (echec) {
        await chargement.edit({ embeds: [erreur(message.guild, echec instanceof ErreurUtilisateur ? echec.message : 'La lecture a échoué.')] });
      }
    },
  },
  simple('join', 'join', 'Me faire venir'),
  simple('pause', 'pause', 'Suspendre'),
  simple('resume', 'resume', 'Reprendre'),
  simple('skip', 'skip', 'Au suivant', ['s', 'next']),
  simple('previous', 'prev', 'Morceau précédent', ['prev', 'back']),
  simple('stop', 'stop', 'Tout arrêter', ['leave', 'dc']),
  simple('shuffle', 'shuffle', 'Mélanger'),
  simple('annuler', 'cancelplaylist', 'Annuler la playlist'),
  {
    nom: 'queue',
    alias: ['q'],
    domaine: 'music',
    categorie: 'music',
    description: 'Ce qui suit',
    async executer(message, parametres) {
      const session = exigerSession(message.guild);
      await message.reply({ embeds: [embedFile(message.guild, session, (Number(parametres[0]) || 1) - 1)], allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'nowplaying',
    alias: ['np'],
    domaine: 'music',
    categorie: 'music',
    description: 'En cours',
    async executer(message) {
      await message.reply({ embeds: [embedLecture(message.guild, lireSession(message.guildId))], components: controles(lireSession(message.guildId), message.guildId), allowedMentions: { repliedUser: false } });
    },
  },
  {
    nom: 'volume',
    alias: ['vol', 'v'],
    domaine: 'music',
    categorie: 'music',
    description: 'De 1 à 200 %',
    usage: '<1-200>',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, reglerVolume(message.member, parametres[0] ?? ''));
    },
  },
  {
    nom: 'loop',
    domaine: 'music',
    categorie: 'music',
    description: 'off · piste · file',
    usage: '[off|piste|file]',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, reglerBoucle(message.member, parametres[0] ?? null));
    },
  },
  {
    nom: 'remove',
    alias: ['rm'],
    domaine: 'music',
    categorie: 'music',
    description: 'Retirer un rang',
    usage: '<position>',
    async executer(message, parametres) {
      if (!message.member) return;
      await repondreTexte(message, retirerPosition(message.member, parametres[0] ?? ''));
    },
  },
  {
    nom: 'panel',
    domaine: 'music',
    categorie: 'music',
    description: 'Tout au clic',
    async executer(message) {
      await message.channel.send(affichagePanneau(message.guild));
    },
  },
  {
    nom: 'help',
    domaine: 'music',
    categorie: 'music',
    description: 'Les commandes musique',
    async executer(message) {
      const p = lireConfig(message.guildId).prefixes.music;
      const embed = new EmbedBuilder()
        .setColor(couleurPour(message.guild))
        .setTitle('🎵 La musique')
        .setDescription(`Toutes les commandes musique. Le panneau **${p}panel** fait la même chose au clic.`)
        .addFields(
          { name: '🎵 Écouter', value: [`**${p}play** — Un titre ou un lien`, `**${p}join** — Me faire venir`, `**${p}panel** — Tout au clic`].join('\n'), inline: true },
          { name: '⏯️ Pendant la lecture', value: [`**${p}pause** — Suspendre`, `**${p}resume** — Reprendre`, `**${p}skip** — Au suivant`, `**${p}previous** — Précédent`, `**${p}stop** — Tout arrêter`].join('\n'), inline: true },
          { name: '​', value: '⠀', inline: false },
          { name: '📋 La file', value: [`**${p}queue** — Ce qui suit`, `**${p}np** — En cours`, `**${p}shuffle** — Mélanger`, `**${p}remove** — Retirer un rang`].join('\n'), inline: true },
          { name: '⚙️ Réglages', value: [`**${p}volume** — De 1 à 200 %`, `**${p}loop** — off · piste · file`].join('\n'), inline: true },
        )
        .setFooter({ text: `${nomEnseigne(message.guild)} · /help pour le reste du bot` });
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  },
];

// ─── Commandes slash ───────────────────────────────────────────────────────

function slash(nom: string, description: string, executer: (i: ChatInputCommandInteraction<'cached'>) => Promise<string | void>, construire?: (b: SlashCommandBuilder) => SlashCommandBuilder): CommandeSlash {
  const constructeur = new SlashCommandBuilder().setName(nom).setDescription(description);
  return {
    categorie: 'music',
    donnees: construire ? construire(constructeur) : constructeur,
    async executer(interaction) {
      const texte = await executer(interaction);
      if (texte) await interaction.reply({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)] });
    },
  };
}

const commandes: CommandeSlash[] = [
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Jouer un titre ou un lien')
      .addStringOption((o) => o.setName('recherche').setDescription('Titre, lien YouTube, SoundCloud, Spotify ou Deezer').setRequired(true).setMaxLength(500)),
    delaiSecondes: 2,
    async executer(interaction) {
      await interaction.deferReply();
      const embed = await lancerLecture(interaction.member, interaction.channelId, interaction.options.getString('recherche', true));
      await interaction.editReply({ embeds: [embed] });
    },
  },
  slash('pause', 'Mettre en pause', async (i) => executerAction(i.member, 'pause', i.channelId)),
  slash('resume', 'Reprendre la lecture', async (i) => executerAction(i.member, 'resume', i.channelId)),
  slash('skip', 'Passer au suivant', async (i) => executerAction(i.member, 'skip', i.channelId)),
  slash('stop', 'Tout arrêter et quitter', async (i) => executerAction(i.member, 'stop', i.channelId)),
  slash('join', 'Me faire venir en vocal', async (i) => executerAction(i.member, 'join', i.channelId)),
  slash('leave', 'Me faire quitter le vocal', async (i) => executerAction(i.member, 'leave', i.channelId)),
  slash('shuffle', 'Mélanger la file', async (i) => executerAction(i.member, 'shuffle', i.channelId)),
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('La file d’attente')
      .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
    async executer(interaction) {
      const session = exigerSession(interaction.guild);
      await interaction.reply({ embeds: [embedFile(interaction.guild, session, (interaction.options.getInteger('page') ?? 1) - 1)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    categorie: 'music',
    donnees: new SlashCommandBuilder().setName('nowplaying').setDescription('Le morceau en cours'),
    async executer(interaction) {
      const session = lireSession(interaction.guildId);
      await interaction.reply({ embeds: [embedLecture(interaction.guild, session)], components: controles(session, interaction.guildId) });
    },
  },
  slash('volume', 'Régler le volume', async (i) => reglerVolume(i.member, String(i.options.getInteger('valeur', true))), (b) =>
    b.addIntegerOption((o) => o.setName('valeur').setDescription('De 1 à 200 %').setMinValue(1).setMaxValue(200).setRequired(true)) as SlashCommandBuilder,
  ),
  slash('loop', 'Boucle : off, morceau ou file', async (i) => reglerBoucle(i.member, i.options.getString('mode')), (b) =>
    b.addStringOption((o) => o.setName('mode').setDescription('Le mode (alterne si vide)').addChoices({ name: 'Désactivée', value: 'off' }, { name: 'Le morceau', value: 'piste' }, { name: 'La file', value: 'file' })) as SlashCommandBuilder,
  ),
];

const pageReglage: PageReglage = {
  id: 'music',
  section: 'music',
  titre: 'Musique',
  emoji: '🎵',
  moduleId: 'music',
  description: 'Le lecteur : YouTube, SoundCloud, Spotify (si configuré) et Deezer.\n-# Les DJ (rôles ci-dessous, whitelist DJ ou staff) passent les morceaux sans vote et peuvent tout arrêter.',
  champs: [
    { genre: 'roles', cle: 'dj', libelle: 'Rôles DJ', max: 10, lire: (c) => c.musique.rolesDj, ecrire: (c, v) => void (c.musique.rolesDj = v) },
    { genre: 'toggle', cle: 'announce', libelle: 'Annoncer chaque morceau', lire: (c) => c.musique.annoncerLecture, ecrire: (c, v) => void (c.musique.annoncerLecture = v) },
    { genre: 'number', cle: 'volume', libelle: 'Volume par défaut', min: 1, max: 200, unite: '%', lire: (c) => c.musique.volumeParDefaut, ecrire: (c, v) => void (c.musique.volumeParDefaut = v) },
    { genre: 'number', cle: 'empty', libelle: 'Quitter si seul après', min: 0, max: 60, unite: 'min', lire: (c) => c.musique.quitterSiVideMinutes, ecrire: (c, v) => void (c.musique.quitterSiVideMinutes = v) },
    { genre: 'number', cle: 'maxqueue', libelle: 'Taille de file (×25 en réserve)', min: 10, max: 1000, lire: (c) => c.musique.maxQueue, ecrire: (c, v) => void (c.musique.maxQueue = v) },
  ],
};

export const moduleMusique: ModuleBot = {
  id: 'music',
  nom: 'Musique',
  emoji: '🎵',
  description: 'Lecteur YouTube / SoundCloud / Spotify / Deezer avec panneau',
  desactivable: true,
  actifParDefaut: true,
  commandes,
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'mu',
      async bouton(interaction: ButtonInteraction<'cached'>, [action]) {
        const membre = interaction.member;
        if (action === 'queue') {
          const session = exigerSession(interaction.guild);
          return interaction.reply({ embeds: [embedFile(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        let texte: string;
        if (action === 'loop') texte = reglerBoucle(membre, null);
        else texte = executerAction(membre, action as Action, interaction.channelId);
        const session = lireSession(interaction.guildId);
        await interaction.update({ embeds: [embedLecture(interaction.guild, session)], components: session ? interaction.message.components.length > 2 ? affichagePanneau(interaction.guild).components : controles(session, interaction.guildId) : [] });
        if (texte) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)], flags: MessageFlags.Ephemeral });
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>) {
        if (!interaction.isStringSelectMenu()) return;
        const membre = interaction.member;
        const valeur = interaction.values[0] ?? '';
        let texte = '';
        if (valeur === 'queue') {
          const session = exigerSession(interaction.guild);
          return interaction.reply({ embeds: [embedFile(interaction.guild, session)], flags: MessageFlags.Ephemeral });
        }
        if (valeur.startsWith('vol-')) texte = reglerVolume(membre, valeur.slice(4));
        else if (valeur.startsWith('loop-')) texte = reglerBoucle(membre, valeur.slice(5) === 'track' ? 'piste' : valeur.slice(5) === 'queue' ? 'file' : 'off');
        else texte = executerAction(membre, valeur as Action, interaction.channelId);
        await interaction.update(affichagePanneau(interaction.guild));
        if (texte) await interaction.followUp({ embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setDescription(texte)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('voiceStateUpdate', (avant, apres) => {
      const session = lireSession(apres.guild.id);
      if (!session) return;
      if (apres.id === apres.client.user.id && !apres.channelId) {
        session.detruire();
        return;
      }
      if (avant.channelId === session.channelId || apres.channelId === session.channelId) session.verifierVide();
    }),
  ],
  async auDemarrage() {
    await initialiserSources();
    registre.info(`Musique prête — FFmpeg : ${FFMPEG ? 'oui' : 'NON'} · Spotify : ${spotifyActif() ? 'oui' : 'non'}`);
  },
  aLArret() {
    detruireTout();
  },
  tests: [
    {
      id: 'status',
      libelle: 'État du lecteur',
      emoji: '🎵',
      description: 'FFmpeg, Spotify et sessions en cours',
      async executer() {
        return [
          `${FFMPEG ? '✅' : '❌'} FFmpeg${FFMPEG ? ` (${FFMPEG.length > 40 ? '…' + FFMPEG.slice(-40) : FFMPEG})` : ' introuvable'}`,
          `${spotifyActif() ? '✅' : 'ℹ️'} Spotify${spotifyActif() ? '' : ' non configuré (liens Spotify refusés)'}`,
          `🎧 ${toutesSessions().length} session(s) en cours sur tous les serveurs`,
        ].join('\n');
      },
    },
  ],
};
