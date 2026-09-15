import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Client, type Guild, PermissionFlagsBits } from 'discord.js';
import { enHexa, enseigneDe, estProprietaireBot, libelleNiveau, lireNiveau } from './coeur/acces';
import { lireJson, lireTout } from './coeur/base';

import { CarteExpirante, creerRegistre, environnement, fuseauValide, LimiteurFenetre, Niveau } from './coeur/outils';
import { activerModule, lireConfig, lireEtatsModules, lireModule, modifierConfig, THEMES } from './coeur/reglages';
import { echapperHtml } from './modules/tickets';

export const h = echapperHtml;

export interface EntreeNavigation {
  href: string;
  libelle: string;
  icone: string;
}

export function navigationPour(serveurId: string): EntreeNavigation[] {
  const base = `/g/${serveurId}`;
  return [
    { href: base, libelle: 'Accueil', icone: '🏠' },
    { href: `${base}/modules`, libelle: 'Modules', icone: '🧩' },
    { href: `${base}/tickets`, libelle: 'Tickets', icone: '🎫' },
    { href: `${base}/giveaways`, libelle: 'Giveaways', icone: '🎉' },
    { href: `${base}/twitch`, libelle: 'Twitch', icone: '🔴' },
    { href: `${base}/moderation`, libelle: 'Modération', icone: '🛡️' },
    { href: `${base}/logs`, libelle: 'Logs', icone: '📜' },
    { href: `${base}/personnalisation`, libelle: 'Personnalisation', icone: '🎨' },
  ];
}

const STYLE = `
:root{--bg:#0e0f14;--panel:#171922;--panel2:#1f2230;--line:#2a2e3f;--text:#e8e8f0;--muted:#9a9cb0;--accent:#9146ff;--ok:#3fe08f;--ko:#e0455a;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"gg sans","Segoe UI",system-ui,Arial,sans-serif;font-size:15px}
a{color:inherit;text-decoration:none}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.04em}
.brand img{width:32px;height:32px;border-radius:50%}
.user{display:flex;align-items:center;gap:10px;color:var(--muted)}
.user img{width:28px;height:28px;border-radius:50%}
.layout{display:flex;min-height:calc(100vh - 61px)}
nav{width:220px;flex:0 0 220px;border-right:1px solid var(--line);padding:16px 10px;background:var(--panel)}
nav a{display:flex;gap:10px;padding:10px 12px;border-radius:10px;color:var(--muted);margin-bottom:2px}
nav a:hover,nav a.on{background:var(--panel2);color:var(--text)}
main{flex:1;padding:28px;max-width:1100px}
h1{font-size:24px;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.card h3{margin:0 0 6px;font-size:16px}
.muted{color:var(--muted)}
.stat{font-size:28px;font-weight:800}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}
.pill.on{background:rgba(63,224,143,.15);color:var(--ok)}.pill.off{background:rgba(224,69,90,.15);color:var(--ko)}
button,.btn{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer;font:inherit}
button.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
button.danger{background:var(--ko)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{color:var(--muted);font-weight:600;background:var(--panel2)}
input,select{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font:inherit;width:100%}
label{display:block;margin:12px 0 6px;color:var(--muted);font-size:13px}
form.inline{display:inline}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between}
.notice{background:rgba(145,70,255,.12);border:1px solid rgba(145,70,255,.35);padding:10px 14px;border-radius:10px;margin-bottom:18px}
.center{max-width:420px;margin:12vh auto;text-align:center}
.servers a.card{display:flex;align-items:center;gap:12px}
.servers img,.servers .ph{width:48px;height:48px;border-radius:14px;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-weight:800}
@media (max-width:760px){nav{display:none}main{padding:18px}}
`;

export interface OptionsPage {
  titre: string;
  enseigne: string;
  corps: string;
  utilisateur?: { username: string; avatar: string | null; id: string } | null;
  navigation?: EntreeNavigation[];
  actuel?: string;
  csrf?: string;
  accent?: string;
}

