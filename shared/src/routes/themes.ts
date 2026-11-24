import { z } from 'zod';
import type { SavedTheme } from '../design-tokens';
import { MARKETPLACE_DESCRIPTION_MAX_LENGTH, MARKETPLACE_NAME_MAX_LENGTH, type MarketplaceTheme } from './marketplace';
import { APP_FONTS, CHAT_TEXT_SIZES, CODE_FONTS, WALLPAPER_EFFECTS } from './preferences';

export const updateThemeRequestSchema = z.object({ theme: z.string(), palette: z.string(), accent: z.string(), code: z.string() }).partial();
export type UpdateThemeRequest = z.infer<typeof updateThemeRequestSchema>;

export const publishThemeRequestSchema = updateThemeRequestSchema.extend({
  name: z.string().trim().min(1).max(MARKETPLACE_NAME_MAX_LENGTH),
  description: z.string().trim().max(MARKETPLACE_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  effect: z.enum(WALLPAPER_EFFECTS).optional(),
  app_font: z.enum(APP_FONTS).optional(),
  code_font: z.enum(CODE_FONTS).optional(),
  chat_text_size: z.enum(CHAT_TEXT_SIZES).optional(),
});
export type PublishThemeRequest = z.infer<typeof publishThemeRequestSchema>;

export type ThemeResponse = SavedTheme & { email: string };
export type PublishThemeResponse = { item: MarketplaceTheme; email: string };
