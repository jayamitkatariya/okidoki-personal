import { createErrorResult, createSuccessResult, type Result } from './result';
import { isRecord } from './type-guards';

// The tokens in web/src/app/tokens/color.css that mobile and shared code read, named like web's colors.ts and kept equal by design-tokens.test.ts. Opaque values are #rrggbb so callers can append an alpha byte.
const plain = {
  black: '#000000',
  white: '#ffffff',
  purple: '#a855f7',
  blue: '#0ea5e9',
  pink: '#ec4899',
  orange: '#f97316',
  teal: '#14b8a6',
  lime: '#84cc16',
};

export type Mode = 'dark' | 'light';
export const MODES: readonly Mode[] = ['dark', 'light'];

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const isThemePreference = (value: unknown): value is ThemePreference => THEME_PREFERENCES.some((theme) => theme === value);

const PALETTE_KEYS = ['background', 'subtle', 'muted', 'selected', 'elevated', 'foreground', 'mutedForeground', 'faintForeground', 'border', 'borderStrong'] as const;
type PaletteColors = Record<(typeof PALETTE_KEYS)[number], string>;

export const PALETTE_PRESETS = {
  dark: ['default', 'slate', 'stone', 'black', 'high-contrast'],
  light: ['default', 'slate', 'stone', 'neutral', 'high-contrast'],
} as const;
export type Palette = (typeof PALETTE_PRESETS)[Mode][number] | 'custom';
export const PALETTES: readonly Palette[] = [...new Set([...PALETTE_PRESETS.dark, ...PALETTE_PRESETS.light]), 'custom'];

export const PALETTE_COLORS: { [M in Mode]: Record<(typeof PALETTE_PRESETS)[M][number], PaletteColors> } = {
  dark: {
    default: { background: '#111111', subtle: '#181818', muted: '#1f1f1f', selected: '#2a2a2a', elevated: '#2a2a2a', foreground: '#ededed', mutedForeground: '#a3a3a3', faintForeground: '#737373', border: '#2a2a2a', borderStrong: '#5c5c5c' },
    slate: { background: '#0d1117', subtle: '#131821', muted: '#19202a', selected: '#232b37', elevated: '#232b37', foreground: '#e6ecf4', mutedForeground: '#97a5ba', faintForeground: '#687487', border: '#242c38', borderStrong: '#515c6d' },
    stone: { background: '#1a1713', subtle: '#201c18', muted: '#27231f', selected: '#312d28', elevated: '#312d28', foreground: '#f2eae2', mutedForeground: '#b0a497', faintForeground: '#80756b', border: '#342f29', borderStrong: '#675e54' },
    black: { background: '#000000', subtle: '#0a0a0a', muted: '#141414', selected: '#222222', elevated: '#222222', foreground: '#ededed', mutedForeground: '#a1a1a1', faintForeground: '#6c6c6c', border: '#262626', borderStrong: '#525252' },
    'high-contrast': { background: '#0b0b0b', subtle: '#141414', muted: '#1c1c1c', selected: '#2e2e2e', elevated: '#2e2e2e', foreground: '#fafafa', mutedForeground: '#bababa', faintForeground: '#858585', border: '#353535', borderStrong: '#5e5e5e' },
  },
  light: {
    default: { background: '#ffffff', subtle: '#f7f8f6', muted: '#f2f3f1', selected: '#e8ece7', elevated: '#ffffff', foreground: '#162118', mutedForeground: '#67706a', faintForeground: '#a1a7a3', border: '#e2e6e0', borderStrong: '#b9c1b8' },
    slate: { background: '#ffffff', subtle: '#f5f8fc', muted: '#eff3f9', selected: '#e4eaf3', elevated: '#ffffff', foreground: '#171f2b', mutedForeground: '#56667c', faintForeground: '#8592a6', border: '#d9e1ec', borderStrong: '#acb7c7' },
    stone: { background: '#fdf9f5', subtle: '#f8f3ed', muted: '#f4eee7', selected: '#ede5dc', elevated: '#ffffff', foreground: '#241c15', mutedForeground: '#6c6053', faintForeground: '#978c80', border: '#e3dbd2', borderStrong: '#bcb0a3' },
    neutral: { background: '#ffffff', subtle: '#f9f9f9', muted: '#f3f3f3', selected: '#eaeaea', elevated: '#ffffff', foreground: '#111111', mutedForeground: '#606060', faintForeground: '#898989', border: '#dedede', borderStrong: '#b4b4b4' },
    'high-contrast': { background: '#ffffff', subtle: '#f5f5f5', muted: '#ededed', selected: '#e0e0e0', elevated: '#ffffff', foreground: '#0a0a0a', mutedForeground: '#4f4f4f', faintForeground: '#6b6b6b', border: '#cccccc', borderStrong: '#949494' },
  },
};