export function page(o: OptionsPage): string {
  const avatar = o.utilisateur?.avatar ? `https://cdn.discordapp.com/avatars/${o.utilisateur.id}/${o.utilisateur.avatar}.png?size=64` : null;
  const navigation = o.navigation
    ? `<nav>${o.navigation.map((n) => `<a class="${n.href === o.actuel ? 'on' : ''}" href="${h(n.href)}">${n.icone} ${h(n.libelle)}</a>`).join('')}<a href="/servers">↩️ Serveurs</a></nav>`
    : '';
  const accent = o.accent && /^#[0-9a-f]{6}$/i.test(o.accent) ? `<style>:root{--accent:${o.accent}}</style>` : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${h(o.titre)} · ${h(o.enseigne)}</title><style>${STYLE}</style>${accent}</head><body>
<div class="top"><a class="brand" href="/servers">🤖 ${h(o.enseigne)}</a>${
    o.utilisateur
      ? `<div class="user">${avatar ? `<img src="${h(avatar)}" alt=""/>` : ''}<span>${h(o.utilisateur.username)}</span><form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${h(o.csrf ?? '')}"/><button class="ghost" type="submit">Déconnexion</button></form></div>`
      : ''
  }</div>
<div class="layout">${navigation}<main>${o.corps}</main></div></body></html>`;
}

export function champCsrf(jeton: string): string {
  return `<input type="hidden" name="csrf" value="${h(jeton)}"/>`;
}

export function table(entetes: string[], rangees: string[][], vide = 'Rien à afficher.'): string {
  if (!rangees.length) return `<div class="card muted">${h(vide)}</div>`;
  return `<table><thead><tr>${entetes.map((x) => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rangees.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function date(ms: number | null | undefined): string {
  return ms ? h(new Date(ms).toLocaleString('fr-FR')) : '—';
}

const registre = creerRegistre('dashboard');

interface Session {
  id: string;
  csrf: string;
  utilisateur: { id: string; username: string; avatar: string | null };
  etat?: string;
}

const DUREE_SESSION_MS = 7 * 86_400_000;
const sessions = new CarteExpirante<string, Session>(DUREE_SESSION_MS);
const etatsEnAttente = new CarteExpirante<string, true>(10 * 60_000);
const limiteur = new LimiteurFenetre(120, 60_000);
const COOKIE_SESSION = 'tcb_session';

function signer(valeur: string): string {
  return `${valeur}.${createHmac('sha256', environnement.siteSecret).update(valeur).digest('base64url')}`;
}

function verifierSignature(signe: string): string | null {
  const i = signe.lastIndexOf('.');
  if (i < 0) return null;
  const valeur = signe.slice(0, i);
  const attendu = Buffer.from(signer(valeur));
  const donnes = Buffer.from(signe);
  return attendu.length === donnes.length && timingSafeEqual(attendu, donnes) ? valeur : null;
}

function lireCookies(conditions: IncomingMessage): Record<string, string> {
  const sortie: Record<string, string> = {};
  for (const partie of (conditions.headers.cookie ?? '').split(';')) {
    const [k, ...v] = partie.trim().split('=');
    if (k) sortie[k] = decodeURIComponent(v.join('='));
  }
  return sortie;
}

function lireSession(conditions: IncomingMessage): Session | null {
  const brut = lireCookies(conditions)[COOKIE_SESSION];
  const id = brut ? verifierSignature(brut) : null;
  return id ? (sessions.lire(id) ?? null) : null;
}

const securise = () => environnement.siteUrl.startsWith('https://');

function envoyer(reponse: ServerResponse, statut: number, corps: string, entetes: Record<string, string> = {}): void {
  reponse.writeHead(statut, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src https://cdn.discordapp.com data:; style-src 'unsafe-inline'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...entetes,
  });
  reponse.end(corps);
}

function rediriger(reponse: ServerResponse, emplacement: string, entetes: Record<string, string> = {}): void {
  reponse.writeHead(302, { Location: emplacement, ...entetes });
  reponse.end();
}

async function lireFormulaireWeb(conditions: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resoudre, rejeter) => {
    let taille = 0;
    const morceaux: Buffer[] = [];
    conditions.on('data', (c: Buffer) => {
      taille += c.length;
      if (taille > 32_000) {
        rejeter(new Error('corps trop volumineux'));
        conditions.destroy();
      } else morceaux.push(c);
    });
    conditions.on('end', () => resoudre(new URLSearchParams(Buffer.concat(morceaux).toString('utf8'))));
    conditions.on('error', rejeter);
  });
}

