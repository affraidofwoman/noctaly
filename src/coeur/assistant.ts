import {
  type ActionRowBuilder,
  type AnySelectMenuInteraction,
  type ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { botPeutGererRole } from './acces';
import { bouton, type ChampFenetre, construireFormulaire, embedEnseigne, rangee } from './affichage';
import { ErreurUtilisateur, tronquer } from './outils';
import { activerModule, type ConfigServeur, lireConfig, lireModule, modifierConfig, moduleActif } from './reglages';

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
      genre: 'channel';
      channelTypes?: ChannelType[];
      lire(c: ConfigServeur): string | null;
      ecrire(c: ConfigServeur, v: string | null): void;
    })
  | (ChampBase & {
      genre: 'channels';
      channelTypes?: ChannelType[];
      max?: number;
      lire(c: ConfigServeur): string[];
      ecrire(c: ConfigServeur, v: string[]): void;
    })
  | (ChampBase & { genre: 'role'; attribuable?: boolean; lire(c: ConfigServeur): string | null; ecrire(c: ConfigServeur, v: string | null): void })
  | (ChampBase & {
      genre: 'roles';
      attribuable?: boolean;
      max?: number;
      lire(c: ConfigServeur): string[];
      ecrire(c: ConfigServeur, v: string[]): void;
    })
  | (ChampBase & { genre: 'toggle'; lire(c: ConfigServeur): boolean; ecrire(c: ConfigServeur, v: boolean): void })
  | (ChampBase & {
      genre: 'text';
      long?: boolean;
      longueurMax?: number;
      obligatoire?: boolean;
      lire(c: ConfigServeur): string;
      ecrire(c: ConfigServeur, v: string): void;
      validate?(v: string): string | null;
    })
  | (ChampBase & {
      genre: 'number';
      min: number;
      max: number;
      unite?: string;
      lire(c: ConfigServeur): number;
      ecrire(c: ConfigServeur, v: number): void;
    })
  | (ChampBase & {
      genre: 'choice';
      options: { valeur: string; libelle: string; emoji?: string }[];
      lire(c: ConfigServeur): string;
      ecrire(c: ConfigServeur, v: string): void;
    })
  | (ChampBase & {
      genre: 'multichoice';
      options: { valeur: string; libelle: string; emoji?: string }[];
      lire(c: ConfigServeur): string[];
      ecrire(c: ConfigServeur, v: string[]): void;
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

export function verifierMisePage(page: PageReglage): void {
  const menus = page.champs.filter((f) => GENRES_MENUS.has(f.genre)).length;
  const bascules = page.champs.filter((f) => f.genre === 'toggle').length;
  const textes = page.champs.filter((f) => f.genre === 'text' || f.genre === 'number').length;
  if (textes > 5) throw new Error(`Page ${page.id} : 5 champs texte maximum`);
  const controles = (page.moduleId ? 1 : 0) + (textes ? 1 : 0) + (page.actions?.length ?? 0) + 1;
  const rangees = menus + Math.ceil(bascules / 5) + Math.ceil(controles / 5);
  if (rangees > 5) throw new Error(`Page ${page.id} : trop de composants (${rangees} rangées)`);
}

function valeurAffichee(serveur: Guild, champ: ChampReglage, reglages: ConfigServeur): string {
  const aucun = '*non défini*';
  switch (champ.genre) {
    case 'channel': {
      const v = champ.lire(reglages);
      return v ? `<#${v}>` : aucun;
    }
    case 'channels': {
      const v = champ.lire(reglages);
      return v.length ? v.map((id) => `<#${id}>`).join(' ') : aucun;
    }
    case 'role': {
      const v = champ.lire(reglages);
      if (!v) return aucun;
      const role = serveur.roles.cache.get(v);
      const avertir = champ.attribuable && role && !botPeutGererRole(serveur, role) ? ' ⚠️ *rôle au-dessus du bot*' : '';
      return `<@&${v}>${avertir}`;
    }
    case 'roles': {
      const v = champ.lire(reglages);
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
      return champ.lire(reglages) ? '🟢 Activé' : '🔴 Désactivé';
    case 'text': {
      const v = champ.lire(reglages);
      return v ? `>>> ${tronquer(v, 180)}` : aucun;
    }
    case 'number':
      return `\`${champ.lire(reglages)}\`${champ.unite ? ` ${champ.unite}` : ''}`;
    case 'choice': {
      const v = champ.lire(reglages);
      const option = champ.options.find((o) => o.valeur === v);
      return option ? `${option.emoji ?? ''} ${option.libelle}`.trim() : aucun;
    }
    case 'multichoice': {
      const v = champ.lire(reglages);
      return champ.options
        .filter((o) => v.includes(o.valeur))
        .map((o) => `${o.emoji ?? ''} ${o.libelle}`.trim())
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
      inline: champ.genre === 'toggle' || champ.genre === 'number',
    });
  }

  const rangees: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (const champ of page.champs) {
    const id = `setup:sel:${page.id}:${champ.cle}`;
    const indication = `${champ.libelle}`.slice(0, 100);
    if (champ.genre === 'channel' || champ.genre === 'channels') {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(0)
        .setMaxValues(champ.genre === 'channel' ? 1 : Math.min(champ.max ?? 25, 25))
        .setChannelTypes(...(champ.channelTypes ?? [ChannelType.GuildText, ChannelType.GuildAnnouncement]));
      const actuel = champ.genre === 'channel' ? [champ.lire(reglages)].filter((v): v is string => !!v) : champ.lire(reglages);
      const valides = actuel.filter((c) => serveur.channels.cache.has(c)).slice(0, 25);
      if (valides.length) menu.setDefaultChannels(...valides);
      rangees.push(rangee(menu));
    } else if (champ.genre === 'role' || champ.genre === 'roles') {
      const menu = new RoleSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(0)
        .setMaxValues(champ.genre === 'role' ? 1 : Math.min(champ.max ?? 25, 25));
      const actuel = champ.genre === 'role' ? [champ.lire(reglages)].filter((v): v is string => !!v) : champ.lire(reglages);
      const valides = actuel.filter((r) => serveur.roles.cache.has(r)).slice(0, 25);
      if (valides.length) menu.setDefaultRoles(...valides);
      rangees.push(rangee(menu));
    } else if (champ.genre === 'choice' || champ.genre === 'multichoice') {
      const actuel = champ.genre === 'choice' ? [champ.lire(reglages)] : champ.lire(reglages);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(indication)
        .setMinValues(champ.genre === 'choice' ? 1 : 0)
        .setMaxValues(champ.genre === 'choice' ? 1 : champ.options.length)
        .addOptions(
          champ.options.slice(0, 25).map((o) => ({
            label: o.libelle,
            value: o.valeur,
            emoji: o.emoji,
            default: actuel.includes(o.valeur),
          })),
        );
      rangees.push(rangee(menu));
    }
  }

  const bascules = page.champs.filter((f) => f.genre === 'toggle');
  for (let i = 0; i < bascules.length; i += 5) {
    rangees.push(
      rangee(
        ...bascules.slice(i, i + 5).map((f) => {
          const sur = f.genre === 'toggle' && f.lire(reglages);
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
  if (page.champs.some((f) => f.genre === 'text' || f.genre === 'number')) {
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
      if (champ.genre !== 'toggle') return;
      modifierConfig(serveur.id, (c) => champ.ecrire(c, !champ.lire(c)));
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
        if (f.genre === 'text') {
          champsFenetre.push({ id: f.cle, libelle: f.libelle, long: f.long, obligatoire: f.obligatoire ?? false, valeur: f.lire(reglages), longueurMax: f.longueurMax ?? (f.long ? 2000 : 200) });
        } else if (f.genre === 'number') {
          champsFenetre.push({ id: f.cle, libelle: `${f.libelle} (${f.min}-${f.max})`, valeur: String(f.lire(reglages)), longueurMax: 10 });
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
    switch (champ.genre) {
      case 'channel':
      case 'role':
        champ.ecrire(c, valeurs[0] ?? null);
        break;
      case 'channels':
      case 'roles':
      case 'multichoice':
        champ.ecrire(c, [...valeurs]);
        break;
      case 'choice':
        if (valeurs[0]) champ.ecrire(c, valeurs[0]);
        break;
      default:
        break;
    }
  });
  let avertissement: string | undefined;
  if ((champ.genre === 'role' || champ.genre === 'roles') && champ.attribuable) {
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
      if (champ.genre !== 'text' && champ.genre !== 'number') continue;
      let brut: string;
      try {
        brut = interaction.fields.getTextInputValue(champ.cle).trim();
      } catch {
        continue;
      }
      if (champ.genre === 'text') {
        const probleme = champ.validate?.(brut) ?? null;
        if (probleme) erreurs.push(`**${champ.libelle}** : ${probleme}`);
        else champ.ecrire(c, brut);
      } else {
        const n = Number(brut.replace(',', '.'));
        if (!Number.isFinite(n) || n < champ.min || n > champ.max) erreurs.push(`**${champ.libelle}** : valeur entre ${champ.min} et ${champ.max} attendue.`);
        else champ.ecrire(c, Math.round(n));
      }
    }
  });
  const avertissement = erreurs.length ? `⚠️ Certaines valeurs ont été ignorées :\n${erreurs.join('\n')}` : '✅ Textes enregistrés.';
  if (interaction.isFromMessage()) await interaction.update(afficherPage(interaction.guild, page, avertissement));
  else await interaction.reply({ ...afficherPage(interaction.guild, page, avertissement), flags: 64 });
}
