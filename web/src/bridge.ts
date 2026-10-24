import { useEffect, useState } from "react";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
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
  if (!previewState) previewState = structuredClone(demoState);
  const state = previewState;
  switch (type) {
    case "signIn": {
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
      state.keys = { ...state.keys, [payload.provider as string]: type === "saveKey" && Boolean(payload.value) };
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
    default:
      return false;
  }
  window.dispatchEvent(new CustomEvent<NativeState>("okidoki-native", { detail: state }));
  return true;
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

export function useNativeState(): { state: NativeState | null; connected: boolean } {
  const [state, setState] = useState<NativeState | null>(window.__okidokiState ?? null);
  const [connected, setConnected] = useState(Boolean(window.okidokiInvoke || window.webkit?.messageHandlers?.okidoki));

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NativeState>).detail;
      if (detail) {
        setState(detail);
        setConnected(true);
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

  return { state, connected };
}

let client: ConvexClient | null = null;
let clientURL = "";

function convexUrl(siteURL: string | undefined, enabled: boolean): string {
  const baked = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim();
  if (baked) return baked;
  if (!enabled || !siteURL) return "";
  return siteURL.replace(":3211", ":3210").replace(/\/$/, "");
}

export function useConvexSnapshot(accountId: string | undefined, siteURL: string | undefined, enabled: boolean): {
  state: NativeState | null;
  connected: boolean;
} {
  const [state, setState] = useState<NativeState | null>(null);
  const [connected, setConnected] = useState(false);
  const url = convexUrl(siteURL, enabled);

  useEffect(() => {
    if (!url || !accountId) return;
    try {
      if (!client || clientURL !== url) {
        // drop the old socket rather than leaving one open per URL tried
        void client?.close();
        client = new ConvexClient(url);
        clientURL = url;
      }
      const unsubscribe = client.onUpdate(
        anyApi.dashboard.bootstrap,
        { accountId },
        (data: unknown) => {
          const value = data as { state?: NativeState | string; updatedAt?: number } | null;
          if (!value?.state) return;
          const parsed = typeof value.state === "string" ? (JSON.parse(value.state) as NativeState) : value.state;
          if (parsed && Array.isArray(parsed.accounts)) {
            setState(parsed);
            setConnected(true);
          }
        },
        () => setConnected(false),
      );
      return () => unsubscribe();
    } catch (error) {
      console.warn("convex unavailable", error);
      setConnected(false);
    }
  }, [url, accountId]);

  return { state, connected };
}
