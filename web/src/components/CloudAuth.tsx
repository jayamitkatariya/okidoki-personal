import { useState } from "react";
import { useDashboard } from "../store";
import type { CloudFlow } from "../cloud";
import { Button, Logo, PixelIcon, TextField } from "./ui";

// Email + password for the sync login. One form, used by the hosted sign-in screen and Settings › Account.
function CredentialsForm({ submitLabel }: { submitLabel?: (flow: CloudFlow) => string }) {
  const { cloud } = useDashboard();
  const [flow, setFlow] = useState<CloudFlow>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = /\S+@\S+\.\S+/.test(email) && password.length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await cloud.signIn(email, password, flow);
      setPassword("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack cloud-form">
      <label className="form-label">Email</label>
      <TextField value={email} onChange={setEmail} placeholder="you@example.com" type="email" icon="user" />
      <label className="form-label">Password</label>
      <TextField
        value={password}
        onChange={setPassword}
        placeholder={flow === "signUp" ? "At least 8 characters" : "Your password"}
        type="password"
        icon="lock"
        onEnter={submit}
      />
      {error ? <p className="cloud-error">{error}</p> : null}
      <Button variant="primary" disabled={!ready} onClick={submit}>
        {busy ? "One moment…" : (submitLabel?.(flow) ?? (flow === "signIn" ? "Sign in" : "Create login"))}
      </Button>
      <button
        className="auth-link"
        onClick={() => {
          setFlow(flow === "signIn" ? "signUp" : "signIn");
          setError("");
        }}
      >
        {flow === "signIn" ? "New here? Create a login" : "Already have a login? Sign in"}
      </button>
    </div>
  );
}

/** The hosted panel's front door: sign in, or explain how to link a Mac. */
export function CloudSignIn() {
  const { cloud } = useDashboard();
  const signedIn = cloud.status === "signedIn";
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={44} glow />
          <h1>{signedIn ? "Almost there" : "Welcome back"}</h1>
          <p>
            {cloud.status === "loading"
              ? "Checking your login…"
              : signedIn
                ? "This login has no Mac linked yet."
                : "Sign in to see what your Mac is up to."}
          </p>
        </div>
        {cloud.status === "signedOut" ? <CredentialsForm /> : null}
        {signedIn ? (
          <>
            <p className="cloud-steps">
              On your Mac, open okidoki › Settings › Sync login and sign in as <strong>{cloud.email}</strong>. Its accounts show up here after the next
              sync.
            </p>
            <Button variant="secondary" onClick={() => void cloud.signOut()}>
              Sign out
            </Button>
          </>
        ) : null}
        <div className="auth-note">
          <PixelIcon name="lock" size={12} />
          Your own Convex deployment. API keys never leave your Mac.
        </div>
      </div>
    </div>
  );
}

/** Settings › Sync login inside the Mac app: link this Mac's accounts to a login. */
export function SyncLogin({ onOpenKeys }: { onOpenKeys: () => void }) {
  const { cloud, state } = useDashboard();
  if (cloud.status === "off") {
    return (
      <div className="pref-row is-stack cloud-card">
        <span className="pref-copy">
          <strong>Sync is off</strong>
          <em>Turn on sync in Keys first. A login lets you see this Mac's runs and history from a browser.</em>
        </span>
        <Button variant="secondary" size="sm" icon="key" onClick={onOpenKeys}>
          Open Keys
        </Button>
      </div>
    );
  }
  if (cloud.status === "loading") {
    return (
      <div className="pref-row cloud-card">
        <span className="pref-copy">
          <strong>Connecting…</strong>
          <em>Checking your login on your deployment.</em>
        </span>
      </div>
    );
  }
  if (cloud.status === "signedOut") {
    return (
      <div className="pref-row is-stack cloud-card">
        <span className="pref-copy">
          <strong>Not signed in</strong>
          <em>Sign in to link {state.accounts.length === 1 ? "this account" : `these ${state.accounts.length} accounts`} to a login, so only you can read what syncs.</em>
        </span>
        <CredentialsForm submitLabel={(flow) => (flow === "signIn" ? "Sign in and link" : "Create login and link")} />
      </div>
    );
  }
  const taken = state.accounts.filter((account) => cloud.taken.includes(account.id));
  const linked = state.accounts.filter((account) => !cloud.taken.includes(account.id));
  return (
    <div className="pref-row is-stack cloud-card">
      <span className="pref-copy">
        <strong>Signed in as {cloud.email}</strong>
        <em>
          {!linked.length
            ? "None of this Mac's accounts are linked to this login."
            : `${linked.length === 1 ? `${linked[0].name} syncs` : `${linked.length} accounts sync`} to this login. No other login can read ${linked.length === 1 ? "it" : "them"}.`}
        </em>
      </span>
      {taken.length ? (
        <p className="cloud-error">
          {taken.map((account) => account.name).join(", ")} {taken.length === 1 ? "is" : "are"} linked to a different login, so {taken.length === 1 ? "it stays" : "they stay"}{" "}
          with that one.
        </p>
      ) : null}
      <Button variant="secondary" size="sm" icon="logout" onClick={() => void cloud.signOut()}>
        Sign out of sync
      </Button>
    </div>
  );
}
