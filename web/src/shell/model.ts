import type { BrowserTab, NativeState, Run, RunStatus, Thread } from "../types";
import { isPage, type Page } from "../nav";

/** What the content card is showing. */
export type View =
  | { kind: "home" }
  | { kind: "chat"; id: string }
  | { kind: "tab"; id: string }
  | { kind: "page"; page: LibraryPage };

/** Pages that open inside the content card. Home and Browser are views of their own now. */
export type LibraryPage = Exclude<Page, "home" | "browser">;

export const LIBRARY: Array<{ page: LibraryPage; title: string; icon: string; hint: string }> = [
  { page: "skills", title: "Replay", icon: "repeat", hint: "Show it once, replay it forever" },
  { page: "runs", title: "Computer", icon: "screen", hint: "Act runs on your Mac and what they wait on" },
  { page: "history", title: "History", icon: "clock", hint: "Every chat and request" },
  { page: "memory", title: "Memory", icon: "memory", hint: "What okidoki knows about you" },
  { page: "vault", title: "Vault", icon: "lock", hint: "Your documents and sealed logins" },
  { page: "settings", title: "Settings", icon: "gear", hint: "Keys, summon, safety, look" },
];

export function viewKey(view: View): string {
  switch (view.kind) {
    case "home":
      return "home";
    case "chat":
      return `chat/${view.id}`;
    case "tab":
      return `tab/${view.id}`;
    case "page":
      return view.page;
  }
}

/** Reads a hash route. `browser` (from the Mac: the agent opened a page) is resolved by the caller. */
export function parseView(raw: string): View | "browser" | { settingsSection: string } | null {
  const route = raw.replace(/^#?\/?/, "");
  if (!route || route === "home") return { kind: "home" };
  if (route === "browser") return "browser";
  if (route === "keys") return { settingsSection: "keys" };
  // Live is a tab of the Computer page in the new shell.
  if (route === "live") return { kind: "page", page: "runs" };
  const [head, ...rest] = route.split("/");
  const id = rest.join("/");
  if (head === "chat" && id) return { kind: "chat", id };
  if (head === "tab" && id) return { kind: "tab", id };
  if (isPage(head) && head !== "home" && head !== "browser") return { kind: "page", page: head as LibraryPage };
  return null;
}

export const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["running", "paused", "waiting", "previewing", "asked"]);
export const NEEDS_YOU: ReadonlySet<RunStatus> = new Set<RunStatus>(["waiting", "previewing", "asked"]);
export const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);

const time = (value?: string | null) => (value ? Date.parse(value) || 0 : 0);

/** A finished run the person hasn't looked at since it ended. */
export function runUnread(run: Run): boolean {
  if (!FINISHED.has(run.status) || run.status === "cancelled") return false;
  const ended = time(run.endedAt) || time(run.updatedAt) || time(run.createdAt);
  return ended > time(run.seenAt);
}

/** A thread okidoki replied in since the person last opened it. */
export function threadUnread(thread: Thread): boolean {
  const last = [...thread.messages].reverse().find((message) => message.role === "assistant");
  if (!last) return false;
  return time(last.createdAt) > time(thread.seenAt);
}

export interface ThreadInfo {
  thread: Thread;
  runs: Run[];
  /** The newest run still going, if any. */
  active: Run | null;
  needsYou: boolean;
  unread: boolean;
}

export function threadInfo(state: NativeState): ThreadInfo[] {
  const byThread = new Map<string, Run[]>();
  for (const run of state.runs) {
    if (!run.threadID) continue;
    const list = byThread.get(run.threadID) ?? [];
    list.push(run);
    byThread.set(run.threadID, list);
  }
  return state.threads
    .filter((thread) => !thread.archived)
    .map((thread) => {
      const runs = (byThread.get(thread.id) ?? []).sort((a, b) => time(b.createdAt) - time(a.createdAt));
      const active = runs.find((run) => ACTIVE.has(run.status)) ?? null;
      const needsYou = runs.some((run) => NEEDS_YOU.has(run.status));
      const unread = !active && (threadUnread(thread) || runs.some(runUnread));
      return { thread, runs, active, needsYou, unread };
    })
    .sort((a, b) => time(b.thread.updatedAt) - time(a.thread.updatedAt));
}

/** Tabs the sidebar lists: the person's pages, and the ones an agent or replay works in. Blank tabs are Home. */
export function splitTabs(tabs: BrowserTab[]): { mine: BrowserTab[]; agent: BrowserTab[] } {
  const visible = tabs.filter((tab) => !tab.blank || tab.ownerRunID || tab.status);
  return {
    mine: visible.filter((tab) => !tab.ownerRunID && !tab.status),
    agent: visible.filter((tab) => tab.ownerRunID || tab.status),
  };
}

/** "1m 1s" and "1h 4m": time spent working, ticking while it runs. */
export function workingFor(start: string | null | undefined, now: number, end?: string | null): string {
  const from = time(start);
  if (!from) return "";
  const seconds = Math.max(0, Math.floor(((end ? time(end) : now) - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface ActionLine {
  icon: string;
  text: string;
}

const ACTION_ICONS: Array<[RegExp, string]> = [
  [/\b(screenshot|captur)/i, "screen"],
  [/\b(sav(e|ing)|download|vault|file[ds]? )/i, "download"],
  [/\b(spawn|parallel|subagent|new tab)/i, "switch"],
  [/\b(remember|memory|history)/i, "clock"],
  [/\b(search|look(ing)? up|find)/i, "search"],
  [/\b(type|typing|fill|enter(ed)? )/i, "keyboard"],
  [/\b(click|press|tap|select|choose)/i, "cursor"],
  [/\b(scroll)/i, "scroll"],
  [/\b(open|navigat|visit|go to|load)/i, "globe"],
  [/\b(check|verif|read)/i, "eye"],
  [/\b(ask|question|wait)/i, "chat"],
];

/** The latest few things a run did, as the Recent tasks card lists them. From its step log, else its steps. */
export function actionLines(run: Run, limit = 3): ActionLine[] {
  const fromLog = run.output
    .split("\n")
    .map((line) => line.replace(/^[\s•·›➤⚙✓✔→-]+/, "").trim())
    .filter((line) => line.length > 2 && line.length < 200 && !/^(pass \d|step \d+\/\d+$)/i.test(line));
  const lines = fromLog.length ? fromLog : run.steps.filter((step) => step.status !== "previewing").map((step) => step.title);
  return lines.slice(-limit).map((text) => ({
    icon: ACTION_ICONS.find(([pattern]) => pattern.test(text))?.[1] ?? "spark",
    text: text.charAt(0).toUpperCase() + text.slice(1),
  }));
}

/** The host for a URL, without "www.". */
export function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Tab or bookmark label: the title, else the site. */
export function siteLabel(title: string, url: string): string {
  return title.trim() || hostOf(url) || "New tab";
}

/** Brings the person's text to a URL when it looks like one, as the address bar decides. */
export function looksLikeAddress(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^(https?|file|about):/i.test(value)) return true;
  if (/\s/.test(value)) return false;
  if (/^localhost(:\d+)?(\/|$)/i.test(value)) return true;
  return /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value);
}

/** Text that reads like a job for the agent rather than a search. */
export function looksLikeTask(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (value.split(/\s+/).length < 3) return false;
  return /^(please |can you |could you |go |find |book |order |buy |cancel |sign |fill |apply |download |compare |send |reply |check |add |make |get |open .* and |log ?in|unsubscribe)/.test(
    value,
  );
}
