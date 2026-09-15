export interface CouleursTheme {
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export type ThemeId = 'discord' | 'twitch' | 'gaming' | 'dark' | 'neon' | 'minimal' | 'custom';

export const THEMES: Record<Exclude<ThemeId, 'custom'>, { label: string; emoji: string; colors: CouleursTheme }> = {
  discord: {
    label: 'Discord',
    emoji: '💙',
    colors: { primary: '#5865F2', success: '#57F287', error: '#ED4245', warning: '#FEE75C', info: '#5865F2' },
  },
  twitch: {
    label: 'Twitch',
    emoji: '💜',
    colors: { primary: '#9146FF', success: '#00F593', error: '#EB0400', warning: '#FFCA5F', info: '#BF94FF' },
  },
  gaming: {
    label: 'Gaming',
    emoji: '🎮',
    colors: { primary: '#FF4655', success: '#3BD16F', error: '#FF1F3D', warning: '#FFB800', info: '#00B2FF' },
  },
  dark: {
    label: 'Dark',
    emoji: '🌑',
    colors: { primary: '#2B2D31', success: '#248046', error: '#A12D2F', warning: '#B5891B', info: '#4E5058' },
  },
  neon: {
    label: 'Neon',
    emoji: '🌈',
    colors: { primary: '#00FFF7', success: '#39FF14', error: '#FF073A', warning: '#FFF01F', info: '#BC13FE' },
  },
  minimal: {
    label: 'Minimal',
    emoji: '⚪',
    colors: { primary: '#E3E5E8', success: '#A3D9A5', error: '#E8A3A3', warning: '#E8D9A3', info: '#A3BFE8' },
  },
};

const HEXA = /^#?([0-9a-f]{6})$/i;

export function estCouleurHexa(valeur: string): boolean {
  return HEXA.test(valeur.trim());
}

export function normaliserHexa(valeur: string): string | null {
  const m = HEXA.exec(valeur.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

export function hexaEnEntier(valeur: string, secours = 0x5865f2): number {
  const m = HEXA.exec(valeur.trim());
  return m ? Number.parseInt(m[1]!, 16) : secours;
}
