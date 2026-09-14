import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { all, parseJson } from '../database/db';
import { brandFor, toHex } from '../core/brand';
import { env } from '../core/env';
import { getConfig, updateConfig } from '../core/guildConfig';
import { createLogger } from '../core/logger';
import { getModuleStates, getModule, setModuleEnabled } from '../core/moduleManager';
import { getLevel, levelLabel } from '../core/permissions';
import { SlidingWindowLimiter } from '../core/rateLimit';
import { TtlMap } from '../core/sessions';
import { THEMES } from '../core/themes';
import { isValidTimezone } from '../core/time';
import { PermLevel } from '../core/types';
import { isBotOwner } from '../core/whitelists';
import { csrfField, date, h, navFor, page, table } from './views';

const log = createLogger('dashboard');

interface Session {
  id: string;
  csrf: string;
  user: { id: string; username: string; avatar: string | null };
  state?: string;
}

const SESSION_MS = 7 * 86_400_000;
const sessions = new TtlMap<string, Session>(SESSION_MS);
const pendingStates = new TtlMap<string, true>(10 * 60_000);
const limiter = new SlidingWindowLimiter(120, 60_000);
const COOKIE = 'tcb_session';

function sign(value: string): string {
  return `${value}.${createHmac('sha256', env.dashboardSecret).update(value).digest('base64url')}`;
}

function unsign(signed: string): string | null {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signed);
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function getSession(req: IncomingMessage): Session | null {
  const raw = cookies(req)[COOKIE];
  const id = raw ? unsign(raw) : null;
  return id ? (sessions.get(id) ?? null) : null;
}

const secure = () => env.dashboardUrl.startsWith('https://');

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src https://cdn.discordapp.com data:; style-src 'unsafe-inline'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 32_000) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// ─── OAuth2 Discord ────────────────────────────────────────────────────────

const redirectUri = () => `${env.dashboardUrl}/callback`;

async function exchangeCode(code: string): Promise<{ id: string; username: string; avatar: string | null } | null> {
  const token = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!token.ok) return null;
  const { access_token } = (await token.json()) as { access_token: string };
  const me = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!me.ok) return null;
  const user = (await me.json()) as { id: string; username: string; global_name?: string; avatar: string | null };
  return { id: user.id, username: user.global_name ?? user.username, avatar: user.avatar };
}

// ─── Accès ─────────────────────────────────────────────────────────────────

async function manageableGuilds(client: Client<true>, userId: string): Promise<Guild[]> {
  const out: Guild[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (isBotOwner(userId)) {
      out.push(guild);
      continue;
    }
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (member && getLevel(member) >= PermLevel.ADMIN) out.push(guild);
  }
  return out;
}

async function requireGuildAccess(client: Client<true>, session: Session, guildId: string): Promise<{ guild: Guild; level: PermLevel } | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  if (isBotOwner(session.user.id)) return { guild, level: PermLevel.BOT_OWNER };
  const member = guild.members.cache.get(session.user.id) ?? (await guild.members.fetch(session.user.id).catch(() => null));
  if (!member) return null;
  const level = getLevel(member);
  return level >= PermLevel.ADMIN ? { guild, level } : null;
}

// ─── Pages ─────────────────────────────────────────────────────────────────

function brandName(guild?: Guild | null): string {
  if (!guild) return process.env.BOT_BRAND_NAME?.trim() || 'Twitch Community';
  const brand = brandFor(guild.id);
  return brand.key ? brand.name : guild.name;
}

function guildPage(session: Session, guild: Guild, path: string, title: string, body: string): string {
  return page({ title, brand: brandName(guild), body, user: session.user, nav: navFor(guild.id), current: path, csrf: session.csrf, accent: toHex(brandFor(guild.id).color) });
}

