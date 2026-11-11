let seq = 0;

/**
 * Sends a request from the shell and calls `onAsked` with the conversation the Mac put it in, so the
 * shell can open it. Gives up quietly after a few seconds.
 */
export function askAndOpen(
  invoke: (type: string, payload?: Record<string, unknown>) => void,
  payload: { text: string; mode: string; threadID?: string; tabID?: string },
  onAsked?: (threadID: string) => void,
): void {
  const ref = `ask-${Date.now()}-${++seq}`;
  const onEvent = (event: Event) => {
    const [got, thread] = String((event as CustomEvent<string>).detail).split("|");
    if (got !== ref) return;
    cleanup();
    if (thread) onAsked?.(thread);
  };
  const timer = window.setTimeout(() => cleanup(), 5000);
  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener("okidoki-asked", onEvent);
  };
  window.addEventListener("okidoki-asked", onEvent);
  invoke("shellAsk", { ...payload, ref });
}
