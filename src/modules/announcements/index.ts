import { SlashCommandBuilder } from 'discord.js';
import { lireConfig } from '../../core/guildConfig';
import type { PageReglage } from '../../core/setup';
import { enHexa } from '../../core/brand';
import { construireFormulaire } from '../../core/ui';
import { Niveau, type ModuleBot, type CommandeSlash } from '../../core/types';
import { nouveauBrouillon, surBoutonRedaction, surFenetreRedaction, surMenuRedaction, stockerBrouillon } from '../../services/embedBuilder';

const annonce: CommandeSlash = {
  categorie: 'customization',
  niveau: Niveau.STAFF,
  donnees: new SlashCommandBuilder().setName('announce').setDescription('Rédiger une annonce avec aperçu'),
  async executer(interaction) {
    const brouillon = nouveauBrouillon(interaction.guild, interaction.user.id, 'announce');
    brouillon.salonId = lireConfig(interaction.guildId).annonces.salonDefautId;
    stockerBrouillon(brouillon);
    const boutonParDefaut = brouillon.boutons[0] ? `${brouillon.boutons[0].label} | ${brouillon.boutons[0].url}` : '';
    await interaction.showModal(
      construireFormulaire(`an:announcem:${brouillon.id}`, 'Nouvelle annonce', [
        { id: 'title', libelle: 'Titre', valeur: '📢 NOUVELLE ANNONCE', longueurMax: 256, indication: '🎮 STREAM CE SOIR !' },
        { id: 'message', libelle: 'Message', long: true, longueurMax: 4000, indication: 'Rendez-vous à 21h !' },
        { id: 'image', libelle: 'Image (lien, facultatif)', obligatoire: false, longueurMax: 500 },
        { id: 'color', libelle: 'Couleur (facultatif)', obligatoire: false, valeur: enHexa(brouillon.couleur), longueurMax: 30 },
        { id: 'button', libelle: 'Bouton « Texte | lien » (facultatif)', obligatoire: false, valeur: boutonParDefaut, longueurMax: 300 },
      ]),
    );
  },
};

const pageReglage: PageReglage = {
  id: 'announcements',
  section: 'community',
  titre: 'Annonces',
  emoji: '📣',
  moduleId: 'announcements',
  ordre: 7,
  description: '`/announce` ouvre un formulaire, montre l’aperçu, puis publie (et diffuse automatiquement dans un salon d’annonces).',
  champs: [{ kind: 'channel', cle: 'channel', libelle: 'Salon des annonces par défaut', get: (c) => c.annonces.salonDefautId, set: (c, v) => void (c.annonces.salonDefautId = v) }],
};

export const moduleAnnonces: ModuleBot = {
  id: 'announcements',
  nom: 'Annonces',
  emoji: '📣',
  description: 'Générateur d’annonces avec aperçu avant publication',
  desactivable: true,
  actifParDefaut: true,
  commandes: [annonce],
  pagesReglage: [pageReglage],
  composants: [
    {
      prefixe: 'an',
      niveau: Niveau.STAFF,
      bouton: (i, parametres) => surBoutonRedaction(i, parametres),
      menu: (i, parametres) => surMenuRedaction(i, parametres),
      fenetre: (i, parametres) => surFenetreRedaction(i, parametres),
    },
  ],
};
