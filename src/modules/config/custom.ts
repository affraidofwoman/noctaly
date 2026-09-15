import {
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  creerEnseigne,
  COULEUR_DEFAUT,
  supprimerEnseigne,
  CLES_EMOJIS,
  lireEnseigne,
  estEmoji,
  estLienImage,
  MOTIF_CLE,
  listerEnseignes,
  PALETTES,
  lireCouleur,
  poserServeursEnseigne,
  enHexa,
  modifierEnseigne,
  type CleEmoji,
  type LiensEnseigne,
} from '../../core/brand';
import { demanderConfirmation } from '../../core/confirm';
import { lireJson } from '../../database/db';
import { tronquer } from '../../core/text';
import { bouton, construireFormulaire, estLienHttp, rangee } from '../../core/ui';
import { Niveau, type GestionnaireComposant } from '../../core/types';
import { ErreurUtilisateur } from '../../core/errors';

const AUCUN = '—';
const EMOJIS_PAR_PAGE = 25;

function exigerEnseigne(cle: string | undefined) {
  const s = cle ? lireEnseigne(cle) : null;
  if (!s) throw new ErreurUtilisateur('Cette enseigne n’existe plus.');
  return s;
}

/** La liste des enseignes. */
export function accueilEnseignes(client: Client, note?: string) {
  const enseignes = listerEnseignes();
  const embed = new EmbedBuilder()
    .setColor(COULEUR_DEFAUT)
    .setTitle('🎨 Enseignes')
    .setDescription(note ?? 'Chaque streamer a sa couleur, son nom, son logo et ses émojis. Les messages du bot prennent ceux du serveur où ils sont envoyés.');
  if (enseignes.length) {
    embed.addFields(
      enseignes.slice(0, 24).map((s) => ({
        name: tronquer(s.nom, 256),
        value: `${enHexa(s.couleur ?? COULEUR_DEFAUT)} · ${s.guilds.length} serveur(s)${s.pseudo_twitch ? ` · 🔴 ${s.pseudo_twitch}` : ''}`,
        inline: true,
      })),
    );
  } else {
    embed.addFields({ name: 'Aucune enseigne', value: 'Le bot garde ses couleurs d’origine partout.', inline: false });
  }
  const composants = [];
  if (enseignes.length) {
    composants.push(
      rangee(
        new StringSelectMenuBuilder()
          .setCustomId('cu:open')
          .setPlaceholder('Ouvrir une enseigne')
          .addOptions(
            enseignes.slice(0, 25).map((s) => ({
              label: tronquer(s.nom, 100),
              value: s.cle,
              description: tronquer(`${s.guilds.length} serveur(s) · ${enHexa(s.couleur ?? COULEUR_DEFAUT)}`, 100),
            })),
          ),
      ),
    );
  }
  composants.push(rangee(bouton('cu:new', 'Nouvelle enseigne', ButtonStyle.Success, '➕')));
  void client;
  return { embeds: [embed], components: composants };
}

