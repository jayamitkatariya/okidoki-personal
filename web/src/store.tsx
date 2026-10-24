import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Account, NativeState, Settings, Toast } from "./types";
import { useNativeState, invoke as nativeInvoke } from "./bridge";
import { demoState } from "./demo";
import { Cloud, CLOUD_OFF, hostedConvexUrl, nativeConvexUrl, type CloudState } from "./cloud";
import { ENTERPRISE_OFF, type EnterpriseState } from "./enterprise";

interface DashboardContextValue {
  state: NativeState;
  settings: Settings;
  account: Account;
  native: boolean;
  connected: boolean;
  convexConnected: boolean;
  /** A browser build pointed at a deployment, with no Mac app around it: read-only, behind sign-in. */
  hosted: boolean;
  cloud: CloudState;
  /** The organization side of a work account. Off until sync is on and signed in. */
  enterprise: EnterpriseState;
  /** The space whose chat is open, remembered per account. */
  spaceId: string | null;
  selectSpace: (spaceId: string | null) => void;
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

const HOSTED_ACCOUNT_KEY = "okidoki.hostedAccount";
const SPACE_KEY = "okidoki.spaces";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

// The hosted panel sees only what the Mac synced, so everything that lives on the Mac
// (keys, permissions, installed tools) starts empty rather than borrowing demo values.
function fromCloud(cloud: CloudState, accountId: string): NativeState {
  const snapshot = cloud.snapshot ?? {};
  return {
    ...demoState,
    runs: [],
    threads: [],
    memories: [],
    skills: [],
    routines: [],
    connectors: [],
    tools: [],
    installedAgents: [],
    agents: [],
    keys: {},
    permissions: {},
    mcpStatus: {},
    mcpSecretNames: {},
    savings: 0,
    ...snapshot,
    // The snapshot's version is the Mac's schema number, not an app version; the other assistants' files aren't here.
    version: typeof snapshot.version === "string" ? snapshot.version : "",
    memorySources: [],
    settings: { ...demoState.settings, ...(snapshot.settings ?? {}) },
    accounts: cloud.accounts,
    currentAccountID: accountId,
    signedOut: false,
    inCall: false,
    onboardingOpen: false,
    dashboardOpen: true,
    sidecar: "on your Mac",
    convexConfigured: true,
  };
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const { state: nativeState, connected, native: bridged } = useNativeState();
  // A real Mac app is on the other end (not the demo fallback) and has sent its state.
  const native = bridged && Boolean(nativeState);
  // The bridge exists before the first snapshot. Don't treat that gap as the hosted sign-in screen.
  const hostedUrl = bridged ? "" : hostedConvexUrl();
  const hosted = Boolean(hostedUrl);
  const cloudUrl = native ? nativeConvexUrl(nativeState) : hostedUrl;

  const [cloud, setCloud] = useState<CloudState>(CLOUD_OFF);
  const [enterprise, setEnterprise] = useState<EnterpriseState>(ENTERPRISE_OFF);
  useEffect(() => {
    if (!cloudUrl) {
      setCloud(CLOUD_OFF);
      setEnterprise(ENTERPRISE_OFF);
    }
  }, [cloudUrl]);
  const [spaceIds, setSpaceIds] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(readStored(SPACE_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });

  const [hostedAccountId, setHostedAccountId] = useState<string | null>(() => readStored(HOSTED_ACCOUNT_KEY));
  const hostedAccount = hosted ? (cloud.accounts.find((item) => item.id === hostedAccountId) ?? cloud.accounts[0] ?? null) : null;

  // Built once per cloud change: a fresh object every render would re-trigger the settings effect below.
  const hostedState = useMemo(() => (hosted ? fromCloud(cloud, hostedAccount?.id ?? "") : null), [hosted, cloud, hostedAccount?.id]);
  const state: NativeState = native ? nativeState! : (hostedState ?? nativeState ?? demoState);
  const base = native || hosted ? state : demoState;
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
    () =>
      state.accounts.find((item) => item.id === state.currentAccountID) ??
      state.accounts[0] ??
      base.accounts[0] ?? { id: "", name: cloud.email ?? "you", email: cloud.email ?? "", kind: "personal" as const, colorHex: "44E45E", createdAt: "" },
    [state.accounts, state.currentAccountID, base.accounts, cloud.email],
  );