export const ACCENT_PRESETS = ['green', 'blue', 'purple', 'pink'] as const;
export const ACCENTS = [...ACCENT_PRESETS, 'custom'] as const;
export type Accent = (typeof ACCENTS)[number];

const ACCENT_KEYS = ['primary', 'primaryText', 'primaryForeground', 'primarySoft'] as const;
type AccentColors = Record<(typeof ACCENT_KEYS)[number], string>;

export const ACCENT_COLORS: Record<(typeof ACCENT_PRESETS)[number], Record<Mode, Omit<AccentColors, 'primaryForeground'>>> = {
  green: {
    dark: { primary: '#3eeba3', primaryText: '#3eeba3', primarySoft: '#3eeba31a' },
    light: { primary: '#2f9d57', primaryText: '#007136', primarySoft: '#2f9d571a' },
  },
  blue: {
    dark: { primary: '#60a5fa', primaryText: '#60a5fa', primarySoft: '#60a5fa1a' },
    light: { primary: '#2563eb', primaryText: '#1d4ed8', primarySoft: '#2563eb1a' },
  },
  purple: {
    dark: { primary: '#c084fc', primaryText: '#c084fc', primarySoft: '#c084fc1a' },
    light: { primary: '#9333ea', primaryText: '#7e22ce', primarySoft: '#9333ea1a' },
  },
  pink: {
    dark: { primary: '#f472b6', primaryText: '#f472b6', primarySoft: '#f472b61a' },
    light: { primary: '#db2777', primaryText: '#be185d', primarySoft: '#db27771a' },
  },
};

const dark = {
  ...PALETTE_COLORS.dark.default,
  ...ACCENT_COLORS.green.dark,
  primaryForeground: '#111111',

  success: '#3eeba3',
  successText: '#3eeba3',
  successForeground: '#111111',
  successSoft: '#3eeba31a',

  destructive: '#ef4444',
  destructiveText: '#ff6f63',
  destructiveForeground: '#ffffff',
  destructiveSoft: '#dc262636',

  warning: '#f59e0b',
  warningText: '#f59e0b',
  warningSoft: '#f59e0b1a',
  warningForeground: '#111111',
  highlight: '#f59e0b4d',
  ...plain,
};

export type DesignColors = Record<keyof typeof dark, string>;

export const DESIGN_COLORS: Record<Mode, DesignColors> = {
  dark,
  light: {
    ...PALETTE_COLORS.light.default,
    ...ACCENT_COLORS.green.light,
    primaryForeground: '#ffffff',

    success: '#2f9d57',
    successText: '#007136',
    successForeground: '#ffffff',
    successSoft: '#2f9d571a',

    destructive: '#dc2626',
    destructiveText: '#b2000f',
    destructiveForeground: '#ffffff',
    destructiveSoft: '#dc262614',

    warning: '#92400e',
    warningText: '#aa4d00',
    warningSoft: '#92400e1f',
    warningForeground: '#ffffff',
    highlight: '#facc1580',
    ...plain,
  },
};

// Ordered so neighbors stay distinct for color-blind readers, in both themes. Starts with success, not primary, so no accent repeats a plain hue.
export const SERIES = ['success', 'blue', 'purple', 'orange', 'pink', 'lime', 'teal', 'warning'] as const satisfies readonly (keyof DesignColors)[];