// - OAuth2 Discord -

const uriRedirection = () => `${environnement.siteUrl}/callback`;

async function echangerCode(code: string): Promise<{ id: string; username: string; avatar: string | null } | null> {
  const jeton = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environnement.clientId, client_secret: environnement.secretClient, grant_type: 'authorization_code', code, redirect_uri: uriRedirection() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!jeton.ok) return null;
  const { access_token } = (await jeton.json()) as { access_token: string };
  const moi = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!moi.ok) return null;
  const utilisateur = (await moi.json()) as { id: string; username: string; global_name?: string; avatar: string | null };
  return { id: utilisateur.id, username: utilisateur.global_name ?? utilisateur.username, avatar: utilisateur.avatar };
}

// - Accès -

async function serveursGerables(client: Client<true>, utilisateurId: string): Promise<Guild[]> {
  const sortie: Guild[] = [];
  for (const serveur of client.guilds.cache.values()) {
    if (estProprietaireBot(utilisateurId)) {
      sortie.push(serveur);
      continue;
    }
    const membre = serveur.members.cache.get(utilisateurId) ?? (await serveur.members.fetch(utilisateurId).catch(() => null));
    if (membre && lireNiveau(membre) >= Niveau.ADMIN) sortie.push(serveur);
  }
  return sortie;
}

async function exigerAccesServeur(client: Client<true>, session: Session, serveurId: string): Promise<{ guild: Guild; level: Niveau } | null> {
  const serveur = client.guilds.cache.get(serveurId);
  if (!serveur) return null;
  if (estProprietaireBot(session.utilisateur.id)) return { guild: serveur, level: Niveau.PROPRIETAIRE_BOT };
  const membre = serveur.members.cache.get(session.utilisateur.id) ?? (await serveur.members.fetch(session.utilisateur.id).catch(() => null));
  if (!membre) return null;
  const niveau = lireNiveau(membre);
  return niveau >= Niveau.ADMIN ? { guild: serveur, level: niveau } : null;
}

// - Pages -

function nomEnseigne(serveur?: Guild | null): string {
  if (!serveur) return process.env.BOT_BRAND_NAME?.trim() || 'Twitch Community';
  const enseigne = enseigneDe(serveur.id);
  return enseigne.cle ? enseigne.nom : serveur.name;
}

function pageServeur(session: Session, serveur: Guild, chemin: string, titre: string, corps: string): string {
  return page({ titre, enseigne: nomEnseigne(serveur), corps, utilisateur: session.utilisateur, navigation: navigationPour(serveur.id), actuel: chemin, csrf: session.csrf, accent: enHexa(enseigneDe(serveur.id).couleur) });
}