function homePage(client: Client<true>, guild: Guild, level: PermLevel): string {
  const states = getModuleStates(guild.id).filter((s) => s.module.toggleable);
  const count = (sql: string) => all<{ n: number }>(sql, guild.id)[0]?.n ?? 0;
  return `<h1>🤖 ${h(brandName(guild))}</h1><p class="sub">Serveur : <b>${h(guild.name)}</b> · ${client.ws.ping >= 0 ? '🟢 En ligne' : '🟠 Connexion…'} · ton accès : ${h(levelLabel(level))}</p>
<div class="grid">
  <div class="card"><div class="muted">Membres</div><div class="stat">${guild.memberCount}</div></div>
  <div class="card"><div class="muted">Modules actifs</div><div class="stat">${states.filter((s) => s.enabled).length}/${states.length}</div></div>
  <div class="card"><div class="muted">Tickets ouverts</div><div class="stat">${count("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'")}</div></div>
  <div class="card"><div class="muted">Giveaways en cours</div><div class="stat">${count("SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ? AND status = 'running'")}</div></div>
  <div class="card"><div class="muted">Chaînes Twitch en live</div><div class="stat">${count('SELECT COUNT(*) AS n FROM twitch_channels WHERE guild_id = ? AND live_stream_id IS NOT NULL')}</div></div>
  <div class="card"><div class="muted">Warns actifs</div><div class="stat">${count('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND active = 1')}</div></div>
</div>
<h2 style="margin-top:28px">Modules</h2>
<div class="grid">${states
    .slice(0, 12)
    .map((s) => `<div class="card row"><span>${s.module.emoji} ${h(s.module.name)}</span><span class="pill ${s.enabled ? 'on' : 'off'}">${s.enabled ? '🟢 Activé' : '🔴 Désactivé'}</span></div>`)
    .join('')}</div>`;
}

function modulesPage(session: Session, guild: Guild, notice?: string): string {
  const states = getModuleStates(guild.id).filter((s) => s.module.toggleable);
  return `<h1>🧩 Modules</h1><p class="sub">Un module désactivé ne répond plus, sans casser les autres.</p>${notice ? `<div class="notice">${h(notice)}</div>` : ''}
<div class="grid">${states
    .map(
      (s) => `<div class="card"><div class="row"><h3>${s.module.emoji} ${h(s.module.name)}</h3><span class="pill ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'Activé' : 'Désactivé'}</span></div>
<p class="muted">${h(s.module.description)}</p>
<form method="post" action="/g/${guild.id}/modules">${csrfField(session.csrf)}<input type="hidden" name="module" value="${h(s.module.id)}"/><input type="hidden" name="enabled" value="${s.enabled ? '0' : '1'}"/>
<button class="${s.enabled ? 'danger' : ''}" type="submit">${s.enabled ? 'Désactiver' : 'Activer'}</button></form></div>`,
    )
    .join('')}</div>`;
}

