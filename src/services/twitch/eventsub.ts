import type { Client } from 'discord.js';
import { env } from '../../core/env';
import { createLogger } from '../../core/logger';
import { formatNumber } from '../../core/text';
import { loadUserToken, refreshUserToken, validateUserToken, type UserToken } from './api';
import { dispatchTwitchEvent, listChannels } from './notifier';

const log = createLogger('eventsub');

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
export class EventSubClient {
  private socket: WebSocket | null = null;
  private token: UserToken | null = loadUserToken();
  private tokenUser: { user_id: string; login: string; scopes: string[] } | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 5_000;
  private stopped = false;
  private subscribed = new Set<string>();

  constructor(private readonly client: Client<true>) {}

  get enabled(): boolean {
    return !!this.token && !!env.twitchClientId;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    this.tokenUser = await validateUserToken(this.token!);
    if (!this.tokenUser) {
      const refreshed = await refreshUserToken(this.token!).catch(() => null);
      if (refreshed) {
        this.token = refreshed;
        this.tokenUser = await validateUserToken(refreshed);
      }
    }
    if (!this.tokenUser) {
      log.warn('TWITCH_USER_TOKEN invalide ou expiré : EventSub (raids, follows, subs) désactivé.');
      return;
    }
    log.info(`EventSub connecté au compte Twitch ${this.tokenUser.login}.`);
    this.connect('wss://eventsub.wss.twitch.tv/ws');
  }

  stop(): void {
    this.stopped = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.socket?.close();
  }

  private connect(url: string): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      void this.onMessage(String(event.data)).catch((err: unknown) => log.warn(`Message EventSub en échec : ${(err as Error).message}`));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return;
      this.subscribed.clear();
      log.warn(`EventSub déconnecté, reconnexion dans ${this.reconnectDelay / 1000} s`);
      setTimeout(() => this.connect('wss://eventsub.wss.twitch.tv/ws'), this.reconnectDelay).unref();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 300_000);
    });
    socket.addEventListener('error', () => undefined);
  }

  private armKeepalive(seconds: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => this.socket?.close(), (seconds + 10) * 1000);
    this.keepaliveTimer.unref();
  }

  private async onMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as WsMessage;
    const type = msg.metadata.message_type;
    if (msg.payload.session?.keepalive_timeout_seconds) this.armKeepalive(msg.payload.session.keepalive_timeout_seconds);
    else if (type === 'session_keepalive' || type === 'notification') this.armKeepalive(30);

    if (type === 'session_welcome' && msg.payload.session) {
      this.reconnectDelay = 5_000;
      await this.subscribeAll(msg.payload.session.id);
    } else if (type === 'session_reconnect' && msg.payload.session?.reconnect_url) {
      const old = this.socket;
      this.connect(msg.payload.session.reconnect_url);
      setTimeout(() => old?.close(), 5_000).unref();
    } else if (type === 'notification' && msg.payload.subscription && msg.payload.event) {
      await this.onEvent(msg.payload.subscription.type, msg.payload.event);
    }
  }

  private async createSubscription(sessionId: string, type: string, version: string, condition: Record<string, string>): Promise<void> {
    const key = `${type}:${JSON.stringify(condition)}`;
    if (this.subscribed.has(key)) return;
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'Client-Id': env.twitchClientId, Authorization: `Bearer ${this.token!.access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      const refreshed = await refreshUserToken(this.token!).catch(() => null);
      if (refreshed) this.token = refreshed;
      return;
    }
    if (res.ok || res.status === 409) this.subscribed.add(key);
    else log.debug(`Abonnement EventSub ${type} refusé (HTTP ${res.status})`);
  }

  private async subscribeAll(sessionId: string): Promise<void> {
    const me = this.tokenUser!;
    const broadcasters = [...new Set(listChannels().filter((c) => c.notify_events && c.broadcaster_id).map((c) => c.broadcaster_id!))];
    for (const id of broadcasters.slice(0, 250)) {
      await this.createSubscription(sessionId, 'channel.raid', '1', { to_broadcaster_user_id: id });
    }
    if (broadcasters.includes(me.user_id)) {
      if (me.scopes.includes('moderator:read:followers')) await this.createSubscription(sessionId, 'channel.follow', '2', { broadcaster_user_id: me.user_id, moderator_user_id: me.user_id });
      if (me.scopes.includes('channel:read:subscriptions')) {
        await this.createSubscription(sessionId, 'channel.subscribe', '1', { broadcaster_user_id: me.user_id });
        await this.createSubscription(sessionId, 'channel.subscription.gift', '1', { broadcaster_user_id: me.user_id });
        await this.createSubscription(sessionId, 'channel.subscription.message', '1', { broadcaster_user_id: me.user_id });
      }
    }
  }

  /** À appeler quand une chaîne est ajoutée : réabonne sans attendre une reconnexion. */
  resync(): void {
    this.socket?.close();
  }

  private async onEvent(type: string, e: Record<string, unknown>): Promise<void> {
    const str = (k: string) => String(e[k] ?? '');
    switch (type) {
      case 'channel.raid':
        return dispatchTwitchEvent(
          this.client,
          str('to_broadcaster_user_id'),
          '⚔️ Raid entrant !',
          `**${str('from_broadcaster_user_name')}** débarque avec **${formatNumber(Number(e.viewers ?? 0))}** viewers !`,
          `https://twitch.tv/${str('to_broadcaster_user_login')}`,
        );
      case 'channel.follow':
        return dispatchTwitchEvent(this.client, str('broadcaster_user_id'), '💜 Nouveau follow', `Merci **${str('user_name')}** pour le follow !`, `https://twitch.tv/${str('broadcaster_user_login')}`);
      case 'channel.subscribe':
        if (e.is_gift) return;
        return dispatchTwitchEvent(this.client, str('broadcaster_user_id'), '⭐ Nouvel abonnement', `**${str('user_name')}** vient de s’abonner (tier ${Number(str('tier')) / 1000}) !`, `https://twitch.tv/${str('broadcaster_user_login')}`);
      case 'channel.subscription.message':
        return dispatchTwitchEvent(
          this.client,
          str('broadcaster_user_id'),
          '⭐ Réabonnement',
          `**${str('user_name')}** se réabonne — **${str('cumulative_months')} mois** !`,
          `https://twitch.tv/${str('broadcaster_user_login')}`,
        );
      case 'channel.subscription.gift':
        return dispatchTwitchEvent(
          this.client,
          str('broadcaster_user_id'),
          '🎁 Abonnements offerts',
          `**${e.is_anonymous ? 'Un anonyme' : str('user_name')}** offre **${str('total')}** abonnement(s) !`,
          `https://twitch.tv/${str('broadcaster_user_login')}`,
        );
    }
  }
}