  const pushToast = useCallback((title: string, detail?: string, kind: Toast["kind"] = "success") => {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-2), { id, title, detail, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5200);
  }, []);

  // The hosted panel can't reach the Mac yet: it switches accounts and signs out locally, and says
  // so for anything that would need the Mac to act.
  const latestCloud = useRef(cloud);
  latestCloud.current = cloud;
  const invoke = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      if (!hosted) {
        nativeInvoke(type, payload);
        return;
      }
      if (type === "switchAccount" && typeof payload.id === "string") {
        setHostedAccountId(payload.id);
        writeStored(HOSTED_ACCOUNT_KEY, payload.id);
      } else if (type === "signOut") {
        void latestCloud.current.signOut();
      } else if (type !== "ready" && type !== "getState") {
        pushToast("Do this on your Mac", "This panel shows what your Mac synced. It can't act from here yet.", "info");
      }
    },
    [hosted, pushToast],
  );

  // the latest settings, so a quick second change builds on the first instead of a stale render
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      // side effects stay out of the state updater, which React may run more than once
      const next = { ...latestSettings.current, ...patch };
      latestSettings.current = next;
      pendingUntil.current = Date.now() + 900;
      // only the changed keys: native merges them, so settings it changed meanwhile aren't overwritten
      if (hosted) {
        // Appearance is the one setting the hosted panel keeps for itself; the rest live on the Mac.
        if (!("appearance" in patch)) {
          pushToast("Do this on your Mac", "This panel shows what your Mac synced. It can't act from here yet.", "info");
          return;
        }
        setSettings(next);
        return;
      }
      setSettings(next);
      nativeInvoke("updateSettings", { patch });
    },
    [hosted, pushToast],
  );

  const updateManySettings = useCallback(
    (next: Settings) => {
      latestSettings.current = next;
      pendingUntil.current = Date.now() + 900;
      if (hosted) {
        pushToast("Do this on your Mac", "This panel shows what your Mac synced. It can't act from here yet.", "info");
        return;
      }
      setSettings(next);
      nativeInvoke("updateSettings", { settings: next });
    },
    [hosted, pushToast],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const accountId = native ? (nativeState?.currentAccountID ?? null) : (hostedAccount?.id ?? null);
  const spaceId = accountId ? (spaceIds[accountId] ?? null) : null;
  const selectSpace = useCallback(
    (next: string | null) => {
      if (!accountId) return;
      setSpaceIds((current) => {
        const updated = { ...current };
        if (next) updated[accountId] = next;
        else delete updated[accountId];
        writeStored(SPACE_KEY, JSON.stringify(updated));
        return updated;
      });
    },
    [accountId],
  );

  const value: DashboardContextValue = {
    state: { ...state, settings },
    settings,
    account,
    native,
    connected,
    convexConnected: cloud.status === "signedIn" && Boolean(cloud.snapshot),
    hosted,
    cloud,
    enterprise,
    spaceId,
    selectSpace,
    toasts,
    updateSettings,
    updateManySettings,
    notify: pushToast,
    dismissToast,
    invoke,
  };

  return (
    <DashboardContext.Provider value={value}>
      {cloudUrl ? (
        <Cloud
          url={cloudUrl}
          accountId={accountId}
          claimAccounts={native ? (nativeState?.accounts ?? null) : null}
          spaceId={spaceId}
          onChange={setCloud}
          onEnterprise={setEnterprise}
        />
      ) : null}
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside DashboardProvider");
  return value;
}