function ticketsPage(guild: Guild): string {
  const rows = all<{ number: number; channel_id: string; user_id: string; category: string; status: string; claimed_by: string | null; created_at: number }>(
    'SELECT number, channel_id, user_id, category, status, claimed_by, created_at FROM tickets WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100',
    guild.id,
  );
  const name = (id: string | null) => (id ? h(guild.members.cache.get(id)?.user.tag ?? id) : '—');
  return `<h1>🎫 Tickets</h1><p class="sub">Les 100 derniers tickets.</p>${table(
    ['N°', 'Statut', 'Motif', 'Ouvert par', 'Pris en charge', 'Date'],
    rows.map((t) => [`#${t.number}`, t.status === 'open' ? '<span class="pill on">ouvert</span>' : `<span class="pill off">${h(t.status)}</span>`, h(t.category), name(t.user_id), name(t.claimed_by), date(t.created_at)]),
    'Aucun ticket.',
  )}`;
}

function giveawaysPage(guild: Guild): string {
  const rows = all<{ id: number; prize: string; status: string; winners_count: number; ends_at: number; winners: string }>('SELECT id, prize, status, winners_count, ends_at, winners FROM giveaways WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100', guild.id);
  const participants = (id: number) => all<{ n: number }>('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?', id)[0]?.n ?? 0;
  return `<h1>🎉 Giveaways</h1><p class="sub">Lance-les depuis Discord avec <code>/giveaway start</code>.</p>${table(
    ['#', 'Lot', 'Statut', 'Participants', 'Gagnants', 'Fin'],
    rows.map((g) => [
      String(g.id),
      h(g.prize),
      h(g.status),
      String(participants(g.id)),
      parseJson<string[]>(g.winners, []).map((w) => h(guild.members.cache.get(w)?.user.tag ?? w)).join(', ') || `${g.winners_count} à tirer`,
      date(g.ends_at),
    ]),
    'Aucun giveaway.',
  )}`;
}

function twitchPage(guild: Guild): string {
  const rows = all<{ login: string; display_name: string | null; channel_id: string; live_stream_id: string | null; last_title: string | null; last_game: string | null; peak_viewers: number | null }>(
    'SELECT login, display_name, channel_id, live_stream_id, last_title, last_game, peak_viewers FROM twitch_channels WHERE guild_id = ? ORDER BY login',
    guild.id,
  );
  return `<h1>🔴 Twitch</h1><p class="sub">Ajoute des chaînes avec <code>/twitch add</code>.</p>${table(
    ['Chaîne', 'État', 'Salon', 'Dernier titre', 'Jeu', 'Pic'],
    rows.map((r) => [
      `<a href="https://twitch.tv/${h(r.login)}">${h(r.display_name ?? r.login)}</a>`,
      r.live_stream_id ? '<span class="pill on">🔴 en live</span>' : '<span class="pill off">hors ligne</span>',
      `#${h(guild.channels.cache.get(r.channel_id)?.name ?? '?')}`,
      h(r.last_title ?? '—'),
      h(r.last_game ?? '—'),
      String(r.peak_viewers ?? 0),
    ]),
    'Aucune chaîne suivie.',
  )}`;
}

function moderationPage(guild: Guild): string {
  const rows = all<{ user_id: string; moderator_id: string; reason: string; created_at: number; active: number }>('SELECT user_id, moderator_id, reason, created_at, active FROM warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100', guild.id);
  const name = (id: string) => h(guild.members.cache.get(id)?.user.tag ?? guild.client.users.cache.get(id)?.tag ?? id);
  return `<h1>🛡️ Modération</h1><p class="sub">Les 100 derniers avertissements.</p>${table(
    ['Membre', 'Raison', 'Par', 'Date', 'Actif'],
    rows.map((w) => [name(w.user_id), h(w.reason), name(w.moderator_id), date(w.created_at), w.active ? 'oui' : 'retiré']),
    'Aucun avertissement.',
  )}`;
}

function logsPage(guild: Guild, pageIndex: number): string {
  const per = 50;
  const rows = all<{ category: string; type: string; user_id: string | null; actor_id: string | null; created_at: number; data: string }>(
    'SELECT category, type, user_id, actor_id, created_at, data FROM logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    guild.id,
    per,
    pageIndex * per,
  );
  const name = (id: string | null) => (id ? h(guild.members.cache.get(id)?.user.tag ?? id) : '—');
  const pager = `<p class="row">${pageIndex > 0 ? `<a class="btn" href="?page=${pageIndex - 1}">← Plus récents</a>` : '<span></span>'}${rows.length === per ? `<a class="btn" href="?page=${pageIndex + 1}">Plus anciens →</a>` : ''}</p>`;
  return `<h1>📜 Logs</h1><p class="sub">L’historique enregistré par le bot.</p>${table(
    ['Date', 'Catégorie', 'Action', 'Membre', 'Par', 'Détails'],
    rows.map((r) => [date(r.created_at), h(r.category), h(r.type), name(r.user_id), name(r.actor_id), `<span class="muted">${h(r.data.slice(0, 160))}</span>`]),
    'Aucun log.',
  )}${pager}`;
}

function customizationPage(session: Session, guild: Guild, notice?: string): string {
  const cfg = getConfig(guild.id).general;
  const themes = [['brand', '🎥 Enseigne du streamer'], ...Object.entries(THEMES).map(([k, t]) => [k, `${t.emoji} ${t.label}`]), ['custom', '🖌️ Personnalisé']];
  return `<h1>🎨 Personnalisation</h1><p class="sub">Le thème des messages du bot sur ce serveur.</p>${notice ? `<div class="notice">${h(notice)}</div>` : ''}
