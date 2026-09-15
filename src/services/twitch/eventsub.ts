import type { Client } from 'discord.js';
import { environnement } from '../../core/env';
import { creerRegistre } from '../../core/logger';
import { formaterNombre } from '../../core/text';
import { chargerJetonUtilisateur, renouvelerJetonUtilisateur, validerJetonUtilisateur, type JetonUtilisateur } from './api';
import { diffuserEvenementTwitch, listerChaines } from './notifier';

const registre = creerRegistre('eventsub');

interface WsMessage {
  metadata: { message_type: string; subscription_type?: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
    subscription?: { type: string };
    event?: Record<string, unknown>;
  };
}

/**
 * Client EventSub WebSocket (optionnel, nécessite TWITCH_USER_TOKEN).
 * Raids : pour toutes les chaînes suivies. Follows et abonnements : seulement la chaîne du compte du jeton
 * (Twitch exige que le jeton appartienne au streamer ou à un modérateur).
 */
export class ClientAbonnementsTwitch {
  private prise: WebSocket | null = null;
  private jeton: JetonUtilisateur | null = chargerJetonUtilisateur();
  private compteJeton: { user_id: string; login: string; scopes: string[] } | null = null;
  private minuteurMaintien: NodeJS.Timeout | null = null;
  private delaiReconnexion = 5_000;
  private arrete = false;
  private abonnes = new Set<string>();

  constructor(private readonly client: Client<true>) {}

  get enabled(): boolean {
    return !!this.jeton && !!environnement.twitchClientId;
  }

  async demarrer(): Promise<void> {
    if (!this.enabled) return;
    this.compteJeton = await validerJetonUtilisateur(this.jeton!);
    if (!this.compteJeton) {
      const renouvele = await renouvelerJetonUtilisateur(this.jeton!).catch(() => null);
      if (renouvele) {
        this.jeton = renouvele;
        this.compteJeton = await validerJetonUtilisateur(renouvele);
      }
    }
    if (!this.compteJeton) {
      registre.avertir('TWITCH_USER_TOKEN invalide ou expiré : EventSub (raids, follows, subs) désactivé.');
      return;
    }
    registre.info(`EventSub connecté au compte Twitch ${this.compteJeton.login}.`);
    this.connecter('wss://eventsub.wss.twitch.tv/ws');
  }

  arreter(): void {
    this.arrete = true;
    if (this.minuteurMaintien) clearTimeout(this.minuteurMaintien);
    this.prise?.close();
  }

  private connecter(url: string): void {
    if (this.arrete) return;
    const prise = new WebSocket(url);
    this.prise = prise;
    prise.addEventListener('message', (evenement) => {
      void this.surMessage(String(evenement.data)).catch((echec: unknown) => registre.avertir(`Message EventSub en échec : ${(echec as Error).message}`));
    });
    prise.addEventListener('close', () => {
      if (this.prise !== prise || this.arrete) return;
      this.abonnes.clear();
      registre.avertir(`EventSub déconnecté, reconnexion dans ${this.delaiReconnexion / 1000} s`);
      setTimeout(() => this.connecter('wss://eventsub.wss.twitch.tv/ws'), this.delaiReconnexion).unref();
      this.delaiReconnexion = Math.min(this.delaiReconnexion * 2, 300_000);
    });
    prise.addEventListener('error', () => undefined);
  }

  private armerMaintien(secondes: number): void {
    if (this.minuteurMaintien) clearTimeout(this.minuteurMaintien);
    this.minuteurMaintien = setTimeout(() => this.prise?.close(), (secondes + 10) * 1000);
    this.minuteurMaintien.unref();
  }

  private async surMessage(brut: string): Promise<void> {
    const charge = JSON.parse(brut) as WsMessage;
    const type = charge.metadata.message_type;
    if (charge.payload.session?.keepalive_timeout_seconds) this.armerMaintien(charge.payload.session.keepalive_timeout_seconds);
    else if (type === 'session_keepalive' || type === 'notification') this.armerMaintien(30);

    if (type === 'session_welcome' && charge.payload.session) {
      this.delaiReconnexion = 5_000;
      await this.abonnerTout(charge.payload.session.id);
    } else if (type === 'session_reconnect' && charge.payload.session?.reconnect_url) {
      const ancien = this.prise;
      this.connecter(charge.payload.session.reconnect_url);
      setTimeout(() => ancien?.close(), 5_000).unref();
    } else if (type === 'notification' && charge.payload.subscription && charge.payload.event) {
      await this.surEvenement(charge.payload.subscription.type, charge.payload.event);
    }
  }

