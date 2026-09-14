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
import { all, get, parseJson, run } from '../../database/db';
import { colorFor, ok } from '../../core/embeds';
import { UserError } from '../../core/errors';
import { getConfig } from '../../core/guildConfig';
import { reply } from '../../core/interactions';
import { journal, recordLog, resolveTextChannel } from '../../core/logService';
import { hasLevel } from '../../core/permissions';
import type { SetupPage } from '../../core/setup';
import { neutralizeMentions, slugify, truncate } from '../../core/text';
import { button, buildModal, row, type ModalField } from '../../core/ui';
import { PermLevel, type BotModule, type SlashCommand } from '../../core/types';

interface Question {
  label: string;
  long: boolean;
  required: boolean;
}

interface FormDef {
  name: string;
  title: string;
  description: string;
  questions: Question[];
  channelId: string | null;
  builtin?: boolean;
}

interface FormRow {
  id: number;
  name: string;
  title: string;
  description: string;
  questions: string;
  channel_id: string | null;
}

/** Formulaires intégrés : partenariat et candidature staff. */
function builtin(guild: Guild, name: string): FormDef | null {
  const cfg = getConfig(guild.id);
  if (name === 'partenariat') {
    return {
      name,
      title: '🤝 Candidature partenariat',
      description: 'Propose un partenariat avec la communauté.',
      channelId: cfg.forms.partnershipChannelId ?? cfg.general.staffChannelId,
      builtin: true,
      questions: [
        { label: 'Ton nom / pseudo', long: false, required: true },
        { label: 'Nom du serveur ou de la chaîne', long: false, required: true },
        { label: 'Description', long: true, required: true },
        { label: 'Lien (invitation, chaîne…)', long: false, required: true },
        { label: 'Pourquoi un partenariat ?', long: true, required: true },
      ],
    };
  }
  if (name === 'staff') {
    return {
      name,
      title: '📋 Candidature staff',
      description: 'Rejoindre l’équipe de modération.',
      channelId: cfg.forms.staffApplyChannelId ?? cfg.general.staffChannelId,
      builtin: true,
      questions: [
        { label: 'Âge', long: false, required: true },
        { label: 'Disponibilités', long: true, required: true },
        { label: 'Expérience de modération', long: true, required: true },
        { label: 'Motivation', long: true, required: true },
      ],
    };
  }
  return null;
}

function getForm(guild: Guild, name: string): FormDef | null {
  const b = builtin(guild, name);
  if (b) return b;
  const r = get<FormRow>('SELECT * FROM forms WHERE guild_id = ? AND name = ?', guild.id, name);
  return r ? { name: r.name, title: r.title, description: r.description, questions: parseJson<Question[]>(r.questions, []), channelId: r.channel_id } : null;
}

function formModal(form: FormDef) {
  const fields: ModalField[] = form.questions.slice(0, 5).map((q, i) => ({ id: `q${i}`, label: q.label, long: q.long, required: q.required, maxLength: q.long ? 1500 : 200 }));
  return buildModal(`form:submit:${form.name}`, form.title, fields);
}

/** Questions en texte : une par ligne, « * » à la fin pour une réponse longue, « ? » au début pour facultative. */
export function parseQuestions(input: string): Question[] {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => {
      const optional = l.startsWith('?');
      const long = l.endsWith('*');
      return { label: l.replace(/^\?/, '').replace(/\*$/, '').trim().slice(0, 45), long, required: !optional };
    })
    .filter((q) => q.label.length > 0);
}

async function submit(interaction: ModalSubmitInteraction<'cached'>, form: FormDef) {
  const guild = interaction.guild;
  const channel = resolveTextChannel(guild, form.channelId ?? getConfig(guild.id).general.staffChannelId);
  if (!channel) throw new UserError('Ce formulaire n’a pas de salon de réception. Préviens le staff.');
  const answers = form.questions.slice(0, 5).map((q, i) => ({ q: q.label, a: neutralizeMentions(interaction.fields.getTextInputValue(`q${i}`).trim()) }));
  const r = run('INSERT INTO form_submissions (guild_id, form_name, user_id, answers, created_at) VALUES (?, ?, ?, ?, ?)', guild.id, form.name, interaction.user.id, JSON.stringify(answers), Date.now());
  const embed = new EmbedBuilder()
    .setColor(colorFor(guild, 'info'))
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
    .setTitle(`${form.title} — #${r.lastInsertRowid}`)
    .setDescription(`<@${interaction.user.id}> \`${interaction.user.id}\``)
    .addFields(answers.map((x) => ({ name: truncate(x.q, 256), value: truncate(x.a || '—', 1024), inline: false })))
    .setTimestamp();
  await channel.send({
    embeds: [embed],
    components: [row(button(`form:ok:${r.lastInsertRowid}`, 'Accepter', ButtonStyle.Success, '✅'), button(`form:no:${r.lastInsertRowid}`, 'Refuser', ButtonStyle.Danger, '❌'))],
    allowedMentions: { parse: [] },
  });
  recordLog(guild.id, 'community', `form-${form.name}`, interaction.user.id, interaction.user.id, { id: r.lastInsertRowid });
  void journal(guild, 'community', { title: 'Formulaire reçu', tone: 'info', lines: [`**${form.title}** de <@${interaction.user.id}>`] });
  await interaction.reply({ embeds: [ok(guild, 'Merci ! Ta réponse a bien été envoyée au staff. Tu recevras un message privé quand elle sera traitée.')], flags: MessageFlags.Ephemeral });
}

