const UNITES: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  seconde: 1_000,
  secondes: 1_000,
  m: 60_000,
  min: 60_000,
  mn: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  heure: 3_600_000,
  heures: 3_600_000,
  j: 86_400_000,
  d: 86_400_000,
  jour: 86_400_000,
  jours: 86_400_000,
  sem: 604_800_000,
  w: 604_800_000,
  semaine: 604_800_000,
  semaines: 604_800_000,
  mois: 2_592_000_000,
};

/**
 * Convertit une durée lisible en millisecondes.
 * Exemples : "2h30", "1j 12h", "45m", "90s", "1 semaine", "2h30m".
 * Retourne null si invalide.
 */
export function lireDuree(saisie: string): number | null {
  const brut = saisie.trim().toLowerCase().replace(/,/g, '.');
  if (!brut) return null;
  // "2h30" -> minutes implicites après les heures
  const heureMinute = /^(\d+)\s*h\s*(\d{1,2})$/.exec(brut);
  if (heureMinute) return Number(heureMinute[1]) * 3_600_000 + Number(heureMinute[2]) * 60_000;
  const expression = /(\d+(?:\.\d+)?)\s*([a-zé]+)/g;
  let total = 0;
  let consomme = '';
  let correspondance: RegExpExecArray | null;
  while ((correspondance = expression.exec(brut)) !== null) {
    const unite = UNITES[correspondance[2]!.normalize('NFD').replace(/[\u0300-\u036f]/g, '')] ?? UNITES[correspondance[2]!];
    if (!unite) return null;
    total += Number(correspondance[1]) * unite;
    consomme += correspondance[0];
  }
  if (!consomme || consomme.replace(/\s/g, '') !== brut.replace(/\s/g, '')) {
    if (/^\d+$/.test(brut)) return Number(brut) * 60_000; // nombre seul = minutes
    return null;
  }
  return total > 0 ? Math.round(total) : null;
}

export function formaterDuree(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '0 s';
  const parties: string[] = [];
  const jours = Math.floor(ms / 86_400_000);
  const heures = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secondes = Math.floor((ms % 60_000) / 1000);
  if (jours) parties.push(`${jours} j`);
  if (heures) parties.push(`${heures} h`);
  if (minutes) parties.push(`${minutes} min`);
  if (secondes && !jours && !heures) parties.push(`${secondes} s`);
  return parties.join(' ');
}

export function formaterHorloge(secondes: number): string {
  if (!Number.isFinite(secondes) || secondes <= 0) return '🔴 Direct';
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type StyleHorodatage = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

export function marqueTemps(ms: number, style: StyleHorodatage = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function joursDepuis(ms: number, maintenant = Date.now()): number {
  return Math.floor((maintenant - ms) / 86_400_000);
}

interface PartiesFuseau {
  annee: number;
  mois: number;
  jour: number;
  heure: number;
  minute: number;
  seconde: number;
  jourSemaine: number;
}

const formateurs = new Map<string, Intl.DateTimeFormat>();

function formateur(fuseauHoraire: string): Intl.DateTimeFormat {
  let f = formateurs.get(fuseauHoraire);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuseauHoraire,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formateurs.set(fuseauHoraire, f);
  }
  return f;
}

export function fuseauValide(fuseauHoraire: string): boolean {
  try {
    formateur(fuseauHoraire);
    return true;
  } catch {
    return false;
  }
}

const JOURS_SEMAINE: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Décompose un instant dans un fuseau horaire donné. */
export function partiesFuseau(ms: number, fuseauHoraire: string): PartiesFuseau {
  const fuseauSur = fuseauValide(fuseauHoraire) ? fuseauHoraire : 'UTC';
  const parties = Object.fromEntries(formateur(fuseauSur).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    annee: Number(parties.year),
    mois: Number(parties.month),
    jour: Number(parties.day),
    heure: Number(parties.hour),
    minute: Number(parties.minute),
    seconde: Number(parties.second),
    jourSemaine: JOURS_SEMAINE[parties.weekday as string] ?? 0,
  };
}

/** Convertit une date/heure "murale" d'un fuseau en timestamp UTC (ms). */
export function heureFuseauEnUtc(annee: number, mois: number, jour: number, heure: number, minute: number, fuseauHoraire: string): number {
  const estimation = Date.UTC(annee, mois - 1, jour, heure, minute);
  let resultat = estimation;
  // Deux itérations suffisent pour gérer les changements d'heure
  for (let i = 0; i < 2; i++) {
    const p = partiesFuseau(resultat, fuseauHoraire);
    const enUtc = Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute);
    resultat += estimation - enUtc;
  }
  return resultat;
}

/** Clé de jour "AAAA-MM-JJ" dans le fuseau donné. */
export function cleJour(ms: number, fuseauHoraire: string): string {
  const p = partiesFuseau(ms, fuseauHoraire);
  return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
}

export function cleJourPrecedent(cle: string): string {
  const [y, m, d] = cle.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return date.toISOString().slice(0, 10);
}

/**
 * Analyse une date "JJ/MM/AAAA" (ou "JJ/MM") et une heure "HH:MM" / "21h" dans un fuseau.
 * Retourne null si invalide.
 */
export function lireDateHeure(dateSaisie: string, heureSaisie: string, fuseauHoraire: string, maintenant = Date.now()): number | null {
  const mp = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(dateSaisie.trim());
  const tm = /^(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?$/i.exec(heureSaisie.trim());
  if (!mp || !tm) return null;
  const jour = Number(mp[1]);
  const mois = Number(mp[2]);
  let annee = mp[3] ? Number(mp[3]) : partiesFuseau(maintenant, fuseauHoraire).annee;
  if (annee < 100) annee += 2000;
  const heure = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31 || heure > 23 || minute > 59) return null;
  const verification = new Date(Date.UTC(annee, mois - 1, jour));
  if (verification.getUTCMonth() !== mois - 1) return null;
  let resultat = heureFuseauEnUtc(annee, mois, jour, heure, minute, fuseauHoraire);
  if (!mp[3] && resultat < maintenant) resultat = heureFuseauEnUtc(annee + 1, mois, jour, heure, minute, fuseauHoraire);
  return resultat;
}

export function formaterDate(ms: number, fuseauHoraire: string, avecHeure = true): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: fuseauValide(fuseauHoraire) ? fuseauHoraire : 'UTC',
    dateStyle: 'long',
    ...(avecHeure ? { timeStyle: 'short' } : {}),
  }).format(new Date(ms));
}

export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
