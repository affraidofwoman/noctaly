import { escapeHtml } from '../services/transcript';

export const h = escapeHtml;

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export function navFor(guildId: string): NavItem[] {
  const base = `/g/${guildId}`;
  return [
    { href: base, label: 'Accueil', icon: '🏠' },
    { href: `${base}/modules`, label: 'Modules', icon: '🧩' },
    { href: `${base}/tickets`, label: 'Tickets', icon: '🎫' },
    { href: `${base}/giveaways`, label: 'Giveaways', icon: '🎉' },
    { href: `${base}/twitch`, label: 'Twitch', icon: '🔴' },
    { href: `${base}/moderation`, label: 'Modération', icon: '🛡️' },
    { href: `${base}/logs`, label: 'Logs', icon: '📜' },
    { href: `${base}/personnalisation`, label: 'Personnalisation', icon: '🎨' },
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

export interface PageOptions {
  title: string;
  brand: string;
  body: string;
  user?: { username: string; avatar: string | null; id: string } | null;
  nav?: NavItem[];
  current?: string;
  csrf?: string;
  accent?: string;
}

export function page(o: PageOptions): string {
  const avatar = o.user?.avatar ? `https://cdn.discordapp.com/avatars/${o.user.id}/${o.user.avatar}.png?size=64` : null;
  const nav = o.nav
    ? `<nav>${o.nav.map((n) => `<a class="${n.href === o.current ? 'on' : ''}" href="${h(n.href)}">${n.icon} ${h(n.label)}</a>`).join('')}<a href="/servers">↩️ Serveurs</a></nav>`
    : '';
  const accent = o.accent && /^#[0-9a-f]{6}$/i.test(o.accent) ? `<style>:root{--accent:${o.accent}}</style>` : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${h(o.title)} · ${h(o.brand)}</title><style>${STYLE}</style>${accent}</head><body>
<div class="top"><a class="brand" href="/servers">🤖 ${h(o.brand)}</a>${
    o.user
      ? `<div class="user">${avatar ? `<img src="${h(avatar)}" alt=""/>` : ''}<span>${h(o.user.username)}</span><form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${h(o.csrf ?? '')}"/><button class="ghost" type="submit">Déconnexion</button></form></div>`
      : ''
  }</div>
<div class="layout">${nav}<main>${o.body}</main></div></body></html>`;
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${h(token)}"/>`;
}

export function table(headers: string[], rows: string[][], empty = 'Rien à afficher.'): string {
  if (!rows.length) return `<div class="card muted">${h(empty)}</div>`;
  return `<table><thead><tr>${headers.map((x) => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function date(ms: number | null | undefined): string {
  return ms ? h(new Date(ms).toLocaleString('fr-FR')) : '—';
}
