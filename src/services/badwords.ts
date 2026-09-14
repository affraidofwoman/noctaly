/**
 * Filtre de mots interdits repris du bot Airline : résiste aux substitutions (0→o, 3→e, @→a…),
 * aux séparateurs (n.e.g.r.e) et aux lettres répétées, sans toucher aux mots sûrs (violet, violon…).
 */

export const DEFAULT_WORDS = [
  'negre', 'negro', 'nigger', 'nigga', 'bougnoule', 'bicot', 'youpin', 'chintok', 'niakoue',
  'nazi', 'heilhitler', 'siegheil',
  'pede', 'tapette', 'tarlouze', 'faggot',
  'pedophile', 'pedo', 'zoophile',
  'pute', 'salope', 'connasse',
];

export const SAFE_WORDS = [
  'violet', 'violette', 'violon', 'violoncelle', 'violoniste',
  'violence', 'violent', 'violente', 'violemment', 'violace',
  'negroni', 'computer', 'reputation', 'deputes', 'depute',
  'pedestre', 'pedopsychiatre', 'pedopsychiatrie', 'pedologie', 'pedoncule', 'pedale', 'pedagogie', 'pedagogique',
];

const LOOKALIKE: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', ')': 'c', '[': 'c', '{': 'c', '<': 'c',
  '£': 'l', '€': 'e', '¥': 'y', '°': 'o', 'µ': 'u', '×': 'x',
};

const VARIANTS: Record<string, string> = {
  a: 'a4@àáâãäå', b: 'b8ß', c: 'c(<[{ç¢', d: 'd', e: 'e3€èéêë', f: 'f', g: 'g69', h: 'h', i: 'i1!|ìíîï', j: 'j',
  k: 'k', l: 'l1|£', m: 'm', n: 'nñ', o: 'o0@°øòóôõö', p: 'p', q: 'q', r: 'r', s: 's5$§', t: 't7+', u: 'uvµùúûü',
  v: 'v', w: 'w', x: 'x×', y: 'y¥ÿ', z: 'z2',
};

/** Forme de base d'un mot : minuscules, sans accents, sosies remplacés, lettres seulement. */
export function baseForm(word: string): string {
  const stripped = word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return [...stripped].map((c) => LOOKALIKE[c] ?? c).join('').replace(/[^a-z]/g, '');
}

const patterns = new Map<string, RegExp>();

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&');
}

function pattern(word: string): RegExp {
  let p = patterns.get(word);
  if (!p) {
    const body = [...word].map((l) => `[${escapeClass(VARIANTS[l] ?? l)}]+`).join('[^a-z0-9]{0,3}');
    p = new RegExp(`(?<![a-z0-9])${body}`, 'gi');
    patterns.set(word, p);
    if (patterns.size > 2000) patterns.delete(patterns.keys().next().value!);
  }
  return p;
}

function ranges(word: string, haystack: string): [number, number][] {
  const out: [number, number][] = [];
  const p = pattern(word);
  p.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = p.exec(haystack)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m.index === p.lastIndex) p.lastIndex++;
  }
  return out;
}

/** Retourne le mot interdit trouvé dans le texte, ou null. */
export function findBannedWord(words: string[], text: string): string | null {
  if (!words.length || !text) return null;
  const haystack = text.slice(0, 4000).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Les mots sûrs ne comptent qu'écrits tels quels : sinon « de p.u.t.e » passerait pour « député ».
  const safe: [number, number][] = [];
  for (const word of SAFE_WORDS) {
    for (let i = haystack.indexOf(word); i !== -1; i = haystack.indexOf(word, i + 1)) safe.push([i, i + word.length]);
  }
  for (const word of words) {
    const base = baseForm(word);
    if (!base) continue;
    for (const [start, end] of ranges(base, haystack)) {
      if (!safe.some(([s, e]) => start >= s && end <= e)) return base;
    }
  }
  return null;
}