function pageAccueil(client: Client<true>, serveur: Guild, niveau: Niveau): string {
  const etats = lireEtatsModules(serveur.id).filter((s) => s.module.desactivable);
  const nombre = (requete: string) => lireTout<{ n: number }>(requete, serveur.id)[0]?.n ?? 0;
  return `<h1>🤖 ${h(nomEnseigne(serveur))}</h1><p class="sub">Serveur : <b>${h(serveur.name)}</b> · ${client.ws.ping >= 0 ? '🟢 En ligne' : '🟠 Connexion…'} · ton accès : ${h(libelleNiveau(niveau))}</p>
<div class="grid">
  <div class="card"><div class="muted">Membres</div><div class="stat">${serveur.memberCount}</div></div>
  <div class="card"><div class="muted">Modules actifs</div><div class="stat">${etats.filter((s) => s.enabled).length}/${etats.length}</div></div>
  <div class="card"><div class="muted">Tickets ouverts</div><div class="stat">${nombre("SELECT COUNT(*) AS n FROM tickets WHERE serveur_id = ? AND statut = 'open'")}</div></div>
  <div class="card"><div class="muted">Giveaways en cours</div><div class="stat">${nombre("SELECT COUNT(*) AS n FROM tirages WHERE serveur_id = ? AND statut = 'running'")}</div></div>
  <div class="card"><div class="muted">Chaînes Twitch en live</div><div class="stat">${nombre('SELECT COUNT(*) AS n FROM chaines_twitch WHERE serveur_id = ? AND live_id IS NOT NULL')}</div></div>
  <div class="card"><div class="muted">Warns actifs</div><div class="stat">${nombre('SELECT COUNT(*) AS n FROM avertissements WHERE serveur_id = ? AND actif = 1')}</div></div>
</div>
<h2 style="margin-top:28px">Modules</h2>
<div class="grid">${etats
    .slice(0, 12)
    .map((s) => `<div class="card row"><span>${s.module.emoji} ${h(s.module.nom)}</span><span class="pill ${s.enabled ? 'on' : 'off'}">${s.enabled ? '🟢 Activé' : '🔴 Désactivé'}</span></div>`)
    .join('')}</div>`;
}

function pageModules(session: Session, serveur: Guild, avertissement?: string): string {
  const etats = lireEtatsModules(serveur.id).filter((s) => s.module.desactivable);
  return `<h1>🧩 Modules</h1><p class="sub">Un module désactivé ne répond plus, sans casser les autres.</p>${avertissement ? `<div class="notice">${h(avertissement)}</div>` : ''}
<div class="grid">${etats
    .map(
      (s) => `<div class="card"><div class="row"><h3>${s.module.emoji} ${h(s.module.nom)}</h3><span class="pill ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'Activé' : 'Désactivé'}</span></div>
<p class="muted">${h(s.module.description)}</p>
<form method="post" action="/g/${serveur.id}/modules">${champCsrf(session.csrf)}<input type="hidden" name="module" value="${h(s.module.id)}"/><input type="hidden" name="enabled" value="${s.enabled ? '0' : '1'}"/>
<button class="${s.enabled ? 'danger' : ''}" type="submit">${s.enabled ? 'Désactiver' : 'Activer'}</button></form></div>`,
    )
    .join('')}</div>`;
}

