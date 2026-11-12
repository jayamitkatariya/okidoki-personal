import { useState } from "react";
import { useDashboard } from "../store";
import type { AccountKind } from "../types";
import { Avatar, Button, Logo, PixelIcon, Segmented, TextField } from "./ui";

/** Shown while signed out: pick an account, or make one. */
function AccountFields({
  name,
  setName,
  email,
  setEmail,
  kind,
  setKind,
  autoFocus,
}: {
  name: string;
  setName: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  kind: AccountKind;
  setKind: (value: AccountKind) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="form-stack">
      <label className="form-label">Name</label>
      <TextField value={name} onChange={setName} placeholder="Your name" autoFocus={autoFocus} />
      <label className="form-label">Email</label>
      <TextField value={email} onChange={setEmail} placeholder="you@example.com" type="email" />
      <div className="form-inline">
        <span className="form-label">Type</span>
        <Segmented
          options={[
            { value: "personal", label: "Personal" },
            { value: "work", label: "Work" },
          ]}
          value={kind}
          onChange={(value) => setKind(value as AccountKind)}
        />
      </div>
    </div>
  );
}

export function AuthGate() {
  const { state, invoke, notify } = useDashboard();
  const [mode, setMode] = useState<"signin" | "create">(state.accounts.length ? "signin" : "create");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<AccountKind>("personal");

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={44} glow />
          <h1>{mode === "signin" ? "Welcome back" : "Make it yours"}</h1>
          <p>{mode === "signin" ? "Pick an account to continue." : "One account per context. Work stays at work."}</p>
        </div>
        {mode === "signin" ? (
          <>
            <div className="auth-accounts">
              {state.accounts.map((account) => (
                <button
                  key={account.id}
                  className="auth-account"
                  onClick={() => {
                    invoke("signIn", { id: account.id });
                    notify("Welcome back", account.name);
                  }}
                >
                  <Avatar account={account} size={34} />
                  <span>
                    <strong>{account.name}</strong>
                    <em>{account.email || account.kind}</em>
                  </span>
                  <PixelIcon name="chevron" size={16} />
                </button>
              ))}
            </div>
            <button className="auth-link" onClick={() => setMode("create")}>
              Create a new account
            </button>
          </>
        ) : (
          <>
            <AccountFields name={name} setName={setName} email={email} setEmail={setEmail} kind={kind} setKind={setKind} autoFocus />
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                const finalName = name.trim() || "You";
                invoke("createAccount", { name: finalName, email: email.trim(), kind });
                notify("Account created", finalName);
              }}
            >
              Create account
            </Button>
            {state.accounts.length ? (
              <button className="auth-link" onClick={() => setMode("signin")}>
                Use an existing account
              </button>
            ) : null}
          </>
        )}
        <div className="auth-note">
          <PixelIcon name="lock" size={13} />
          Stays on this Mac. Nothing leaves it unless you ask a model.
        </div>
      </div>
    </div>
  );
}
