const UNITS: Record<string, number> = {
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
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/,/g, '.');
  if (!raw) return null;
  // "2h30" -> minutes implicites après les heures
  const hm = /^(\d+)\s*h\s*(\d{1,2})$/.exec(raw);
  if (hm) return Number(hm[1]) * 3_600_000 + Number(hm[2]) * 60_000;
  const re = /(\d+(?:\.\d+)?)\s*([a-zé]+)/g;
  let total = 0;
  let consumed = '';
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const unit = UNITS[match[2]!.normalize('NFD').replace(/[\u0300-\u036f]/g, '')] ?? UNITS[match[2]!];
    if (!unit) return null;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  if (!consumed || consumed.replace(/\s/g, '') !== raw.replace(/\s/g, '')) {
    if (/^\d+$/.test(raw)) return Number(raw) * 60_000; // nombre seul = minutes
    return null;
  }
  return total > 0 ? Math.round(total) : null;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '0 s';
  const parts: string[] = [];
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (days) parts.push(`${days} j`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (seconds && !days && !hours) parts.push(`${seconds} s`);
  return parts.join(' ');
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '🔴 Direct';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

export function ts(ms: number, style: TimestampStyle = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function daysSince(ms: number, now = Date.now()): number {
  return Math.floor((now - ms) / 86_400_000);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Décompose un instant dans un fuseau horaire donné. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const safeZone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const parts = Object.fromEntries(formatter(safeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
  };
}

/** Convertit une date/heure "murale" d'un fuseau en timestamp UTC (ms). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess;
  // Deux itérations suffisent pour gérer les changements d'heure
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(result, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    result += guess - asUtc;
  }
  return result;
}

/** Clé de jour "AAAA-MM-JJ" dans le fuseau donné. */
export function dayKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return date.toISOString().slice(0, 10);
}

/**
 * Analyse une date "JJ/MM/AAAA" (ou "JJ/MM") et une heure "HH:MM" / "21h" dans un fuseau.
 * Retourne null si invalide.
 */
export function parseDateTime(dateInput: string, timeInput: string, timeZone: string, now = Date.now()): number | null {
  const dm = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(dateInput.trim());
  const tm = /^(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?$/i.exec(timeInput.trim());
  if (!dm || !tm) return null;
  const day = Number(dm[1]);
  const month = Number(dm[2]);
  let year = dm[3] ? Number(dm[3]) : zonedParts(now, timeZone).year;
  if (year < 100) year += 2000;
  const hour = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null;
  let result = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  if (!dm[3] && result < now) result = zonedTimeToUtc(year + 1, month, day, hour, minute, timeZone);
  return result;
}

export function formatDate(ms: number, timeZone: string, withTime = true): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: isValidTimezone(timeZone) ? timeZone : 'UTC',
    dateStyle: 'long',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(new Date(ms));
}

export const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