function pageTickets(serveur: Guild): string {
  const rangees = lireTout<{ numero: number; salon_id: string; utilisateur_id: string; categorie: string; statut: string; pris_par: string | null; cree_le: number }>(
    'SELECT numero, salon_id, utilisateur_id, categorie, statut, pris_par, cree_le FROM tickets WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 100',
    serveur.id,
  );
  const nom = (id: string | null) => (id ? h(serveur.members.cache.get(id)?.user.tag ?? id) : '—');
  return `<h1>🎫 Tickets</h1><p class="sub">Les 100 derniers tickets.</p>${table(
    ['N°', 'Statut', 'Motif', 'Ouvert par', 'Pris en charge', 'Date'],
    rangees.map((t) => [`#${t.numero}`, t.statut === 'open' ? '<span class="pill on">ouvert</span>' : `<span class="pill off">${h(t.statut)}</span>`, h(t.categorie), nom(t.utilisateur_id), nom(t.pris_par), date(t.cree_le)]),
    'Aucun ticket.',
  )}`;
}

function pageTirages(serveur: Guild): string {
  const rangees = lireTout<{ id: number; lot: string; statut: string; nombre_gagnants: number; fin_le: number; gagnants: string }>('SELECT id, lot, statut, nombre_gagnants, fin_le, gagnants FROM tirages WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 100', serveur.id);
  const participants = (id: number) => lireTout<{ n: number }>('SELECT COUNT(*) AS n FROM participations_tirages WHERE tirage_id = ?', id)[0]?.n ?? 0;
  return `<h1>🎉 Giveaways</h1><p class="sub">Lance-les depuis Discord avec <code>/giveaway start</code>.</p>${table(
    ['#', 'Lot', 'Statut', 'Participants', 'Gagnants', 'Fin'],
    rangees.map((g) => [
      String(g.id),
      h(g.lot),
      h(g.statut),
      String(participants(g.id)),
      lireJson<string[]>(g.gagnants, []).map((w) => h(serveur.members.cache.get(w)?.user.tag ?? w)).join(', ') || `${g.nombre_gagnants} à tirer`,
      date(g.fin_le),
    ]),
    'Aucun giveaway.',
  )}`;
}

function pageTwitch(serveur: Guild): string {
  const rangees = lireTout<{ pseudo: string; nom_affiche: string | null; salon_id: string; live_id: string | null; dernier_titre: string | null; dernier_jeu: string | null; pic_spectateurs: number | null }>(
    'SELECT pseudo, nom_affiche, salon_id, live_id, dernier_titre, dernier_jeu, pic_spectateurs FROM chaines_twitch WHERE serveur_id = ? ORDER BY pseudo',
    serveur.id,
  );
  return `<h1>🔴 Twitch</h1><p class="sub">Ajoute des chaînes avec <code>/twitch add</code>.</p>${table(
    ['Chaîne', 'État', 'Salon', 'Dernier titre', 'Jeu', 'Pic'],
    rangees.map((r) => [
      `<a href="https://twitch.tv/${h(r.pseudo)}">${h(r.nom_affiche ?? r.pseudo)}</a>`,
      r.live_id ? '<span class="pill on">🔴 en live</span>' : '<span class="pill off">hors ligne</span>',
      `#${h(serveur.channels.cache.get(r.salon_id)?.name ?? '?')}`,
      h(r.dernier_titre ?? '—'),
      h(r.dernier_jeu ?? '—'),
      String(r.pic_spectateurs ?? 0),
    ]),
    'Aucune chaîne suivie.',
  )}`;
}

function pageModeration(serveur: Guild): string {
  const rangees = lireTout<{ utilisateur_id: string; moderateur_id: string; raison: string; cree_le: number; actif: number }>('SELECT utilisateur_id, moderateur_id, raison, cree_le, actif FROM avertissements WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT 100', serveur.id);
  const nom = (id: string) => h(serveur.members.cache.get(id)?.user.tag ?? serveur.client.users.cache.get(id)?.tag ?? id);
  return `<h1>🛡️ Modération</h1><p class="sub">Les 100 derniers avertissements.</p>${table(
    ['Membre', 'Raison', 'Par', 'Date', 'Actif'],
    rangees.map((w) => [nom(w.utilisateur_id), h(w.raison), nom(w.moderateur_id), date(w.cree_le), w.actif ? 'oui' : 'retiré']),
    'Aucun avertissement.',
  )}`;
}

function pageJournaux(serveur: Guild, indicePage: number): string {
  const parPage = 50;
  const rangees = lireTout<{ categorie: string; type: string; utilisateur_id: string | null; acteur_id: string | null; cree_le: number; donnees: string }>(
    'SELECT categorie, type, utilisateur_id, acteur_id, cree_le, donnees FROM journaux WHERE serveur_id = ? ORDER BY cree_le DESC LIMIT ? OFFSET ?',
    serveur.id,
    parPage,
    indicePage * parPage,
  );
  const nom = (id: string | null) => (id ? h(serveur.members.cache.get(id)?.user.tag ?? id) : '—');
  const pagination = `<p class="row">${indicePage > 0 ? `<a class="btn" href="?page=${indicePage - 1}">← Plus récents</a>` : '<span></span>'}${rangees.length === parPage ? `<a class="btn" href="?page=${indicePage + 1}">Plus anciens →</a>` : ''}</p>`;
  return `<h1>📜 Logs</h1><p class="sub">L’historique enregistré par le bot.</p>${table(
    ['Date', 'Catégorie', 'Action', 'Membre', 'Par', 'Détails'],
    rangees.map((r) => [date(r.cree_le), h(r.categorie), h(r.type), nom(r.utilisateur_id), nom(r.acteur_id), `<span class="muted">${h(r.donnees.slice(0, 160))}</span>`]),
    'Aucun log.',
  )}${pagination}`;
}

function pagePersonnalisation(session: Session, serveur: Guild, avertissement?: string): string {
  const reglages = lireConfig(serveur.id).general;
  const themes = [['brand', '🎥 Enseigne du streamer'], ...Object.entries(THEMES).map(([k, t]) => [k, `${t.emoji} ${t.label}`]), ['custom', '🖌️ Personnalisé']];
  return `<h1>🎨 Personnalisation</h1><p class="sub">Le thème des messages du bot sur ce serveur.</p>${avertissement ? `<div class="notice">${h(avertissement)}</div>` : ''}