/** L'écran d'une enseigne, avec son rendu sous les yeux. */
export function ecranEnseigne(client: Client, cle: string, note?: string) {
  const s = exigerEnseigne(cle);
  const couleur = s.couleur ?? COULEUR_DEFAUT;
  const liens = lireJson<LiensEnseigne>(s.liens, {});
  const emojis = lireJson<Record<string, string>>(s.emojis, {});

  const apercu = new EmbedBuilder()
    .setColor(couleur)
    .setTitle(s.nom)
    .setDescription('Voilà de quoi auront l’air les messages de cette enseigne.')
    .addFields(
      { name: 'Couleur', value: `${enHexa(couleur)}${s.couleur === null ? ' *(celle du bot)*' : ''}`, inline: true },
      { name: 'Émojis repris', value: String(Object.keys(emojis).length), inline: true },
      { name: 'Serveurs couverts', value: String(s.guilds.length), inline: true },
    );
  if (s.logo) apercu.setThumbnail(s.logo);
  if (s.pied) apercu.setFooter({ text: s.pied, iconURL: s.logo ?? undefined });
  if (s.fond) apercu.setImage(s.fond);

  const nomServeur = (id: string) => client.guilds.cache.get(id)?.name ?? id;
  const lignesLiens = (Object.entries(liens) as [string, string][]).filter(([, v]) => v).map(([k, v]) => `• ${k} — ${v}`);
  const reglages = new EmbedBuilder()
    .setColor(couleur)
    .setTitle('Réglages')
    .addFields(
      { name: 'Clé', value: `\`${s.cle}\``, inline: true },
      { name: 'Chaîne Twitch', value: s.pseudo_twitch ? `[${s.pseudo_twitch}](https://twitch.tv/${s.pseudo_twitch})` : AUCUN, inline: true },
      { name: 'Pied de page', value: s.pied || AUCUN, inline: true },
      { name: 'Liens', value: tronquer(lignesLiens.join('\n') || AUCUN, 1024), inline: false },
      { name: 'Serveurs de l’enseigne', value: tronquer(s.guilds.length ? s.guilds.map((g) => `• ${nomServeur(g)}`).join('\n') : AUCUN, 1024), inline: false },
    );
  if (note) reglages.setDescription(note);

  const quoi = new StringSelectMenuBuilder()
    .setCustomId(`cu:what:${cle}`)
    .setPlaceholder('Que veux-tu changer ?')
    .addOptions(
      { label: 'La couleur', value: 'color', description: 'Une palette, ou ton code exact', emoji: '🎨' },
      { label: 'Le nom', value: 'name', description: 'Ce qui s’affiche en tête des écrans', emoji: '🏷️' },
      { label: 'Le pied de page', value: 'footer', description: 'La signature sous chaque message', emoji: '✍️' },
      { label: 'Le logo', value: 'logo', description: 'Une image, en https', emoji: '🖼️' },
      { label: 'Le fond de bienvenue', value: 'background', description: 'L’image derrière la carte d’arrivée', emoji: '🌄' },
      { label: 'La chaîne Twitch', value: 'twitch', description: 'Le pseudo Twitch du streamer', emoji: '🔴' },
      { label: 'Les liens', value: 'links', description: 'Twitch, YouTube, X, TikTok, Instagram', emoji: '🔗' },
      { label: 'Les serveurs couverts', value: 'guilds', description: 'Où cette enseigne s’applique', emoji: '🌐' },
      { label: 'Les émojis', value: 'emojis', description: 'Seulement ceux que tu veux changer', emoji: '😀' },
    );

  return {
    embeds: [apercu, reglages],
    components: [
      rangee(quoi),
      rangee(bouton('cu:home', 'Toutes les enseignes', ButtonStyle.Secondary, '⬅️'), bouton(`cu:del:${cle}`, 'Supprimer', ButtonStyle.Danger, '🗑️')),
    ],
  };
}

function ecranCouleur(cle: string) {
  const s = exigerEnseigne(cle);
  const actuel = s.couleur ?? COULEUR_DEFAUT;
  const embed = new EmbedBuilder()
    .setColor(actuel)
    .setTitle('Couleur')
    .setDescription('Quatre familles, six tons chacune. Ou donne ton code exact.')
    .addFields(PALETTES.map((p) => ({ name: p.name, value: `${p.description}\n${p.tons.map((t) => t.name).join(' · ')}`, inline: false })))
    .setFooter({ text: `Actuellement : ${enHexa(actuel)}` });
  const tons = PALETTES.flatMap((p) => p.tons.map((t) => ({ ...t, palette: p.name }))).slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:col:${cle}`)
    .setPlaceholder('Choisir un ton')
    .addOptions(tons.map((t) => ({ label: `${t.name} — ${t.palette}`, value: String(t.color), description: enHexa(t.color), default: t.color === actuel })));
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`cu:hex:${cle}`, 'Code exact', ButtonStyle.Primary),
        bouton(`cu:reset:${cle}`, 'Couleur du bot', ButtonStyle.Secondary),
        bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

function ecranServeurs(client: Client, cle: string) {
  const s = exigerEnseigne(cle);
  const serveurs = [...client.guilds.cache.values()].slice(0, 25);
  const embed = new EmbedBuilder()
    .setColor(s.couleur ?? COULEUR_DEFAUT)
    .setTitle('Serveurs de l’enseigne')
    .setDescription('Les messages envoyés sur ces serveurs prennent les couleurs de l’enseigne.\n-# Un serveur ne peut appartenir qu’à une seule enseigne.');
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:srv:${cle}`)
    .setPlaceholder('Choisir les serveurs')
    .setMinValues(0)
    .setMaxValues(Math.max(1, serveurs.length))
    .addOptions(
      serveurs.length
        ? serveurs.map((g) => ({ label: tronquer(g.name, 100), value: g.id, description: `${g.memberCount} membre(s)`, default: s.guilds.includes(g.id) }))
        : [{ label: 'Aucun serveur', value: 'none' }],
    );
  return { embeds: [embed], components: [rangee(menu), rangee(bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary, '⬅️'))] };
}

