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
    case "deleteSkill": {
      state.skills = state.skills.filter((skill) => skill.id !== payload.id);
      break;
    }
    default:
      return false;
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
