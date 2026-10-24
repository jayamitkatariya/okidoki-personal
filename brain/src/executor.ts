import type { ExecuteRequest } from "./types";
import { splitCommand } from "../../shared/commandLine";

export type Emit = (event: string, data: Record<string, unknown>) => void;
type Job = { proc?: ReturnType<typeof Bun.spawn>; cancelled: boolean; paused: boolean; killTimer?: ReturnType<typeof setTimeout> };
const active = new Map<string, Job>();
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function isBlocked(command: string): boolean {
  return [/\brm\s+(?:-[\w]+\s+)*["']?\/(?:["']?\s|$)/i, /\bsudo\s+rm\b/i,
    /\bmkfs\b/i, /\bdiskutil\s+erase/i, /\bdd\s+.*of=["']?\/dev\//i,
    />\s*["']?\/dev\/disk/i, /:\s*\(\s*\)\s*\{/].some(p => p.test(command));
}
export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Tools on the path, no interactive prompts, and a native password dialog when sudo needs one. */
export function jobEnvironment(): Record<string, string | undefined> {
  const home = process.env.HOME ?? "";
  const env: Record<string, string | undefined> = { ...process.env,
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.opencode/bin`, `${home}/.hermes/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`, `${home}/bin`, process.env.PATH ?? ""].join(":"),
    TERM: "dumb", NO_COLOR: "1", NONINTERACTIVE: "1", CI: "1", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1", GIT_TERMINAL_PROMPT: "0", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  if (process.env.OKIDOKI_ASKPASS) {
    env.SUDO_ASKPASS = process.env.OKIDOKI_ASKPASS;
    // sudo only falls back to the helper when it believes a display exists.
    env.DISPLAY ??= ":0";
  }
  return env;
}

export function validateExecution(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "execution request required";
  const r = value as ExecuteRequest;
  if (typeof r.runId !== "string" || !/^[\w-]{1,128}$/.test(r.runId)) return "valid runId required";
  if (!["terminal", "background", "coding"].includes(r.kind)) return "unknown execution kind";
  if (r.workingDirectory !== undefined && (typeof r.workingDirectory !== "string" || r.workingDirectory.includes("\0"))) return "invalid working folder";
  if (r.commands !== undefined && (!Array.isArray(r.commands) || r.commands.some(c => typeof c !== "string"))) return "commands must be an array of strings";
  if (r.kind === "coding") {
    if (typeof r.prompt !== "string" || !r.prompt.trim()) return "coding prompt required";
    if (r.agent && !["claude", "opencode", "omp", "hermes"].includes(r.agent)) return "unknown coding agent";
    if (r.extraArgs !== undefined && (typeof r.extraArgs !== "string" || r.extraArgs.includes("\0") || splitCommand(r.extraArgs) === null)) return "coding agent options contain an incomplete quote or escape";
  } else if (!Array.isArray(r.commands) || !r.commands.length || r.commands.length > 50 ||
    r.commands.some(c => typeof c !== "string" || !c.trim() || c.includes("\0") || /\{\{[^}]+\}\}/.test(c))) {
    return "provide 1–50 complete commands; choose any requested files first";
  }
  if ((r.commands ?? []).some(isBlocked)) return "that command could destroy the Mac. I won't run it.";
}

export function agentCommand(request: ExecuteRequest): string[] {
  const prompt = request.prompt!;
  const commands = {
    opencode: ["opencode", "run", "--auto", prompt],
    omp: ["omp", "-p", "--auto-approve", prompt],
    hermes: ["hermes", "-z", prompt],
    claude: ["claude", "-p", prompt, "--output-format", "text", "--permission-mode", "acceptEdits"],
  };
  const extra = splitCommand(request.extraArgs ?? "");
  if (!extra) throw new Error("coding agent options contain an incomplete quote or escape");
  return [...commands[request.agent ?? "claude"], ...extra];
}

// One shell owns the entire plan: cd, variables and exports survive between steps.
// A private framing token separates progress events from arbitrary command output.
export function planScript(commands: string[], marker: string): string {
  return ["set -o pipefail", ...commands.flatMap((command, index) => [
    `printf '\\036${marker}:start:${index}\\037\\n'`,
    `eval ${shellQuote(command)}`,
    "okidoki_step_code=$?",
    `printf '\\036${marker}:end:${index}:%s\\037\\n' "$okidoki_step_code"`,
    'if [ "$okidoki_step_code" -ne 0 ]; then exit "$okidoki_step_code"; fi',
  ])].join("\n");
}

function signal(job: Job, sig: NodeJS.Signals): void {
  if (!job.proc) return;
  try { process.kill(-job.proc.pid, sig); } catch { try { job.proc.kill(sig); } catch {} }
}
function terminate(job: Job): void {
  if (job.killTimer) return;
  signal(job, "SIGCONT");
  signal(job, "SIGTERM");
  job.killTimer = setTimeout(() => signal(job, "SIGKILL"), 750);
  job.killTimer.unref();
}

export async function execute(request: ExecuteRequest, emit: Emit): Promise<void> {
  const invalid = validateExecution(request);
  if (invalid) { emit("error", { message: invalid }); return; }
  if (active.has(request.runId)) { emit("error", { message: "this job is already running" }); return; }
  const job: Job = { cancelled: false, paused: false };
  active.set(request.runId, job);
  const cwd = (request.workingDirectory || process.env.HOME || "/").replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  const commands = request.commands ?? [];
  const marker = `okidoki_${crypto.randomUUID().replaceAll("-", "")}`;
  let output = "";
  let timedOut = false;
  let currentStep = 0;
  const completed = new Set<number>();
  const append = (text: string) => {
    if (!text) return;
    const clean = text.replace(ansi, "");
    output = (output + clean).slice(-80_000);
    emit("output", { text: clean });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cmd = request.kind === "coding" ? agentCommand(request) : ["/bin/zsh", "-c", planScript(commands, marker)];
    job.proc = Bun.spawn({ cmd, cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: jobEnvironment() });
    emit("started", { runId: request.runId });
    timer = setTimeout(() => { timedOut = true; terminate(job); }, 30 * 60 * 1000);
    const read = async (stream: ReadableStream<Uint8Array>, framed: boolean) => {
      const decoder = new TextDecoder();
      let buffer = "";
      const drain = (final = false) => {
        while (buffer) {
          const start = framed ? buffer.indexOf("\x1e") : -1;
          if (start < 0) { append(buffer); buffer = ""; return; }
          append(buffer.slice(0, start)); buffer = buffer.slice(start);
          const end = buffer.indexOf("\x1f\n");
          if (end < 0) { if (final || buffer.length > 512) { append(buffer); buffer = ""; } return; }
          const frame = buffer.slice(1, end).split(":");
          if (frame[0] !== marker) { append(buffer.slice(0, end + 2)); }
          else {
            const index = Number(frame[2]); currentStep = index;
            const status = frame[1] === "start" ? "running" : Number(frame[3]) === 0 ? "done" : "failed";
            if (status === "done") completed.add(index);
            emit("step", { index, status, title: commands[index] });
            if (status === "running") emit("output", { text: `\n$ ${commands[index]}\n` });
          }
          buffer = buffer.slice(end + 2);
        }
      };
      for await (const chunk of stream) { buffer += decoder.decode(chunk, { stream: true }); drain(); }
      buffer += decoder.decode(); drain(true);
    };
    await Promise.all([read(job.proc.stdout as ReadableStream<Uint8Array>, request.kind !== "coding"), read(job.proc.stderr as ReadableStream<Uint8Array>, false)]);
    const code = await job.proc.exited;
    if (job.cancelled) { emit("cancelled", { summary: "stopped by you" }); return; }
    if (code !== 0 || timedOut || (request.kind !== "coding" && completed.size !== commands.length)) {
      emit("step", { index: currentStep, status: "failed", title: commands[currentStep] ?? "run agent" });
      const tail = output.trim().split("\n").slice(-5).join("\n");
      const hint = /command not found/.test(output) ? "A required tool isn't installed. Ask me to install it, then try again." : /incorrect password|a password is required|terminal is required|no askpass/.test(output) ? "This step needs your Mac login password. Try again and type it in the dialog when it appears." : "No later steps were run. You can change the request and try again.";
      emit("error", { message: timedOut ? "This job reached the 30 minute limit and was stopped." : `Step ${currentStep + 1} stopped (exit ${code}). ${hint}${tail ? "\n\n" + tail : ""}`, code });
      return;
    }
    const tail = output.split("\n").map(l => l.trim()).filter(l => l && l.length < 200).slice(-4).join("\n");
    emit("done", { summary: tail || "Finished all steps successfully.", code: 0 });
  } catch (error) {
    emit("error", { message: error instanceof Error ? error.message : "could not start this job" });
  } finally {
    if (timer) clearTimeout(timer);
    if (job.killTimer) clearTimeout(job.killTimer);
    if (active.get(request.runId) === job) active.delete(request.runId);
  }
}

export function stop(runId: string): boolean {
  const job = active.get(runId);
  if (!job) return false;
  job.cancelled = true; terminate(job); return true;
}
export function pause(runId: string): boolean {
  const job = active.get(runId);
  if (!job?.proc || job.cancelled) return false;
  signal(job, "SIGSTOP"); job.paused = true; return true;
}
export function resume(runId: string): boolean {
  const job = active.get(runId);
  if (!job?.proc || job.cancelled) return false;
  signal(job, "SIGCONT"); job.paused = false; return true;
}

export function stopAll(): void { for (const id of active.keys()) stop(id); }
