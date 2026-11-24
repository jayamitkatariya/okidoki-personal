import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The engine is the harness runtime (Claude Code, Codex, OpenCode, Cursor,
 * Gemini, Pi, Muse and the in-house loop). It stays a child process so a
 * harness crash or a native module fault can never take the brain down.
 */
const DEFAULT_PORT = 4332;
const ENGINE_HEADER = "X-Okidoki-Engine-Secret";
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

function supportDir(): string {
  return process.env.OKIDOKI_SUPPORT_DIR ?? join(homedir(), "Library", "Application Support", "Okidoki");
}

export class LocalEngine {
  readonly port: number;
  private readonly secret: string;
  private readonly stateDir: string;
  private readonly log: ReturnType<typeof createWriteStream>;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private failures = 0;

  constructor() {
    this.port = Number(process.env.OKIDOKI_ENGINE_PORT ?? DEFAULT_PORT);
    this.secret = process.env.OKIDOKI_ENGINE_SECRET ?? randomBytes(32).toString("base64url");
    this.stateDir = join(supportDir(), "engine");
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(join(this.stateDir, "workspaces"), { recursive: true });
    this.log = createWriteStream(join(this.stateDir, "engine.log"), { flags: "a" });
  }

  private entry(): string {
    const here = import.meta.dir;
    if (process.env.OKIDOKI_ENGINE_ENTRY) return process.env.OKIDOKI_ENGINE_ENTRY;
    const bundled = join(here, "engine.js");
    return existsSync(bundled) ? bundled : join(here, "index.ts");
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndWait().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndWait(): Promise<void> {
    this.stopping = false;
    const entry = this.entry();
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OKIDOKI_LOCAL: "1",
        OKIDOKI_ENGINE_SECRET: this.secret,
        OKIDOKI_ENGINE_PORT: String(this.port),
        OKIDOKI_WORKSPACE_ID: process.env.OKIDOKI_WORKSPACE_ID ?? "personal",
        OKIDOKI_ENGINE_STATE_DIR: this.stateDir,
        OKIDOKI_WORKSPACE_ROOT: process.env.OKIDOKI_ENGINE_WORKSPACE_ROOT
          ?? process.env.OKIDOKI_WORKSPACE_ROOT
          ?? join(this.stateDir, "workspaces"),
        OKIDOKI_MONOLITH_URL: process.env.OKIDOKI_MONOLITH_URL ?? "http://127.0.0.1:9",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.log.write(chunk));
    child.on("exit", (code, signal) => {
      this.log.write(`[supervisor] engine exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
      this.child = null;
      if (!this.stopping) this.scheduleRestart();
    });
    return this.waitForHealth();
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError = "engine did not answer";
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(`engine exited during startup: ${lastError}`);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          headers: { [ENGINE_HEADER]: this.secret },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          this.failures = 0;
          return;
        }
        lastError = `health returned ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "engine is not listening";
      }
      await Bun.sleep(250);
    }
    throw new Error(lastError);
  }

  private scheduleRestart(): void {
    if (this.stopping || this.starting) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.failures, RESTART_DELAYS_MS.length - 1)];
    this.failures += 1;
    this.log.write(`[supervisor] restarting engine in ${delay}ms (failure ${this.failures})\n`);
    setTimeout(() => {
      if (!this.stopping) void this.start().catch(() => {});
    }, delay).unref?.();
  }

  async status(): Promise<{ running: boolean; healthy: boolean; port: number; pid: number | null }> {
    const pid = this.child?.pid ?? null;
    let healthy = false;
    try {
      healthy = (await this.engineFetch("/health", { signal: AbortSignal.timeout(1_500) })).ok;
    } catch {
      healthy = false;
    }
    return { running: Boolean(this.child), healthy, port: this.port, pid };
  }

  /** A request to the engine, authenticated with the per-launch secret. */
  engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(ENGINE_HEADER, this.secret);
    return fetch(`http://127.0.0.1:${this.port}${path}`, { ...init, headers });
  }

  /** Forwards a brain request under /engine/* to the engine, keeping paths and streams intact. */
  async proxy(request: Request): Promise<Response> {
    await this.start();
    const url = new URL(request.url);
    const target = `${url.pathname.slice("/engine".length)}${url.search}`;
    const headers = new Headers(request.headers);
    for (const name of ["host", "origin", "authorization", "content-length"]) headers.delete(name);
    headers.set(ENGINE_HEADER, this.secret);
    return this.engineFetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}

// A force-killed brain must not leave a harness runtime holding its port.
process.on("exit", () => localEngine.stop());

export const localEngine = new LocalEngine();
