import { useState } from "react";
import { useDashboard } from "../store";
import { Avatar, Button, Logo, PixelIcon, TextField } from "./ui";

/**
 * Shown while signed out. okidoki is local-first and has one identity on this Mac — there are no
 * accounts to switch between. With an identity already, it's a single "continue"; without one, a name
 * and an email make it yours. The account-scoped data model underneath is unchanged.
 */
export function AuthGate() {
  const { state, invoke, notify } = useDashboard();
  const existing = state.accounts.find((account) => account.id === state.currentAccountID) ?? state.accounts[0] ?? null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={44} glow />
          <h1>{existing ? "Welcome back" : "Make it yours"}</h1>
          <p>{existing ? "okidoki is ready on this Mac." : "One Mac, one okidoki. Everything stays on it."}</p>
        </div>
        {existing ? (
          <button
            className="auth-account"
            onClick={() => {
              invoke("signIn", { id: existing.id });
              notify("Welcome back", existing.name);
            }}
          >
            <Avatar account={existing} size={34} />
            <span>
              <strong>{existing.name}</strong>
              <em>{existing.email || "Continue"}</em>
            </span>
            <PixelIcon name="chevron" size={16} />
          </button>
        ) : (
          <>
            <div className="form-stack">
              <label className="form-label">Name</label>
              <TextField value={name} onChange={setName} placeholder="Your name" autoFocus />
              <label className="form-label">Email</label>
              <TextField value={email} onChange={setEmail} placeholder="you@example.com" type="email" />
            </div>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                const finalName = name.trim() || "You";
                invoke("createAccount", { name: finalName, email: email.trim(), kind: "personal" });
                notify("Made it yours", finalName);
              }}
            >
              Get started
            </Button>
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
