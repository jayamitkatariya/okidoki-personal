import { useState } from "react";
import type { Host } from "./api";
import { useSession } from "./useSession";
import { SessionPage } from "./SessionPage";
import { Button, Logo, PixelIcon, TextField } from "../components/ui";

/** The joiner page: join with a name and the host's code, then the live session. No install, no account. */
export function SessionApp({ host }: { host: Host }) {
  const session = useSession(host);
  const { state } = session;

  if (state.phase === "in" && state.session && state.you) {
    return <SessionPage session={session} />;
  }

  if (state.phase === "ended") {
    return (
      <div className="collab-gate">
        <div className="collab-gate-card">
          <Logo size={44} glow />
          <h1>Session ended</h1>
          <p>The host closed the session. Ask them to start another if you want back in.</p>
          <Button variant="secondary" size="lg" onClick={() => window.location.reload()}>
            Back to join
          </Button>
        </div>
      </div>
    );
  }

  return <JoinGate session={session} />;
}

function JoinGate({ session }: { session: ReturnType<typeof useSession> }) {
  const { state } = session;
  const params = new URLSearchParams(window.location.search);
  const [name, setName] = useState("");
  const [code, setCode] = useState(params.get("code") ?? "");
  const joining = state.phase === "joining";

  const submit = () => {
    if (!name.trim() || !code.trim() || joining) return;
    void session.join(name, code);
  };

  return (
    <div className="collab-gate">
      <div className="collab-gate-card">
        <Logo size={44} glow />
        <h1>Join the session</h1>
        <p>Watch okidoki work in a shared Mac, chat with everyone, and ask it to do things. Everything stays on the host's Mac.</p>
        <div className="collab-gate-form">
          <label className="form-label">Your name</label>
          <TextField value={name} onChange={setName} placeholder="What everyone calls you" autoFocus />
          <label className="form-label">Session code</label>
          <TextField
            value={code}
            onChange={(value) => setCode(value.toUpperCase())}
            placeholder="6 characters from the host"
            className="collab-code-field"
            onEnter={submit}
          />
          {state.error ? (
            <p className="collab-gate-error" role="alert">
              <PixelIcon name="hand" size={14} /> {state.error}
            </p>
          ) : null}
          <Button variant="primary" size="lg" disabled={!name.trim() || !code.trim() || joining} onClick={submit}>
            {joining ? "Joining…" : "Join"}
          </Button>
        </div>
        <div className="collab-gate-note">
          <PixelIcon name="lock" size={13} />
          You see okidoki's private Mac, never the host's own screen.
        </div>
      </div>
    </div>
  );
}
