import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { enseigneDe, lireCouleur, enHexa } from '../../core/brand';
import { embedEnseigne, info, ok } from '../../core/embeds';
import { environnement } from '../../core/env';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { creerRegistre } from '../../core/logger';
import { lirePageReglage, afficherPage, type PageReglage } from '../../core/setup';
import { tronquer } from '../../core/text';
import { marqueTemps } from '../../core/time';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { aideVariables } from '../../core/variables';
import { Niveau, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';
import { lireLives, twitchConfigure, MOTIF_PSEUDO, normaliserPseudo, type TwitchStream } from '../../services/twitch/api';
import { ClientAbonnementsTwitch } from '../../services/twitch/eventsub';
import {
  ajouterChaine,
  construireMessageLive,
  lireChaine,
  lireChaineParId,
  listerChaines,
  sonderClips,
  sonderLives,
  retirerChaine,
  modifierChaine,
  type LigneChaineTwitch,
} from '../../services/twitch/notifier';

const registre = creerRegistre('twitch');
let abonnementsTwitch: ClientAbonnementsTwitch | null = null;

function exigerTwitch(): void {
  if (!twitchConfigure()) throw new ErreurUtilisateur('Twitch n’est pas relié : l’hébergeur doit renseigner `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` dans le fichier .env.');
}

function exigerChaine(serveurId: string, id: string | number | undefined): LigneChaineTwitch {
  const rangee = lireChaineParId(Number(id));
  if (!rangee || rangee.serveur_id !== serveurId) throw new ErreurUtilisateur('Cette chaîne n’est plus suivie.');
  return rangee;
}

async function suivre(serveur: Guild, pseudoBrut: string, salonId: string | null, roleId: string | null): Promise<LigneChaineTwitch> {
  exigerTwitch();
  const pseudo = normaliserPseudo(pseudoBrut);
  if (!MOTIF_PSEUDO.test(pseudo)) throw new ErreurUtilisateur('Pseudo Twitch invalide (3 à 25 caractères : lettres, chiffres, _).');
  if (listerChaines(serveur.id).length >= 25 && !lireChaine(serveur.id, pseudo)) throw new ErreurUtilisateur('25 chaînes maximum par serveur.');
  const reglages = lireConfig(serveur.id).twitch;
  const cible = salonId ?? reglages.salonDefautId;
  if (!cible) throw new ErreurUtilisateur('Choisis un salon d’annonce (option `salon`, ou salon par défaut dans `/twitch setup`).');
  const rangee = await ajouterChaine(serveur.id, pseudo, cible, roleId ?? reglages.roleDefautId).catch((echec: Error) => {
    if (echec.message === 'introuvable') throw new ErreurUtilisateur(`La chaîne **${pseudo}** n’existe pas sur Twitch.`);
    throw echec;
  });
  abonnementsTwitch?.resynchroniser();
  return rangee;
}

// ─── Écrans ────────────────────────────────────────────────────────────────

function ecranListe(serveur: Guild, note?: string) {
  const rangees = listerChaines(serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🔴 Chaînes Twitch suivies')
    .setDescription(
      [
        note,
        rangees.length ? 'Choisis une chaîne pour régler son salon, son rôle, son message et ses notifications.' : '*Aucune chaîne suivie. Ajoute la première !*',
        twitchConfigure() ? null : '\n⚠️ `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` manquants dans le .env : aucune notification ne partira.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  for (const r of rangees.slice(0, 24)) {
    embed.addFields({
      name: `${r.live_id ? '🔴' : '⚫'} ${r.nom_affiche ?? r.pseudo}`,
      value: tronquer(`<#${r.salon_id}>${r.role_id ? ` · <@&${r.role_id}>` : ''}${r.live_id ? `\n-# en live depuis ${marqueTemps(r.live_debut_le ?? Date.now(), 'R')}` : ''}`, 1024),
      inline: true,
    });
  }
  const composants: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (rangees.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('twc:open')
          .setPlaceholder('Régler une chaîne')
          .addOptions(rangees.slice(0, 25).map((r) => ({ label: r.nom_affiche ?? r.pseudo, value: String(r.id), emoji: r.live_id ? '🔴' : '⚫', description: `twitch.tv/${r.pseudo}` }))),
      ),
    );
  }
  composants.push(rangee(bouton('twc:add', 'Ajouter une chaîne', ButtonStyle.Success, '➕'), bouton('twc:back', 'Réglages Twitch', ButtonStyle.Secondary, '⚙️')));
  return { embeds: [embed], components: composants };
}

function ecranChaine(serveur: Guild, r: LigneChaineTwitch, note?: string) {
  const drapeau = (v: number) => (v ? '🟢' : '🔴');
  const embed = embedEnseigne(serveur)
    .setAuthor({ name: `twitch.tv/${r.pseudo}`, iconURL: r.image_profil ?? undefined, url: `https://twitch.tv/${r.pseudo}` })
    .setTitle(`🔴 ${r.nom_affiche ?? r.pseudo}`)
    .setDescription(
      [
        note,
        `• Salon — <#${r.salon_id}>`,
        `• Rôle mentionné — ${r.role_id ? `<@&${r.role_id}>` : '*aucun*'}`,
        `• Couleur — ${r.couleur ?? '*par défaut*'}`,
        `• Message — ${r.message ? `\`${tronquer(r.message, 150)}\`` : '*celui du serveur*'}`,
        '',
        `${drapeau(r.afficher_image)} Miniature du live · ${drapeau(r.notifier_fin)} Fin de live · ${drapeau(r.notifier_changements)} Jeu/titre · ${drapeau(r.notifier_clips)} Clips · ${drapeau(r.notifier_evenements)} Raids/follows/subs`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
  if (r.image_profil) embed.setThumbnail(r.image_profil);
  const selecteurSalon = new ChannelSelectMenuBuilder()
    .setCustomId(`twc:chan:${r.id}`)
    .setPlaceholder('Salon d’annonce')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (serveur.channels.cache.has(r.salon_id)) selecteurSalon.setDefaultChannels(r.salon_id);
  const selecteurRole = new RoleSelectMenuBuilder().setCustomId(`twc:role:${r.id}`).setPlaceholder('Rôle mentionné (aucun = personne)').setMinValues(0).setMaxValues(1);
  if (r.role_id && serveur.roles.cache.has(r.role_id)) selecteurRole.setDefaultRoles(r.role_id);
  const basculer = (cle: string, texteLibelle: string, sur: number) => bouton(`twc:tog:${r.id}:${cle}`, texteLibelle, sur ? ButtonStyle.Success : ButtonStyle.Secondary, sur ? '🟢' : '🔴');
  return {
    embeds: [embed],
    components: [
      rangee(selecteurSalon),
      rangee(selecteurRole),
      rangee(basculer('afficher_image', 'Miniature', r.afficher_image), basculer('notifier_fin', 'Fin', r.notifier_fin), basculer('notifier_changements', 'Jeu/titre', r.notifier_changements), basculer('notifier_clips', 'Clips', r.notifier_clips), basculer('notifier_evenements', 'Événements', r.notifier_evenements)),
      rangee(
        bouton(`twc:msg:${r.id}`, 'Message & couleur', ButtonStyle.Primary, '📝'),
        bouton(`twc:test:${r.id}`, 'Tester', ButtonStyle.Secondary, '🧪'),
        bouton(`twc:del:${r.id}`, 'Ne plus suivre', ButtonStyle.Danger, '🗑️'),
        bouton('twc:list', 'Toutes les chaînes', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function liveFactice(r: LigneChaineTwitch): TwitchStream {
  return {
    id: 'test',
    user_id: r.diffuseur_id ?? '0',
    user_login: r.pseudo,
    user_name: r.nom_affiche ?? r.pseudo,
    game_id: '',
    game_name: r.dernier_jeu || 'Just Chatting',
    title: r.dernier_titre || 'Live de test — tout fonctionne !',
    viewer_count: 42,
    started_at: new Date().toISOString(),
    thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${r.pseudo}-{width}x{height}.jpg`,
  };
}

async function envoyerTest(serveur: Guild, client: Client, r: LigneChaineTwitch): Promise<string> {
  const [live] = twitchConfigure() ? await lireLives([r.pseudo]).catch(() => []) : [];
  const salon = serveur.channels.cache.get(r.salon_id);
  if (!salon?.isTextBased()) throw new ErreurUtilisateur('Le salon d’annonce est introuvable.');
  const charge = construireMessageLive(serveur, r, live ?? liveFactice(r));
  await salon.send({ ...charge, content: `🧪 **Test** — ${charge.content}`, allowedMentions: { parse: [] } });
  void client;
  return `✅ Notification de test postée dans <#${salon.id}>${live ? ' (avec le live réel en cours)' : ''}.`;
}

// ─── Setup ─────────────────────────────────────────────────────────────────

const pageReglage: PageReglage = {
  id: 'twitch',
  section: 'twitch',
  titre: 'Twitch',
  emoji: '🔴',
  moduleId: 'twitch',
  description: `Les réglages par défaut des annonces de live. Chaque chaîne peut avoir son salon, son rôle, son message et sa couleur.\n-# Variables : ${['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand'].map((v) => `\`{${v}}\``).join(' ')}`,
  champs: [
    {
      genre: 'channel',
      cle: 'channel',
      libelle: 'Salon d’annonce par défaut',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      lire: (c) => c.twitch.salonDefautId,
      ecrire: (c, v) => void (c.twitch.salonDefautId = v),
    },
    { genre: 'role', cle: 'role', libelle: 'Rôle mentionné par défaut', lire: (c) => c.twitch.roleDefautId, ecrire: (c, v) => void (c.twitch.roleDefautId = v) },
    { genre: 'text', cle: 'live', libelle: 'Message de live', long: true, longueurMax: 1500, obligatoire: true, lire: (c) => c.twitch.messageLive, ecrire: (c, v) => void (c.twitch.messageLive = v) },
    { genre: 'text', cle: 'end', libelle: 'Message de fin (vide = aucun)', long: true, longueurMax: 1500, lire: (c) => c.twitch.messageFin, ecrire: (c, v) => void (c.twitch.messageFin = v) },
    {
      genre: 'text',
      cle: 'color',
      libelle: 'Couleur (#hex)',
      longueurMax: 7,
      lire: (c) => c.twitch.color,
      ecrire: (c, v) => void (c.twitch.color = enHexa(lireCouleur(v) ?? 0x9146ff)),
      validate: (v) => (lireCouleur(v) !== null ? null : 'Code hexadécimal attendu (ex : #9146FF).'),
    },
  ],
  actions: [
    {
      id: 'channels',
      libelle: 'Chaînes suivies',
      emoji: '📺',
      async executer(interaction) {
        await interaction.update(ecranListe(interaction.guild));
      },
    },
    {
      id: 'brand',
      libelle: 'Suivre la chaîne de l’enseigne',
      emoji: '💜',
      async executer(interaction) {
        const pseudo = enseigneDe(interaction.guildId).pseudoTwitch;
        if (!pseudo) throw new ErreurUtilisateur('L’enseigne de ce serveur n’a pas de chaîne Twitch (réglable par l’owner bot avec /custom).');
        await interaction.deferUpdate();
        const r = await suivre(interaction.guild, pseudo, null, null);
        await interaction.editReply(ecranChaine(interaction.guild, r, `✅ **${r.nom_affiche}** est suivie.`));
      },
    },
  ],
};

// ─── Commandes ─────────────────────────────────────────────────────────────

const optionPseudo = (o: import('discord.js').SlashCommandStringOption) => o.setName('chaine').setDescription('Pseudo ou lien Twitch').setRequired(true).setMaxLength(100);

const twitch: CommandeSlash = {
  categorie: 'twitch',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('Les annonces de live Twitch')
    .addSubcommand((s) => s.setName('setup').setDescription('Régler les annonces de live'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Suivre une chaîne')
        .addStringOption(optionPseudo)
        .addChannelOption((o) => o.setName('salon').setDescription('Salon d’annonce').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner')),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Ne plus suivre une chaîne').addStringOption((o) => optionPseudo(o).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Les chaînes suivies'))
    .addSubcommand((s) => s.setName('test').setDescription('Envoyer une notification de test').addStringOption((o) => optionPseudo(o).setAutocomplete(true))),
  niveauxSousCommandes: { list: Niveau.STAFF },
  async autocompletion(interaction) {
    const saisie = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      listerChaines(interaction.guildId)
        .filter((r) => r.pseudo.includes(saisie))
        .slice(0, 25)
        .map((r) => ({ name: r.nom_affiche ?? r.pseudo, value: r.pseudo })),
    );
  },
  async executer(interaction) {
    const serveur = interaction.guild;
    const sousCommande = interaction.options.getSubcommand();
    switch (sousCommande) {
      case 'setup':
        return repondre(interaction, { ...afficherPage(serveur, lirePageReglage('twitch')!), ephemeral: true });
      case 'list':
        return repondre(interaction, { ...ecranListe(serveur), ephemeral: true });
      case 'add': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await suivre(serveur, interaction.options.getString('chaine', true), interaction.options.getChannel('salon')?.id ?? null, interaction.options.getRole('role')?.id ?? null);
        return interaction.editReply(ecranChaine(serveur, r, `✅ **${r.nom_affiche}** est suivie.`));
      }
      case 'remove': {
        const pseudo = normaliserPseudo(interaction.options.getString('chaine', true));
        if (!retirerChaine(serveur.id, pseudo)) throw new ErreurUtilisateur(`**${pseudo}** n’est pas suivie ici.`);
        return repondre(interaction, { embeds: [ok(serveur, `**${pseudo}** n’est plus suivie.`)], ephemeral: true });
      }
      case 'test': {
        const r = lireChaine(serveur.id, normaliserPseudo(interaction.options.getString('chaine', true)));
        if (!r) throw new ErreurUtilisateur('Cette chaîne n’est pas suivie ici.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ embeds: [info(serveur, await envoyerTest(serveur, interaction.client, r))] });
      }
    }
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'twitch',
    alias: ['lives'],
    domaine: 'general',
    categorie: 'twitch',
    description: 'Les chaînes suivies',
    niveau: Niveau.STAFF,
    async executer(message) {
      const { embeds } = ecranListe(message.guild);
      await message.reply({ embeds, allowedMentions: { repliedUser: false } });
    },
  },
];

export const moduleTwitch: ModuleBot = {
  id: 'twitch',
  nom: 'Twitch',
  emoji: '🔴',
  description: 'Annonces de live multi-chaînes, fin de live, clips, raids',
  desactivable: true,
  actifParDefaut: true,
  commandes: [twitch],
  commandesPrefixe,
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'twc',
      niveau: Niveau.ADMIN,
      async bouton(interaction: ButtonInteraction<'cached'>, [action, id, cle]) {
        const serveur = interaction.guild;
        switch (action) {
          case 'list':
            return interaction.update(ecranListe(serveur));
          case 'back':
            return interaction.update(afficherPage(serveur, lirePageReglage('twitch')!));
          case 'add':
            return interaction.showModal(
              construireFormulaire('twc:addm', 'Suivre une chaîne', [{ id: 'login', libelle: 'Pseudo ou lien Twitch', indication: 'ex : zerator', longueurMax: 100 }]),
            );
          case 'tog': {
            const r = exigerChaine(serveur.id, id);
            const autorise = ['afficher_image', 'notifier_fin', 'notifier_changements', 'notifier_clips', 'notifier_evenements'] as const;
            const champ = autorise.find((k) => k === cle);
            if (!champ) return;
            modifierChaine(r.id, { [champ]: r[champ] ? 0 : 1 });
            if (champ === 'notifier_evenements') abonnementsTwitch?.resynchroniser();
            const suivant = exigerChaine(serveur.id, id);
            const note = champ === 'notifier_evenements' && suivant.notifier_evenements && !abonnementsTwitch?.enabled ? '⚠️ Les événements (raids, follows, subs) demandent `TWITCH_USER_TOKEN` dans le .env.' : undefined;
            return interaction.update(ecranChaine(serveur, suivant, note));
          }
          case 'msg': {
            const r = exigerChaine(serveur.id, id);
            return interaction.showModal(
              construireFormulaire(`twc:msgm:${r.id}`, `Annonce de ${r.nom_affiche ?? r.pseudo}`.slice(0, 45), [
                { id: 'message', libelle: 'Message (vide = celui du serveur)', long: true, valeur: r.message, obligatoire: false, longueurMax: 1500, indication: '🔴 {streamer} est en LIVE ! {role}' },
                { id: 'color', libelle: 'Couleur #hex (vide = par défaut)', valeur: r.couleur, obligatoire: false, longueurMax: 7 },
              ]),
            );
          }
          case 'test': {
            const r = exigerChaine(serveur.id, id);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return interaction.editReply({ embeds: [info(serveur, await envoyerTest(serveur, interaction.client, r))] });
          }
          case 'del': {
            const r = exigerChaine(serveur.id, id);
            retirerChaine(serveur.id, r.pseudo);
            return interaction.update(ecranListe(serveur, `✅ **${r.nom_affiche ?? r.pseudo}** n’est plus suivie.`));
          }
        }
      },
      async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        if (action === 'open' && interaction.isStringSelectMenu()) return interaction.update(ecranChaine(serveur, exigerChaine(serveur.id, interaction.values[0])));
        const r = exigerChaine(serveur.id, id);
        if (action === 'chan' && interaction.isChannelSelectMenu()) modifierChaine(r.id, { salon_id: interaction.values[0]! });
        if (action === 'role' && interaction.isRoleSelectMenu()) modifierChaine(r.id, { role_id: interaction.values[0] ?? null });
        return interaction.update(ecranChaine(serveur, exigerChaine(serveur.id, id), '✅ C’est enregistré.'));
      },
      async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, id]) {
        const serveur = interaction.guild;
        const repondreEcran = async (charge: ReturnType<typeof ecranChaine>) => {
          if (interaction.isFromMessage()) await interaction.update(charge);
          else await interaction.reply({ ...charge, flags: MessageFlags.Ephemeral });
        };
        if (action === 'addm') {
          await interaction.deferUpdate().catch(() => undefined);
          const r = await suivre(serveur, interaction.fields.getTextInputValue('login'), null, null);
          await interaction.editReply(ecranChaine(serveur, r, `✅ **${r.nom_affiche}** est suivie.`));
          return;
        }
        if (action === 'msgm') {
          const r = exigerChaine(serveur.id, id);
          const couleurBrute = interaction.fields.getTextInputValue('color').trim();
          const couleur = couleurBrute ? lireCouleur(couleurBrute) : null;
          if (couleurBrute && couleur === null) throw new ErreurUtilisateur('Couleur attendue au format #9146FF.');
          modifierChaine(r.id, { message: interaction.fields.getTextInputValue('message').trim() || null, couleur: couleur !== null ? enHexa(couleur) : null });
          await repondreEcran(ecranChaine(serveur, exigerChaine(serveur.id, id), '✅ C’est enregistré.'));
        }
      },
    },
  ],
  taches: [
    {
      nom: 'twitch-streams',
      intervalleMs: environnement.twitchIntervalleSecondes * 1000,
      auDemarrage: true,
      async executer(client) {
        if (twitchConfigure()) await sonderLives(client);
      },
    },
    {
      nom: 'twitch-clips',
      intervalleMs: 5 * 60_000,
      async executer(client) {
        if (twitchConfigure()) await sonderClips(client);
      },
    },
  ],
  async auDemarrage(client) {
    if (!twitchConfigure()) {
      registre.avertir('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET absents : les annonces de live sont inactives.');
      return;
    }
    abonnementsTwitch = new ClientAbonnementsTwitch(client);
    await abonnementsTwitch.demarrer().catch((echec: unknown) => registre.avertir(`EventSub non démarré : ${(echec as Error).message}`));
  },
  aLArret() {
    abonnementsTwitch?.arreter();
  },
  tests: [
    {
      id: 'variables',
      libelle: 'Variables des annonces',
      emoji: '🧩',
      description: 'Les variables utilisables dans les messages de live',
      async executer() {
        return aideVariables(['streamer', 'game', 'title', 'viewers', 'url', 'role', 'brand', 'server']);
      },
    },
    {
      id: 'status',
      libelle: 'État de la connexion Twitch',
      emoji: '📡',
      description: 'Clés API, EventSub et chaînes suivies',
      async executer(interaction) {
        const rangees = listerChaines(interaction.guildId);
        return [
          `${twitchConfigure() ? '✅' : '❌'} Clés API Twitch`,
          `${abonnementsTwitch?.enabled ? '✅' : 'ℹ️'} EventSub (raids, follows, subs)${abonnementsTwitch?.enabled ? '' : ' — nécessite TWITCH_USER_TOKEN'}`,
          `📺 ${rangees.length} chaîne(s) suivie(s), ${rangees.filter((r) => r.live_id).length} en live`,
          `⏱️ Vérification toutes les ${environnement.twitchIntervalleSecondes} s`,
        ].join('\n');
      },
    },
  ],
};

