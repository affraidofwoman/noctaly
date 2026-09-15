import type { Client, VoiceState } from 'discord.js';
import { lireTout, executer } from '../database/db';
import { creerRegistre } from '../core/logger';

const registre = creerRegistre('vocal');

export interface CreditVocal {
  serveurId: string;
  utilisateurId: string;
  salonId: string;
  secondes: number;
  /** Seul(e) dans le salon, sourd ou dans le salon AFK : les modules peuvent ignorer ce temps. */
  inactif: boolean;
}

type Ecouteur = (credit: CreditVocal, client: Client) => void;

const ecouteurs: Ecouteur[] = [];
const CREDIT_MAX_S = 10 * 60;

/** Un module s'abonne au temps passé en vocal (XP, statistiques, quêtes…). */
export function surTempsVocal(ecouteur: Ecouteur): void {
  ecouteurs.push(ecouteur);
}

function emettre(client: Client, credit: CreditVocal): void {
  if (credit.secondes <= 0) return;
  for (const l of ecouteurs) {
    try {
      l(credit, client);
    } catch (echec) {
      registre.avertir(`Écouteur vocal en échec : ${(echec as Error).message}`);
    }
  }
}

function estInactif(etat: VoiceState): boolean {
  const salon = etat.channel;
  if (!salon) return true;
  if (etat.selfDeaf || etat.serverDeaf) return true;
  if (etat.guild.afkChannelId === salon.id) return true;
  return salon.members.filter((m) => !m.user.bot).size < 2;
}

function credit(client: Client, serveurId: string, utilisateurId: string, jusqua: number, etat: VoiceState | null): void {
  const rangee = lireTout<{ salon_id: string; debut_le: number }>('SELECT salon_id, debut_le FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, utilisateurId)[0];
  if (!rangee) return;
  const secondes = Math.min(Math.floor((jusqua - rangee.debut_le) / 1000), CREDIT_MAX_S);
  emettre(client, { serveurId, utilisateurId, salonId: rangee.salon_id, secondes, inactif: etat ? estInactif(etat) : false });
}

/** À brancher sur voiceStateUpdate (module cœur). */
export function traiterEtatVocal(avant: VoiceState, apres: VoiceState): void {
  const membre = apres.member ?? avant.member;
  if (!membre || membre.user.bot) return;
  const maintenant = Date.now();
  const serveurId = apres.guild.id;
  if (avant.channelId && avant.channelId !== apres.channelId) {
    credit(apres.client, serveurId, membre.id, maintenant, avant);
    executer('DELETE FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', serveurId, membre.id);
  }
  if (apres.channelId && avant.channelId !== apres.channelId) {
    executer('INSERT OR REPLACE INTO sessions_vocales (serveur_id, utilisateur_id, salon_id, debut_le) VALUES (?, ?, ?, ?)', serveurId, membre.id, apres.channelId, maintenant);
  }
}

/** Crédite régulièrement les sessions en cours (le temps n'est pas perdu en cas de redémarrage). */
export function crediterVocal(client: Client): void {
  const maintenant = Date.now();
  for (const rangee of lireTout<{ serveur_id: string; utilisateur_id: string; salon_id: string; debut_le: number }>('SELECT * FROM sessions_vocales')) {
    const serveur = client.guilds.cache.get(rangee.serveur_id);
    const etat = serveur?.voiceStates.cache.get(rangee.utilisateur_id);
    if (!serveur || !etat?.channelId) {
      executer('DELETE FROM sessions_vocales WHERE serveur_id = ? AND utilisateur_id = ?', rangee.serveur_id, rangee.utilisateur_id);
      continue;
    }
    const secondes = Math.min(Math.floor((maintenant - rangee.debut_le) / 1000), CREDIT_MAX_S);
    emettre(client, { serveurId: rangee.serveur_id, utilisateurId: rangee.utilisateur_id, salonId: etat.channelId, secondes, inactif: estInactif(etat) });
    executer('UPDATE sessions_vocales SET debut_le = ?, salon_id = ? WHERE serveur_id = ? AND utilisateur_id = ?', maintenant, etat.channelId, rangee.serveur_id, rangee.utilisateur_id);
  }
}

/** Au démarrage : repart de zéro pour les personnes déjà en vocal. */
export function resynchroniserVocal(client: Client): void {
  executer('DELETE FROM sessions_vocales');
  const maintenant = Date.now();
  for (const serveur of client.guilds.cache.values()) {
    for (const etat of serveur.voiceStates.cache.values()) {
      if (!etat.channelId || etat.member?.user.bot) continue;
      executer('INSERT OR REPLACE INTO sessions_vocales (serveur_id, utilisateur_id, salon_id, debut_le) VALUES (?, ?, ?, ?)', serveur.id, etat.id, etat.channelId, maintenant);
    }
  }
}
