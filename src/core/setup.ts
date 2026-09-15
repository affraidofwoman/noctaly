import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonBuilder,
  type ButtonInteraction,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import { embedEnseigne } from './embeds';
import { lireConfig, modifierConfig, type ConfigServeur } from './guildConfig';
import { lireModule, moduleActif, activerModule } from './moduleManager';
import { botPeutGererRole } from './permissions';
import { tronquer } from './text';
import { bouton, construireFormulaire, rangee, type ChampFenetre } from './ui';
import { ErreurUtilisateur } from './errors';

export type SectionReglage =
  | 'welcome'
  | 'logs'
  | 'tickets'
  | 'giveaways'
  | 'twitch'
  | 'moderation'
  | 'music'
  | 'roles'
  | 'community'
  | 'security'
  | 'appearance';

export const SECTIONS_REGLAGE: Record<SectionReglage, { label: string; emoji: string }> = {
  welcome: { label: 'Bienvenue', emoji: '👋' },
  logs: { label: 'Logs', emoji: '📜' },
  tickets: { label: 'Tickets', emoji: '🎫' },
  giveaways: { label: 'Giveaways', emoji: '🎉' },
  twitch: { label: 'Twitch', emoji: '🔴' },
  moderation: { label: 'Modération', emoji: '🛡️' },
  music: { label: 'Musique', emoji: '🎵' },
  roles: { label: 'Rôles', emoji: '🎭' },
  community: { label: 'Communauté', emoji: '💡' },
  security: { label: 'Sécurité & accès', emoji: '🔐' },
  appearance: { label: 'Apparence', emoji: '🎨' },
};

interface ChampBase {
  cle: string;
  libelle: string;
  aide?: string;
}

export type ChampReglage =
  | (ChampBase & {
      kind: 'channel';
      channelTypes?: ChannelType[];
      get(c: ConfigServeur): string | null;
      set(c: ConfigServeur, v: string | null): void;
    })
  | (ChampBase & {
      kind: 'channels';
      channelTypes?: ChannelType[];
      max?: number;
      get(c: ConfigServeur): string[];
      set(c: ConfigServeur, v: string[]): void;
    })
  | (ChampBase & { kind: 'role'; attribuable?: boolean; get(c: ConfigServeur): string | null; set(c: ConfigServeur, v: string | null): void })
  | (ChampBase & {
      kind: 'roles';
      attribuable?: boolean;
      max?: number;
      get(c: ConfigServeur): string[];
      set(c: ConfigServeur, v: string[]): void;
    })
  | (ChampBase & { kind: 'toggle'; get(c: ConfigServeur): boolean; set(c: ConfigServeur, v: boolean): void })
  | (ChampBase & {
      kind: 'text';
      long?: boolean;
      maxLength?: number;
      required?: boolean;
      get(c: ConfigServeur): string;
      set(c: ConfigServeur, v: string): void;
      validate?(v: string): string | null;
    })
  | (ChampBase & {
      kind: 'number';
      min: number;
      max: number;
      unit?: string;
      get(c: ConfigServeur): number;
      set(c: ConfigServeur, v: number): void;
    })
  | (ChampBase & {
      kind: 'choice';
      options: { value: string; label: string; emoji?: string }[];
      get(c: ConfigServeur): string;
      set(c: ConfigServeur, v: string): void;
    })
  | (ChampBase & {
      kind: 'multichoice';
      options: { value: string; label: string; emoji?: string }[];
      get(c: ConfigServeur): string[];
      set(c: ConfigServeur, v: string[]): void;
    });

export interface ActionReglage {
  id: string;
  libelle: string;
  emoji: string;
  style?: ButtonStyle;
  executer(interaction: ButtonInteraction<'cached'>): Promise<unknown>;
}

export interface PageReglage {
  id: string;
  section: SectionReglage;
  titre: string;
  emoji: string;
  description: string;
  /** Module dont l'activation est proposée sur la page. */
  moduleId?: string;
  champs: ChampReglage[];
  actions?: ActionReglage[];
  ordre?: number;
}

const pages = new Map<string, PageReglage>();

export function enregistrerPagesReglage(liste: PageReglage[]): void {
  for (const page of liste) {
    if (pages.has(page.id)) throw new Error(`Page de configuration en double : ${page.id}`);
    verifierMisePage(page);
    pages.set(page.id, page);
  }
}

