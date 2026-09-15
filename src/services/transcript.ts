import type { Collection, Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { enseigneDe, enHexa } from '../core/brand';

export function echapperHtml(texte: string): string {
  return texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Récupère tout l'historique d'un salon (du plus ancien au plus récent), plafonné. */
export async function recupererMessages(salon: GuildTextBasedChannel, max = 5000): Promise<Message[]> {
  const recuperes: Message[] = [];
  let avant: string | undefined;
  while (recuperes.length < max) {
    const lot: Collection<string, Message> | null = await salon.messages.fetch({ limit: 100, before: avant }).catch(() => null);
    if (!lot || lot.size === 0) break;
    recuperes.push(...lot.values());
    avant = lot.last()!.id;
    if (lot.size < 100) break;
  }
  return recuperes.reverse();
}

/** Remplace mentions et émojis Discord par du HTML lisible (le texte est déjà échappé). */
function rendreContenu(echappe: string, serveur: Guild): string {
  return echappe
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;a?:(\w{2,32}):(\d{15,25})&gt;/g, (_m, nom: string, id: string) => `<img class="emo" src="https://cdn.discordapp.com/emojis/${id}.webp?size=44&amp;animated=true" alt=":${nom}:" title=":${nom}:" loading="lazy"/>`)
    .replace(/&lt;@!?(\d{15,25})&gt;/g, (_m, id: string) => {
      const membre = serveur.members.cache.get(id);
      const nom = membre?.displayName ?? serveur.client.users.cache.get(id)?.username ?? id;
      return `<span class="mention">@${echapperHtml(nom)}</span>`;
    })
    .replace(/&lt;@&amp;(\d{15,25})&gt;/g, (_m, id: string) => {
      const role = serveur.roles.cache.get(id);
      if (!role) return '<span class="mention">@rôle</span>';
      const couleur = role.hexColor !== '#000000' ? role.hexColor : '#a68cff';
      return `<span class="mention role" style="color:${couleur};background:${couleur}22;border:1px solid ${couleur}55">@${echapperHtml(role.name)}</span>`;
    })
    .replace(/&lt;#(\d{15,25})&gt;/g, (_m, id: string) => `<span class="mention salon">#${echapperHtml(serveur.channels.cache.get(id)?.name ?? 'salon')}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function rendreMessage(m: Message, serveur: Guild): string {
  const heure = new Date(m.createdTimestamp).toLocaleString('fr-FR');
  const auteur = echapperHtml(m.member?.displayName ?? m.author.globalName ?? m.author.username);
  const avatar = echapperHtml(m.author.displayAvatarURL({ size: 64 }));
  const bot = m.author.bot ? '<span class="tag-bot">BOT</span>' : '';
  const textes: string[] = [];
  if (m.content) textes.push(rendreContenu(echapperHtml(m.content), serveur));
  for (const embed of m.embeds) {
    const parties = [embed.title ? `<b>${echapperHtml(embed.title)}</b>` : '', embed.description ? rendreContenu(echapperHtml(embed.description), serveur) : ''];
    for (const f of embed.fields) parties.push(`<b>${echapperHtml(f.name)}</b><br/>${rendreContenu(echapperHtml(f.value), serveur)}`);
    const couleur = embed.hexColor ?? '#7b5cff';
    textes.push(`<div class="embed" style="border-left-color:${couleur}">${parties.filter(Boolean).join('<br/>')}</div>`);
  }
  const attachments = [...m.attachments.values()]
    .map((a) => {
      const url = echapperHtml(a.url);
      const nom = echapperHtml(a.name || 'fichier');
      return /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
        ? `<a class="att-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${nom}" loading="lazy"/></a>`
        : `<a class="att-file" href="${url}" target="_blank" rel="noopener">📎 ${nom}</a>`;
    })
    .join('');
  return `<div class="msg"><img class="avatar" src="${avatar}" alt="" loading="lazy"/><div class="corps"><div class="tete"><span class="auteur">${auteur}</span>${bot}<span class="heure">${heure}</span></div>${textes.map((t) => `<div class="texte">${t}</div>`).join('')}${attachments ? `<div class="pjs">${attachments}</div>` : ''}</div></div>`;
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

export interface OptionsTranscript {
  titre?: string;
  sousTitre?: string;
}

/** Transcript HTML autonome, aux couleurs de l'enseigne (repris du bot Airline). */
export function construireTranscript(salon: GuildTextBasedChannel, messages: Message[], options: OptionsTranscript = {}): string {
  const serveur = salon.guild;
  const enseigne = enseigneDe(serveur.id);
  const accent = enHexa(enseigne.couleur);
  const nom = echapperHtml(enseigne.cle ? enseigne.nom : serveur.name);
  const logo = enseigne.logo ?? serveur.iconURL({ size: 64 });
  const corps = messages.length ? messages.map((m) => rendreMessage(m, serveur)).join('\n') : '<div class="vide">Aucun message.</div>';
  const titre = echapperHtml(options.titre ?? `Transcript — ${salon.name}`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${titre}</title><style>${style(accent)}</style></head><body>
<div class="wrap">
  <div class="entete">
    <div class="marque">${logo ? `<img class="logo" src="${echapperHtml(logo)}" alt=""/>` : ''}<div class="titre">${nom}</div></div>
    <div class="salon"># ${echapperHtml(salon.name)}</div>
    <div class="meta">${messages.length} message${messages.length > 1 ? 's' : ''} · transcript généré le ${new Date().toLocaleString('fr-FR')}</div>
    ${options.sousTitre ? `<div class="meta">${echapperHtml(options.sousTitre)}</div>` : ''}
  </div>
  ${corps}
</div>
</body></html>`;
}