function ecranEmojis(cle: string, page = 0) {
  const s = exigerEnseigne(cle);
  const enseignes = lireJson<Record<string, string>>(s.emojis, {});
  const cles = (Object.keys(CLES_EMOJIS) as CleEmoji[]).sort();
  const pages = Math.max(1, Math.ceil(cles.length / EMOJIS_PAR_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const tranche = cles.slice(p * EMOJIS_PAR_PAGE, (p + 1) * EMOJIS_PAR_PAGE);
  const pris = Object.entries(enseignes);
  const embed = new EmbedBuilder()
    .setColor(s.couleur ?? COULEUR_DEFAUT)
    .setTitle('Émojis')
    .setDescription('Choisis une clé pour lui donner ton émoji. Celles que tu laisses gardent celui du bot — pas besoin de tout fournir.')
    .addFields({ name: `Repris par l’enseigne (${pris.length})`, value: tronquer(pris.length ? pris.map(([n, c]) => `${c} \`${n}\``).join(' · ') : AUCUN, 1024) })
    .setFooter({ text: `Page ${p + 1} sur ${pages} · ${cles.length} clés en tout` });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cu:emo:${cle}`)
    .setPlaceholder('Quelle clé changer ?')
    .addOptions(
      tranche.map((k) => ({
        label: k,
        value: k,
        description: enseignes[k] ? 'repris par l’enseigne' : `garde ${CLES_EMOJIS[k]}`,
      })),
    );
  return {
    embeds: [embed],
    components: [
      rangee(menu),
      rangee(
        bouton(`cu:emop:${cle}:${p - 1}`, 'Précédent', ButtonStyle.Secondary, '⬅️').setDisabled(p === 0),
        bouton(`cu:emop:${cle}:${p + 1}`, 'Suivant', ButtonStyle.Secondary, '➡️').setDisabled(p >= pages - 1),
        bouton(`cu:m:${cle}`, 'Retour', ButtonStyle.Secondary),
      ),
    ],
  };
}

const CHAMPS_TEXTE: Record<string, { title: string; label: string; long?: boolean; required: boolean; max: number }> = {
  name: { title: 'Le nom', label: 'Nom de l’enseigne', required: true, max: 64 },
  footer: { title: 'Le pied de page', label: 'Signature (vide = aucune)', required: false, max: 128 },
  logo: { title: 'Le logo', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  background: { title: 'Le fond de bienvenue', label: 'Lien https d’une image (vide = aucun)', required: false, max: 512 },
  twitch: { title: 'La chaîne Twitch', label: 'Pseudo Twitch (vide = aucune)', required: false, max: 25 },
};

export const composantEnseignes: GestionnaireComposant = {
  prefixe: 'cu',
  niveau: Niveau.PROPRIETAIRE_BOT,
  async bouton(interaction: ButtonInteraction<'cached'>, [action, cle, extra]) {
    const client = interaction.client;
    switch (action) {
      case 'home':
        await interaction.update(accueilEnseignes(client));
        return;
      case 'm':
        await interaction.update(ecranEnseigne(client, cle!));
        return;
      case 'new':
        await interaction.showModal(
          construireFormulaire('cu:newm', 'Nouvelle enseigne', [
            { id: 'key', libelle: 'Clé (minuscules, chiffres, - et _)', indication: 'ex : zerator', longueurMax: 32, longueurMin: 2 },
            { id: 'name', libelle: 'Nom affiché', indication: 'ex : ZeratoR', longueurMax: 64 },
          ]),
        );
        return;
      case 'hex':
        await interaction.showModal(construireFormulaire(`cu:hexm:${cle}`, 'Code couleur', [{ id: 'value', libelle: 'Code hexadécimal', indication: '#9146FF', longueurMax: 7 }]));
        return;
      case 'reset':
        modifierEnseigne(cle!, { couleur: null });
        await interaction.update(ecranEnseigne(client, cle!, '✅ Couleur remise à celle du bot.'));
        return;
      case 'emop':
        await interaction.update(ecranEmojis(cle!, Number(extra) || 0));
        return;
      case 'del': {
        const s = exigerEnseigne(cle);
        await demanderConfirmation(interaction, {
          titre: 'Supprimer l’enseigne ?',
          description: `L’enseigne **${s.nom}** sera supprimée. Ses ${s.guilds.length} serveur(s) reprendront les couleurs du bot.`,
          libelleConfirmation: 'Supprimer',
          surConfirmation: async (i) => {
            supprimerEnseigne(s.cle);
            await i.update({ embeds: [new EmbedBuilder().setColor(0x3fe08f).setDescription(`✅ Enseigne **${s.nom}** supprimée.`)], components: [] });
          },
        });
        return;
      }
    }
  },
  async menu(interaction: AnySelectMenuInteraction<'cached'>, [action, cle]) {
    if (!interaction.isStringSelectMenu()) return;
    const client = interaction.client;
    const valeur = interaction.values[0] ?? '';
    switch (action) {
      case 'open':
        await interaction.update(ecranEnseigne(client, valeur));
        return;
      case 'what': {
        const s = exigerEnseigne(cle);
        if (valeur === 'color') return void (await interaction.update(ecranCouleur(s.cle)));
        if (valeur === 'guilds') return void (await interaction.update(ecranServeurs(client, s.cle)));
        if (valeur === 'emojis') return void (await interaction.update(ecranEmojis(s.cle)));
        if (valeur === 'links') {
          const liens = lireJson<LiensEnseigne>(s.liens, {});
          await interaction.showModal(
            construireFormulaire(`cu:linksm:${s.cle}`, 'Les liens', [
              { id: 'twitch', libelle: 'Twitch', valeur: liens.twitch, obligatoire: false, longueurMax: 200 },
              { id: 'youtube', libelle: 'YouTube', valeur: liens.youtube, obligatoire: false, longueurMax: 200 },
              { id: 'x', libelle: 'X / Twitter', valeur: liens.x, obligatoire: false, longueurMax: 200 },
              { id: 'tiktok', libelle: 'TikTok', valeur: liens.tiktok, obligatoire: false, longueurMax: 200 },
              { id: 'instagram', libelle: 'Instagram', valeur: liens.instagram, obligatoire: false, longueurMax: 200 },
            ]),
          );
          return;
        }
        const champ = CHAMPS_TEXTE[valeur];
        if (!champ) return;
        const actuel = valeur === 'twitch' ? s.pseudo_twitch : (s as unknown as Record<string, string | null>)[valeur];
        await interaction.showModal(
          construireFormulaire(`cu:txtm:${s.cle}:${valeur}`, champ.title, [{ id: 'value', libelle: champ.label, valeur: actuel, obligatoire: champ.required, longueurMax: champ.max }]),
        );
        return;
      }
      case 'col': {
        const couleur = lireCouleur(Number(valeur));
        if (couleur === null) throw new ErreurUtilisateur('Couleur invalide.');
        modifierEnseigne(cle!, { couleur });
        await interaction.update(ecranEnseigne(client, cle!, `✅ Couleur : **${enHexa(couleur)}**`));
        return;
      }
      case 'srv': {
        const ids = interaction.values.filter((v) => v !== 'none');
        poserServeursEnseigne(cle!, ids);
        await interaction.update(ecranEnseigne(client, cle!, `✅ ${ids.length} serveur(s) couvert(s).`));
        return;
      }
      case 'emo': {
        const s = exigerEnseigne(cle);
        const actuel = lireJson<Record<string, string>>(s.emojis, {})[valeur];
        await interaction.showModal(
          construireFormulaire(`cu:emom:${s.cle}:${valeur}`, `Émoji « ${valeur} »`, [
            { id: 'value', libelle: 'Émoji (vide = celui du bot)', indication: '<:nom:123456789012345678> ou 🎉', valeur: actuel, obligatoire: false, longueurMax: 64 },
          ]),
        );
        return;
      }
    }
  },
  async fenetre(interaction: ModalSubmitInteraction<'cached'>, [action, cle, extra]) {
    const client = interaction.client;
    const repondreEcran = async (charge: ReturnType<typeof ecranEnseigne>) => {
      if (interaction.isFromMessage()) await interaction.update(charge);
      else await interaction.reply({ ...charge, flags: 64 });
    };
    switch (action) {
      case 'newm': {
        const nouvelleCle = interaction.fields.getTextInputValue('key').trim().toLowerCase();
        const nom = interaction.fields.getTextInputValue('name').trim();
        if (!MOTIF_CLE.test(nouvelleCle)) throw new ErreurUtilisateur('Clé invalide : 2 à 32 caractères parmi a-z, 0-9, - et _.');
        if (lireEnseigne(nouvelleCle)) throw new ErreurUtilisateur('Cette clé existe déjà.');
        creerEnseigne(nouvelleCle, nom || nouvelleCle);
        await repondreEcran(ecranEnseigne(client, nouvelleCle, '✅ Enseigne créée. Choisis maintenant ce que tu veux régler.'));
        return;
      }
      case 'hexm': {
        const couleur = lireCouleur(interaction.fields.getTextInputValue('value'));
        if (couleur === null) throw new ErreurUtilisateur('Code attendu : 6 caractères hexadécimaux, ex. `#9146FF`.');
        modifierEnseigne(cle!, { couleur });
        await repondreEcran(ecranEnseigne(client, cle!, `✅ Couleur : **${enHexa(couleur)}**`));
        return;
      }
      case 'txtm': {
        const brut = interaction.fields.getTextInputValue('value').trim();
        if (extra === 'name') {
          if (!brut) throw new ErreurUtilisateur('Le nom ne peut pas être vide.');
          modifierEnseigne(cle!, { nom: brut });
        } else if (extra === 'footer') {
          modifierEnseigne(cle!, { pied: brut || null });
        } else if (extra === 'logo' || extra === 'background') {
          if (brut && !estLienImage(brut)) throw new ErreurUtilisateur('Lien attendu : https, terminé par .png, .jpg, .gif ou .webp.');
          modifierEnseigne(cle!, { [extra]: brut || null });
        } else if (extra === 'twitch') {
          const pseudo = brut.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase();
          if (pseudo && !/^[a-z0-9_]{3,25}$/.test(pseudo)) throw new ErreurUtilisateur('Pseudo Twitch invalide.');
          modifierEnseigne(cle!, { pseudo_twitch: pseudo || null });
        }
        await repondreEcran(ecranEnseigne(client, cle!, '✅ C’est enregistré.'));
        return;
      }
      case 'linksm': {
        const liens: LiensEnseigne = {};
        const rejetes: string[] = [];
        for (const k of ['twitch', 'youtube', 'x', 'tiktok', 'instagram'] as const) {
          const v = interaction.fields.getTextInputValue(k).trim();
          if (!v) continue;
          if (!estLienHttp(v)) rejetes.push(k);
          else liens[k] = v;
        }
        modifierEnseigne(cle!, { liens });
        await repondreEcran(ecranEnseigne(client, cle!, rejetes.length ? `⚠️ Ignorés (lien http(s) attendu) : ${rejetes.join(', ')}` : '✅ Liens enregistrés.'));
        return;
      }
      case 'emom': {
        const s = exigerEnseigne(cle);
        const cleEmoji = extra as CleEmoji;
        if (!(cleEmoji in CLES_EMOJIS)) throw new ErreurUtilisateur('Clé d’émoji inconnue.');
        const brut = interaction.fields.getTextInputValue('value').trim();
        const emojis = lireJson<Partial<Record<CleEmoji, string>>>(s.emojis, {});
        if (!brut) delete emojis[cleEmoji];
        else if (!estEmoji(brut)) throw new ErreurUtilisateur('Émoji attendu : un émoji unicode ou `<:nom:id>`.');
        else emojis[cleEmoji] = brut;
        modifierEnseigne(s.cle, { emojis });
        if (interaction.isFromMessage()) await interaction.update(ecranEmojis(s.cle));
        else await interaction.reply({ ...ecranEmojis(s.cle), flags: 64 });
        return;
      }
    }
  },
};