export function viderPagesReglage(): void {
  pages.clear();
}

export function lirePageReglage(id: string): PageReglage | undefined {
  return pages.get(id);
}

export function pagesDeSection(section: SectionReglage): PageReglage[] {
  return [...pages.values()].filter((p) => p.section === section).sort((a, b) => (a.ordre ?? 50) - (b.ordre ?? 50));
}

const GENRES_MENUS = new Set(['channel', 'channels', 'role', 'roles', 'choice', 'multichoice']);

/** Vérifie qu'une page tient dans les 5 rangées de composants autorisées par Discord. */
export function verifierMisePage(page: PageReglage): void {
  const menus = page.champs.filter((f) => GENRES_MENUS.has(f.kind)).length;
  const bascules = page.champs.filter((f) => f.kind === 'toggle').length;
  const textes = page.champs.filter((f) => f.kind === 'text' || f.kind === 'number').length;
  if (textes > 5) throw new Error(`Page ${page.id} : 5 champs texte maximum`);
  const controles = (page.moduleId ? 1 : 0) + (textes ? 1 : 0) + (page.actions?.length ?? 0) + 1;
  const rangees = menus + Math.ceil(bascules / 5) + Math.ceil(controles / 5);
  if (rangees > 5) throw new Error(`Page ${page.id} : trop de composants (${rangees} rangées)`);
}

function valeurAffichee(serveur: Guild, champ: ChampReglage, reglages: ConfigServeur): string {
  const aucun = '*non défini*';
  switch (champ.kind) {
    case 'channel': {
      const v = champ.get(reglages);
      return v ? `<#${v}>` : aucun;
    }
    case 'channels': {
      const v = champ.get(reglages);
      return v.length ? v.map((id) => `<#${id}>`).join(' ') : aucun;
    }
    case 'role': {
      const v = champ.get(reglages);
      if (!v) return aucun;
      const role = serveur.roles.cache.get(v);
      const avertir = champ.attribuable && role && !botPeutGererRole(serveur, role) ? ' ⚠️ *rôle au-dessus du bot*' : '';
      return `<@&${v}>${avertir}`;
    }
    case 'roles': {
      const v = champ.get(reglages);
      if (!v.length) return aucun;
      const bloques = champ.attribuable
        ? v.filter((id) => {
            const r = serveur.roles.cache.get(id);
            return r && !botPeutGererRole(serveur, r);
          })
        : [];
      return v.map((id) => `<@&${id}>`).join(' ') + (bloques.length ? `\n⚠️ ${bloques.length} rôle(s) au-dessus du bot` : '');
    }
    case 'toggle':
      return champ.get(reglages) ? '🟢 Activé' : '🔴 Désactivé';
    case 'text': {
      const v = champ.get(reglages);
      return v ? `>>> ${tronquer(v, 180)}` : aucun;
    }
    case 'number':
      return `\`${champ.get(reglages)}\`${champ.unit ? ` ${champ.unit}` : ''}`;
    case 'choice': {
      const v = champ.get(reglages);
      const option = champ.options.find((o) => o.value === v);
      return option ? `${option.emoji ?? ''} ${option.label}`.trim() : aucun;
    }
    case 'multichoice': {
      const v = champ.get(reglages);
      return champ.options
        .filter((o) => v.includes(o.value))
        .map((o) => `${o.emoji ?? ''} ${o.label}`.trim())
        .join(', ') || aucun;
    }
  }
}

