import type { CollabEvent, JoinResponse, Participant, SessionSnapshot } from "./protocol";

/**
 * The joiner page's link to the host. Two implementations of one interface: HttpHost talks to the
 * host app's CollabServer over the LAN; MockHost simulates a session in the browser so the page is
 * provable in the dev preview and the tests without a Mac. The page never knows which it holds.
 */
export interface Host {
  join(name: string, code: string): Promise<JoinResponse>;
  state(token: string): Promise<{ you: Participant; session: SessionSnapshot }>;
  /** Subscribe to the SSE stream. Returns an unsubscribe. */
  subscribe(token: string, onEvent: (event: CollabEvent) => void, onStatus?: (connected: boolean) => void): () => void;
  /** A URL the screen <img> reloads on a timer to pull the latest VM frame. */
  frameURL(token: string): string;
  chat(token: string, text: string, ask: boolean): Promise<void>;
  runSkill(token: string, id: string, values?: Record<string, string>): Promise<{ runID?: string }>;
  stopRun(token: string, id: string): Promise<void>;
  wheel(token: string, action: "request" | "release"): Promise<{ holder: string | null }>;
  input(token: string, payload: Record<string, unknown>): Promise<void>;
}

export class HttpHost implements Host {
  constructor(private base: string = "") {}

  private async post<T>(path: string, token: string | null, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `request failed (${res.status})`);
    return data as T;
  }

  join(name: string, code: string) {
    return this.post<JoinResponse>("/api/join", null, { name, code });
  }

  async state(token: string) {
    const res = await fetch(`${this.base}/api/state?token=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || "session unavailable");
    return data as { you: Participant; session: SessionSnapshot };
  }

  subscribe(token: string, onEvent: (event: CollabEvent) => void, onStatus?: (connected: boolean) => void) {
    const source = new EventSource(`${this.base}/api/events?token=${encodeURIComponent(token)}`);
    source.onopen = () => onStatus?.(true);
    source.onerror = () => onStatus?.(false);
    source.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as CollabEvent);
      } catch {
        // A malformed line is dropped, never crashes the page.
      }
    };
    return () => source.close();
  }

  frameURL(token: string) {
    // Cache-busted so the screen <img> pulls a fresh frame on each poll.
    return `${this.base}/api/frame?token=${encodeURIComponent(token)}&t=${Date.now()}`;
  }

  async chat(token: string, text: string, ask: boolean) {
    await this.post("/api/chat", token, { text, ask });
  }

  runSkill(token: string, id: string, values?: Record<string, string>) {
    return this.post<{ runID?: string }>("/api/skills/run", token, { id, values });
  }

  async stopRun(token: string, id: string) {
    await this.post("/api/runs/stop", token, { id });
  }

  wheel(token: string, action: "request" | "release") {
    return this.post<{ holder: string | null }>("/api/wheel", token, { action });
  }

  async input(token: string, payload: Record<string, unknown>) {
    await this.post("/api/input", token, payload);
  }
}

/** The dev preview and the tests have no host behind them; a query flag forces it elsewhere too. */
export function useMock(): boolean {
  if (typeof window === "undefined") return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mock") === "1") return true;
  if (params.get("mock") === "0") return false;
  return Boolean(import.meta.env?.DEV);
}
