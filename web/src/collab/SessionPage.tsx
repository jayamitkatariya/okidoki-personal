import { useEffect, useRef, useState } from "react";
import type { useSession } from "./useSession";
import type { ChatMessage, Participant, SkillCard } from "./protocol";
import { asksOkidoki } from "./protocol";
import { isDrag, keyInput, normPoint, scrollInput } from "./input";
import { Button, Logo, Modal, PixelIcon, TextField } from "../components/ui";
import { cx } from "../lib";

type Session = ReturnType<typeof useSession>;

/** The live session: the shared Mac's screen, the group chat, and okidoki acting on request. */
export function SessionPage({ session }: { session: Session }) {
  const { state, host, token } = session;
  const snap = state.session!;
  const you = state.you!;
  const [frame, setFrame] = useState<string | null>(null);

  // Pull a fresh frame a few times a second while the VM is up. The mock returns a stand-in screen.
  useEffect(() => {
    if (!token || !snap.vm.running) {
      setFrame(null);
      return;
    }
    setFrame(host.frameURL(token));
    const timer = window.setInterval(() => setFrame(host.frameURL(token)), 320);
    return () => window.clearInterval(timer);
  }, [token, snap.vm.running, host]);

  return (
    <div className="collab">
      <header className="collab-top">
        <span className="collab-brand">
          <Logo size={26} />
          <strong>okidoki</strong>
          <em>live session</em>
        </span>
        <span className="collab-host">
          <PixelIcon name="screen" size={14} />
          {snap.hostName}
        </span>
        <span className={cx("collab-conn", state.connected && "is-on")} title={state.connected ? "Connected" : "Reconnecting…"}>
          <i /> {state.connected ? "Live" : "Reconnecting"}
        </span>
        <span className="collab-people">
          {snap.participants.slice(0, 6).map((p) => (
            <Dot key={p.id} person={p} you={p.id === you.id} driving={snap.wheelHolder === p.id} />
          ))}
          <em>{snap.participants.length} here</em>
        </span>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          Leave
        </Button>
      </header>

      <div className="collab-body">
        <section className="collab-stage">
          <Screen session={session} frame={frame} />
          <WheelBar session={session} />
          <SkillRow session={session} />
        </section>

        <ChatPanel session={session} />
      </div>
      {state.error ? <div className="collab-error" role="alert">{state.error}</div> : null}
    </div>
  );
}

function Dot({ person, you, driving }: { person: Participant; you: boolean; driving?: boolean }) {
  const initials = person.name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <span
      className={cx("collab-dot", you && "is-you", driving && "is-driving")}
      style={{ background: `#${person.colorHex}` }}
      title={person.name + (you ? " (you)" : "") + (driving ? " · driving" : "")}
    >
      {initials}
    </span>
  );
}

/**
 * The shared Mac's screen. While you hold the wheel it becomes the controls: pointer moves, clicks,
 * drags, scrolls and keystrokes go to the guest; everyone else sees your pointer live. Esc releases.
 */