  private async creerAbonnement(sessionId: string, type: string, version: string, condition: Record<string, string>): Promise<void> {
    const cle = `${type}:${JSON.stringify(condition)}`;
    if (this.abonnes.has(cle)) return;
    const reponse = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': environnement.twitchClientId, Authorization: `Bearer ${this.jeton!.access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (reponse.status === 401) {
      const renouvele = await renouvelerJetonUtilisateur(this.jeton!).catch(() => null);
      if (renouvele) this.jeton = renouvele;
      return;
    }
    if (reponse.ok || reponse.status === 409) this.abonnes.add(cle);
    else registre.debogage(`Abonnement EventSub ${type} refusé (HTTP ${reponse.status})`);
  }

  private async abonnerTout(sessionId: string): Promise<void> {
    const moi = this.compteJeton!;
    const diffuseurs = [...new Set(listerChaines().filter((c) => c.notifier_evenements && c.diffuseur_id).map((c) => c.diffuseur_id!))];
    for (const id of diffuseurs.slice(0, 250)) {
      await this.creerAbonnement(sessionId, 'channel.raid', '1', { to_broadcaster_user_id: id });
    }
    if (diffuseurs.includes(moi.user_id)) {
      if (moi.scopes.includes('moderator:read:followers')) await this.creerAbonnement(sessionId, 'channel.follow', '2', { broadcaster_user_id: moi.user_id, moderator_user_id: moi.user_id });
      if (moi.scopes.includes('channel:read:subscriptions')) {
        await this.creerAbonnement(sessionId, 'channel.subscribe', '1', { broadcaster_user_id: moi.user_id });
        await this.creerAbonnement(sessionId, 'channel.subscription.gift', '1', { broadcaster_user_id: moi.user_id });
        await this.creerAbonnement(sessionId, 'channel.subscription.message', '1', { broadcaster_user_id: moi.user_id });
      }
    }
  }

  /** À appeler quand une chaîne est ajoutée : réabonne sans attendre une reconnexion. */
  resynchroniser(): void {
    this.prise?.close();
  }

  private async surEvenement(type: string, e: Record<string, unknown>): Promise<void> {
    const texte = (k: string) => String(e[k] ?? '');
    switch (type) {
      case 'channel.raid':
        return diffuserEvenementTwitch(
          this.client,
          texte('to_broadcaster_user_id'),
          '⚔️ Raid entrant !',
          `**${texte('from_broadcaster_user_name')}** débarque avec **${formaterNombre(Number(e.viewers ?? 0))}** viewers !`,
          `https://twitch.tv/${texte('to_broadcaster_user_login')}`,
        );
      case 'channel.follow':
        return diffuserEvenementTwitch(this.client, texte('broadcaster_user_id'), '💜 Nouveau follow', `Merci **${texte('user_name')}** pour le follow !`, `https://twitch.tv/${texte('broadcaster_user_login')}`);
      case 'channel.subscribe':
        if (e.is_gift) return;
        return diffuserEvenementTwitch(this.client, texte('broadcaster_user_id'), '⭐ Nouvel abonnement', `**${texte('user_name')}** vient de s’abonner (tier ${Number(texte('tier')) / 1000}) !`, `https://twitch.tv/${texte('broadcaster_user_login')}`);
      case 'channel.subscription.message':
        return diffuserEvenementTwitch(
          this.client,
          texte('broadcaster_user_id'),
          '⭐ Réabonnement',
          `**${texte('user_name')}** se réabonne — **${texte('cumulative_months')} mois** !`,
          `https://twitch.tv/${texte('broadcaster_user_login')}`,
        );
      case 'channel.subscription.gift':
        return diffuserEvenementTwitch(
          this.client,
          texte('broadcaster_user_id'),
          '🎁 Abonnements offerts',
          `**${e.is_anonymous ? 'Un anonyme' : texte('user_name')}** offre **${texte('total')}** abonnement(s) !`,
          `https://twitch.tv/${texte('broadcaster_user_login')}`,
        );
    }
  }
}
