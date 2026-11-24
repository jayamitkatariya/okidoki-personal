import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Account, NativeState, Settings, Toast } from "./types";
import { useNativeState, invoke as nativeInvoke } from "./bridge";
import { applyTheme } from "./shell/theme";
import { demoState } from "./demo";

interface DashboardContextValue {
  state: NativeState;
  settings: Settings;
  account: Account;
  native: boolean;
  /** Inside the Mac app, before its first state arrives: nothing real to show yet. */
  booting: boolean;
  connected: boolean;
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
  const { state: nativeState, connected, native: bridged } = useNativeState();
  // A real Mac app is on the other end (not the demo fallback) and has sent its state.
  const native = bridged && Boolean(nativeState);
  const state: NativeState = native ? nativeState! : (nativeState ?? demoState);
  const base = native ? state : demoState;
  const [settings, setSettings] = useState<Settings>(state.settings);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pendingUntil = useRef(0);
  // Waiting on the Mac's first state, but never forever: after a moment, show what there is.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setPatient(false), 1500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (Date.now() > pendingUntil.current) setSettings(state.settings);
  }, [state.settings]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const root = document.documentElement;
      const theme = resolveTheme(settings.appearance);
      applyTheme(root, settings.palette, settings.accent, theme);
      const swap = () => {
        root.dataset.theme = theme;
        root.style.colorScheme = theme;
        // Kobra components key their dark styles off a `dark` class.
        root.classList.toggle("dark", theme === "dark");
      };
      // First paint and unchanged themes switch at once. A real change crossfades one snapshot of the
      // page (a view transition) instead of every surface running its own color transition at its own
      // speed, which is what made the switch feel like a hard cut.
      const changed = root.dataset.theme !== undefined && root.dataset.theme !== theme;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const start = (document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } }).startViewTransition;
      if (!changed || reduce || !start) {
        swap();
        return;
      }
      root.classList.add("theme-switching");
      start
        .call(document, swap)
        .finished.catch(() => undefined)
        .finally(() => root.classList.remove("theme-switching"));
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.appearance, settings.palette, settings.accent]);

  const account = useMemo(
    () =>
      state.accounts.find((item) => item.id === state.currentAccountID) ??
      state.accounts[0] ??
      base.accounts[0] ?? { id: "", name: "you", email: "", kind: "personal" as const, colorHex: "44E45E", createdAt: "" },
    [state.accounts, state.currentAccountID, base.accounts],
  );

  const pushToast = useCallback((title: string, detail?: string, kind: Toast["kind"] = "success") => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-2), { id, title, detail, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5200);
  }, []);

  const invoke = useCallback((type: string, payload: Record<string, unknown> = {}) => nativeInvoke(type, payload), []);

  // the latest settings, so a quick second change builds on the first instead of a stale render
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    // side effects stay out of the state updater, which React may run more than once
    const next = { ...latestSettings.current, ...patch };
    latestSettings.current = next;
    pendingUntil.current = Date.now() + 900;
    // only the changed keys: native merges them, so settings it changed meanwhile aren't overwritten
    setSettings(next);
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
    booting: bridged && !nativeState && patient,
    connected,
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