function Screen({ session, frame }: { session: Session; frame: string | null }) {
  const { state, pointer } = session;
  const snap = state.session!;
  const you = state.you!;
  const driving = snap.wheelHolder === you.id;
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pressRef = useRef<{ x: number; y: number; button: number } | null>(null);
  const lastMoveRef = useRef(0);
  const lastScrollRef = useRef(0);

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = imgRef.current?.getBoundingClientRect();
    return rect ? normPoint(event.clientX, event.clientY, rect) : { x: 0, y: 0 };
  };

  // Focus the stage when the wheel is taken, so keystrokes flow without another click.
  useEffect(() => {
    if (driving) stageRef.current?.focus();
  }, [driving]);

  // React's onWheel is passive; a native listener is the only way to stop the page scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !driving) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = Date.now();
      if (now - lastScrollRef.current < 50) return;
      lastScrollRef.current = now;
      const p = point(event);
      const packet = scrollInput(p.x, p.y, event.deltaX, event.deltaY);
      if (packet) void session.sendInput(packet);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving, session.sendInput]);

  const onMouseMove = (event: React.MouseEvent) => {
    if (!driving) return;
    if (pressRef.current) return; // a press in progress becomes a click or a drag on release
    const now = Date.now();
    if (now - lastMoveRef.current < 33) return;
    lastMoveRef.current = now;
    const p = point(event);
    void session.sendInput({ kind: "move", x: p.x, y: p.y });
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (!driving) return;
    event.preventDefault();
    stageRef.current?.focus();
    const p = point(event);
    pressRef.current = { ...p, button: event.button };
  };

  const onMouseUp = (event: React.MouseEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!driving || !press) return;
    const p = point(event);
    if (isDrag(press, p)) {
      void session.sendInput({ kind: "drag", fromX: press.x, fromY: press.y, toX: p.x, toY: p.y });
    } else {
      void session.sendInput({ kind: "click", x: p.x, y: p.y, button: press.button === 2 ? "right" : "left" });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!driving) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void session.setWheel("release");
      return;
    }
    const packet = keyInput(event);
    if (packet) {
      event.preventDefault();
      void session.sendInput(packet);
    }
  };

  const remotePointer = snap.wheelHolder && snap.wheelHolder !== you.id && pointer && pointer.by === snap.wheelHolder ? pointer : null;

  return (
    <div
      ref={stageRef}
      className={cx("collab-screen", snap.vm.running && "is-on", driving && "is-driving")}
      tabIndex={driving ? 0 : -1}
      role={driving ? "application" : undefined}
      aria-label={driving ? "The shared Mac's screen — you are driving. Escape releases the wheel." : "The shared Mac's screen"}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { pressRef.current = null; }}
      onContextMenu={(event) => { if (driving) event.preventDefault(); }}
      onKeyDown={onKeyDown}
    >
      {frame ? (
        <img ref={imgRef} src={frame} alt="The shared Mac's screen" draggable={false} />
      ) : (
        <span className="collab-screen-idle">
          <PixelIcon name="screen" size={28} />
          {snap.vm.running ? "Connecting to the screen…" : "The shared Mac is off. The host can start it."}
        </span>
      )}
      {snap.vm.running ? (
        <span className="collab-live">
          <i /> LIVE
        </span>
      ) : null}
      {remotePointer ? (
        <span
          key={remotePointer.seq}
          className={cx("collab-remote-pointer", remotePointer.click && "is-click")}
          style={{ left: `${remotePointer.x * 100}%`, top: `${remotePointer.y * 100}%`, background: `#${remotePointer.color}` }}
          aria-hidden="true"
        />
      ) : null}
      {driving ? <span className="collab-driving-hint">You're driving · Esc releases</span> : null}
      {snap.run ? <RunStrip session={session} /> : null}
    </div>
  );
}

function WheelBar({ session }: { session: Session }) {
  const { state } = session;
  const snap = state.session!;
  const you = state.you!;
  const driving = snap.wheelHolder === you.id;
  const runActive = Boolean(snap.run);

  return (
    <div className="collab-wheel">
      {driving ? (
        <>
          <span className="collab-wheel-state is-you">
            <PixelIcon name="cursor" size={14} /> You're driving
          </span>
          <em>click the screen, then type · drag to move things · Esc releases</em>
          <Button variant="secondary" size="sm" onClick={() => void session.setWheel("release")}>
            Release the wheel
          </Button>
        </>
      ) : snap.wheelHolder ? (
        <span className="collab-wheel-state">
          <PixelIcon name="cursor" size={14} /> {snap.wheelHolderName ?? "Someone"} is driving
        </span>
      ) : (
        <>
          <Button
            variant="secondary"
            size="sm"
            icon="cursor"
            disabled={runActive || !snap.vm.running}
            onClick={() => void session.setWheel("request")}
          >
            Take the wheel
          </Button>
          <em>{runActive ? "okidoki is working — stop the run to drive" : snap.vm.running ? "drive the shared Mac yourself, live for everyone" : "the shared Mac is off"}</em>
        </>
      )}
    </div>
  );
}

