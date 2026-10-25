import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConvexReactClient, useConvexAuth, useMutation, useQuery } from "convex/react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { anyApi } from "convex/server";
import type { Account, NativeState } from "./types";
import { EnterpriseBridge, type EnterpriseState } from "./enterprise";
import { invoke } from "./bridge";

// Sign-in for sync and the hosted panel, through Convex Auth on the person's own deployment.
// Without a Convex URL none of this mounts, and okidoki stays fully local.

export type CloudStatus = "off" | "loading" | "signedOut" | "signedIn";
export type CloudFlow = "signIn" | "signUp";

export interface CloudState {
  status: CloudStatus;
  email: string | null;
  /** Accounts this login owns (the hosted panel's switcher). */
  accounts: Account[];
  /** The synced snapshot for the current account, as the Mac sent it. */
  snapshot: Partial<NativeState> | null;
  /** Accounts on this Mac that another login already owns. */
  taken: string[];
  signIn: (email: string, password: string, flow: CloudFlow) => Promise<void>;
  signOut: () => Promise<void>;
}

export const CLOUD_OFF: CloudState = {
  status: "off",
  email: null,
  accounts: [],
  snapshot: null,
  taken: [],
  signIn: async () => {
    throw new Error("Turn on sync first.");
  },
  signOut: async () => {},
};

export const CONVEX_CLOUD_URL = "https://wonderful-rook-611.convex.cloud";

/** The Convex client URL. Dev preview stays local unless VITE_CONVEX_URL is set. */
export function hostedConvexUrl(): string {
  const fromEnv = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim() ?? "";
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "";
  return CONVEX_CLOUD_URL;
}

/** Inside the Mac app: the deployment's client URL, while sync is on. */
export function nativeConvexUrl(state: NativeState | null): string {
  if (!state?.settings.syncEnabled || !state.settings.convexSiteURL) return "";
  const site = state.settings.convexSiteURL.replace(/\/$/, "");
  // Cloud HTTP actions live on .convex.site; the client talks to .convex.cloud.
  if (site.includes(".convex.site")) return site.replace(".convex.site", ".convex.cloud");
  // Self-hosted: the Mac stores the HTTP actions port (:3211); the client uses :3210.
  return site.replace(":3211", ":3210");
}

// One client per deployment for the page's lifetime. Closing it on unmount breaks React's
// development double-mount (the memoized client would be reused after close), so only a URL change closes it.
let shared: { url: string; client: ConvexReactClient } | null = null;
function clientFor(url: string): ConvexReactClient {
  if (shared?.url === url) return shared.client;
  void shared?.client.close();
  shared = { url, client: new ConvexReactClient(url) };
  return shared.client;
}

export function Cloud(props: {
  url: string;
  accountId: string | null;
  claimAccounts: Account[] | null;
  spaceId: string | null;
  onChange: (state: CloudState) => void;
  onEnterprise: (state: EnterpriseState) => void;
}) {
  const client = clientFor(props.url);
  return (
    <ConvexAuthProvider client={client} storageNamespace={props.url}>
      <CloudBridge accountId={props.accountId} claimAccounts={props.claimAccounts} onChange={props.onChange} />
      <EnterpriseBridge accountId={props.accountId} spaceId={props.spaceId} onChange={props.onEnterprise} />
    </ConvexAuthProvider>
  );
}

function CloudBridge({ accountId, claimAccounts, onChange }: { accountId: string | null; claimAccounts: Account[] | null; onChange: (state: CloudState) => void }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const actions = useAuthActions();
  const me = useQuery(anyApi.accounts.me, isAuthenticated ? {} : "skip") as { id: string; email: string } | null | undefined;
  const mine = useQuery(anyApi.accounts.mine, isAuthenticated ? {} : "skip") as Account[] | undefined;
  const boot = useQuery(anyApi.dashboard.bootstrap, isAuthenticated && accountId ? { accountId } : "skip") as
    | { state: Partial<NativeState> | string | null }
    | null
    | undefined;
  const claim = useMutation(anyApi.accounts.claim);
  const [taken, setTaken] = useState<string[]>([]);
  const claimedFor = useRef("");

  // Inside the Mac app, signing in links this Mac's accounts to the login (once per login and account set).
  useEffect(() => {
    if (!me || !claimAccounts?.length) return;
    const key = `${me.id}:${claimAccounts.map((account) => account.id).join(",")}`;
    if (claimedFor.current === key) return;
    claimedFor.current = key;
    const accounts = claimAccounts.map(({ id, name, email, kind, colorHex, createdAt }) => ({ id, name, email, kind, colorHex, createdAt }));
    void claim({ accounts }).then((result: { taken: string[] }) => setTaken(result.taken));
  }, [me, claimAccounts, claim]);

  // Inside the Mac app: accounts this login owns that another Mac created come here too, so their threads
  // and memory sync in. A reinstalled Mac gets its accounts back the same way.
  const adoptedFor = useRef("");
  useEffect(() => {
    if (!me || !mine || !claimAccounts) return;
    const here = new Set(claimAccounts.map((account) => account.id));
    const missing = mine.filter((account) => !here.has(account.id));
    if (!missing.length) return;
    const key = `${me.id}:${missing.map((account) => account.id).sort().join(",")}`;
    if (adoptedFor.current === key) return;
    adoptedFor.current = key;
    invoke("adoptAccounts", { accounts: missing.map(({ id, name, email, kind, colorHex, createdAt }) => ({ id, name, email, kind, colorHex, createdAt })) });
  }, [me, mine, claimAccounts]);

  // Stable callbacks over the latest actions, so reporting state up doesn't loop on a new identity each render.
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const signIn = useCallback(async (email: string, password: string, flow: CloudFlow) => {
    try {
      await latestActions.current.signIn("password", { email: email.trim().toLowerCase(), password, flow });
    } catch (error) {
      console.warn("[okidoki] sign-in failed", error);
      throw new Error(friendlyError(error, flow));
    }
  }, []);
  const signOut = useCallback(async () => {
    claimedFor.current = "";
    await latestActions.current.signOut();
  }, []);

  const snapshot = useMemo(() => {
    const raw = boot?.state;
    if (!raw) return null;
    try {
      return typeof raw === "string" ? (JSON.parse(raw) as Partial<NativeState>) : raw;
    } catch {
      return null;
    }
  }, [boot]);

  // Both queries must land before "signed in", or the shell briefly says no Mac is linked.
  const status: CloudStatus = isLoading || (isAuthenticated && (me === undefined || mine === undefined)) ? "loading" : isAuthenticated ? "signedIn" : "signedOut";
  useEffect(() => {
    onChange({ status, email: me?.email ?? null, accounts: mine ?? [], snapshot, taken, signIn, signOut });
  }, [status, me, mine, snapshot, taken, signIn, signOut, onChange]);

  return null;
}

// Convex Auth reports failures with terse codes; say what to do instead. Only a real credential
// error says "don't match" — anything else is a connection problem, not the person's typing.
function friendlyError(error: unknown, flow: CloudFlow): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists/i.test(message)) return "There's already a login with that email. Sign in instead.";
  if (/InvalidAccountId|InvalidSecret|Invalid credentials/i.test(message)) return "That email and password don't match.";
  if (/TooManyFailedAttempts/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  if (/password/i.test(message) && flow === "signUp") return "Use a password of at least 8 characters.";
  return "Couldn't reach your Convex deployment. Check that it's running and try again.";
}