export function afficherAccueil(serveur: Guild) {
  const reglages = lireConfig(serveur.id);
  const embed = embedEnseigne(serveur)
    .setTitle('🤖 CONFIGURATION DU SERVEUR')
    .setDescription(
      [
        "Bienvenue dans l'assistant !",
        '',
        'Nous allons configurer votre serveur **étape par étape**.',
        'Chaque section est indépendante : configure uniquement ce dont tu as besoin.',
        '',
        '💡 *Astuce : `/quicksetup` crée automatiquement les salons de base.*',
        reglages.assistant.termineLe ? `\n✅ Dernière configuration terminée <t:${Math.floor(reglages.assistant.termineLe / 1000)}:R>.` : '',
      ].join('\n'),
    );
  const boutonsSections = (Object.keys(SECTIONS_REGLAGE) as SectionReglage[])
    .filter((s) => pagesDeSection(s).length > 0)
    .map((s) => bouton(`setup:sec:${s}`, SECTIONS_REGLAGE[s].label, ButtonStyle.Secondary, SECTIONS_REGLAGE[s].emoji));
  boutonsSections.push(bouton('setup:done', 'Terminer', ButtonStyle.Success, '✅'));
  const rangees: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < boutonsSections.length && rangees.length < 5; i += 4) rangees.push(rangee(...boutonsSections.slice(i, i + 4)));
  return { embeds: [embed], components: rangees };
}

export function afficherSection(serveur: Guild, section: SectionReglage) {
  const liste = pagesDeSection(section);
  if (liste.length === 1) return afficherPage(serveur, liste[0]!);
  const info = SECTIONS_REGLAGE[section];
  const embed = embedEnseigne(serveur)
    .setTitle(`${info.emoji} ${info.label.toUpperCase()}`)
    .setDescription(
      liste
        .map((p) => {
          const statut = p.moduleId ? (moduleActif(serveur.id, p.moduleId) ? '🟢' : '🔴') : '⚙️';
          return `${statut} ${p.emoji} **${p.titre}**\n-# ${p.description}`;
        })
        .join('\n'),
    );
  const boutons = liste.map((p) => bouton(`setup:page:${p.id}`, p.titre, ButtonStyle.Primary, p.emoji));
  const rangees: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < boutons.length && rangees.length < 4; i += 5) rangees.push(rangee(...boutons.slice(i, i + 5)));
  rangees.push(rangee(bouton('setup:home', 'Retour', ButtonStyle.Secondary, '⬅️')));
  return { embeds: [embed], components: rangees };
}