function RunStrip({ session }: { session: Session }) {
  const { state } = session;
  const run = state.session!.run!;
  const you = state.you!;
  const last = run.steps.slice(-3);
  const canStop = run.requestedBy === you.id;
  return (
    <div className="collab-run">
      <div className="collab-run-head">
        <span className={cx("collab-run-status", `is-${run.status}`)}>
          <i /> {run.status === "running" ? "Working" : run.status}
        </span>
        <strong>{run.title}</strong>
        {canStop ? (
          <Button variant="ghost" size="sm" onClick={() => void session.stopRun()}>
            Stop
          </Button>
        ) : null}
      </div>
      {run.needs ? (
        <p className="collab-run-needs">
          <PixelIcon name="hand" size={13} /> waiting for the host — {run.needs}
        </p>
      ) : (
        <ul className="collab-run-steps">
          {last.map((step) => (
            <li key={step.index}>
              <PixelIcon name={stepIcon(step.kind)} size={12} />
              <span>{step.say}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function stepIcon(kind: string): string {
  if (kind === "pointer") return "cursor";
  if (kind === "keys") return "keyboard";
  if (kind === "app") return "switch";
  if (kind === "look") return "eye";
  return "spark";
}

function SkillRow({ session }: { session: Session }) {
  const snap = session.state.session!;
  const [open, setOpen] = useState<SkillCard | null>(null);
  if (!snap.skills.length) return null;
  return (
    <div className="collab-skills">
      <span className="collab-skills-label">
        <PixelIcon name="repeat" size={13} /> Ask a saved skill
      </span>
      <div className="collab-skills-row">
        {snap.skills.map((skill) => (
          <button key={skill.id} type="button" className="collab-skill" onClick={() => setOpen(skill)}>
            <strong>{skill.name}</strong>
            <em>{skill.summary}</em>
          </button>
        ))}
      </div>
      <SkillRunModal skill={open} onClose={() => setOpen(null)} onRun={(values) => { void session.runSkill(open!.id, values); setOpen(null); }} />
    </div>
  );
}

function SkillRunModal({ skill, onClose, onRun }: { skill: SkillCard | null; onClose: () => void; onRun: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [skill]);
  if (!skill) return null;
  return (
    <Modal open onClose={onClose} title={skill.name} subtitle={skill.summary} width={460}>
      <div className="collab-skill-form">
        {skill.inputs.length ? (
          skill.inputs.map((input) => (
            <div key={input.name} className="collab-skill-field">
              <label className="form-label">{input.name}</label>
              <TextField value={values[input.name] ?? ""} onChange={(v) => setValues((prev) => ({ ...prev, [input.name]: v }))} placeholder={input.description} />
            </div>
          ))
        ) : (
          <p className="collab-skill-none">No inputs — it runs as-is.</p>
        )}
        <Button variant="primary" icon="play" onClick={() => onRun(values)}>
          Run in the shared Mac
        </Button>
      </div>
    </Modal>
  );
}

function ChatPanel({ session }: { session: Session }) {
  const { state } = session;
  const snap = state.session!;
  const you = state.you!;
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snap.chat.length]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const isAsk = ask || asksOkidoki(trimmed);
    void session.sendChat(trimmed, isAsk);
    setText("");
  };

  return (
    <aside className="collab-chat">
      <div className="collab-chat-head">
        <PixelIcon name="chat" size={15} />
        Group chat
        <em>{snap.participants.length} present</em>
      </div>
      <div className="collab-chat-scroll" ref={scrollRef}>
        {snap.chat.map((message) => (
          <Bubble key={message.id} message={message} you={message.authorID === you.id} />
        ))}
      </div>
      <div className="collab-composer">
        <button type="button" className={cx("collab-ask-chip", ask && "is-on")} onClick={() => setAsk((v) => !v)} aria-pressed={ask}>
          <PixelIcon name="spark" size={13} />
          {ask ? "Asking okidoki" : "Ask okidoki"}
        </button>
        <textarea
          className="collab-input"
          value={text}
          rows={1}
          placeholder={ask ? "ask okidoki to do something in the shared Mac…" : "message everyone…"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button variant="primary" size="sm" icon="arrow" disabled={!text.trim()} onClick={send} aria-label="Send" />
      </div>
    </aside>
  );
}

function Bubble({ message, you }: { message: ChatMessage; you: boolean }) {
  if (message.kind === "system") {
    return <div className="collab-msg-system">{message.text}</div>;
  }
  const okidoki = message.kind === "okidoki";
  return (
    <div className={cx("collab-msg", okidoki && "is-okidoki", you && "is-you", message.kind === "ask" && "is-ask")}>
      <span className="collab-msg-author">
        <i style={{ background: okidoki ? "#1FB57A" : `#${message.colorHex}` }} />
        {okidoki ? "okidoki" : message.authorName}
        {message.kind === "ask" ? <em>asked okidoki</em> : null}
      </span>
      <p>{message.text}</p>
    </div>
  );
}
