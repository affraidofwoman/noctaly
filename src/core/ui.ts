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

export interface ChampFenetre {
  id: string;
  libelle: string;
  description?: string;
  long?: boolean;
  obligatoire?: boolean;
  indication?: string;
  valeur?: string | null;
  longueurMin?: number;
  longueurMax?: number;
}

/** Construit un modal Discord à partir d'une liste de champs texte (5 maximum). */
export function construireFormulaire(idPersonnalise: string, titre: string, champs: ChampFenetre[]): ModalBuilder {
  const fenetre = new ModalBuilder().setCustomId(idPersonnalise).setTitle(titre.slice(0, 45));
  for (const champ of champs.slice(0, 5)) {
    const saisie = new TextInputBuilder()
      .setCustomId(champ.id)
      .setStyle(champ.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(champ.obligatoire ?? true)
      .setMaxLength(Math.min(champ.longueurMax ?? (champ.long ? 4000 : 200), 4000));
    if (champ.longueurMin) saisie.setMinLength(champ.longueurMin);
    if (champ.indication) saisie.setPlaceholder(champ.indication.slice(0, 100));
    if (champ.valeur) saisie.setValue(champ.valeur.slice(0, champ.longueurMax ?? 4000));
    const libelle = new LabelBuilder().setLabel(champ.libelle.slice(0, 45)).setTextInputComponent(saisie);
    if (champ.description) libelle.setDescription(champ.description.slice(0, 100));
    fenetre.addLabelComponents(libelle);
  }
  return fenetre;
}

export function rangee<T extends MessageActionRowComponentBuilder>(...composants: T[]): ActionRowBuilder<T> {
  return new ActionRowBuilder<T>().addComponents(...composants);
}

export function bouton(idPersonnalise: string, libelle: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(idPersonnalise).setStyle(style);
  if (libelle) b.setLabel(libelle.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function boutonLien(url: string, libelle: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setURL(url).setLabel(libelle.slice(0, 80)).setStyle(ButtonStyle.Link);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function boutonBascule(idPersonnalise: string, libelle: string, actif: boolean): ButtonBuilder {
  return bouton(idPersonnalise, `${libelle} : ${actif ? 'activé' : 'désactivé'}`, actif ? ButtonStyle.Success : ButtonStyle.Secondary, actif ? '🟢' : '🔴');
}

export function estLienHttp(valeur: string): boolean {
  try {
    const u = new URL(valeur);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
