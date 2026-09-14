import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js';

export interface ModalField {
  id: string;
  label: string;
  description?: string;
  long?: boolean;
  required?: boolean;
  placeholder?: string;
  value?: string | null;
  minLength?: number;
  maxLength?: number;
}

/** Construit un modal Discord à partir d'une liste de champs texte (5 maximum). */
export function buildModal(customId: string, title: string, fields: ModalField[]): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
  for (const field of fields.slice(0, 5)) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setStyle(field.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required ?? true)
      .setMaxLength(Math.min(field.maxLength ?? (field.long ? 4000 : 200), 4000));
    if (field.minLength) input.setMinLength(field.minLength);
    if (field.placeholder) input.setPlaceholder(field.placeholder.slice(0, 100));
    if (field.value) input.setValue(field.value.slice(0, field.maxLength ?? 4000));
    const label = new LabelBuilder().setLabel(field.label.slice(0, 45)).setTextInputComponent(input);
    if (field.description) label.setDescription(field.description.slice(0, 100));
    modal.addLabelComponents(label);
  }
  return modal;
}

export function row<T extends MessageActionRowComponentBuilder>(...components: T[]): ActionRowBuilder<T> {
  return new ActionRowBuilder<T>().addComponents(...components);
}

export function button(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setStyle(style);
  if (label) b.setLabel(label.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function linkButton(url: string, label: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setURL(url).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Link);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function toggleButton(customId: string, label: string, enabled: boolean): ButtonBuilder {
  return button(customId, `${label} : ${enabled ? 'activé' : 'désactivé'}`, enabled ? ButtonStyle.Success : ButtonStyle.Secondary, enabled ? '🟢' : '🔴');
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
