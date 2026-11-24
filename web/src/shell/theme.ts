import {
  ACCENT_COLORS,
  PALETTE_COLORS,
  type Mode,
} from "../../../shared/src/design-tokens";

/**
 * Themes are a palette (surfaces and ink) plus an accent. okidoki keeps its own
 * warm default, and borrows the donor's slate, stone, neutral and high-contrast
 * palettes and its blue/purple/pink accents. Values are written as CSS
 * variables on <html>, so every surface, native-slot page and popup follows.
 */

export const PALETTES = [
  { id: "okidoki", label: "okidoki" },
  { id: "slate", label: "Slate" },
  { id: "stone", label: "Stone" },
  { id: "neutral", label: "Neutral" },
  { id: "high-contrast", label: "High contrast" },
] as const;

export const ACCENTS = [
  { id: "okidoki", label: "okidoki green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
] as const;

type Tokens = Record<string, string>;

const OKIDOKI: Record<Mode, Tokens> = {
  light: {
    "--bg": "#f0f2ed",
    "--panel": "#fafbf8",
    "--panel-line": "rgba(14, 21, 18, 0.06)",
    "--tile": "#ffffff",
    "--tile-hover": "#fbfcfb",
    "--tile-line": "rgba(14, 21, 18, 0.08)",
    "--ok-card": "#ffffff",
    "--card-soft": "#f7f8f7",
    "--card-hover": "#fbfcfb",
    "--well": "rgba(14, 21, 18, 0.03)",
    "--well-strong": "rgba(14, 21, 18, 0.06)",
    "--ink": "#0e1512",
    "--ink-2": "#2b3430",
    "--ok-muted": "#5d6762",
    "--faint": "#727d75",
    "--line": "rgba(14, 21, 18, 0.07)",
    "--line-strong": "rgba(14, 21, 18, 0.13)",
    "--s-ink": "#111613",
    "--s-ink-2": "#2a312d",
    "--s-muted": "#5f6964",
    "--s-faint": "#6f7873",
    "--s-hover": "rgba(17, 22, 19, 0.05)",
    "--s-press": "rgba(17, 22, 19, 0.08)",
    "--s-active": "rgba(255, 255, 255, 0.78)",
    "--s-tile": "rgba(255, 255, 255, 0.5)",
    "--s-tile-hover": "rgba(255, 255, 255, 0.78)",
    "--c-bg": "#ffffff",
    "--c-soft": "#f6f7f6",
    "--c-well": "#f1f3f1",
    "--c-line": "rgba(17, 22, 19, 0.07)",
    "--c-line-strong": "rgba(17, 22, 19, 0.12)",
    "--glass": "rgba(255, 255, 255, 0.72)",
    "--glass-strong": "rgba(255, 255, 255, 0.88)",
    "--nav-bg": "rgba(241, 242, 241, 0.72)",
    "--ok-accent": "#0b7a45",
    "--accent-hover": "#096a3c",
    "--accent-soft": "rgba(11, 122, 69, 0.1)",
    "--accent-ink": "#0b7a45",
    "--accent-bright": "#44e45e",
    "--brand": "#44e45e",
    "--green": "#12965a",
    "--green-bright": "#36d158",
    "--green-soft": "rgba(11, 122, 69, 0.09)",
    "--on-accent": "#ffffff",
    "--focus": "0 0 0 3px rgba(54, 209, 88, 0.35)",
  },
  dark: {
    "--bg": "#101612",
    "--panel": "#161d18",
    "--panel-line": "rgba(255, 255, 255, 0.06)",
    "--tile": "#1c241f",
    "--tile-hover": "#222c25",
    "--tile-line": "rgba(255, 255, 255, 0.07)",
    "--ok-card": "#151917",
    "--card-soft": "#1a1f1d",
    "--card-hover": "#1e2321",
    "--well": "rgba(255, 255, 255, 0.035)",
    "--well-strong": "rgba(255, 255, 255, 0.06)",
    "--ink": "#eef2ef",
    "--ink-2": "#d3dbd6",
    "--ok-muted": "#98a29c",
    "--faint": "#91a096",
    "--line": "rgba(255, 255, 255, 0.07)",
    "--line-strong": "rgba(255, 255, 255, 0.13)",
    "--s-ink": "#eef2ef",
    "--s-ink-2": "#d4dad6",
    "--s-muted": "#9ba49f",
    "--s-faint": "#8d968f",
    "--s-hover": "rgba(255, 255, 255, 0.06)",
    "--s-press": "rgba(255, 255, 255, 0.09)",
    "--s-active": "rgba(255, 255, 255, 0.1)",
    "--s-tile": "rgba(255, 255, 255, 0.06)",
    "--s-tile-hover": "rgba(255, 255, 255, 0.1)",
    "--c-bg": "#151817",
    "--c-soft": "#1b1f1d",
    "--c-well": "#202523",
    "--c-line": "rgba(255, 255, 255, 0.07)",
    "--c-line-strong": "rgba(255, 255, 255, 0.12)",
    "--glass": "rgba(28, 32, 31, 0.72)",
    "--glass-strong": "rgba(32, 36, 35, 0.88)",
    "--nav-bg": "rgba(7, 9, 8, 0.72)",
    "--ok-accent": "#44e45e",
    "--accent-hover": "#5bea72",
    "--accent-soft": "rgba(68, 228, 94, 0.12)",
    "--accent-ink": "#4cfb6a",
    "--accent-bright": "#44e45e",
    "--brand": "#44e45e",
    "--green": "#4cfb6a",
    "--green-bright": "#44e45e",
    "--green-soft": "rgba(76, 251, 106, 0.1)",
    "--on-accent": "#03170f",
    "--focus": "0 0 0 3px rgba(68, 228, 94, 0.32)",
  },
};

interface Surface {
  background: string;
  subtle: string;
  muted: string;
  selected: string;
  elevated: string;
  foreground: string;
  mutedForeground: string;
  faintForeground: string;
  border: string;
  borderStrong: string;
}

const DONOR_PALETTE: Record<string, string> = {
  slate: "slate",
  stone: "stone",
  "high-contrast": "high-contrast",
};

function donorSurface(paletteId: string, mode: Mode): Tokens | null {
  const key = paletteId === "neutral" ? (mode === "dark" ? "black" : "neutral") : DONOR_PALETTE[paletteId];
  if (!key) return null;
  const p = (PALETTE_COLORS[mode] as Record<string, Surface>)[key];
  if (!p) return null;
  return {
    "--bg": p.background,
    "--panel": p.subtle,
    "--panel-line": p.border,
    "--tile": p.elevated,
    "--tile-hover": p.selected,
    "--tile-line": p.border,
    "--ok-card": p.elevated,
    "--card-soft": p.subtle,
    "--card-hover": p.muted,
    "--well": p.muted,
    "--well-strong": p.selected,
    "--ink": p.foreground,
    "--ink-2": p.foreground,
    "--ok-muted": p.mutedForeground,
    "--faint": p.faintForeground,
    "--line": p.border,
    "--line-strong": p.borderStrong,
    "--s-ink": p.foreground,
    "--s-ink-2": p.foreground,
    "--s-muted": p.mutedForeground,
    "--s-faint": p.faintForeground,
    "--s-hover": p.muted,
    "--s-press": p.selected,
    "--s-active": p.selected,
    "--s-tile": p.subtle,
    "--s-tile-hover": p.elevated,
    "--c-bg": p.elevated,
    "--c-soft": p.subtle,
    "--c-well": p.muted,
    "--c-line": p.border,
    "--c-line-strong": p.borderStrong,
    "--glass": p.background === "#ffffff" ? "rgba(255, 255, 255, 0.8)" : "rgba(0, 0, 0, 0.72)",
    "--glass-strong": p.background === "#ffffff" ? "rgba(255, 255, 255, 0.92)" : "rgba(0, 0, 0, 0.85)",
    "--nav-bg": p.background === "#ffffff" ? "rgba(245, 245, 245, 0.72)" : "rgba(10, 10, 10, 0.72)",
  };
}

const OKIDOKI_ACCENT: Record<Mode, Tokens> = {
  light: {
    "--ok-accent": "#0b7a45",
    "--accent-hover": "#096a3c",
    "--accent-soft": "rgba(11, 122, 69, 0.1)",
    "--accent-ink": "#0b7a45",
    "--accent-bright": "#44e45e",
    "--brand": "#44e45e",
    "--green": "#12965a",
    "--green-bright": "#36d158",
    "--green-soft": "rgba(11, 122, 69, 0.09)",
    "--on-accent": "#ffffff",
    "--focus": "0 0 0 3px rgba(54, 209, 88, 0.35)",
  },
  dark: {
    "--ok-accent": "#44e45e",
    "--accent-hover": "#5bea72",
    "--accent-soft": "rgba(68, 228, 94, 0.12)",
    "--accent-ink": "#4cfb6a",
    "--accent-bright": "#44e45e",
    "--brand": "#44e45e",
    "--green": "#4cfb6a",
    "--green-bright": "#44e45e",
    "--green-soft": "rgba(76, 251, 106, 0.1)",
    "--on-accent": "#03170f",
    "--focus": "0 0 0 3px rgba(68, 228, 94, 0.32)",
  },
};

function accentTokens(accentId: string, mode: Mode): Tokens {
  if (accentId === "okidoki" || !(accentId in ACCENT_COLORS)) {
    return OKIDOKI_ACCENT[mode];
  }
  const a = ACCENT_COLORS[accentId as keyof typeof ACCENT_COLORS][mode];
  const fg = mode === "dark" ? "#111111" : "#ffffff";
  return {
    "--ok-accent": a.primary,
    "--accent-hover": a.primaryText,
    "--accent-soft": a.primarySoft,
    "--accent-ink": a.primaryText,
    "--accent-bright": a.primary,
    "--brand": a.primary,
    "--green": a.primary,
    "--green-bright": a.primary,
    "--green-soft": a.primarySoft,
    "--on-accent": fg,
    "--focus": `0 0 0 3px ${a.primarySoft}`,
  };
}

/** Every variable a palette owns; used both to apply and to preview swatches. */
export function themeTokens(paletteId: string | undefined, accentId: string | undefined, mode: Mode): Tokens {
  const base = (paletteId && donorSurface(paletteId, mode)) || OKIDOKI[mode];
  return { ...base, ...accentTokens(accentId ?? "okidoki", mode) };
}

export function applyTheme(root: HTMLElement, paletteId: string | undefined, accentId: string | undefined, mode: Mode): void {
  const tokens = themeTokens(paletteId, accentId, mode);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
}

export function palettePreview(paletteId: string, mode: Mode): { bg: string; fg: string } {
  const tokens = themeTokens(paletteId, "okidoki", mode);
  return { bg: tokens["--bg"], fg: tokens["--ink"] };
}

export function accentPreview(accentId: string, mode: Mode): string {
  return themeTokens("okidoki", accentId, mode)["--ok-accent"];
}
