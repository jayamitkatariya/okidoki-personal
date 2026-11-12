import { toast } from "@/components/ui/toast";

let seq = 0;
let lastSent = { text: "", at: 0 };

/** How long the view may still jump to the reply's chat; after this, a toast offers it instead. */
const JUMP_WINDOW = 4000;
/** How long a reply's chat is still worth offering at all. */
const LISTEN_WINDOW = 60000;

/**
 * Waits for the Mac to say which conversation request `ref` landed in.
 * - Soon, and you're still where you asked from: opens it (`onAsked`).
 * - Later, or you've moved on: a toast offers to open it, so the view never jumps out from under you.
 */
export function followAsk(ref: string, onAsked: ((threadID: string) => void) | undefined, onSettled?: () => void): () => void {
  const sentAt = Date.now();
  const sentFrom = window.location.hash;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };
  const onEvent = (event: Event) => {
    const [got, thread] = String((event as CustomEvent<string>).detail).split("|");
    if (got !== ref) return;
    cleanup();
    settle();
    if (!thread || !onAsked) return;
    const stayed = window.location.hash === sentFrom;
    if (stayed && Date.now() - sentAt < JUMP_WINDOW) onAsked(thread);
    else toast({ message: "okidoki picked up your request", state: "info", action: { label: "Open chat", run: () => onAsked(thread) } });
  };
  // The button stops turning after a few seconds either way; listening goes on a while longer.
  const spin = window.setTimeout(settle, JUMP_WINDOW);
  const timer = window.setTimeout(() => cleanup(), LISTEN_WINDOW);
  const cleanup = () => {
    window.clearTimeout(timer);
    window.clearTimeout(spin);
    window.removeEventListener("okidoki-asked", onEvent);
  };
  window.addEventListener("okidoki-asked", onEvent);
  return cleanup;
}

export function nextAskRef(): string {
  return `ask-${Date.now()}-${++seq}`;
}

/**
 * Sends a request from the shell and opens the conversation the Mac put it in. A second click on the
 * same request within a moment is ignored, so a double-click doesn't send it twice. Returns false then.
 */
export function askAndOpen(
  invoke: (type: string, payload?: Record<string, unknown>) => void,
  payload: { text: string; mode: string; threadID?: string; tabID?: string },
  onAsked?: (threadID: string) => void,
): boolean {
  const now = Date.now();
  if (payload.text === lastSent.text && now - lastSent.at < 1500) return false;
  lastSent = { text: payload.text, at: now };
  const ref = nextAskRef();
  followAsk(ref, onAsked);
  invoke("shellAsk", { ...payload, ref });
  return true;
}
