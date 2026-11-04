/**
 * The okidoki app's control endpoint (127.0.0.1, token in control.json), for the CLI and the MCP server.
 * No dependencies. Everything risky the app does for another agent still waits for the person's okay.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Json = Record<string, unknown>;

export function supportDir(): string {
  return process.env.OKIDOKI_SUPPORT_DIR || join(homedir(), "Library", "Application Support", "Okidoki Personal");
}

function control(): { port: number; token: string } {
  try {
    const info = JSON.parse(readFileSync(join(supportDir(), "control.json"), "utf8")) as { port?: number; token?: string };
    if (info.port && info.token) return { port: info.port, token: info.token };
  } catch {}
  throw new Error("okidoki isn't running on this Mac (no control.json). Open Okidoki Personal and try again.");
}

export async function call(method: "GET" | "POST", path: string, body?: Json, timeoutSeconds = 0): Promise<Json> {
  const { port, token } = control();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    // A task asked to wait holds the request open that long, plus a margin.
    signal: AbortSignal.timeout((Math.max(timeoutSeconds, 0) + 90) * 1000),
  });
  const json = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(String(json.error ?? `okidoki answered HTTP ${response.status}`));
  return json;
}

const q = (value: unknown) => encodeURIComponent(String(value ?? ""));
const tabQuery = (tab: unknown) => (tab === undefined || tab === null || tab === "" ? "" : `?tab=${q(tab)}`);

/** Every thing another agent can ask of okidoki, shared by the CLI and the MCP server. */
export const api = {
  status: () => call("GET", "/status"),
  task: (text: string, mode = "auto", wait = 0, thread?: string) =>
    call("POST", "/tasks", { text, mode, wait, ...(thread ? { thread } : {}) }, wait),
  runs: (limit = 10) => call("GET", `/runs?limit=${limit}`),
  run: (id: string, log = false) => call("GET", `/runs/${q(id)}${log ? "?log=1" : ""}`),
  wait: (id: string, timeout = 300) => call("GET", `/runs/${q(id)}/wait?timeout=${timeout}`, undefined, timeout),
  control: (id: string, verb: "stop" | "pause" | "resume" | "takeback") => call("POST", `/runs/${q(id)}/${verb}`, {}),
  reply: (id: string, text: string) => call("POST", `/runs/${q(id)}/reply`, { text }),
  save: (id: string, name?: string) => call("POST", `/runs/${q(id)}/save`, name ? { name } : {}, 90),
  skills: () => call("GET", "/skills"),
  library: () => call("GET", "/library"),
  replay: (skill: string, opts: { items?: Json[]; values?: Json; times?: number; wait?: number } = {}) =>
    call("POST", `/skills/${q(skill)}/run`, opts as Json, opts.wait ?? 0),
  tabs: () => call("GET", "/browser/tabs"),
  open: (url: string, front = false) => call("POST", "/browser/open", { url, front }),
  page: (tab?: number | string) => call("GET", `/browser/page${tabQuery(tab)}`),
  act: (action: Json) => call("POST", "/browser/act", action),
  screenshot: (tab?: number | string) => call("GET", `/browser/screenshot${tabQuery(tab)}`),
  close: (tab: number | string) => call("POST", "/browser/close", { tab: Number(tab) }),
  memory: () => call("GET", "/memory"),
  remember: (text: string) => call("POST", "/memory", { text }),
  vault: (query: string) => call("GET", `/vault/search?q=${q(query)}`),
};
