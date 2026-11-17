import { useCallback, useEffect, useRef, useState } from "react";
import type { Host } from "./api";
import type { CollabEvent, InputPayload, Participant, SessionSnapshot } from "./protocol";
import { CHAT_MAX } from "./protocol";

export type Phase = "join" | "joining" | "in" | "ended";

export interface SessionState {
  phase: Phase;
  you: Participant | null;
  session: SessionSnapshot | null;
  connected: boolean;
  error: string | null;
}

/** The wheel holder's live pointer, for everyone else's overlay. Transient — never in the snapshot. */
export interface PointerMark {
  x: number;
  y: number;
  color: string;
  by: string;
  click: boolean;
  seq: number;
}

const EMPTY: SessionState = { phase: "join", you: null, session: null, connected: false, error: null };

/** Joining, the live event stream reduced into one snapshot, and the actions a participant can take. */
export function useSession(host: Host) {
  const [state, setState] = useState<SessionState>(EMPTY);
  const [pointer, setPointer] = useState<PointerMark | null>(null);
  const tokenRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const pointerSeq = useRef(0);

  const reduce = useCallback((event: CollabEvent) => {
    setState((prev) => {
      if (!prev.session && event.type !== "hello" && event.type !== "ended") return prev;
      switch (event.type) {
        case "hello":
          return { ...prev, phase: "in", you: event.you, session: event.session, connected: true, error: null };
        case "chat": {
          if (!prev.session) return prev;
          const chat = [...prev.session.chat, event.message].slice(-300);
          return { ...prev, session: { ...prev.session, chat } };
        }
        case "presence":
          return prev.session ? { ...prev, session: { ...prev.session, participants: event.participants } } : prev;
        case "run":
          return prev.session ? { ...prev, session: { ...prev.session, run: event.run } } : prev;
        case "vm":
          return prev.session ? { ...prev, session: { ...prev.session, vm: { phase: event.phase, running: event.running } } } : prev;
        case "skills":
          return prev.session ? { ...prev, session: { ...prev.session, skills: event.skills } } : prev;
        case "wheel":
          return prev.session ? { ...prev, session: { ...prev.session, wheelHolder: event.holder, wheelHolderName: event.holderName } } : prev;
        case "ended":
          return { ...prev, phase: "ended", connected: false };
        default:
          return prev;
      }
    });
  }, []);

  const onEvent = useCallback((event: CollabEvent) => {
    if (event.type === "pointer") {
      pointerSeq.current += 1;
      setPointer({ x: event.x, y: event.y, color: event.color, by: event.by, click: Boolean(event.click), seq: pointerSeq.current });
      return;
    }
    if ((event.type === "wheel" && !event.holder) || event.type === "ended") setPointer(null);
    reduce(event);
  }, [reduce]);

  const join = useCallback(async (name: string, code: string) => {
    setState((prev) => ({ ...prev, phase: "joining", error: null }));
    try {
      const res = await host.join(name, code);
      tokenRef.current = res.token;
      setState({ phase: "in", you: res.you, session: res.session, connected: true, error: null });
      unsubRef.current?.();
      unsubRef.current = host.subscribe(res.token, onEvent, (connected) => setState((prev) => ({ ...prev, connected })));
    } catch (err) {
      setState((prev) => ({ ...prev, phase: "join", error: err instanceof Error ? err.message : "couldn't join" }));
    }
  }, [host, onEvent]);

  const sendChat = useCallback(async (text: string, ask: boolean) => {
    const token = tokenRef.current;
    if (!token || !text.trim()) return;
    try {
      await host.chat(token, text.slice(0, CHAT_MAX), ask);
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : "couldn't send" }));
    }
  }, [host]);

  const runSkill = useCallback(async (id: string, values?: Record<string, string>) => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await host.runSkill(token, id, values);
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : "couldn't start" }));
    }
  }, [host]);

  const stopRun = useCallback(async () => {
    const token = tokenRef.current;
    const id = state.session?.run?.id;
    if (!token || !id) return;
    try {
      await host.stopRun(token, id);
    } catch {
      // The run may have finished already; nothing to do.
    }
  }, [host, state.session?.run?.id]);

  const setWheel = useCallback(async (action: "request" | "release") => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await host.wheel(token, action);
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : "couldn't take the wheel" }));
    }
  }, [host]);

  const sendInput = useCallback(async (payload: InputPayload) => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await host.input(token, payload);
    } catch {
      // Input is best-effort; a dropped packet is not worth an error banner.
    }
  }, [host]);

  useEffect(() => () => { unsubRef.current?.(); }, []);

  return { state, pointer, join, sendChat, runSkill, stopRun, setWheel, sendInput, host, token: tokenRef.current };
}