const partner: SlashCommand = {
  category: 'community',
  cooldownSeconds: 60,
  data: new SlashCommandBuilder().setName('partner').setDescription('Proposer un partenariat'),
  async execute(interaction) {
    await interaction.showModal(formModal(builtin(interaction.guild, 'partenariat')!));
  },
};

const staffapply: SlashCommand = {
  category: 'community',
  cooldownSeconds: 60,
  data: new SlashCommandBuilder().setName('staffapply').setDescription('Candidater pour le staff'),
  async execute(interaction) {
    await interaction.showModal(formModal(builtin(interaction.guild, 'staff')!));
  },
};

const formCommand: SlashCommand = {
  category: 'admin',
  level: PermLevel.ADMIN,
  data: new SlashCommandBuilder()
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
  async autocomplete(interaction) {
    const rows = all<FormRow>('SELECT * FROM forms WHERE guild_id = ? ORDER BY name', interaction.guildId);
    const options = [{ name: '🤝 Partenariat (intégré)', value: 'partenariat' }, { name: '📋 Candidature staff (intégré)', value: 'staff' }, ...rows.map((r) => ({ name: truncate(r.title, 100), value: r.name }))];
    const focused = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(options.filter((o) => o.name.toLowerCase().includes(focused)).slice(0, 25));
  },
  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const rows = all<FormRow>('SELECT * FROM forms WHERE guild_id = ? ORDER BY name', guild.id);
      const lines = ['🤝 **Partenariat** — intégré (`/partner`)', '📋 **Candidature staff** — intégré (`/staffapply`)', ...rows.map((r) => `📝 **${r.title}** \`${r.name}\` — ${parseJson<Question[]>(r.questions, []).length} question(s) → <#${r.channel_id}>`)];
      return reply(interaction, { embeds: [new EmbedBuilder().setColor(colorFor(guild)).setTitle('📝 Formulaires').setDescription(lines.join('\n'))], ephemeral: true });
    }
    if (sub === 'create') {
      const title = interaction.options.getString('titre', true);
      const channel = interaction.options.getChannel('salon', true);
      return interaction.showModal(
        buildModal(`form:create:${channel.id}`, `Questions — ${title}`.slice(0, 45), [
          { id: 'title', label: 'Titre', value: title, maxLength: 45 },
          { id: 'description', label: 'Description du formulaire', required: false, maxLength: 300 },
          { id: 'questions', label: 'Questions (une par ligne, 5 max)', long: true, maxLength: 400, placeholder: 'Âge\nDisponibilités*\n?Lien vers ton portfolio\n(* = réponse longue, ? = facultative)' },
        ]),
      );
    }
    const name = interaction.options.getString('formulaire', true);
    if (sub === 'delete') {
      if (builtin(guild, name)) throw new UserError('Les formulaires intégrés se désactivent en coupant le module.');
      const r = run('DELETE FROM forms WHERE guild_id = ? AND name = ?', guild.id, name);
      return reply(interaction, { embeds: [ok(guild, r.changes ? 'Formulaire supprimé.' : 'Introuvable.')], ephemeral: true });
    }
    const form = getForm(guild, name);
    if (!form) throw new UserError('Formulaire introuvable.');
    const channel = (interaction.options.getChannel('salon') ?? interaction.channel) as GuildTextBasedChannel | null;
    if (!channel) return;
    const sent = await channel.send({
      embeds: [new EmbedBuilder().setColor(colorFor(guild)).setTitle(form.title).setDescription(form.description || 'Clique sur le bouton pour remplir le formulaire.')],
      components: [row(button(`form:open:${form.name}`, 'Remplir le formulaire', ButtonStyle.Primary, '📝'))],
    });
    return reply(interaction, { embeds: [ok(guild, `Bouton posté : ${sent.url}`)], ephemeral: true });
  },
};

