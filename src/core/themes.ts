export interface ThemeColors {
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export type ThemeId = 'discord' | 'twitch' | 'gaming' | 'dark' | 'neon' | 'minimal' | 'custom';

export const THEMES: Record<Exclude<ThemeId, 'custom'>, { label: string; emoji: string; colors: ThemeColors }> = {
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

const HEX = /^#?([0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

export function normalizeHex(value: string): string | null {
  const m = HEX.exec(value.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

export function hexToInt(value: string, fallback = 0x5865f2): number {
  const m = HEX.exec(value.trim());
  return m ? Number.parseInt(m[1]!, 16) : fallback;
}
