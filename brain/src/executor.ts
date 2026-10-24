import type { ExecuteRequest } from "./types";

export type Emit = (event: string, data: Record<string, unknown>) => void;

const active = new Map<string, { proc: ReturnType<typeof Bun.spawn>; paused: boolean }>();

const blocked = [
  /rm\s+-rf\s+\/(\s|$)/,
  /sudo\s+rm\s+-rf/,
  /mkfs/,
  /diskutil\s+erase/,
  /dd\s+if=.*of=\/dev\//,
  />\s*\/dev\/disk/,
];

const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function isBlocked(command: string): boolean {
  return blocked.some((pattern) => pattern.test(command));
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function agentCommand(agent: ExecuteRequest["agent"], prompt: string): { bin: string; args: string[] } {
  switch (agent) {
    case "opencode":
      return { bin: "opencode", args: ["run", "--auto", prompt] };
    case "omp":
      return { bin: "omp", args: ["-p", "--auto-approve", prompt] };
    case "hermes":
      return { bin: "hermes", args: ["-z", prompt] };
    case "claude":
    default:
      return { bin: "claude", args: ["-p", prompt, "--output-format", "text", "--permission-mode", "acceptEdits"] };
  }
}

function freedBytes(output: string): number | undefined {
  const matches = [...output.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(GB|GiB|MB|MiB)/gi)];
  if (!matches.length) return undefined;
  let total = 0;
  for (const match of matches) {
    const value = Number(match[1].replace(",", "."));
    const unit = match[2].toLowerCase();
    total += unit.startsWith("g") ? value : value / 1024;
  }
  return Math.round(total * 1_073_741_824);
}

function plainSummary(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 200 && !line.startsWith("===") && !line.startsWith("---"));
  const meaningful = lines.filter((line) => !/^(warning|hint):/i.test(line) && !/deprecat/i.test(line));
  return meaningful.slice(-4).join("\n") || "done.";
}

async function streamProcess(
  runId: string,
  cmd: string[],
  cwd: string,
  emit: Emit,
): Promise<number> {
  const env = {
    ...process.env,
    PATH: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.opencode/bin`,
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.cargo/bin`,
      process.env.PATH ?? "",
    ].join(":"),
    TERM: "dumb",
    NO_COLOR: "1",
  };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    emit("error", { message: error instanceof Error ? error.message : "could not start the command" });
    return 127;
  }
  active.set(runId, { proc, paused: false });

  const read = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 0) {
        emit("output", { text: buffer.replace(ansi, "") });
        buffer = "";
      }
    }
  };

  await Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]);
  const code = await proc.exited;
  active.delete(runId);
  return code;
}

export async function execute(request: ExecuteRequest, emit: Emit): Promise<void> {
  const runId = request.runId;
  const workingDirectory = request.workingDirectory?.startsWith("~")
    ? request.workingDirectory.replace(/^~/, process.env.HOME ?? "")
    : request.workingDirectory || process.env.HOME!;
  const commands = request.commands ?? [];

  for (const command of commands) {
    if (isBlocked(command)) {
      emit("error", { message: "that command could destroy the Mac. I won't run it." });
      return;
    }
  }

  emit("started", { runId });
  let allOutput = "";
  const collect: Emit = (event, data) => {
    if (event === "output" && typeof data.text === "string") allOutput += data.text;
    emit(event, data);
  };

  try {
    if (request.kind === "coding") {
      if (!request.prompt) {
        emit("error", { message: "no prompt to give the coding agent" });
        return;
      }
      const { bin, args } = agentCommand(request.agent, request.prompt);
      const path = Bun.which(bin) ?? bin;
      emit("step", { index: 0, status: "running", title: `running ${request.agent ?? "claude"}` });
      emit("output", { text: `$ ${bin} ${args.map((a) => (a === request.prompt ? shellQuote(a) : a)).join(" ")}\n\n` });
      const code = await streamProcess(runId, [path, ...args], workingDirectory, collect);
      if (code !== 0) {
        emit("error", { message: allOutput.split("\n").slice(-5).join("\n") || `agent exited with ${code}` });
        return;
      }
      emit("done", { summary: plainSummary(allOutput), code });
      return;
    }

    if (!commands.length) {
      emit("done", { summary: "nothing to run", code: 0 });
      return;
    }

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      emit("step", { index, status: "running", title: command });
      emit("output", { text: `\n$ ${command}\n` });
      const code = await streamProcess(runId, ["/bin/zsh", "-c", command], workingDirectory, collect);
      if (code !== 0) {
        emit("step", { index, status: "failed", title: command });
        emit("error", { message: allOutput.split("\n").filter(Boolean).slice(-6).join("\n") || `command exited with ${code}` });
        return;
      }
      emit("step", { index, status: "done", title: command });
    }

    emit("done", { summary: plainSummary(allOutput), freedBytes: freedBytes(allOutput), code: 0 });
  } catch (error) {
    emit("error", { message: error instanceof Error ? error.message : "unexpected failure" });
  }
}

export function stop(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  try {
    entry.proc.kill();
  } catch {}
  active.delete(runId);
  return true;
}

export function pause(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  try {
    process.kill(entry.proc.pid, "SIGSTOP");
    entry.paused = true;
    return true;
  } catch {
    return false;
  }
}

export function resume(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  try {
    process.kill(entry.proc.pid, "SIGCONT");
    entry.paused = false;
    return true;
  } catch {
    return false;
  }
}
