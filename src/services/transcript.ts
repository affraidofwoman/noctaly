import type { Collection, Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { brandFor, toHex } from '../core/brand';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Récupère tout l'historique d'un salon (du plus ancien au plus récent), plafonné. */
export async function fetchAllMessages(channel: GuildTextBasedChannel, max = 5000): Promise<Message[]> {
  const collected: Message[] = [];
  let before: string | undefined;
  while (collected.length < max) {
    const batch: Collection<string, Message> | null = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    collected.push(...batch.values());
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return collected.reverse();
}

/** Remplace mentions et émojis Discord par du HTML lisible (le texte est déjà échappé). */
function renderContent(escaped: string, guild: Guild): string {
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;a?:(\w{2,32}):(\d{15,25})&gt;/g, (_m, name: string, id: string) => `<img class="emo" src="https://cdn.discordapp.com/emojis/${id}.webp?size=44&amp;animated=true" alt=":${name}:" title=":${name}:" loading="lazy"/>`)
    .replace(/&lt;@!?(\d{15,25})&gt;/g, (_m, id: string) => {
      const member = guild.members.cache.get(id);
      const name = member?.displayName ?? guild.client.users.cache.get(id)?.username ?? id;
      return `<span class="mention">@${escapeHtml(name)}</span>`;
    })
    .replace(/&lt;@&amp;(\d{15,25})&gt;/g, (_m, id: string) => {
      const role = guild.roles.cache.get(id);
      if (!role) return '<span class="mention">@rôle</span>';
      const color = role.hexColor !== '#000000' ? role.hexColor : '#a68cff';
      return `<span class="mention role" style="color:${color};background:${color}22;border:1px solid ${color}55">@${escapeHtml(role.name)}</span>`;
    })
    .replace(/&lt;#(\d{15,25})&gt;/g, (_m, id: string) => `<span class="mention salon">#${escapeHtml(guild.channels.cache.get(id)?.name ?? 'salon')}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function renderMessage(m: Message, guild: Guild): string {
  const time = new Date(m.createdTimestamp).toLocaleString('fr-FR');
  const author = escapeHtml(m.member?.displayName ?? m.author.globalName ?? m.author.username);
  const avatar = escapeHtml(m.author.displayAvatarURL({ size: 64 }));
  const bot = m.author.bot ? '<span class="tag-bot">BOT</span>' : '';
  const texts: string[] = [];
  if (m.content) texts.push(renderContent(escapeHtml(m.content), guild));
  for (const embed of m.embeds) {
    const parts = [embed.title ? `<b>${escapeHtml(embed.title)}</b>` : '', embed.description ? renderContent(escapeHtml(embed.description), guild) : ''];
    for (const f of embed.fields) parts.push(`<b>${escapeHtml(f.name)}</b><br/>${renderContent(escapeHtml(f.value), guild)}`);
    const color = embed.hexColor ?? '#7b5cff';
    texts.push(`<div class="embed" style="border-left-color:${color}">${parts.filter(Boolean).join('<br/>')}</div>`);
  }
  const attachments = [...m.attachments.values()]
    .map((a) => {
      const url = escapeHtml(a.url);
      const name = escapeHtml(a.name || 'fichier');
      return /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
        ? `<a class="att-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}" loading="lazy"/></a>`
        : `<a class="att-file" href="${url}" target="_blank" rel="noopener">📎 ${name}</a>`;
    })
    .join('');
  return `<div class="msg"><img class="avatar" src="${avatar}" alt="" loading="lazy"/><div class="corps"><div class="tete"><span class="auteur">${author}</span>${bot}<span class="heure">${time}</span></div>${texts.map((t) => `<div class="texte">${t}</div>`).join('')}${attachments ? `<div class="pjs">${attachments}</div>` : ''}</div></div>`;
}

function style(accent: string): string {
  return `
:root{--neon:${accent};--void:#07080d;--panneau:#0e1018;--bord:#241b4d;--texte:#e7e6f5;--doux:#9a97c0;--cyan:#46c8ff;}
*{box-sizing:border-box;}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#14122b 0%,var(--void) 60%) fixed;color:var(--texte);font-family:"gg sans","Segoe UI",system-ui,Arial,sans-serif;}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 64px;}
.entete{border:1px solid var(--bord);border-radius:16px;padding:20px 24px;background:linear-gradient(180deg,${accent}1a,${accent}00);box-shadow:0 0 40px ${accent}26;margin-bottom:20px;}
.marque{display:flex;align-items:center;gap:12px;}
.logo{width:36px;height:36px;border-radius:10px;object-fit:cover;}
.titre{font-size:19px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;}
.salon{margin-top:12px;font-size:15px;color:var(--neon);font-weight:700;}
.meta{margin-top:3px;font-size:12.5px;color:var(--doux);}
.msg{display:flex;gap:12px;padding:11px 10px;border-radius:12px;}
.msg:hover{background:${accent}0d;}
.avatar{width:40px;height:40px;border-radius:50%;flex:0 0 auto;border:1px solid var(--bord);object-fit:cover;}
.corps{min-width:0;flex:1;}
.tete{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.auteur{font-weight:700;color:#fff;}
.tag-bot{font-size:10px;font-weight:800;background:var(--neon);color:#fff;padding:1px 5px;border-radius:4px;}
.heure{font-size:11.5px;color:var(--doux);}
.texte{margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;}
.texte a{color:var(--cyan);text-decoration:none;}
.embed{border-left:4px solid var(--neon);background:var(--panneau);padding:8px 12px;border-radius:6px;margin-top:4px;}
.emo{width:1.35em;height:1.35em;vertical-align:-.28em;object-fit:contain;}
.mention{background:${accent}29;color:#fff;border-radius:4px;padding:0 3px;font-weight:600;}
.mention.salon{background:rgba(70,200,255,.13);color:var(--cyan);}
.pjs{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;}
.att-img img{max-width:260px;max-height:220px;border-radius:10px;border:1px solid var(--bord);display:block;}
.att-file{display:inline-block;padding:8px 12px;border:1px solid var(--bord);border-left:3px solid var(--neon);border-radius:8px;color:#fff;text-decoration:none;font-size:13px;background:var(--panneau);}
.vide{text-align:center;color:var(--doux);padding:48px 0;}
`;
}

export interface TranscriptOptions {
  title?: string;
  subtitle?: string;
}

/** Transcript HTML autonome, aux couleurs de l'enseigne (repris du bot Airline). */
export function buildTranscriptHtml(channel: GuildTextBasedChannel, messages: Message[], options: TranscriptOptions = {}): string {
  const guild = channel.guild;
  const brand = brandFor(guild.id);
  const accent = toHex(brand.color);
  const name = escapeHtml(brand.key ? brand.name : guild.name);
  const logo = brand.logo ?? guild.iconURL({ size: 64 });
  const body = messages.length ? messages.map((m) => renderMessage(m, guild)).join('\n') : '<div class="vide">Aucun message.</div>';
  const title = escapeHtml(options.title ?? `Transcript — ${channel.name}`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title}</title><style>${style(accent)}</style></head><body>
<div class="wrap">
  <div class="entete">
    <div class="marque">${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt=""/>` : ''}<div class="titre">${name}</div></div>
    <div class="salon"># ${escapeHtml(channel.name)}</div>
    <div class="meta">${messages.length} message${messages.length > 1 ? 's' : ''} · transcript généré le ${new Date().toLocaleString('fr-FR')}</div>
    ${options.subtitle ? `<div class="meta">${escapeHtml(options.subtitle)}</div>` : ''}
  </div>
  ${body}
</div>
</body></html>`;
}