// GitHub's light and dark code themes, which web highlights code with (CODE_THEMES in web's colors.ts).
export const CODE_COLORS = {
  dark: { foreground: '#e1e4e8', comment: '#6a737d', keyword: '#f97583', string: '#9ecbff', constant: '#79b8ff' },
  light: { foreground: '#24292e', comment: '#6a737d', keyword: '#d73a49', string: '#032f62', constant: '#005cc5' },
};

export const BRAND_COLORS = {
  okidoki: { light: '#2f9d57', dark: '#3eeba3' },
  claude: '#d97757',
  codex: ['#b1a7ff', '#7a9dff', '#3941ff'],
  gemini: ['#4796e3', '#9177c7', '#ca6673'],
  muse: '#0668e1',
  opencode: ['#4b4646', '#f1ecec'],
  slack: ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e'],
  linear: '#8d8ff8',
  gitlab: '#fc6d26',
  badge: { label: '#121212', linear: '#5e6ad2', slack: '#4a154b' },
  // Emails assume a white page.
  email: { text: '#222', muted: '#888', link: '#0066cc' },
} as const;

const channels = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
export const mix = (from: string, to: string, amount: number) => {
  const target = channels(to);
  return `#${channels(from).map((channel, index) => Math.round(channel + (target[index] - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
};
export const linearChannels = (hex: string) => channels(hex).map((channel) => channel / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
export const luminance = (hex: string) => {
  const [r, g, b] = linearChannels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

export const cssName = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export const normalizeHex = (value: string) => {
  const hex = `#${value.trim().replace(/^#/, '').toLowerCase()}`;
  return isHex(hex) ? hex : null;
};

// A type alias, not an interface: only an alias can be saved as a ClientStateValue.
export type CustomTheme = { background: string; foreground: string; accent: string };

export const isCustomTheme = (value: unknown): value is CustomTheme => isRecord(value) && [value.background, value.foreground, value.accent].every(isHex);

export const SAVED_THEME_NAME_MAX_LENGTH = 40;
export const MAX_SAVED_THEMES = 50;
export type NamedTheme = CustomTheme & { name: string };
export const normalizeSavedThemes = (value: unknown): NamedTheme[] => (Array.isArray(value)
  ? value.filter((theme): theme is NamedTheme => isRecord(theme) && typeof theme.name === 'string' && theme.name.trim() !== '' && theme.name.length <= SAVED_THEME_NAME_MAX_LENGTH && isCustomTheme(theme)).slice(0, MAX_SAVED_THEMES)
  : []);

// Code colors, the terminal and diagrams are styled per mode, so a custom theme is dark when its background is darker than its text.
export const customMode = ({ background, foreground }: CustomTheme): Mode => (luminance(background) < luminance(foreground) ? 'dark' : 'light');

export const themeCode = ({ background, foreground, accent }: CustomTheme) => [background, foreground, accent].join(',');

export function parseThemeCode(code: string): Result<CustomTheme> {
  const colors = code.split(',').map(normalizeHex);
  if (colors.length !== 3 || !colors.every(isHex)) return createErrorResult({ message: 'Paste three hex colors separated by commas.' });
  const [background, foreground, accent] = colors;
  return createSuccessResult({ background, foreground, accent });
}

export interface Theme {
  mode: Mode;
  palette: Palette;
  accent: Accent;
  custom: CustomTheme;
}

export const DEFAULT_THEME: Omit<Theme, 'mode'> = {
  palette: 'default',
  accent: 'green',
  custom: { background: PALETTE_COLORS.dark.default.background, foreground: PALETTE_COLORS.dark.default.foreground, accent: '#888888' },
};

export const normalizeThemePreference = (value: unknown): ThemePreference => (isThemePreference(value) ? value : 'system');
export const normalizePalette = (value: unknown): Palette => PALETTES.find((palette) => palette === value) ?? DEFAULT_THEME.palette;
export const normalizeAccent = (value: unknown): Accent => ACCENTS.find((accent) => accent === value) ?? DEFAULT_THEME.accent;
export const normalizeCustomTheme = (value: unknown): CustomTheme => (isCustomTheme(value) ? value : DEFAULT_THEME.custom);

