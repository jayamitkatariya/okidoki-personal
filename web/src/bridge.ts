import { useEffect, useState } from "react";
import type { Account, AccountKind, McpServer, NativeState, Settings } from "./types";
import { demoState } from "./demo";

declare global {
  interface Window {
    okidokiInvoke?: (type: string, payload?: Record<string, unknown>) => void;
    okidokiNative?: (payload: NativeState) => void;
    __okidokiState?: NativeState;
    webkit?: {
      messageHandlers: {
        okidoki: { postMessage: (message: unknown) => void };
      };
    };
  }
}

// Browser preview: no native body. Handle the core flows locally so the preview
// stays explorable — sign in, add an account, sign out, tweak settings.
let previewState: NativeState | null = null;

function previewInvoke(type: string, payload: Record<string, unknown>): boolean {
  // Publish a new snapshot each time: mutating the last event's object causes
  // React to ignore later account changes because its identity hasn't changed.
  const state = structuredClone(previewState ?? demoState);
  switch (type) {
    case "signIn":
    case "switchAccount": {
      const id = payload.id as string | undefined;
      if (!id || !state.accounts.some((account) => account.id === id)) return false;
      state.currentAccountID = id;
      state.signedOut = false;
      break;
    }
    case "createAccount": {
      const account: Account = {
        id: `acct-${Math.random().toString(16).slice(2, 8)}`,
        name: (payload.name as string) || "You",
        email: (payload.email as string) ?? "",
        kind: (payload.kind as AccountKind) ?? "personal",
        colorHex: "44E45E",
        createdAt: new Date().toISOString(),
      };
      state.accounts = [...state.accounts, account];
      state.currentAccountID = account.id;
      state.signedOut = false;
      break;
    }
    case "signOut": {
      state.signedOut = true;
      break;
    }
    case "updateSettings": {
      state.settings = { ...state.settings, ...((payload.patch ?? payload.settings) as Partial<Settings>) };
      break;
    }
    case "setConnector": {
      state.connectors = state.connectors.map((connector) => (connector.id === payload.id ? { ...connector, enabled: Boolean(payload.enabled) } : connector));
      break;
    }
    case "installAgentSkill": {
      state.agentSkill = { installed: true, cli: true, paths: ["~/.claude/skills/okidoki/SKILL.md", "~/.agents/skills/okidoki/SKILL.md"] };
      break;
    }
    case "rescanCodingAgents":
    case "pickCodingAgentFolder":
      break;
    case "uninstallAgentSkill": {
      state.agentSkill = { installed: false, cli: state.agentSkill?.cli ?? false, paths: [] };
      break;
    }
    case "saveKey":
    case "deleteKey": {
      const provider = payload.provider as string;
      const set = type === "saveKey" && Boolean(payload.value);
      state.keys = { ...state.keys, [provider]: set };
      state.keyProviders = state.keyProviders?.map((item) => (item.id === provider ? { ...item, set: set || item.builtin } : item));
      break;
    }
    case "saveMcpServer": {
      const server = payload.server as McpServer;
      const exists = state.settings.mcpServers.some((item) => item.id === server.id);
      state.settings = {
        ...state.settings,
        mcpServers: exists ? state.settings.mcpServers.map((item) => (item.id === server.id ? server : item)) : [...state.settings.mcpServers, server],
      };
      const secrets = payload.secrets as { env?: Record<string, string>; headers?: Record<string, string> } | undefined;
      if (secrets) state.mcpSecretNames = { ...state.mcpSecretNames, [server.id]: [...Object.keys(secrets.env ?? {}), ...Object.keys(secrets.headers ?? {})].sort() };
      // No real server to reach in the preview: pretend it answered with one tool.
      state.mcpStatus = { ...state.mcpStatus, [server.id]: { id: server.id, ok: true, tools: [{ name: "ping", description: "Preview stand-in" }] } };
      break;
    }
    case "deleteMcpServer": {
      state.settings = { ...state.settings, mcpServers: state.settings.mcpServers.filter((item) => item.id !== payload.id) };
      break;
    }
    case "startWatching": {
      state.watching = {
        recording: true,
        startedAt: new Date().toISOString(),
        name: (payload.name as string) ?? "",
        steps: [
          { id: "live-1", text: "switch to Safari", app: "Safari", action: "switch", delay: 0.3 },
          { id: "live-2", text: "in Safari, click “Address and Search”", app: "Safari", action: "click", label: "Address and Search", x: 640, y: 60, delay: 1.2 },
          { id: "live-3", text: "in Safari, type “weather”", app: "Safari", action: "type", input: "weather", delay: 0.9 },
          { id: "live-4", text: "in Safari, press ↩", app: "Safari", action: "key", input: "return", delay: 0.4 },
        ],
        replaying: false,
      };
      break;
    }
    case "stopWatching": {
      const live = state.watching;
      if (live?.recording) {
        state.skills = [
          {
            id: `skill-${Math.random().toString(16).slice(2, 8)}`,
            accountID: state.currentAccountID,
            name: live.name || "safari flow",
            summary: `${live.steps.length} steps in Safari`,
            steps: live.steps,
            createdAt: new Date().toISOString(),
            source: "watch me",
            runCount: 0,
          },
          ...state.skills,
        ];
      }
      state.watching = { recording: false, startedAt: null, name: "", steps: [], replaying: false };
      break;
    }
    case "discardWatching": {
      state.watching = { recording: false, startedAt: null, name: "", steps: [], replaying: false };
      break;
    }
    case "renameSkill": {
      state.skills = state.skills.map((skill) => (skill.id === payload.id ? { ...skill, name: (payload.name as string) || skill.name } : skill));
      break;
    }
    case "openBrowser": {
      // No browser window in the preview: hand back a finished stand-in run so the page has something to show.
      state.runs = [
        {
          id: `run-${Math.random().toString(16).slice(2, 8)}`,
          accountID: state.currentAccountID,
          kind: "browser",
          title: "opened the browser",
          prompt: "",
          status: "done",
          steps: [],
          output: "",
          summary: "Preview stand-in",
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
        ...state.runs,
      ];
      break;
    }
    case "vaultImportSources": {
      if (state.vaultImport) state.vaultImport = { ...state.vaultImport, scanned: true, scanning: false };
      break;
    }
    case "vaultImportBrowser":
    case "vaultImportCSV": {
      // No Keychain or files in the preview: report a stand-in result so the flow can be explored.
      if (!state.vaultImport) return false;
      const browser = state.vaultImport.sources.find((source) => source.id === payload.browser);
      const csv = type === "vaultImportCSV";
      state.vaultImport = {
        ...state.vaultImport,
        busy: null,
        last: { source: csv ? "Passwords.csv" : (browser?.name ?? "browser"), imported: csv ? 12 : (browser?.logins ?? 0), updated: 0, skipped: 2, errors: [], finishedAt: new Date().toISOString() },
        csvToTrash: csv ? "Passwords.csv" : state.vaultImport.csvToTrash,
      };
      break;
    }
    case "vaultImportCookies": {
      if (!state.vaultImport) return false;
      const browser = state.vaultImport.sources.find((source) => source.id === payload.browser);
      state.vaultImport = {
        ...state.vaultImport,
        cookiesBusy: null,
        lastCookies: { source: browser?.name ?? "browser", cookies: 840, sites: 61, skipped: 12, errors: [], finishedAt: new Date().toISOString() },
      };
      break;
    }
    case "vaultImportTrashCSV": {
      if (state.vaultImport) state.vaultImport = { ...state.vaultImport, csvToTrash: null };
      break;
    }
    case "deleteSkill": {
      state.skills = state.skills.filter((skill) => skill.id !== payload.id);
      break;
    }
    // Pins and bookmarks, as OkidokiStore keeps them, so the sidebar's drags and menus work in the preview.
    case "pinSite":
    case "pinTab": {
      const tab = state.browser?.tabs.find((item) => item.id === payload.tabID);
      const url = (payload.url as string | undefined) ?? tab?.address;
      if (!url) return false;
      const host = previewHost(url);
      const pins = state.pins ?? [];
      if (pins.some((pin) => previewHost(pin.url) === host)) return false;
      if (pins.length >= 12) return false;
      const pin = { id: `pin-${Math.random().toString(16).slice(2, 8)}`, url, title: (payload.title as string) || tab?.title || host, createdAt: new Date().toISOString() };
      const index = typeof payload.index === "number" && payload.index >= 0 && payload.index < pins.length ? payload.index : pins.length;
      state.pins = [...pins.slice(0, index), pin, ...pins.slice(index)];
      break;
    }
    case "unpin": {
      state.pins = (state.pins ?? []).filter((pin) => pin.id !== payload.id);
      break;
    }
    case "reorderPins": {
      const ids = [...new Set(payload.ids as string[])];
      const pins = state.pins ?? [];
      state.pins = [...ids.map((id) => pins.find((pin) => pin.id === id)).filter((pin) => pin !== undefined), ...pins.filter((pin) => !ids.includes(pin.id))];
      break;
    }
    case "addBookmark":
    case "toggleBookmark": {
      const tab = state.browser?.tabs.find((item) => item.id === payload.tabID);
      const url = (payload.url as string | undefined) ?? tab?.address;
      if (!url) return false;
      const bookmarks = state.bookmarks ?? [];
      const existing = bookmarks.find((item) => item.url === url);
      if (existing) {
        if (type === "addBookmark") return false;
        state.bookmarks = bookmarks.filter((item) => item !== existing);
      } else {
        const bookmark = { id: `bm-${Math.random().toString(16).slice(2, 8)}`, url, title: (payload.title as string) || tab?.title || previewHost(url), createdAt: new Date().toISOString() };
        const index = Math.min(Math.max(typeof payload.index === "number" ? payload.index : 0, 0), bookmarks.length);
        state.bookmarks = [...bookmarks.slice(0, index), bookmark, ...bookmarks.slice(index)];
      }
      break;
    }
    case "removeBookmark": {
      state.bookmarks = (state.bookmarks ?? []).filter((item) => item.id !== payload.id);
      break;
    }
    case "browserOpen": {
      if (!state.browser || typeof payload.url !== "string") return false;
      const url = payload.url;
      const tab = { ...state.browser.tabs[0], id: `tab-${Math.random().toString(16).slice(2, 8)}`, number: state.browser.tabs.length + 1, title: previewHost(url), address: url, host: previewHost(url), loading: false, blank: false, status: null, ownerRunID: null, threadID: null, canGoBack: false, canGoForward: false, hasLogin: false, loadError: null };
      state.browser = { ...state.browser, tabs: [...state.browser.tabs, tab], activeID: tab.id };
      break;
    }
    case "browserClose": {
      if (!state.browser) return false;
      state.browser = { ...state.browser, tabs: state.browser.tabs.filter((tab) => tab.id !== payload.tabID) };
      break;
    }
    default:
      return false;
  }
  if (state.browser) {
    const saved = new Set((state.bookmarks ?? []).map((item) => item.url));
    state.browser = { ...state.browser, tabs: state.browser.tabs.map((tab) => ({ ...tab, bookmarked: saved.has(tab.address) })) };
  }
  previewState = state;
  window.dispatchEvent(new CustomEvent<NativeState>("okidoki-native", { detail: state }));
  return true;
}

/** Inside the Mac app, where native views (the browser) can sit on the page. */
export function isNative(): boolean {
  return Boolean(window.webkit?.messageHandlers?.okidoki);
}

export function invoke(type: string, payload: Record<string, unknown> = {}): void {
  if (window.okidokiInvoke) {
    window.okidokiInvoke(type, payload);
    return;
  }
  if (window.webkit?.messageHandlers?.okidoki) {
    window.webkit.messageHandlers.okidoki.postMessage({ type, payload });
    return;
  }
  if (previewInvoke(type, payload)) return;
  console.info("[okidoki]", type, payload);
}

export function hasNativeBridge(): boolean {
  return Boolean(window.okidokiInvoke || window.webkit?.messageHandlers?.okidoki);
}

export function useNativeState(): { state: NativeState | null; connected: boolean; native: boolean } {
  const [state, setState] = useState<NativeState | null>(window.__okidokiState ?? null);
  const native = hasNativeBridge();
  const [connected, setConnected] = useState(native);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NativeState>).detail;
      if (detail) {
        setState(detail);
        setConnected(hasNativeBridge());
      }
    };
    window.addEventListener("okidoki-native", handler);
    invoke("ready");
    const timer = window.setTimeout(() => {
      setConnected((value) => {
        if (!value) {
          setState((current) => current ?? demoState);
        }
        return value;
      });
    }, 450);
    return () => {
      window.removeEventListener("okidoki-native", handler);
      window.clearTimeout(timer);
    };
  }, []);

  return { state, connected, native };
}

function previewHost(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
