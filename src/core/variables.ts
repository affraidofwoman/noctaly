import type { Guild, GuildBasedChannel, GuildMember, Role, User } from 'discord.js';
import { enseigneDe } from './brand';
import { lireConfig } from './guildConfig';
import { formaterDate, partiesFuseau } from './time';

export interface ContexteVariables {
  serveur?: Guild | null;
  membre?: GuildMember | null;
  utilisateur?: User | null;
  salon?: GuildBasedChannel | { id: string; toString(): string } | null;
  role?: Role | null;
  extra?: Record<string, string | number | null | undefined>;
  maintenant?: number;
}

export const DOCS_VARIABLES: Record<string, string> = {
  user: "Nom d'affichage de l'utilisateur",
  mention: "Mention de l'utilisateur",
  username: "Nom d'utilisateur",
  userid: "Identifiant de l'utilisateur",
  createdat: 'Date de création du compte',
  server: 'Nom du serveur',
  membercount: 'Nombre de membres',
  channel: 'Mention du salon',
  role: 'Mention du rôle',
  date: 'Date du jour',
  time: 'Heure actuelle',
  streamer: 'Nom du streamer (Twitch)',
  game: 'Jeu/catégorie (Twitch)',
  title: 'Titre du live (Twitch)',
  viewers: 'Nombre de viewers (Twitch)',
  url: 'Lien du live (Twitch)',
  level: 'Niveau (XP)',
  boosts: 'Nombre de boosts du serveur',
  brand: 'Nom de l’enseigne du streamer',
  twitch: 'Lien de la chaîne Twitch de l’enseigne',
};

/** Remplace les variables {nom} connues. Les variables inconnues sont laissées intactes. */
export function remplirModele(modele: string, contexte: ContexteVariables): string {
  const utilisateur = contexte.membre?.user ?? contexte.utilisateur ?? null;
  const serveur = contexte.serveur ?? contexte.membre?.guild ?? null;
  const fuseau = serveur ? lireConfig(serveur.id).general.fuseau : 'Europe/Paris';
  const maintenant = contexte.maintenant ?? Date.now();
  const parties = partiesFuseau(maintenant, fuseau);

  const valeurs: Record<string, string | undefined> = {
    user: contexte.membre?.displayName ?? utilisateur?.globalName ?? utilisateur?.username,
    mention: utilisateur ? `<@${utilisateur.id}>` : undefined,
    username: utilisateur?.username,
    userid: utilisateur?.id,
    createdat: utilisateur ? formaterDate(utilisateur.createdTimestamp, fuseau, false) : undefined,
    server: serveur?.name,
    membercount: serveur ? String(serveur.memberCount) : undefined,
    channel: contexte.salon ? `<#${contexte.salon.id}>` : undefined,
    role: contexte.role ? `<@&${contexte.role.id}>` : undefined,
    date: `${String(parties.jour).padStart(2, '0')}/${String(parties.mois).padStart(2, '0')}/${parties.annee}`,
    time: `${String(parties.heure).padStart(2, '0')}:${String(parties.minute).padStart(2, '0')}`,
    boosts: serveur ? String(serveur.premiumSubscriptionCount ?? 0) : undefined,
    brand: serveur ? (enseigneDe(serveur.id).cle ? enseigneDe(serveur.id).nom : serveur.name) : enseigneDe(null).nom,
    twitch: serveur && enseigneDe(serveur.id).pseudoTwitch ? `https://twitch.tv/${enseigneDe(serveur.id).pseudoTwitch}` : undefined,
  };
  for (const [k, v] of Object.entries(contexte.extra ?? {})) {
    if (v !== undefined && v !== null) valeurs[k.toLowerCase()] = String(v);
  }

  return modele.replace(/\{([a-z_]+)\}/gi, (entier, nom: string) => {
    const valeur = valeurs[nom.toLowerCase()];
    return valeur === undefined ? entier : valeur;
  });
}

export function aideVariables(noms: string[]): string {
  return noms.map((n) => `\`{${n}}\` — ${DOCS_VARIABLES[n] ?? n}`).join('\n');
}
