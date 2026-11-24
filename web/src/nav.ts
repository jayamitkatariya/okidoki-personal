/** The places the shell can route to. Most are library pages; "home", "browser" and "live" map onto Home, a tab and Computer. */
export type Page = "home" | "browser" | "runs" | "live" | "history" | "memory" | "skills" | "automations" | "vault" | "settings";

const PAGES: ReadonlySet<string> = new Set<Page>(["home", "browser", "runs", "live", "history", "memory", "skills", "automations", "vault", "settings"]);

export function isPage(value: string): value is Page {
  return PAGES.has(value);
}

export const SETTINGS_JUMP_EVENT = "okidoki-settings-jump";

/** Asks the Settings page to scroll to a section. */
export function jumpToSettingsSection(section: string) {
  // Let the page mount first when it's not the current one.
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(SETTINGS_JUMP_EVENT, { detail: section })), 60);
}
