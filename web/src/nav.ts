import type { AccountKind } from "./types";

export type Page = "home" | "runs" | "live" | "history" | "memory" | "notes" | "reminders" | "skills" | "vault" | "terminal" | "toolbox" | "settings";

export interface NavItem {
  id: Page;
  title: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

// Ordered by how often you reach for each page: the daily tools first, setup last.
// Settings isn't here; it's pinned to the bottom of the sidebar so it never scrolls away.
export const NAV: NavGroup[] = [
  {
    label: "workspace",
    items: [
      { id: "home", title: "Home", icon: "home" },
      { id: "skills", title: "Replay", icon: "record" },
      { id: "notes", title: "Notes", icon: "note" },
      { id: "reminders", title: "Reminders", icon: "bell" },
      { id: "terminal", title: "Terminal", icon: "terminal" },
    ],
  },
  {
    label: "activity",
    items: [
      { id: "runs", title: "Runs", icon: "runs" },
      { id: "live", title: "Live", icon: "eye" },
      { id: "history", title: "History", icon: "clock" },
    ],
  },
  {
    label: "library",
    items: [
      { id: "memory", title: "Memory", icon: "memory" },
      { id: "vault", title: "Vault", icon: "lock" },
      { id: "toolbox", title: "Toolbox", icon: "grid" },
    ],
  },
];

/** Pinned under the groups. */
export const SETTINGS_ITEM: NavItem = { id: "settings", title: "Settings", icon: "gear" };

/** Pages that only earn a sidebar row while they have something to show. */
export const ON_DEMAND: ReadonlySet<Page> = new Set<Page>(["live"]);

export const SECTION_META: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Home", subtitle: "What needs you, and what's moving" },
  runs: { title: "Runs", subtitle: "Live work and action previews" },
  live: { title: "Live", subtitle: "Watch okidoki drive, step by step" },
  history: { title: "History", subtitle: "Threads and past requests" },
  memory: { title: "Memory", subtitle: "What okidoki knows about you" },
  skills: { title: "Replay", subtitle: "Show it once, replay it forever" },
  toolbox: { title: "Toolbox", subtitle: "Free tools, connectors and MCP servers" },
  settings: { title: "Settings", subtitle: "Keys, permissions, voice, safety, look" },
  vault: { title: "Vault", subtitle: "Your documents folder and sealed logins" },
  terminal: { title: "Terminal", subtitle: "Plain English in, reviewed commands out, plus your coding agents" },
  notes: { title: "Notes", subtitle: "Jot it down; okidoki can find it later" },
  reminders: { title: "Reminders", subtitle: "okidoki taps you on the shoulder, or does the chore itself" },
};

/** Routes that land on a Settings section rather than a page of their own. */
export const SETTINGS_ROUTES: Record<string, string> = { keys: "keys" };

/** Asks the Settings page to scroll to a section. Resolves "keys" and friends to the page they live on. */
export function resolveRoute(route: string): { page: string; section?: string } {
  const section = SETTINGS_ROUTES[route];
  return section ? { page: "settings", section } : { page: route };
}

export const SETTINGS_JUMP_EVENT = "okidoki-settings-jump";

export function jumpToSettingsSection(section: string) {
  // Let the page mount first when it's not the current one.
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(SETTINGS_JUMP_EVENT, { detail: section })), 60);
}

/** The sidebar groups. Every account sees the same pages. */
export function navFor(_kind?: AccountKind): NavGroup[] {
  return NAV;
}

/** The group a page sits in, for the breadcrumb. */
export function groupOf(page: Page): string {
  if (page === SETTINGS_ITEM.id) return "setup";
  return NAV.find((group) => group.items.some((item) => item.id === page))?.label ?? "workspace";
}

export function isPage(value: string): value is Page {
  return Object.prototype.hasOwnProperty.call(SECTION_META, value);
}

/** Whether a page is in the sidebar. */
export function pageAvailable(page: Page, kind?: AccountKind): boolean {
  return page === SETTINGS_ITEM.id || navFor(kind).some((group) => group.items.some((item) => item.id === page));
}
