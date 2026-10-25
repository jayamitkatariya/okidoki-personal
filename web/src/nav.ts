import type { AccountKind } from "./types";

export type Page = "home" | "runs" | "live" | "history" | "memory" | "skills" | "toolbox" | "settings" | "spaces" | "team" | "vault";

export interface NavItem {
  id: Page;
  title: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Shown only while a work account is selected. */
  enterprise?: boolean;
}

export const NAV: NavGroup[] = [
  {
    label: "workspace",
    items: [
      { id: "home", title: "Home", icon: "home" },
      { id: "runs", title: "Runs", icon: "runs" },
      { id: "live", title: "Live", icon: "eye" },
      { id: "history", title: "History", icon: "clock" },
    ],
  },
  {
    label: "knowledge",
    items: [
      { id: "memory", title: "Memory", icon: "memory" },
      { id: "skills", title: "Replay", icon: "record" },
    ],
  },
  {
    label: "enterprise",
    enterprise: true,
    items: [
      { id: "spaces", title: "Spaces", icon: "chat" },
      { id: "team", title: "Team", icon: "people" },
      { id: "vault", title: "Vault", icon: "lock" },
    ],
  },
  {
    label: "setup",
    items: [
      { id: "toolbox", title: "Toolbox", icon: "grid" },
      { id: "settings", title: "Settings", icon: "gear" },
    ],
  },
];

export const SECTION_META: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Home", subtitle: "What needs you, and what's moving" },
  runs: { title: "Runs", subtitle: "Live work and action previews" },
  live: { title: "Live", subtitle: "Watch okidoki drive, step by step" },
  history: { title: "History", subtitle: "Threads and past requests" },
  memory: { title: "Memory", subtitle: "What okidoki knows about you" },
  skills: { title: "Replay", subtitle: "Show it once, replay it forever" },
  toolbox: { title: "Toolbox", subtitle: "Free tools, agents and Apple apps" },
  settings: { title: "Settings", subtitle: "Input, voice, permissions, look" },
  spaces: { title: "Spaces", subtitle: "Group chats with colleagues, an agent and a worker" },
  team: { title: "Team", subtitle: "Your organization, its people and join codes" },
  vault: { title: "Vault", subtitle: "Confidential documents and shared logins" },
};

/** Routes that land on a Settings section rather than a page of their own. */
export const SETTINGS_ROUTES: Record<string, string> = { keys: "keys", sync: "sync-login" };

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

/** The sidebar for an account: the enterprise group appears only for a work account. */
export function navFor(kind: AccountKind): NavGroup[] {
  return NAV.filter((group) => !group.enterprise || kind === "work");
}

export function isPage(value: string): value is Page {
  return Object.prototype.hasOwnProperty.call(SECTION_META, value);
}

/** Whether a page is reachable for this account; enterprise pages need a work account. */
export function pageAvailable(page: Page, kind: AccountKind): boolean {
  return navFor(kind).some((group) => group.items.some((item) => item.id === page));
}
