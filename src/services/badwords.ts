/**
 * Filtre de mots interdits repris du bot Airline : résiste aux substitutions (0→o, 3→e, @→a…),
 * aux séparateurs (n.e.g.r.e) et aux lettres répétées, sans toucher aux mots sûrs (violet, violon…).
 */

export const MOTS_DEFAUT = [
  'negre', 'negro', 'nigger', 'nigga', 'bougnoule', 'bicot', 'youpin', 'chintok', 'niakoue',
  'nazi', 'heilhitler', 'siegheil',
  'pede', 'tapette', 'tarlouze', 'faggot',
  'pedophile', 'pedo', 'zoophile',
  'pute', 'salope', 'connasse',
];

export const MOTS_SURS = [
  'violet', 'violette', 'violon', 'violoncelle', 'violoniste',
  'violence', 'violent', 'violente', 'violemment', 'violace',
  'negroni', 'computer', 'reputation', 'deputes', 'depute',
  'pedestre', 'pedopsychiatre', 'pedopsychiatrie', 'pedologie', 'pedoncule', 'pedale', 'pedagogie', 'pedagogique',
];

const SOSIES: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', ')': 'c', '[': 'c', '{': 'c', '<': 'c',
  '£': 'l', '€': 'e', '¥': 'y', '°': 'o', 'µ': 'u', '×': 'x',
};

const VARIANTES: Record<string, string> = {
  a: 'a4@àáâãäå', b: 'b8ß', c: 'c(<[{ç¢', d: 'd', e: 'e3€èéêë', f: 'f', g: 'g69', h: 'h', i: 'i1!|ìíîï', j: 'j',
  k: 'k', l: 'l1|£', m: 'm', n: 'nñ', o: 'o0@°øòóôõö', p: 'p', q: 'q', r: 'r', s: 's5$§', t: 't7+', u: 'uvµùúûü',
  v: 'v', w: 'w', x: 'x×', y: 'y¥ÿ', z: 'z2',
};

/** Forme de base d'un mot : minuscules, sans accents, sosies remplacés, lettres seulement. */
export function formeDeBase(mot: string): string {
  const epure = mot.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return [...epure].map((c) => SOSIES[c] ?? c).join('').replace(/[^a-z]/g, '');
}

const motifs = new Map<string, RegExp>();

function echapperClasse(caracteres: string): string {
  return caracteres.replace(/[\\\]^-]/g, '\\$&');
}

function motif(mot: string): RegExp {
  let p = motifs.get(mot);
  if (!p) {
    const corps = [...mot].map((l) => `[${echapperClasse(VARIANTES[l] ?? l)}]+`).join('[^a-z0-9]{0,3}');
    p = new RegExp(`(?<![a-z0-9])${corps}`, 'gi');
    motifs.set(mot, p);
    if (motifs.size > 2000) motifs.delete(motifs.keys().next().value!);
  }
  return p;
}

function plages(mot: string, botte: string): [number, number][] {
  const sortie: [number, number][] = [];
  const p = motif(mot);
  p.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = p.exec(botte)) !== null) {
    sortie.push([m.index, m.index + m[0].length]);
    if (m.index === p.lastIndex) p.lastIndex++;
  }
  return sortie;
}

/** Retourne le mot interdit trouvé dans le texte, ou null. */
export function trouverMotInterdit(mots: string[], texte: string): string | null {
  if (!mots.length || !texte) return null;
  const botte = texte.slice(0, 4000).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Les mots sûrs ne comptent qu'écrits tels quels : sinon « de p.u.t.e » passerait pour « député ».
  const surs: [number, number][] = [];
  for (const mot of MOTS_SURS) {
    for (let i = botte.indexOf(mot); i !== -1; i = botte.indexOf(mot, i + 1)) surs.push([i, i + mot.length]);
  }
  for (const mot of mots) {
    const base = formeDeBase(mot);
    if (!base) continue;
    for (const [demarrer, fin] of plages(base, botte)) {
      if (!surs.some(([s, e]) => demarrer >= s && fin <= e)) return base;
    }
  }
  return null;
}