<form class="card" method="post" action="/g/${serveur.id}/personnalisation">${champCsrf(session.csrf)}
<label>Thème</label><select name="theme">${themes.map(([v, l]) => `<option value="${h(v!)}"${reglages.theme === v ? ' selected' : ''}>${h(l!)}</option>`).join('')}</select>
<label>Couleur principale (thème personnalisé)</label><input name="primary" value="${h(reglages.colors.primary)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Succès</label><input name="success" value="${h(reglages.colors.success)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Erreur</label><input name="error" value="${h(reglages.colors.error)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Avertissement</label><input name="warning" value="${h(reglages.colors.warning)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Information</label><input name="info" value="${h(reglages.colors.info)}" pattern="#?[0-9a-fA-F]{6}"/>
<label>Pied de page (vide = enseigne)</label><input name="footer" maxlength="128" value="${h(reglages.footer)}"/>
<label>Fuseau horaire</label><input name="timezone" maxlength="64" value="${h(reglages.fuseau)}"/>
<p><button type="submit">💾 Enregistrer</button></p></form>`;
}

// - Routeur -

async function traiter(client: Client<true>, conditions: IncomingMessage, reponse: ServerResponse): Promise<void> {
  const ip = (conditions.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || conditions.socket.remoteAddress || 'inconnu';
  if (!limiteur.compter(ip)) return envoyer(reponse, 429, page({ titre: 'Trop de requêtes', enseigne: nomEnseigne(), corps: '<div class="center"><h1>⏳ Doucement</h1><p class="muted">Réessaie dans une minute.</p></div>' }));
  const url = new URL(conditions.url ?? '/', environnement.siteUrl);
  const chemin = url.pathname.replace(/\/+$/, '') || '/';
  const session = lireSession(conditions);

  if (chemin === '/health') {
    reponse.writeHead(200, { 'Content-Type': 'application/json' });
    reponse.end(JSON.stringify({ ok: true, guilds: client.guilds.cache.size, ping: client.ws.ping }));
    return;
  }

  if (chemin === '/login') {
    const etat = randomBytes(18).toString('base64url');
    etatsEnAttente.ecrire(etat, true);
    const autorisation = new URL('https://discord.com/oauth2/authorize');
    autorisation.search = new URLSearchParams({ client_id: environnement.clientId, response_type: 'code', scope: 'identify', redirect_uri: uriRedirection(), state: etat }).toString();
    return rediriger(reponse, autorisation.toString());
  }

  if (chemin === '/callback') {
    const etat = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (!code || !etatsEnAttente.possede(etat)) return envoyer(reponse, 400, page({ titre: 'Connexion refusée', enseigne: nomEnseigne(), corps: '<div class="center"><h1>❌ Connexion expirée</h1><p><a class="btn" href="/login">Réessayer</a></p></div>' }));
    etatsEnAttente.supprimer(etat);
    const utilisateur = await echangerCode(code).catch(() => null);
    if (!utilisateur) return envoyer(reponse, 400, page({ titre: 'Connexion refusée', enseigne: nomEnseigne(), corps: '<div class="center"><h1>❌ Discord a refusé la connexion</h1><p><a class="btn" href="/login">Réessayer</a></p></div>' }));
    const id = randomBytes(32).toString('base64url');
    sessions.ecrire(id, { id, csrf: randomBytes(24).toString('base64url'), utilisateur });
    registre.info(`Connexion au dashboard : ${utilisateur.username} (${utilisateur.id})`);
    return rediriger(reponse, '/servers', {
      'Set-Cookie': `${COOKIE_SESSION}=${encodeURIComponent(signer(id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DUREE_SESSION_MS / 1000}${securise() ? '; Secure' : ''}`,
    });
  }

  if (!session) {
    if (chemin === '/') {
      return envoyer(reponse, 200, page({ titre: 'Connexion', enseigne: nomEnseigne(), corps: `<div class="center card"><h1>🤖 ${h(nomEnseigne())}</h1><p class="muted">Le tableau de bord du bot. Connecte-toi avec Discord pour gérer tes serveurs.</p><p><a class="btn" href="/login">Se connecter avec Discord</a></p></div>` }));
    }
    return rediriger(reponse, '/');
  }

  if (conditions.method === 'POST') {
    const formulaire = await lireFormulaireWeb(conditions).catch(() => null);
    if (!formulaire || formulaire.get('csrf') !== session.csrf) return envoyer(reponse, 403, page({ titre: 'Refusé', enseigne: nomEnseigne(), corps: '<div class="center"><h1>🔒 Requête refusée</h1></div>' }));
    if (chemin === '/logout') {
      sessions.supprimer(session.id);
      return rediriger(reponse, '/', { 'Set-Cookie': `${COOKIE_SESSION}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${securise() ? '; Secure' : ''}` });
    }
    const m = /^\/g\/(\d{17,20})\/(modules|personnalisation)$/.exec(chemin);
    if (!m) return envoyer(reponse, 404, 'Introuvable');
    const acces = await exigerAccesServeur(client, session, m[1]!);
    if (!acces) return envoyer(reponse, 403, page({ titre: 'Refusé', enseigne: nomEnseigne(), corps: '<div class="center"><h1>🔒 Accès refusé</h1></div>', utilisateur: session.utilisateur, csrf: session.csrf }));
    if (m[2] === 'modules') {
      const module = lireModule(formulaire.get('module') ?? '');
      if (!module?.desactivable) return rediriger(reponse, `/g/${m[1]}/modules`);
      activerModule(m[1]!, module.id, formulaire.get('enabled') === '1');
      registre.info(`Dashboard : ${session.utilisateur.username} a ${formulaire.get('enabled') === '1' ? 'activé' : 'désactivé'} ${module.id} sur ${m[1]}`);
      return envoyer(reponse, 200, pageServeur(session, acces.guild, `/g/${m[1]}/modules`, 'Modules', pageModules(session, acces.guild, `${module.emoji} ${module.nom} ${formulaire.get('enabled') === '1' ? 'activé' : 'désactivé'}.`)));
    }
    const hexa = (v: string | null) => (v && /^#?[0-9a-f]{6}$/i.test(v) ? `#${v.replace('#', '').toUpperCase()}` : null);
    const theme = formulaire.get('theme') ?? 'brand';
    const fuseau = formulaire.get('timezone') ?? '';
    modifierConfig(m[1]!, (c) => {
      if (theme === 'brand' || theme === 'custom' || theme in THEMES) c.general.theme = theme as typeof c.general.theme;
      for (const k of ['primary', 'success', 'error', 'warning', 'info'] as const) {
        const v = hexa(formulaire.get(k));
        if (v) c.general.colors[k] = v;
      }
      c.general.footer = (formulaire.get('footer') ?? '').slice(0, 128);
      if (fuseauValide(fuseau)) c.general.fuseau = fuseau;
    });
    return envoyer(reponse, 200, pageServeur(session, acces.guild, `/g/${m[1]}/personnalisation`, 'Personnalisation', pagePersonnalisation(session, acces.guild, 'Enregistré.')));
  }

  if (chemin === '/' || chemin === '/servers') {
    const serveurs = await serveursGerables(client, session.utilisateur.id);
    const invitation = `https://discord.com/oauth2/authorize?client_id=${environnement.clientId}&scope=bot%20applications.commands&permissions=${PermissionFlagsBits.Administrator}`;
    const corps = `<h1>Tes serveurs</h1><p class="sub">Les serveurs où le bot est présent et où tu as un accès Admin (rôle, permission ou whitelist).</p>
<div class="grid servers">${serveurs
      .map((g) => `<a class="card" href="/g/${g.id}">${g.iconURL() ? `<img src="${h(g.iconURL({ size: 96 })!)}" alt=""/>` : `<span class="ph">${h(g.name.slice(0, 1))}</span>`}<span><b>${h(g.name)}</b><br/><span class="muted">${g.memberCount} membres</span></span></a>`)
      .join('')}</div>${serveurs.length ? '' : '<div class="card muted">Aucun serveur accessible.</div>'}<p style="margin-top:24px"><a class="btn" href="${h(invitation)}">➕ Ajouter le bot à un serveur</a></p>`;
    return envoyer(reponse, 200, page({ titre: 'Serveurs', enseigne: nomEnseigne(), corps, utilisateur: session.utilisateur, csrf: session.csrf }));
  }

  const m = /^\/g\/(\d{17,20})(?:\/(modules|tickets|giveaways|twitch|moderation|logs|personnalisation))?$/.exec(chemin);
  if (!m) return envoyer(reponse, 404, page({ titre: 'Introuvable', enseigne: nomEnseigne(), corps: '<div class="center"><h1>404</h1><p><a class="btn" href="/servers">Retour</a></p></div>', utilisateur: session.utilisateur, csrf: session.csrf }));
  const acces = await exigerAccesServeur(client, session, m[1]!);
  if (!acces) return envoyer(reponse, 403, page({ titre: 'Refusé', enseigne: nomEnseigne(), corps: '<div class="center"><h1>🔒 Accès refusé</h1><p class="muted">Il faut un accès Admin sur ce serveur.</p></div>', utilisateur: session.utilisateur, csrf: session.csrf }));
  const { guild: serveur } = acces;
  const section = m[2];
  const pages: Record<string, [string, () => string]> = {
    '': ['Accueil', () => pageAccueil(client, serveur, acces.level)],
    modules: ['Modules', () => pageModules(session, serveur)],
    tickets: ['Tickets', () => pageTickets(serveur)],
    giveaways: ['Giveaways', () => pageTirages(serveur)],
    twitch: ['Twitch', () => pageTwitch(serveur)],
    moderation: ['Modération', () => pageModeration(serveur)],
    logs: ['Logs', () => pageJournaux(serveur, Math.max(0, Number(url.searchParams.get('page')) || 0))],
    personnalisation: ['Personnalisation', () => pagePersonnalisation(session, serveur)],
  };
  const [titre, afficher] = pages[section ?? '']!;
  return envoyer(reponse, 200, pageServeur(session, serveur, chemin, titre, afficher()));
}

let serveurWeb: http.Server | null = null;

export function demarrerSite(client: Client<true>): void {
  if (serveurWeb) return;
  serveurWeb = http.createServer((conditions, reponse) => {
    traiter(client, conditions, reponse).catch((echec: unknown) => {
      registre.erreur('Erreur du dashboard', echec);
      if (!reponse.headersSent) envoyer(reponse, 500, page({ titre: 'Erreur', enseigne: nomEnseigne(), corps: '<div class="center"><h1>❌ Une erreur est survenue</h1></div>' }));
    });
  });
  serveurWeb.headersTimeout = 15_000;
  serveurWeb.requestTimeout = 20_000;
  serveurWeb.listen(environnement.sitePort, () => registre.info(`Dashboard en ligne sur ${environnement.siteUrl} (port ${environnement.sitePort})`));
}

export function arreterSite(): void {
  serveurWeb?.close();
  serveurWeb = null;
}
