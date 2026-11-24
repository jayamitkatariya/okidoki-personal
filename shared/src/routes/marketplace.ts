import { z } from 'zod';
import { ACCENTS, customMode, isCustomTheme, PALETTE_PRESETS, PALETTES, THEME_PREFERENCES, type Accent, type CustomTheme, type Mode, type Palette, type ThemeChange, type ThemePreference } from '../design-tokens';
import type { ManagerAvatar } from './manager';
import { APP_FONTS, CHAT_TEXT_SIZES, CODE_FONTS, DEFAULT_USER_PREFERENCES, WALLPAPER_EFFECTS, type ServedUserPreferences, type ServedWallpaper } from './preferences';

export const MARKETPLACE_KINDS = ['theme', 'avatar'] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];

export const MARKETPLACE_NAME_MAX_LENGTH = 40;
export const MARKETPLACE_DESCRIPTION_MAX_LENGTH = 200;
const MARKETPLACE_REPORT_MAX_LENGTH = 500;

export const themeColorsSchema = z.object({
  palette: z.custom<Palette>((value) => PALETTES.some((palette) => palette === value)),
  accent: z.custom<Accent>((value) => ACCENTS.some((accent) => accent === value)),
  custom: z.custom<CustomTheme>(isCustomTheme),
});
export type ThemeColors = z.infer<typeof themeColorsSchema>;

const wallpaperSchema = z.object({ key: z.string(), effect: z.enum(WALLPAPER_EFFECTS) });

export function themeModes({ palette, custom }: ThemeColors): Mode[] {
  return palette === 'custom' ? [customMode(custom)] : (['light', 'dark'] as const).filter((mode) => PALETTE_PRESETS[mode].some((name) => name === palette));
}

/** The mode a theme can really use: `system` needs colors for both, and colors for one mode force it. */
export function themeMode(colors: ThemeColors, mode: ThemePreference | undefined): ThemePreference {
  const modes = themeModes(colors);
  if (modes.length === 1) return modes[0];
  return mode ?? 'system';
}

const themeSettingsShape = {
  colors: themeColorsSchema,
  mode: z.enum(THEME_PREFERENCES),
  chat_text_size: z.enum(CHAT_TEXT_SIZES),
  app_font: z.enum(APP_FONTS),
  code_font: z.enum(CODE_FONTS),
};

// Themes published before they carried a mode and fonts get the ones they implied.
export const themeContentSchema = z.object({
  ...themeSettingsShape,
  mode: themeSettingsShape.mode.optional(),
  chat_text_size: themeSettingsShape.chat_text_size.default(DEFAULT_USER_PREFERENCES.chat_text_size),
  app_font: themeSettingsShape.app_font.default(DEFAULT_USER_PREFERENCES.app_font),
  code_font: themeSettingsShape.code_font.default(DEFAULT_USER_PREFERENCES.code_font),
  wallpaper: wallpaperSchema.nullable(),
}).transform((content) => ({ ...content, mode: themeMode(content.colors, content.mode) }));
export type MarketplaceThemeContent = z.infer<typeof themeContentSchema>;

export function themeChange({ colors, mode }: Pick<MarketplaceThemeContent, 'colors' | 'mode'>): ThemeChange {
  const usesCustom = colors.palette === 'custom' || colors.accent === 'custom';
  return { palette: colors.palette, accent: colors.accent, ...(usesCustom && { custom: colors.custom }), theme: themeMode(colors, mode) };
}

const publishBase = {
  name: z.string().trim().min(1).max(MARKETPLACE_NAME_MAX_LENGTH),
  description: z.string().trim().max(MARKETPLACE_DESCRIPTION_MAX_LENGTH).nullable(),
};

/** `wallpaper.key` is `null` for the image uploaded with the request, otherwise the publisher's own wallpaper or the theme's current one. */
const themeFields = { ...publishBase, ...themeSettingsShape, wallpaper: z.object({ key: z.string().nullable(), effect: z.enum(WALLPAPER_EFFECTS) }).nullable() };
export const updateMarketplaceThemeSchema = z.object(themeFields);
export type UpdateMarketplaceThemeRequest = z.infer<typeof updateMarketplaceThemeSchema>;

export const publishMarketplaceItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('theme'), ...themeFields }),
  z.object({ kind: z.literal('avatar'), ...publishBase, workspace_id: z.string().uuid() }),
]);
export type PublishMarketplaceItemRequest = z.infer<typeof publishMarketplaceItemSchema>;

export const reportMarketplaceItemSchema = z.object({ reason: z.string().trim().min(1).max(MARKETPLACE_REPORT_MAX_LENGTH) });

interface MarketplaceItemBase {
  id: string;
  name: string;
  description: string | null;
  /** `null` for the ones Okidoki made. */
  author_name: string | null;
  add_count: number;
  added: boolean;
  mine: boolean;
  created_at: string;
}

export type MarketplaceItem = MarketplaceItemBase & (
  | { kind: 'theme'; content: Omit<MarketplaceThemeContent, 'wallpaper'> & { wallpaper: ServedWallpaper | null } }
  | { kind: 'avatar'; content: ManagerAvatar }
);
export type MarketplaceTheme = Extract<MarketplaceItem, { kind: 'theme' }>;
export type MarketplaceAvatar = Extract<MarketplaceItem, { kind: 'avatar' }>;

export interface ListMarketplaceItemsResponse {
  items: MarketplaceItem[];
}

export interface ManagerAvatarSource {
  id: string;
  name: string;
  avatar: ManagerAvatar;
}

export interface ListManagerAvatarSourcesResponse {
  managers: ManagerAvatarSource[];
}

export interface MarketplaceItemResponse {
  item: MarketplaceItem;
}

export interface ApplyMarketplaceThemeResponse {
  item: MarketplaceTheme;
  preferences: ServedUserPreferences;
}

interface AdminMarketplaceReport {
  id: string;
  item_id: string;
  item_name: string;
  item_kind: MarketplaceKind;
  item_hidden: boolean;
  reporter_email: string | null;
  reason: string;
  created_at: string;
}

export interface AdminListMarketplaceReportsResponse {
  reports: AdminMarketplaceReport[];
}

export const adminUpdateMarketplaceItemSchema = z.object({ hidden: z.boolean() });
