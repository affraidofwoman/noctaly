import { randomInt } from 'node:crypto';
import { ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, SlashCommandBuilder, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { couleurPour, erreur, ok } from '../../core/embeds';
import { ErreurUtilisateur } from '../../core/errors';
import { lireConfig } from '../../core/guildConfig';
import { repondre } from '../../core/interactions';
import { journal, resoudreSalonTexte } from '../../core/logService';
import { botPeutGererRole } from '../../core/permissions';
import { CarteExpirante } from '../../core/sessions';
import type { PageReglage } from '../../core/setup';
import { joursDepuis } from '../../core/time';
import { bouton, construireFormulaire, rangee } from '../../core/ui';
import { sur, Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { donnerRolesAuto } from '../../services/autorole';

const codes = new CarteExpirante<string, { code: string; tries: number }>(5 * 60_000);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function fabriquerCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Code affiché avec des espaces fines et des caractères invisibles pour gêner la lecture automatique. */
function afficherCode(code: string): string {
  return code.split('').join('​ ');
}

async function verifier(membre: GuildMember): Promise<string> {
  const serveur = membre.guild;
  const reglages = lireConfig(serveur.id).verification;
  if (reglages.ageCompteMinJours && joursDepuis(membre.user.createdTimestamp) < reglages.ageCompteMinJours) {
    void journal(serveur, 'security', { titre: 'Vérification refusée', ton: 'alerte', lignes: [`<@${membre.id}> : compte trop récent (${joursDepuis(membre.user.createdTimestamp)} j < ${reglages.ageCompteMinJours} j)`] });
    throw new ErreurUtilisateur(`Ton compte Discord doit avoir au moins **${reglages.ageCompteMinJours} jours** pour accéder au serveur. Contacte le staff si besoin.`);
  }
  const verifie = reglages.roleVerifieId ? serveur.roles.cache.get(reglages.roleVerifieId) : null;
  if (!verifie || !botPeutGererRole(serveur, verifie)) throw new ErreurUtilisateur('La vérification est mal configurée. Préviens le staff.');
  if (membre.roles.cache.has(verifie.id)) return 'Tu es déjà vérifié(e) ✅';
  await membre.roles.add(verifie, 'Vérification réussie');
  const nonVerifie = reglages.roleNonVerifieId ? serveur.roles.cache.get(reglages.roleNonVerifieId) : null;
  if (nonVerifie && botPeutGererRole(serveur, nonVerifie)) await membre.roles.remove(nonVerifie, 'Vérification réussie').catch(() => undefined);
  await donnerRolesAuto(membre, 'member', 'Rôle automatique après vérification');
  void journal(serveur, 'security', { titre: 'Membre vérifié', ton: 'ok', lignes: [`<@${membre.id}> \`${membre.user.tag}\``] });
  return `Bienvenue ! Tu as maintenant accès au serveur avec <@&${verifie.id}>.`;
}

const commandeVerifier: CommandeSlash = {
  categorie: 'admin',
  niveau: Niveau.ADMIN,
  donnees: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Le panneau de vérification')
    .addChannelOption((o) => o.setName('salon').setDescription('Où le poster').addChannelTypes(ChannelType.GuildText)),
  async executer(interaction) {
    const reglages = lireConfig(interaction.guildId).verification;
    if (!reglages.roleVerifieId) throw new ErreurUtilisateur('Choisis d’abord le rôle « vérifié » dans `/setup` → Sécurité & accès.');
    const salon = (interaction.options.getChannel('salon') ?? resoudreSalonTexte(interaction.guild, reglages.channelId) ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!salon) throw new ErreurUtilisateur('Salon introuvable.');
    const embed = new EmbedBuilder()
      .setColor(couleurPour(interaction.guild))
      .setTitle('🔐 VÉRIFICATION')
      .setDescription(`Bienvenue sur **${interaction.guild.name}** !\n\nPour accéder au serveur, clique sur le bouton ci-dessous${reglages.method === 'captcha' ? ' puis recopie le code affiché' : ''}.`);
    const envoye = await salon.send({ embeds: [embed], components: [rangee(bouton('verif:start', 'Me vérifier', ButtonStyle.Success, '✅'))] });
    await repondre(interaction, { embeds: [ok(interaction.guild, `Panneau posté : ${envoye.url}`)], ephemeral: true });
  },
};

const pageReglage: PageReglage = {
  id: 'verification',
  section: 'security',
  titre: 'Vérification',
  emoji: '🔐',
  moduleId: 'verification',
  ordre: 2,
  description:
    'Les nouveaux arrivent avec un accès limité, puis se vérifient (`/verify`).\n-# Donne au rôle « non vérifié » un accès au seul salon de vérification. Les rôles automatiques sont donnés après vérification.',
  champs: [
    { kind: 'role', cle: 'verified', libelle: 'Rôle vérifié', attribuable: true, get: (c) => c.verification.roleVerifieId, set: (c, v) => void (c.verification.roleVerifieId = v) },
    { kind: 'role', cle: 'unverified', libelle: 'Rôle non vérifié (à l’arrivée)', attribuable: true, get: (c) => c.verification.roleNonVerifieId, set: (c, v) => void (c.verification.roleNonVerifieId = v) },
    {
      kind: 'choice',
      cle: 'method',
      libelle: 'Méthode',
      options: [
        { value: 'button', label: 'Un simple clic', emoji: '🖱️' },
        { value: 'captcha', label: 'Recopier un code (anti-bot)', emoji: '🔢' },
      ],
      get: (c) => c.verification.method,
      set: (c, v) => void (c.verification.method = v as 'button' | 'captcha'),
    },
    { kind: 'channel', cle: 'channel', libelle: 'Salon de vérification', get: (c) => c.verification.channelId, set: (c, v) => void (c.verification.channelId = v) },
    { kind: 'number', cle: 'age', libelle: 'Âge minimum du compte', min: 0, max: 365, unit: 'j', get: (c) => c.verification.ageCompteMinJours, set: (c, v) => void (c.verification.ageCompteMinJours = v) },
  ],
};

export const moduleVerification: ModuleBot = {
  id: 'verification',
  nom: 'Vérification',
  emoji: '🔐',
  description: 'Accès limité à l’arrivée puis vérification (clic ou code)',
  desactivable: true,
  actifParDefaut: false,
  commandes: [commandeVerifier],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'verif',
      async bouton(interaction, [action]) {
        const reglages = lireConfig(interaction.guildId).verification;
        if (action === 'start' && reglages.method === 'button') {
          const texte = await verifier(interaction.member);
          await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'start') {
          const code = fabriquerCode();
          codes.ecrire(`${interaction.guildId}:${interaction.user.id}`, { code, tries: 0 });
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(couleurPour(interaction.guild)).setTitle('🔢 Ton code').setDescription(`Recopie ce code :\n\n# ${afficherCode(code)}\n\n-# Valable 5 minutes.`)],
            components: [rangee(bouton('verif:enter', 'Entrer le code', ButtonStyle.Primary, '⌨️'))],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (action === 'enter') {
          await interaction.showModal(construireFormulaire('verif:code', 'Vérification', [{ id: 'code', libelle: 'Le code affiché', longueurMax: 12, longueurMin: 6 }]));
        }
      },
      async fenetre(interaction) {
        const cle = `${interaction.guildId}:${interaction.user.id}`;
        const enAttente = codes.lire(cle);
        if (!enAttente) throw new ErreurUtilisateur('Ton code a expiré. Clique à nouveau sur « Me vérifier ».');
        const saisi = interaction.fields.getTextInputValue('code').replace(/[\s​]/g, '').toUpperCase();
        if (saisi !== enAttente.code) {
          enAttente.tries++;
          if (enAttente.tries >= 3) codes.supprimer(cle);
          await interaction.reply({ embeds: [erreur(interaction.guild, enAttente.tries >= 3 ? 'Trop d’essais. Relance la vérification.' : 'Code incorrect, réessaie.')], flags: MessageFlags.Ephemeral });
          return;
        }
        codes.supprimer(cle);
        const texte = await verifier(interaction.member);
        await interaction.reply({ embeds: [ok(interaction.guild, texte)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  evenements: [
    sur('guildMemberAdd', async (membre) => {
      if (membre.user.bot) return;
      const reglages = lireConfig(membre.guild.id).verification;
      const role = reglages.roleNonVerifieId ? membre.guild.roles.cache.get(reglages.roleNonVerifieId) : null;
      if (role && botPeutGererRole(membre.guild, role)) await membre.roles.add(role, 'En attente de vérification').catch(() => undefined);
    }, 44),
  ],
};