export type SavedTheme = Omit<Theme, 'mode'> & { theme: ThemePreference };
export type ThemeChange = Partial<SavedTheme>;

// Re-picking the current theme must not reset the color theme.
export const themePreferenceChange = (current: ThemePreference, theme: ThemePreference): ThemeChange => (theme === current ? {} : { theme, palette: DEFAULT_THEME.palette });
export const colorThemeChange = (mode: Mode, palette: Palette): ThemeChange => ({ theme: mode, palette });
export const themeCodeChange = (custom: CustomTheme): ThemeChange => ({ ...colorThemeChange(customMode(custom), 'custom'), accent: 'custom', custom });

export const resolvePalette = (mode: Mode, palette: Palette, custom: CustomTheme): Palette =>
  ((palette === 'custom' ? customMode(custom) === mode : PALETTE_PRESETS[mode].some((name) => name === palette)) ? palette : 'default');

export const themeLabel = (value: string) => value[0].toUpperCase() + value.slice(1).replaceAll('-', ' ');

export const themeKey = ({ mode, palette, accent, custom }: Theme) =>
  [mode, palette, accent, ...(palette === 'custom' || accent === 'custom' ? [themeCode(custom)] : [])].join(':');

// Mixing amounts are measured from the default palette.
function customPalette(custom: CustomTheme): PaletteColors {
  const { background, foreground } = custom;
  const selected = mix(background, foreground, 0.105);
  return {
    background,
    subtle: mix(background, foreground, 0.035),
    muted: mix(background, foreground, 0.06),
    selected,
    elevated: customMode(custom) === 'dark' ? selected : background,
    foreground,
    mutedForeground: mix(background, foreground, 0.65),
    faintForeground: mix(background, foreground, 0.43),
    border: mix(background, foreground, 0.115),
    borderStrong: mix(background, foreground, 0.32),
  };
}

const READABLE_TEXT_KEYS = ['primaryText', 'successText', 'destructiveText', 'warningText'] as const;

// The smallest step toward white or black that reads at 4.5:1, so the text keeps its color.
function readableText(color: string, { background, selected }: PaletteColors) {
  const score = (text: string) => Math.min(contrast(text, background), contrast(text, selected));
  let best = color;
  for (let step = 0; step <= 20 && score(best) < 4.5; step++) {
    best = ['#ffffff', '#000000'].map((toward) => mix(color, toward, step / 20)).reduce((a, b) => (score(b) > score(a) ? b : a));
  }
  return best;
}

function customAccent(accent: string, paletteColors: PaletteColors): AccentColors {
  return {
    primary: accent,
    primaryText: readableText(accent, paletteColors),
    primaryForeground: contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#000000' : '#ffffff',
    primarySoft: `${accent}1a`,
  };
}

export function designColors({ mode, palette, accent, custom }: Theme): DesignColors {
  const resolved = resolvePalette(mode, palette, custom);
  const presets: Partial<Record<Palette, PaletteColors>> = PALETTE_COLORS[mode];
  const paletteColors = presets[resolved] ?? customPalette(custom);
  const colors = { ...DESIGN_COLORS[mode], ...paletteColors, ...(accent === 'custom' ? customAccent(custom.accent, paletteColors) : ACCENT_COLORS[accent][mode]) };
  return resolved === 'custom' ? { ...colors, ...Object.fromEntries(READABLE_TEXT_KEYS.map((key) => [key, readableText(colors[key], paletteColors)])) } : colors;
}

export function customThemeVariables(theme: Omit<Theme, 'mode'>): Record<string, string> {
  const keys = [...(theme.palette === 'custom' ? [...PALETTE_KEYS, ...READABLE_TEXT_KEYS] : []), ...(theme.accent === 'custom' ? ACCENT_KEYS : [])];
  return Object.fromEntries(MODES.flatMap((mode) => {
    const colors = designColors({ ...theme, mode });
    return keys.map((key) => [`--${mode}-${cssName(key)}`, colors[key]]);
  }));
}