export function afficherPage(serveur: Guild, page: PageReglage, avertissement?: string) {
  const reglages = lireConfig(serveur.id);
  const embed = embedEnseigne(serveur).setTitle(`${page.emoji} ${page.titre.toUpperCase()}`);
  const lignes = [page.description];
  if (page.moduleId) {
    const module = lireModule(page.moduleId);
    lignes.push('', `**Module ${module?.nom ?? page.moduleId} :** ${moduleActif(serveur.id, page.moduleId) ? '🟢 Activé' : '🔴 Désactivé'}`);
  }
  if (avertissement) lignes.push('', avertissement);
  embed.setDescription(lignes.join('\n'));
  for (const champ of page.champs.slice(0, 25)) {
    embed.addFields({
      name: champ.libelle,
      value: tronquer(`${valeurAffichee(serveur, champ, reglages)}${champ.aide ? `\n-# ${champ.aide}` : ''}`, 1024),
      inline: champ.kind === 'toggle' || champ.kind === 'number',
    });
  }

  const rangees: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (const champ of page.champs) {
    const id = `setup:sel:${page.id}:${champ.cle}`;
    const indication = `${champ.libelle}`.slice(0, 100);
    if (champ.kind === 'channel' || champ.kind === 'channels') {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(0)
        .setMaxValues(champ.kind === 'channel' ? 1 : Math.min(champ.max ?? 25, 25))
        .setChannelTypes(...(champ.channelTypes ?? [ChannelType.GuildText, ChannelType.GuildAnnouncement]));
      const actuel = champ.kind === 'channel' ? [champ.get(reglages)].filter((v): v is string => !!v) : champ.get(reglages);
      const valides = actuel.filter((c) => serveur.channels.cache.has(c)).slice(0, 25);
      if (valides.length) menu.setDefaultChannels(...valides);
      rangees.push(rangee(menu));
    } else if (champ.kind === 'role' || champ.kind === 'roles') {
      const menu = new RoleSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(0)
        .setMaxValues(champ.kind === 'role' ? 1 : Math.min(champ.max ?? 25, 25));
      const actuel = champ.kind === 'role' ? [champ.get(reglages)].filter((v): v is string => !!v) : champ.get(reglages);
      const valides = actuel.filter((r) => serveur.roles.cache.has(r)).slice(0, 25);
      if (valides.length) menu.setDefaultRoles(...valides);
      rangees.push(rangee(menu));
    } else if (champ.kind === 'choice' || champ.kind === 'multichoice') {
      const actuel = champ.kind === 'choice' ? [champ.get(reglages)] : champ.get(reglages);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(champ.kind === 'choice' ? 1 : 0)
        .setMaxValues(champ.kind === 'choice' ? 1 : champ.options.length)
        .addOptions(
          champ.options.slice(0, 25).map((o) => ({
            label: o.label,
            value: o.value,
            emoji: o.emoji,
            default: actuel.includes(o.value),
          })),
        );
      rangees.push(rangee(menu));
    }
  }

  const bascules = page.champs.filter((f) => f.kind === 'toggle');
  for (let i = 0; i < bascules.length; i += 5) {
    rangees.push(
      rangee(
        ...bascules.slice(i, i + 5).map((f) => {
          const sur = f.kind === 'toggle' && f.get(reglages);
          return bouton(`setup:tog:${page.id}:${f.cle}`, f.libelle, sur ? ButtonStyle.Success : ButtonStyle.Secondary, sur ? '🟢' : '🔴');
        }),
      ),
    );
  }

  const controles: ButtonBuilder[] = [];
  if (page.moduleId) {
    const sur = moduleActif(serveur.id, page.moduleId);
    controles.push(bouton(`setup:mod:${page.id}`, sur ? 'Désactiver le module' : 'Activer le module', sur ? ButtonStyle.Danger : ButtonStyle.Success, sur ? '⏸️' : '▶️'));
  }
  if (page.champs.some((f) => f.kind === 'text' || f.kind === 'number')) {
    controles.push(bouton(`setup:txt:${page.id}`, 'Modifier les textes', ButtonStyle.Primary, '📝'));
  }
  for (const action of page.actions ?? []) {
    controles.push(bouton(`setup:act:${page.id}:${action.id}`, action.libelle, action.style ?? ButtonStyle.Primary, action.emoji));
  }
  const plusieurs = pagesDeSection(page.section).length > 1;
  controles.push(bouton(plusieurs ? `setup:sec:${page.section}` : 'setup:home', 'Retour', ButtonStyle.Secondary, '⬅️'));
  for (let i = 0; i < controles.length; i += 5) rangees.push(rangee(...controles.slice(i, i + 5)));

  return { embeds: [embed], components: rangees.slice(0, 5) };
}

function trouverChamp(page: PageReglage, cle: string | undefined): ChampReglage {
  const champ = page.champs.find((f) => f.cle === cle);
  if (!champ) throw new ErreurUtilisateur('Ce paramètre est introuvable. Relance `/setup`.');
  return champ;
}

function exigerPage(id: string | undefined): PageReglage {
  const page = id ? pages.get(id) : undefined;
  if (!page) throw new ErreurUtilisateur("Cette page de configuration n'existe plus. Relance `/setup`.");
  return page;
}

export async function traiterBoutonReglage(interaction: ButtonInteraction<'cached'>, parametres: string[]): Promise<void> {
  const [action, pageId, cle] = parametres;
  const serveur = interaction.guild;
  switch (action) {
    case 'home':
      await interaction.update(afficherAccueil(serveur));
      return;
    case 'sec':
      await interaction.update(afficherSection(serveur, pageId as SectionReglage));
      return;
    case 'page':
      await interaction.update(afficherPage(serveur, exigerPage(pageId)));
      return;
    case 'done': {
      modifierConfig(serveur.id, (c) => {
        c.assistant.termineLe = Date.now();
      });
      const embed = embedEnseigne(serveur, 'success')
        .setTitle('✅ CONFIGURATION TERMINÉE')
        .setDescription('Votre serveur est prêt ! 🎉\n\nTu peux revenir à tout moment avec `/setup`, voir les modules avec `/modules` ou tester les messages avec `/test`.');
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
    case 'tog': {
      const page = exigerPage(pageId);
      const champ = trouverChamp(page, cle);
      if (champ.kind !== 'toggle') return;
      modifierConfig(serveur.id, (c) => champ.set(c, !champ.get(c)));
      await interaction.update(afficherPage(serveur, page));
      return;
    }
    case 'mod': {
      const page = exigerPage(pageId);
      if (!page.moduleId) return;
      activerModule(serveur.id, page.moduleId, !moduleActif(serveur.id, page.moduleId));
      await interaction.update(afficherPage(serveur, page));
      return;
    }
    case 'txt': {
      const page = exigerPage(pageId);
      const reglages = lireConfig(serveur.id);
      const champsFenetre: ChampFenetre[] = [];
      for (const f of page.champs) {
        if (f.kind === 'text') {
          champsFenetre.push({ id: f.cle, libelle: f.libelle, long: f.long, obligatoire: f.required ?? false, valeur: f.get(reglages), longueurMax: f.maxLength ?? (f.long ? 2000 : 200) });
        } else if (f.kind === 'number') {
          champsFenetre.push({ id: f.cle, libelle: `${f.libelle} (${f.min}-${f.max})`, valeur: String(f.get(reglages)), longueurMax: 10 });
        }
      }
      const fenetre = construireFormulaire(`setup:txtm:${page.id}`, `${page.titre} — textes`, champsFenetre);
      await interaction.showModal(fenetre);
      return;
    }
    case 'act': {
      const page = exigerPage(pageId);
      const actionPage = page.actions?.find((a) => a.id === cle);
      if (!actionPage) throw new ErreurUtilisateur('Action introuvable.');
      await actionPage.executer(interaction);
      return;
    }
  }
}

export async function traiterMenuReglage(interaction: AnySelectMenuInteraction<'cached'>, parametres: string[]): Promise<void> {
  const [, pageId, cle] = parametres;
  const page = exigerPage(pageId);
  const champ = trouverChamp(page, cle);
  const valeurs = interaction.values;
  modifierConfig(interaction.guildId, (c) => {
    switch (champ.kind) {
      case 'channel':
      case 'role':
        champ.set(c, valeurs[0] ?? null);
        break;
      case 'channels':
      case 'roles':
      case 'multichoice':
        champ.set(c, [...valeurs]);
        break;
      case 'choice':
        if (valeurs[0]) champ.set(c, valeurs[0]);
        break;
      default:
        break;
    }
  });
  let avertissement: string | undefined;
  if ((champ.kind === 'role' || champ.kind === 'roles') && champ.attribuable) {
    const bloques = valeurs.filter((id) => {
      const r = interaction.guild.roles.cache.get(id);
      return r && !botPeutGererRole(interaction.guild, r);
    });
    if (bloques.length) {
      avertissement = `⚠️ Je ne peux pas attribuer ${bloques.map((id) => `<@&${id}>`).join(', ')} : place mon rôle **au-dessus** dans les paramètres du serveur.`;
    }
  }
  await interaction.update(afficherPage(interaction.guild, page, avertissement ?? '✅ Enregistré.'));
}

export async function traiterFenetreReglage(interaction: ModalSubmitInteraction<'cached'>, parametres: string[]): Promise<void> {
  const [, pageId] = parametres;
  const page = exigerPage(pageId);
  const erreurs: string[] = [];
  modifierConfig(interaction.guildId, (c) => {
    for (const champ of page.champs) {
      if (champ.kind !== 'text' && champ.kind !== 'number') continue;
      let brut: string;
      try {
        brut = interaction.fields.getTextInputValue(champ.cle).trim();
      } catch {
        continue;
      }
      if (champ.kind === 'text') {
        const probleme = champ.validate?.(brut) ?? null;
        if (probleme) erreurs.push(`**${champ.libelle}** : ${probleme}`);
        else champ.set(c, brut);
      } else {
        const n = Number(brut.replace(',', '.'));
        if (!Number.isFinite(n) || n < champ.min || n > champ.max) erreurs.push(`**${champ.libelle}** : valeur entre ${champ.min} et ${champ.max} attendue.`);
        else champ.set(c, Math.round(n));
      }
    }
  });
  const avertissement = erreurs.length ? `⚠️ Certaines valeurs ont été ignorées :\n${erreurs.join('\n')}` : '✅ Textes enregistrés.';
  if (interaction.isFromMessage()) await interaction.update(afficherPage(interaction.guild, page, avertissement));
  else await interaction.reply({ ...afficherPage(interaction.guild, page, avertissement), flags: 64 });
}
