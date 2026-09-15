import { SlashCommandBuilder, type Message } from 'discord.js';
import { lire, executer } from '../../database/db';
import { info, ok } from '../../core/embeds';
import { repondre } from '../../core/interactions';
import { neutraliserMentions, tronquer } from '../../core/text';
import { formaterDuree, marqueTemps } from '../../core/time';
import { sur, type ModuleBot, type CommandePrefixe, type CommandeSlash } from '../../core/types';

interface LigneAfk {
  raison: string;
  depuis: number;
}

const prevenus = new Map<string, number>();

function mettreAfk(serveurId: string, utilisateurId: string, raison: string): void {
  executer('INSERT OR REPLACE INTO afk (serveur_id, utilisateur_id, raison, depuis) VALUES (?, ?, ?, ?)', serveurId, utilisateurId, tronquer(neutraliserMentions(raison || 'AFK'), 200), Date.now());
}

async function surMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;
  const soi = lire<LigneAfk>('SELECT raison, depuis FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, message.author.id);
  // Le message qui active l'AFK ne doit pas le retirer aussitôt.
  if (soi && Date.now() - soi.depuis > 5_000) {
    executer('DELETE FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, message.author.id);
    const note = await message.reply({ embeds: [ok(message.guild, `👋 Bienvenue de retour <@${message.author.id}> ! Tu étais AFK depuis **${formaterDuree(Date.now() - soi.depuis)}**.`)], allowedMentions: { repliedUser: false } }).catch(() => null);
    if (note) setTimeout(() => void note.delete().catch(() => undefined), 10_000).unref();
  }
  const mentionnes = [...message.mentions.users.values()].filter((u) => u.id !== message.author.id && !u.bot).slice(0, 5);
  const lignes: string[] = [];
  for (const utilisateur of mentionnes) {
    const rangee = lire<LigneAfk>('SELECT raison, depuis FROM afk WHERE serveur_id = ? AND utilisateur_id = ?', message.guildId, utilisateur.id);
    if (!rangee) continue;
    const cle = `${message.channelId}:${utilisateur.id}`;
    if ((prevenus.get(cle) ?? 0) > Date.now()) continue;
    prevenus.set(cle, Date.now() + 60_000);
    lignes.push(`💤 <@${utilisateur.id}> est actuellement AFK ${marqueTemps(rangee.depuis, 'R')}.\n**Raison :** ${rangee.raison}`);
  }
  if (prevenus.size > 5_000) for (const [k, v] of prevenus) if (v < Date.now()) prevenus.delete(k);
  if (lignes.length) await message.reply({ embeds: [info(message.guild, lignes.join('\n\n'), { emoji: '💤' })], allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
}

const afk: CommandeSlash = {
  categorie: 'community',
  donnees: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Te mettre AFK')
    .addStringOption((o) => o.setName('raison').setDescription('Ex : En train de dormir').setMaxLength(200)),
  async executer(interaction) {
    const raison = interaction.options.getString('raison') ?? 'AFK';
    mettreAfk(interaction.guildId, interaction.user.id, raison);
    await repondre(interaction, { embeds: [info(interaction.guild, `💤 <@${interaction.user.id}> est maintenant AFK.\n**Raison :** ${neutraliserMentions(raison)}`)], allowedMentions: { parse: [] } });
  },
};

const commandesPrefixe: CommandePrefixe[] = [
  {
    nom: 'afk',
    domaine: 'general',
    categorie: 'community',
    description: 'Te mettre AFK',
    usage: '[raison]',
    async executer(message, parametres) {
      const raison = parametres.join(' ') || 'AFK';
      mettreAfk(message.guildId, message.author.id, raison);
      await message.reply({ embeds: [info(message.guild, `💤 Tu es maintenant AFK.\n**Raison :** ${neutraliserMentions(raison)}`)], allowedMentions: { parse: [], repliedUser: false } });
    },
  },
];

export const moduleAfk: ModuleBot = {
  id: 'afk',
  nom: 'AFK',
  emoji: '💤',
  description: 'Statut AFK avec rappel quand on te mentionne',
  desactivable: true,
  actifParDefaut: true,
  commandes: [afk],
  commandesPrefixe,
  evenements: [sur('messageCreate', (m) => surMessage(m), 120)],
};