const setupPage: SetupPage = {
  id: 'forms',
  section: 'community',
  title: 'Formulaires',
  emoji: '📝',
  moduleId: 'forms',
  order: 15,
  description: 'Où arrivent les candidatures intégrées (`/partner`, `/staffapply`). Les formulaires personnalisés se créent avec `/form create`.',
  fields: [
    { kind: 'channel', key: 'partner', label: 'Salon des partenariats', get: (c) => c.forms.partnershipChannelId, set: (c, v) => void (c.forms.partnershipChannelId = v) },
    { kind: 'channel', key: 'staff', label: 'Salon des candidatures staff', get: (c) => c.forms.staffApplyChannelId, set: (c, v) => void (c.forms.staffApplyChannelId = v) },
  ],
};

export const formsModule: BotModule = {
  id: 'forms',
  name: 'Formulaires',
  emoji: '📝',
  description: 'Partenariats, candidatures staff et formulaires personnalisés',
  toggleable: true,
  defaultEnabled: true,
  commands: [partner, staffapply, formCommand],
  setupPages: [setupPage],
  components: [
    {
      prefix: 'form',
      async button(interaction: ButtonInteraction<'cached'>, [action, arg]) {
        if (action === 'open') {
          const form = getForm(interaction.guild, arg ?? '');
          if (!form) throw new UserError('Ce formulaire n’existe plus.');
          return interaction.showModal(formModal(form));
        }
        if (!hasLevel(interaction.member, PermLevel.STAFF)) throw new UserError('Réservé au staff.');
        const sub = get<{ id: number; user_id: string; form_name: string; status: string }>('SELECT id, user_id, form_name, status FROM form_submissions WHERE id = ? AND guild_id = ?', Number(arg), interaction.guildId);
        if (!sub) throw new UserError('Réponse introuvable.');
        if (sub.status !== 'pending') throw new UserError('Cette réponse a déjà été traitée.');
        const accepted = action === 'ok';
        run('UPDATE form_submissions SET status = ?, handled_by = ? WHERE id = ?', accepted ? 'accepted' : 'denied', interaction.user.id, sub.id);
        const form = getForm(interaction.guild, sub.form_name);
        const user = await interaction.client.users.fetch(sub.user_id).catch(() => null);
        await user
          ?.send({ embeds: [new EmbedBuilder().setColor(colorFor(interaction.guild, accepted ? 'success' : 'error')).setDescription(`${accepted ? '✅' : '❌'} Ta réponse au formulaire **${form?.title ?? sub.form_name}** sur **${interaction.guild.name}** a été **${accepted ? 'acceptée' : 'refusée'}**.${accepted ? '\nLe staff va te recontacter.' : ''}`)] })
          .catch(() => undefined);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setColor(colorFor(interaction.guild, accepted ? 'success' : 'error')).setFooter({ text: `${accepted ? 'Acceptée' : 'Refusée'} par ${interaction.user.tag}` });
        await interaction.update({ embeds: [embed], components: [] });
      },
      async modal(interaction: ModalSubmitInteraction<'cached'>, [action, arg]) {
        if (action === 'submit') {
          const form = getForm(interaction.guild, arg ?? '');
          if (!form) throw new UserError('Ce formulaire n’existe plus.');
          return submit(interaction, form);
        }
        if (action === 'create') {
          if (!hasLevel(interaction.member, PermLevel.ADMIN)) throw new UserError('Réservé aux admins.');
          const title = interaction.fields.getTextInputValue('title').trim();
          const questions = parseQuestions(interaction.fields.getTextInputValue('questions'));
          if (!questions.length) throw new UserError('Ajoute au moins une question.');
          const name = slugify(title, 40);
          if (builtin(interaction.guild, name)) throw new UserError('Ce nom est réservé.');
          run(
            `INSERT INTO forms (guild_id, name, title, description, questions, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, name) DO UPDATE SET title = excluded.title, description = excluded.description, questions = excluded.questions, channel_id = excluded.channel_id`,
            interaction.guildId,
            name,
            title,
            interaction.fields.getTextInputValue('description').trim(),
            JSON.stringify(questions),
            arg,
            Date.now(),
          );
          await interaction.reply({ embeds: [ok(interaction.guild, `Formulaire **${title}** enregistré (\`${name}\`, ${questions.length} question(s)).\nPoste son bouton avec \`/form panel\`.`)], flags: MessageFlags.Ephemeral });
        }
      },
    },
  ],
};