<form class="card" method="post" action="/g/${guild.id}/personnalisation">${csrfField(session.csrf)}
<label>Thème</label><select name="theme">${themes.map(([v, l]) => `<option value="${h(v!)}"${cfg.theme === v ? ' selected' : ''}>${h(l!)}</option>`).join('')}</select>
<label>Couleur principale (thème personnalisé)</label><input name="primary" value="${h(cfg.colors.primary)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Succès</label><input name="success" value="${h(cfg.colors.success)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Erreur</label><input name="error" value="${h(cfg.colors.error)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Avertissement</label><input name="warning" value="${h(cfg.colors.warning)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Information</label><input name="info" value="${h(cfg.colors.info)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Pied de page (vide = enseigne)</label><input name="footer" maxlength="128" value="${h(cfg.footer)}"/>
<label>Fuseau horaire</label><input name="timezone" maxlength="64" value="${h(cfg.timezone)}"/>
<p><button type="submit">💾 Enregistrer</button></p></form>`;
}

// ─── Routeur ───────────────────────────────────────────────────────────────

async function handle(client: Client<true>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'inconnu';
  if (!limiter.hit(ip)) return send(res, 429, page({ title: 'Trop de requêtes', brand: brandName(), body: '<div class="center"><h1>⏳ Doucement</h1><p class="muted">Réessaie dans une minute.</p></div>' }));
  const url = new URL(req.url ?? '/', env.dashboardUrl);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const session = getSession(req);

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, guilds: client.guilds.cache.size, ping: client.ws.ping }));
    return;
  }

  if (path === '/login') {
    const state = randomBytes(18).toString('base64url');
    pendingStates.set(state, true);
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.search = new URLSearchParams({ client_id: env.clientId, response_type: 'code', scope: 'identify', redirect_uri: redirectUri(), state }).toString();
    return redirect(res, auth.toString());
  }

  if (path === '/callback') {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (!code || !pendingStates.has(state)) return send(res, 400, page({ title: 'Connexion refusée', brand: brandName(), body: '<div class="center"><h1>❌ Connexion expirée</h1><p><a class="btn" href="/login">Réessayer</a></p></div>' }));
    pendingStates.delete(state);
    const user = await exchangeCode(code).catch(() => null);
    if (!user) return send(res, 400, page({ title: 'Connexion refusée', brand: brandName(), body: '<div class="center"><h1>❌ Discord a refusé la connexion</h1><p><a class="btn" href="/login">Réessayer</a></p></div>' }));
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { id, csrf: randomBytes(24).toString('base64url'), user });
    log.info(`Connexion au dashboard : ${user.username} (${user.id})`);
    return redirect(res, '/servers', {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(sign(id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure() ? '; Secure' : ''}`,
    });
  }

  if (!session) {
    if (path === '/') {
      return send(res, 200, page({ title: 'Connexion', brand: brandName(), body: `<div class="center card"><h1>🤖 ${h(brandName())}</h1><p class="muted">Le tableau de bord du bot. Connecte-toi avec Discord pour gérer tes serveurs.</p><p><a class="btn" href="/login">Se connecter avec Discord</a></p></div>` }));
    }
    return redirect(res, '/');
  }

  if (req.method === 'POST') {
    const form = await readForm(req).catch(() => null);
    if (!form || form.get('csrf') !== session.csrf) return send(res, 403, page({ title: 'Refusé', brand: brandName(), body: '<div class="center"><h1>🔒 Requête refusée</h1></div>' }));
    if (path === '/logout') {
      sessions.delete(session.id);
      return redirect(res, '/', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure() ? '; Secure' : ''}` });
    }
    const m = /^\/g\/(\d{17,20})\/(modules|personnalisation)$/.exec(path);
    if (!m) return send(res, 404, 'Introuvable');
    const access = await requireGuildAccess(client, session, m[1]!);
    if (!access) return send(res, 403, page({ title: 'Refusé', brand: brandName(), body: '<div class="center"><h1>🔒 Accès refusé</h1></div>', user: session.user, csrf: session.csrf }));
    if (m[2] === 'modules') {
      const mod = getModule(form.get('module') ?? '');
      if (!mod?.toggleable) return redirect(res, `/g/${m[1]}/modules`);
      setModuleEnabled(m[1]!, mod.id, form.get('enabled') === '1');
      log.info(`Dashboard : ${session.user.username} a ${form.get('enabled') === '1' ? 'activé' : 'désactivé'} ${mod.id} sur ${m[1]}`);
      return send(res, 200, guildPage(session, access.guild, `/g/${m[1]}/modules`, 'Modules', modulesPage(session, access.guild, `${mod.emoji} ${mod.name} ${form.get('enabled') === '1' ? 'activé' : 'désactivé'}.`)));
    }
    const hex = (v: string | null) => (v && /^#?[0-9a-f]{6}$/i.test(v) ? `#${v.replace('#', '').toUpperCase()}` : null);
    const theme = form.get('theme') ?? 'brand';
    const timezone = form.get('timezone') ?? '';
    updateConfig(m[1]!, (c) => {
      if (theme === 'brand' || theme === 'custom' || theme in THEMES) c.general.theme = theme as typeof c.general.theme;
      for (const k of ['primary', 'success', 'error', 'warning', 'info'] as const) {
        const v = hex(form.get(k));
        if (v) c.general.colors[k] = v;
      }
      c.general.footer = (form.get('footer') ?? '').slice(0, 128);
      if (isValidTimezone(timezone)) c.general.timezone = timezone;
    });
    return send(res, 200, guildPage(session, access.guild, `/g/${m[1]}/personnalisation`, 'Personnalisation', customizationPage(session, access.guild, 'Enregistré.')));
  }

  if (path === '/' || path === '/servers') {
    const guilds = await manageableGuilds(client, session.user.id);
    const invite = `https://discord.com/oauth2/authorize?client_id=${env.clientId}&scope=bot%20applications.commands&permissions=${PermissionFlagsBits.Administrator}`;
    const body = `<h1>Tes serveurs</h1><p class="sub">Les serveurs où le bot est présent et où tu as un accès Admin (rôle, permission ou whitelist).</p>
<div class="grid servers">${guilds
      .map((g) => `<a class="card" href="/g/${g.id}">${g.iconURL() ? `<img src="${h(g.iconURL({ size: 96 })!)}" alt=""/>` : `<span class="ph">${h(g.name.slice(0, 1))}</span>`}<span><b>${h(g.name)}</b><br/><span class="muted">${g.memberCount} membres</span></span></a>`)
      .join('')}</div>${guilds.length ? '' : '<div class="card muted">Aucun serveur accessible.</div>'}<p style="margin-top:24px"><a class="btn" href="${h(invite)}">➕ Ajouter le bot à un serveur</a></p>`;
    return send(res, 200, page({ title: 'Serveurs', brand: brandName(), body, user: session.user, csrf: session.csrf }));
  }

  const m = /^\/g\/(\d{17,20})(?:\/(modules|tickets|giveaways|twitch|moderation|logs|personnalisation))?$/.exec(path);
  if (!m) return send(res, 404, page({ title: 'Introuvable', brand: brandName(), body: '<div class="center"><h1>404</h1><p><a class="btn" href="/servers">Retour</a></p></div>', user: session.user, csrf: session.csrf }));
  const access = await requireGuildAccess(client, session, m[1]!);
  if (!access) return send(res, 403, page({ title: 'Refusé', brand: brandName(), body: '<div class="center"><h1>🔒 Accès refusé</h1><p class="muted">Il faut un accès Admin sur ce serveur.</p></div>', user: session.user, csrf: session.csrf }));
  const { guild } = access;
  const section = m[2];
  const pages: Record<string, [string, () => string]> = {
    '': ['Accueil', () => homePage(client, guild, access.level)],
    modules: ['Modules', () => modulesPage(session, guild)],
    tickets: ['Tickets', () => ticketsPage(guild)],
    giveaways: ['Giveaways', () => giveawaysPage(guild)],
    twitch: ['Twitch', () => twitchPage(guild)],
    moderation: ['Modération', () => moderationPage(guild)],
    logs: ['Logs', () => logsPage(guild, Math.max(0, Number(url.searchParams.get('page')) || 0))],
    personnalisation: ['Personnalisation', () => customizationPage(session, guild)],
  };
  const [title, render] = pages[section ?? '']!;
  return send(res, 200, guildPage(session, guild, path, title, render()));
}

let server: http.Server | null = null;

export function startDashboard(client: Client<true>): void {
  if (server) return;
  server = http.createServer((req, res) => {
    handle(client, req, res).catch((err: unknown) => {
      log.error('Erreur du dashboard', err);
      if (!res.headersSent) send(res, 500, page({ title: 'Erreur', brand: brandName(), body: '<div class="center"><h1>❌ Une erreur est survenue</h1></div>' }));
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;
  server.listen(env.dashboardPort, () => log.info(`Dashboard en ligne sur ${env.dashboardUrl} (port ${env.dashboardPort})`));
}

export function stopDashboard(): void {
  server?.close();
  server = null;
}
