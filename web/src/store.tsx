import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Account, NativeState, Settings, Toast } from "./types";
import { useConvexSnapshot, useNativeState, invoke as nativeInvoke } from "./bridge";
import { demoState } from "./demo";

interface DashboardContextValue {
  state: NativeState;
  settings: Settings;
  account: Account;
  native: boolean;
  connected: boolean;
  convexConnected: boolean;
  toasts: Toast[];
  updateSettings: (patch: Partial<Settings>) => void;
  updateManySettings: (settings: Settings) => void;
  notify: (title: string, detail?: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  invoke: (type: string, payload?: Record<string, unknown>) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

function resolveTheme(appearance: Settings["appearance"]): "light" | "dark" {
  if (appearance === "dark") return "dark";
  if (appearance === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const { state: nativeState, connected, native } = useNativeState();
  const base = nativeState ?? demoState;
  const convex = useConvexSnapshot(
    nativeState?.currentAccountID ?? demoState.currentAccountID,
    nativeState?.settings.convexSiteURL ?? demoState.settings.convexSiteURL,
    Boolean(nativeState?.settings.syncEnabled),
  );
  const state = nativeState ?? convex.state ?? demoState;
  const [settings, setSettings] = useState<Settings>(state.settings);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pendingUntil = useRef(0);

  useEffect(() => {
    if (Date.now() > pendingUntil.current) setSettings(state.settings);
  }, [state.settings]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(settings.appearance);
      document.documentElement.style.colorScheme = resolveTheme(settings.appearance);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.appearance]);

  const account = useMemo(
    () => state.accounts.find((item) => item.id === state.currentAccountID) ?? state.accounts[0] ?? base.accounts[0],
    [state.accounts, state.currentAccountID, base.accounts],
  );

  const pushToast = useCallback((title: string, detail?: string, kind: Toast["kind"] = "success") => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-2), { id, title, detail, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5200);
  }, []);

  const invoke = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    nativeInvoke(type, payload);
  }, []);

  // the latest settings, so a quick second change builds on the first instead of a stale render
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    // side effects stay out of the state updater, which React may run more than once
    const next = { ...latestSettings.current, ...patch };
    latestSettings.current = next;
    pendingUntil.current = Date.now() + 900;
    setSettings(next);
    // only the changed keys: native merges them, so settings it changed meanwhile aren't overwritten
    nativeInvoke("updateSettings", { patch });
  }, []);

  const updateManySettings = useCallback((next: Settings) => {
    latestSettings.current = next;
    pendingUntil.current = Date.now() + 900;
    setSettings(next);
    nativeInvoke("updateSettings", { settings: next });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const value: DashboardContextValue = {
    state: { ...state, settings },
    settings,
    account,
    native,
    connected,
    convexConnected: convex.connected,
    toasts,
    updateSettings,
    updateManySettings,
    notify: pushToast,
    dismissToast,
    invoke,
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside DashboardProvider");
  return value;
}
