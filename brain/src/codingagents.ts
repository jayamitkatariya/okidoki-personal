/**
 * Coding agents: Claude Code, Codex, Amp, Pi, OpenCode, Gemini CLI, Cursor Agent or any command the person
 * adds. okidoki hands them the jobs they are better at (files, the terminal, code, deep Mac work, vault
 * chores) and runs them non-interactively in a working folder, streaming what they do into the run.
 *
 * Flags here were checked against each CLI's `--help` (claude, codex, pi, opencode, cursor-agent) or its
 * docs (amp: ampcode.com/docs/cli, gemini: gemini-cli docs/cli). Anything else is a custom command.
 */
import type { Subprocess } from "bun";
import { engineAvailable, runEngineAgent, stopEngineRun } from "./engine/chats";

export type AgentFormat = "claude" | "codex" | "pi" | "opencode" | "gemini" | "text";
export type AgentAccess = "workspace" | "full";

export interface AgentPreset {
  id: string;
  name: string;
  /** The program, looked up on the Mac's PATH. */
  binary: string;
  format: AgentFormat;
  /** Where its flags were checked: the CLI's --help on a Mac, or its docs. */
  verified: "help" | "docs";
  /** What it can touch at each access level, in words for Settings and the run preview. */
  access: Record<AgentAccess, string>;
  /** True when the agent has no permission layer of its own, so every run waits for an okay. */
  unguarded?: boolean;
}

export const PRESETS: AgentPreset[] = [
  {
    id: "claude", name: "Claude Code", binary: "claude", format: "claude", verified: "help",
    access: {
      workspace: "Reads anything, edits files in the working folder, and runs only safe commands there (list, copy, move, make folders, convert). Deleting, installing or sending stops and asks you.",
      full: "Bypasses Claude Code's permission checks: any file, any command.",
    },
  },
  {
    id: "codex", name: "Codex", binary: "codex", format: "codex", verified: "help",
    access: {
      workspace: "Codex's workspace-write sandbox: it writes only inside the working folder and has no network.",
      full: "No sandbox and no approvals: any file, any command, the network.",
    },
  },
  {
    id: "amp", name: "Amp", binary: "amp", format: "claude", verified: "docs",
    access: {
      workspace: "Amp's own permission rules apply; commands they don't allow are denied and come back to you.",
      full: "Amp's own permission rules apply.",
    },
  },
  {
    id: "pi", name: "Pi", binary: "pi", format: "pi", verified: "help", unguarded: true,
    access: {
      workspace: "Pi has no permission layer: it can run any command, so each job waits for your okay first.",
      full: "Pi has no permission layer: it can run any command.",
    },
  },
  {
    id: "opencode", name: "OpenCode", binary: "opencode", format: "opencode", verified: "help",
    access: {
      workspace: "OpenCode's own permission config applies; anything set to ask is not auto-approved.",
      full: "Auto-approves every permission that isn't explicitly denied (--auto).",
    },
  },
  {
    id: "gemini", name: "Gemini CLI", binary: "gemini", format: "gemini", verified: "docs",
    access: {
      workspace: "auto_edit approval mode: file edits are allowed, shell commands are not.",
      full: "yolo approval mode: every tool runs without asking.",
    },
  },
  {
    id: "cursor", name: "Cursor Agent", binary: "cursor-agent", format: "claude", verified: "help",
    access: {
      workspace: "Cursor's sandbox and allow-list apply; commands it doesn't allow are not run.",
      full: "--force: runs every command unless you denied it in Cursor.",
    },
  },
];

export function preset(id: string): AgentPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Claude Code tools allowed in workspace mode: reading, editing in the working folder, and file chores. */
export const CLAUDE_SAFE_TOOLS = [
  "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "TodoWrite",
  ...["ls", "pwd", "find", "file", "stat", "du", "wc", "head", "tail", "cat", "sort", "uniq", "diff", "mkdir", "cp", "mv", "touch",
    "mdls", "mdfind", "pdftotext", "pdfinfo", "textutil", "sips", "unzip", "zip", "tar", "shasum", "md5", "jq", "date", "echo",
    "rg", "grep", "okidoki", "git status", "git diff", "git log"].map((cmd) => `Bash(${cmd} *)`),
];
/** Never in workspace mode, even when a broader rule would allow it. */
export const CLAUDE_DENIED_TOOLS = ["Bash(rm *)", "Bash(sudo *)", "Bash(git push *)", "Bash(curl *)", "Bash(wget *)",
  "Bash(brew *)", "Bash(npm install *)", "Bash(pip install *)", "Bash(osascript *)"];

/** A program-wide rule for something on the deny list ("Bash(rm *)"), or a deny rule a command falls under. */
function isRiskyRule(rule: string): boolean {
  return CLAUDE_DENIED_TOOLS.some((denied) => rule === denied || rule.startsWith(denied.slice(0, -2)));
}

/** A deny rule comes off only for what the person okayed: the rule itself or an exact command under it. */
function denyLifted(denied: string, allow: string[]): boolean {
  const prefix = denied.slice(0, -2); // "Bash(rm *)" → "Bash(rm "
  return allow.some((rule) => rule === denied || rule.startsWith(prefix));
}

export interface AgentRunRequest {
  runId: string;
  /** Run on the local harness runtime (the engine) instead of the agent's CLI. */
  engine?: boolean;
  /** A preset id, or "custom". */
  agent: string;
  prompt: string;
  cwd: string;
  /** Absolute path of the binary as the Mac found it; the preset's name is looked up on PATH otherwise. */
  binary?: string;
  /** For custom agents: the command, with {prompt} and {cwd} where they go. */
  template?: string;
  access?: AgentAccess;
  /** The agent's own session or thread id from an earlier run in the same conversation. */
  sessionId?: string;
  /** Exact tool rules the person okayed after a denial, e.g. "Bash(rm old.pdf)". */
  allow?: string[];
  /** PATH entries to add (the Mac's search paths). */
  path?: string[];
  timeoutMs?: number;
}

/** What okidoki tells the coding agent about itself, so the two can hand work back and forth. */
export function collaborationNote(cwd: string): string {
  return [
    `You were started by okidoki, the person's assistant app on this Mac, to do a job that needs files, the terminal or code. Work in ${cwd}.`,
    `okidoki can do what you can't: the web with the person's own logins (okidoki browse "<task>"), Mac apps like Mail, Notes and Calendar (okidoki computer "<task>"), replaying saved skills (okidoki skills, okidoki replay), what it remembers about them (okidoki memory) and finding documents in their vault (okidoki vault). Run \`okidoki help\` for more; add --wait 300 to get the result.`,
    `Don't hand file or terminal work back to okidoki — that's your part. Never delete outside ${cwd}, install software, or send anything on the person's behalf; if the job needs that, stop and say exactly what you need.`,
    `Finish with a short plain summary of what you did and where the results are.`,
  ].join("\n");
}

/** Single-quoted for zsh, so a prompt can never break out of its argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The argv for a run. Custom agents run their template through zsh, with {prompt} and {cwd} quoted in. */
export function buildCommand(request: AgentRunRequest): string[] {
  const access: AgentAccess = request.access === "full" ? "full" : "workspace";
  const note = collaborationNote(request.cwd);
  const session = request.sessionId?.trim() || undefined;
  if (request.agent === "custom" || !preset(request.agent)) {
    const template = (request.template ?? "").trim();
    if (!template) throw new Error("this agent has no command");
    const withPrompt = template.includes("{prompt}") ? template : `${template} {prompt}`;
    // One pass, so a "{cwd}" inside the prompt stays text instead of splicing a quoted path into it.
    const values: Record<string, string> = { prompt: shellQuote(`${request.prompt}\n\n${note}`), cwd: shellQuote(request.cwd) };
    const command = withPrompt.replace(/\{(prompt|cwd)\}/g, (_, name: string) => values[name]);
    return ["/bin/zsh", "-c", command];
  }
  const p = preset(request.agent)!;
  const bin = request.binary?.trim() || p.binary;
  switch (p.id) {
    case "claude": {
      const args = [bin, "-p", request.prompt, "--output-format", "stream-json", "--verbose", "--append-system-prompt", note];
      if (session) args.push("--resume", session);
      if (access === "full") {
        args.push("--permission-mode", "bypassPermissions");
      } else {
        // One argument per rule (a rule can hold commas), each list closed by the next flag.
        const allow = request.allow ?? [];
        args.push("--allowedTools", ...CLAUDE_SAFE_TOOLS, ...allow);
        // A command the person okayed lifts its deny rule. Only that exact command is allowed, so any other
        // use of the program still falls outside the allow list, and with no one to ask in -p it's refused.
        const denied = CLAUDE_DENIED_TOOLS.filter((rule) => !denyLifted(rule, allow));
        if (denied.length) args.push("--disallowedTools", ...denied);
        args.push("--permission-mode", "acceptEdits");
      }
      return args;
    }
    case "codex": {
      const prompt = `${request.prompt}\n\n${note}`;
      const sandbox = access === "full" ? ["--dangerously-bypass-approvals-and-sandbox"] : [];
      if (session) {
        return [bin, "exec", "resume", "--json", "--skip-git-repo-check",
          ...(access === "full" ? sandbox : ["-c", `sandbox_mode="workspace-write"`]), session, prompt];
      }
      return [bin, "exec", "--json", "--skip-git-repo-check", "-C", request.cwd,
        ...(access === "full" ? sandbox : ["-s", "workspace-write"]), prompt];
    }
    case "amp": {
      const prompt = `${request.prompt}\n\n${note}`;
      return session ? [bin, "threads", "continue", session, "--execute", prompt, "--stream-json"] : [bin, "--execute", prompt, "--stream-json"];
    }
    case "pi": {
      const args = [bin, "-p", "--mode", "json", "--append-system-prompt", note];
      if (session) args.push("--session", session);
      return [...args, "--", request.prompt];
    }
    case "opencode": {
      const args = [bin, "run", "--format", "json"];
      if (session) args.push("--session", session);
      if (access === "full") args.push("--auto");
      return [...args, `${request.prompt}\n\n${note}`];
    }
    case "gemini": {
      const args = [bin, "-p", `${request.prompt}\n\n${note}`, "--output-format", "stream-json", "--approval-mode", access === "full" ? "yolo" : "auto_edit"];
      if (session) args.push("--resume", session);
      return args;
    }
    case "cursor": {
      const args = [bin, "-p", "--output-format", "stream-json", "--trust", "--workspace", request.cwd];
      if (session) args.push("--resume", session);
      if (access === "full") args.push("--force");
      return [...args, `${request.prompt}\n\n${note}`];
    }
  }
  throw new Error(`unknown agent ${request.agent}`);
}

export interface Denial {
  tool: string;
  detail: string;
  /** Rules that would allow it next time, for Claude Code's --allowedTools: the denied commands' programs,
   * or for risky programs (rm, sudo, curl…) only the exact command that was denied. */
  rules: string[];
}

const SHELL_WORDS = new Set(["for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "in", "time", "!", "{", "}"]);

/** The programs a shell command runs ("mkdir -p x && cp a b; rm c" → mkdir, cp, rm), as Bash(<program> *) rules.
 * A risky program (one on the deny list) is never allowed wholesale: its rule is that exact command, so an okay
 * for "rm notes.txt" doesn't also allow "rm -rf ~". */
export function commandRules(command: string): string[] {
  const rules = new Set<string>();
  for (const part of command.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const words = part.trim().replace(/^[({\s]+/, "").split(/\s+/).filter(Boolean);
    if (["for", "select", "case"].includes(words[0] ?? "")) continue; // "for f in *.pdf" runs nothing itself
    while (words.length && (SHELL_WORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
    const program = words[0]?.replace(/^["']|["')]$/g, "");
    if (program && /^[\w./+-]+$/.test(program) && !program.startsWith("$")) {
      // Subcommand tools are scoped to their subcommand: git push, npm install.
      const scoped = ["git", "npm", "pip", "pip3", "brew", "bun", "yarn"].includes(program) && words[1] && /^[a-z-]+$/.test(words[1]);
      const wide = scoped ? `Bash(${program} ${words[1]} *)` : `Bash(${program} *)`;
      rules.add(isRiskyRule(wide) ? `Bash(${words.join(" ")})` : wide);
    }
  }
  return [...rules];
}

export type AgentEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string; id?: string }
  | { type: "tool_done"; id?: string; ok: boolean; detail?: string }
  | { type: "result"; text: string; isError?: boolean; denials?: Denial[] }
  | { type: "log"; text: string };

const clip = (value: unknown, max = 160): string => {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One line a person can read about a tool call: the command, the file, or the arguments. */
export function toolDetail(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url", "description"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clip(value);
    if (Array.isArray(value) && value.length) return clip(value.join(" "));
  }
  return clip(input);
}

/** Denied steps that need something new allowed. One denied only for its shape (a long compound command
 * of programs it may already run) was worked around by the agent and isn't the person's to approve. */
function claudeDenials(raw: unknown): Denial[] {
  if (!Array.isArray(raw)) return [];
  const safe = new Set(CLAUDE_SAFE_TOOLS);
  const seen = new Set<string>();
  return raw.map((d) => {
    const item = (d ?? {}) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const tool = item.tool_name ?? "tool";
    const command = typeof item.tool_input?.command === "string" ? item.tool_input.command : "";
    const detail = command || toolDetail(tool, item.tool_input);
    const rules = (tool === "Bash" && command ? commandRules(command) : [tool]).filter((rule) => !safe.has(rule));
    return { tool, detail, rules };
  }).filter((denial) => {
    const key = denial.rules.join(" ");
    if (!denial.rules.length || seen.has(`${key}|${denial.detail}`)) return false;
    seen.add(`${key}|${denial.detail}`);
    return true;
  });
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

const DENIED_RESULT = /permission to use|requires? (manual )?approval|cannot be auto-allowed|can't be checked|was (blocked|denied)/i;

/** Turns one line of an agent's JSON output into events. Unknown shapes are skipped, never fatal. */
export function parseLine(format: AgentFormat, line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (format === "text") return [{ type: "log", text: trimmed }];
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ type: "log", text: trimmed }];
  }
  if (!msg || typeof msg !== "object") return [];
  const out: AgentEvent[] = [];
  switch (format) {
    case "claude": {
      // Claude Code's stream-json; Amp and Cursor Agent follow the same shape.
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) out.push({ type: "session", id: String(msg.session_id) });
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        if (msg.parent_tool_use_id) break; // a subagent's inner turns
        for (const block of msg.message.content) {
          if (block?.type === "text" && block.text?.trim()) out.push({ type: "text", text: block.text });
          if (block?.type === "tool_use") out.push({ type: "tool", name: String(block.name ?? "tool"), detail: toolDetail(block.name, block.input), id: block.id });
        }
      }
      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block?.type === "tool_result") {
            const detail = clip(textBlocks(block.content) || block.content);
            // A permission denial comes back as the tool's result; it didn't run.
            out.push({ type: "tool_done", id: block.tool_use_id, ok: !block.is_error && !DENIED_RESULT.test(detail.slice(0, 240)), detail });
          }
        }
      }
      // Cursor Agent reports tools as their own events.
      if (msg.type === "tool_call" && msg.subtype === "started") {
        const call = msg.tool_call && typeof msg.tool_call === "object" ? Object.entries(msg.tool_call)[0] : undefined;
        const name = call ? String(call[0]).replace(/ToolCall$/, "") : "tool";
        out.push({ type: "tool", name, detail: toolDetail(name, (call?.[1] as any)?.args), id: msg.call_id });
      }
      if (msg.type === "tool_call" && msg.subtype === "completed") out.push({ type: "tool_done", id: msg.call_id, ok: true });
      if (msg.type === "result") {
        if (msg.session_id) out.push({ type: "session", id: String(msg.session_id) });
        out.push({
          type: "result",
          text: typeof msg.result === "string" ? msg.result : String(msg.error ?? ""),
          isError: Boolean(msg.is_error) || (typeof msg.subtype === "string" && msg.subtype.startsWith("error")),
          denials: claudeDenials(msg.permission_denials),
        });
      }
      break;
    }
    case "codex": {
      if (msg.type === "thread.started" && msg.thread_id) out.push({ type: "session", id: String(msg.thread_id) });
      const item = msg.item ?? {};
      if (msg.type === "item.started" && item.type === "command_execution") out.push({ type: "tool", name: "shell", detail: clip(String(item.command ?? "").replace(/^\/bin\/zsh -lc /, "")), id: item.id });
      if (msg.type === "item.started" && item.type === "mcp_tool_call") out.push({ type: "tool", name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, detail: clip(item.arguments), id: item.id });
      if (msg.type === "item.completed") {
        if (item.type === "agent_message" && item.text?.trim()) out.push({ type: "text", text: item.text });
        if (item.type === "command_execution" || item.type === "mcp_tool_call") out.push({ type: "tool_done", id: item.id, ok: item.exit_code == null ? item.status !== "failed" : item.exit_code === 0, detail: clip(item.aggregated_output) });
        if (item.type === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          out.push({ type: "tool", name: "edit", detail: clip(changes.map((c: any) => `${c.kind ?? "change"} ${c.path ?? ""}`).join(", ")), id: item.id });
          out.push({ type: "tool_done", id: item.id, ok: item.status !== "failed" });
        }
        if (item.type === "web_search") out.push({ type: "tool", name: "web search", detail: clip(item.query) });
      }
      if (msg.type === "turn.failed") out.push({ type: "result", text: String(msg.error?.message ?? "the turn failed"), isError: true });
      if (msg.type === "error") out.push({ type: "log", text: clip(msg.message, 400) });
      break;
    }
    case "pi": {
      if (msg.type === "session" && msg.id) out.push({ type: "session", id: String(msg.id) });
      if (msg.type === "tool_execution_start") out.push({ type: "tool", name: String(msg.toolName ?? "tool"), detail: toolDetail(msg.toolName, msg.args), id: msg.toolCallId });
      if (msg.type === "tool_execution_end") out.push({ type: "tool_done", id: msg.toolCallId, ok: !msg.isError && !msg.result?.isError, detail: clip(textBlocks(msg.result?.content)) });
      if (msg.type === "message_end" && msg.message?.role === "assistant") {
        const text = textBlocks(msg.message.content);
        if (text.trim()) out.push({ type: "text", text });
      }
      break;
    }
    case "opencode": {
      if (msg.sessionID) out.push({ type: "session", id: String(msg.sessionID) });
      const part = msg.part ?? {};
      if (msg.type === "tool_use") {
        out.push({ type: "tool", name: String(part.tool ?? "tool"), detail: toolDetail(part.tool, part.state?.input), id: part.id ?? part.callID });
        if (part.state?.status === "completed" || part.state?.status === "error") {
          out.push({ type: "tool_done", id: part.id ?? part.callID, ok: part.state.status === "completed", detail: clip(part.state.output ?? part.state.error) });
        }
      }
      if (msg.type === "text" && typeof part.text === "string" && part.text.trim()) out.push({ type: "text", text: part.text });
      if (msg.type === "error") out.push({ type: "result", text: clip(msg.error?.data?.message ?? msg.error?.message ?? msg.error, 400), isError: true });
      break;
    }
    case "gemini": {
      if (msg.type === "init" && msg.session_id) out.push({ type: "session", id: String(msg.session_id) });
      if (msg.type === "message" && msg.role === "assistant" && typeof msg.content === "string" && msg.content) {
        // Streamed as chunks (delta: true); joined by the runner.
        out.push({ type: "text", text: msg.content });
      }
      if (msg.type === "tool_use") out.push({ type: "tool", name: String(msg.tool_name ?? "tool"), detail: toolDetail(msg.tool_name, msg.parameters), id: msg.tool_id });
      if (msg.type === "tool_result") out.push({ type: "tool_done", id: msg.tool_id, ok: msg.status !== "error", detail: clip(msg.output ?? msg.error?.message) });
      if (msg.type === "error") out.push({ type: "log", text: clip(msg.message, 400) });
      if (msg.type === "result" && msg.status === "error") out.push({ type: "result", text: clip(msg.error?.message ?? "failed", 400), isError: true });
      break;
    }
  }
  return out;
}

export interface AgentOutcome {
  ok: boolean;
  answer: string;
  sessionId?: string;
  exitCode: number | null;
  denials: Denial[];
  stopped: boolean;
  error?: string;
  /** Tool calls it made, for the run's steps. */
  tools: number;
}

/** Folds events into the final outcome: the last thing the agent said, its session, any denials. */
export class OutcomeBuilder {
  sessionId?: string;
  private texts: string[] = [];
  private result?: { text: string; isError?: boolean; denials?: Denial[] };
  private logs: string[] = [];
  tools = 0;
  private lastWasGeminiChunk = false;

  constructor(private format: AgentFormat) {}

  add(event: AgentEvent): void {
    switch (event.type) {
      case "session": this.sessionId = event.id; break;
      case "text":
        if (this.format === "gemini" && this.lastWasGeminiChunk && this.texts.length) this.texts[this.texts.length - 1] += event.text;
        else this.texts.push(event.text);
        this.lastWasGeminiChunk = this.format === "gemini";
        return;
      case "tool": this.tools += 1; break;
      case "result": this.result = event; break;
      case "log": this.logs.push(event.text); if (this.logs.length > 60) this.logs.shift(); break;
    }
    this.lastWasGeminiChunk = false;
  }

  finish(exitCode: number | null, stderr: string, stopped: boolean): AgentOutcome {
    const denials = this.result?.denials ?? [];
    const said = (this.result?.text?.trim() || this.texts[this.texts.length - 1]?.trim() || this.logs.slice(-30).join("\n").trim());
    const failed = stopped || Boolean(this.result?.isError) || (exitCode !== 0 && exitCode !== null);
    const why = failed && !stopped ? (this.result?.isError ? this.result.text : lastLines(stderr) || `exited with code ${exitCode}`) : undefined;
    return {
      ok: !failed,
      answer: said || (stopped ? "stopped." : failed ? "" : "done."),
      sessionId: this.sessionId,
      exitCode,
      denials,
      stopped,
      error: stopped ? "you stopped it" : why,
      tools: this.tools,
    };
  }
}

function lastLines(text: string, count = 6): string {
  return text.trim().split("\n").slice(-count).join("\n").slice(0, 600);
}

const running = new Map<string, { proc: Subprocess; stopped: boolean; timedOut?: boolean }>();

/** Stops a coding agent run and everything it started. True when one was running. */
export function stopCodingAgent(runId: string): boolean {
  if (stopEngineRun(runId)) return true;
  const entry = running.get(runId);
  if (!entry) return false;
  entry.stopped = true;
  killGroup(entry.proc, "SIGTERM");
  setTimeout(() => killGroup(entry.proc, "SIGKILL"), 3000);
  return true;
}

export function stopAllCodingAgents(): void {
  for (const runId of [...running.keys()]) stopCodingAgent(runId);
}

function killGroup(proc: Subprocess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode) return;
  try {
    process.kill(-proc.pid, signal); // its own process group: the agent and its shells
  } catch {
    try { proc.kill(signal); } catch {}
  }
}

/** Runs one job to the end, calling `onEvent` for everything it does. */
export async function runCodingAgent(request: AgentRunRequest, onEvent: (event: AgentEvent) => void): Promise<AgentOutcome> {
  if (request.engine) {
    if (await engineAvailable()) {
      let emitted = 0;
      try {
        return await runEngineAgent(request, (event) => {
          emitted += 1;
          onEvent(event);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "the harness runtime failed";
        if (emitted > 0) {
          return { ok: false, answer: "", exitCode: null, denials: [], stopped: false, tools: 0, error: message };
        }
        onEvent({ type: "log", text: `harness runtime unavailable: ${message} — using the CLI` });
      }
    } else {
      onEvent({ type: "log", text: "harness runtime is not ready — using the CLI" });
    }
  }
  const argv = buildCommand(request);
  const format: AgentFormat = request.agent === "custom" || !preset(request.agent) ? "text" : preset(request.agent)!.format;
  const builder = new OutcomeBuilder(format);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PATH = [...(request.path ?? []), env.PATH ?? ""].filter(Boolean).join(":");
  env.NO_COLOR = "1";
  env.OKIDOKI_DELEGATED = "1";
  delete env.OKIDOKI_BRAIN_TOKEN;
  delete env.ANTHROPIC_API_KEY; // the agent uses its own sign-in, never okidoki's key
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    // perl's setpgrp gives the agent its own process group, so stop reaches every shell it started.
    proc = Bun.spawn(["/usr/bin/perl", "-e", "setpgrp(0,0); exec @ARGV or die qq(could not start $ARGV[0]: $!\\n)", "--", ...argv], {
      cwd: request.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
  } catch (error) {
    return { ok: false, answer: "", exitCode: null, denials: [], stopped: false, tools: 0, error: error instanceof Error ? error.message : "couldn't start" };
  }
  const entry: { proc: Subprocess; stopped: boolean; timedOut?: boolean } = { proc, stopped: false };
  running.set(request.runId, entry);
  const limitMs = request.timeoutMs ?? 30 * 60_000;
  const timeout = setTimeout(() => {
    entry.timedOut = true;
    stopCodingAgent(request.runId);
  }, limitMs);
  const emit = (event: AgentEvent) => {
    builder.add(event);
    try { onEvent(event); } catch {}
  };
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        for (const event of parseLine(format, line)) emit(event);
      }
    }
    for (const event of parseLine(format, pending)) emit(event);
  } catch {}
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  running.delete(request.runId);
  const stderr = await stderrPromise;
  // The time limit isn't the person stopping it: report it as a failure that says why.
  if (entry.timedOut) {
    const outcome = builder.finish(exitCode, stderr, false);
    return { ...outcome, ok: false, stopped: false, error: `it ran past the ${Math.round(limitMs / 60_000)}-minute limit and was stopped` };
  }
  return builder.finish(exitCode, stderr, entry.stopped);
}

// MARK: - Routing

/** What the Mac tells /think about the coding agents the person turned on. */
export interface CodingAgentsContext {
  agents: { id: string; name: string }[];
  defaultId?: string;
  folder?: string;
  /** The agent already working in this conversation, so follow-ups go back to it. */
  threadAgent?: string;
}

const FILE_WORK = /\b(files?|folders?|director(y|ies)|pdfs?|csvs?|spreadsheets?|docx?|documents?|rename|reorgani[sz]e|organi[sz]e|sort(ed)? (them|by)|convert|extract|merge|split|dedupe|duplicates?|terminal|shell|script|scripts|code|codebase|repo|repository|git|compile|build|refactor|debug|tests?|bash|zsh|python|node|bun|npm|cli|command line|vault)\b/;
const FILE_VERBS = /\b(make|create|write|move|copy|rename|organi[sz]e|sort|convert|extract|merge|split|clean|fix|build|refactor|run|set ?up|install|generate|find|search|list|zip|compress|resize|tidy|batch)\b/;

const APP_OR_WEB = /\b(in|on|to|into|from) (the )?(notes|calendar|reminders|mail|messages|slack|safari|chrome|finder window|keynote|pages|numbers|whatsapp|gmail|website|site|web|browser)\b|\bhttps?:\/\/|\b\w+\.(com|in|org|io|net|gov|edu|co|ai|app|dev)\b/;

/** A job for a coding agent: it acts on files, folders, code or the terminal, not on websites or app windows. */
export function looksLikeAgentWork(text: string): boolean {
  const t = text.toLowerCase();
  // Work inside a Mac app or on a website stays with computer use or the browser, even if it mentions files.
  if (APP_OR_WEB.test(t)) return false;
  return FILE_WORK.test(t) && FILE_VERBS.test(t);
}

export function codingAgentPrompt(context: CodingAgentsContext | undefined): string {
  if (!context?.agents?.length) return "";
  const names = context.agents.map((a) => `${a.name} (id: ${a.id})`).join(", ");
  const lead = context.agents.find((a) => a.id === context.defaultId) ?? context.agents[0];
  return [
    `Coding agents are connected: ${names}. The default is ${lead.name}. They work in ${context.folder || "the working folder"} with files, the terminal and code, far better than driving Finder or Terminal by clicking.`,
    `- Jobs on files, folders, documents, code, scripts or the terminal — organising, renaming, converting, extracting from documents, sorting PDFs, building or fixing code, data wrangling, vault chores — → kind coding_agent, with agent_task: a complete, self-contained instruction in their words plus anything from the conversation it needs (paths, names, formats), and agent: the id when they named one (else leave empty). Keep preview_steps short.`,
    `- Websites, logins and Mac app windows stay browser or computer_use; the coding agent can call okidoki for those itself.`,
    context.threadAgent ? `- This conversation is already working with ${context.agents.find((a) => a.id === context.threadAgent)?.name ?? context.threadAgent}; a follow-up about that work ("now also…", "undo that", "what did you change?") is coding_agent too.` : ``,
  ].filter(Boolean).join("\n");
}

/** Makes a coding_agent decision safe to hand to the Mac: an agent that's on, and a task to give it. */
export function checkCodingAgentDecision<T extends { kind: string; answer: string; agentTask?: string; agentId?: string; previewSummary?: string; title: string }>(decision: T, context: CodingAgentsContext | undefined, requestText: string): T {
  if (decision.kind !== "coding_agent") return decision;
  const agents = context?.agents ?? [];
  if (!agents.length) {
    return { ...decision, kind: "computer_use", previewSummary: decision.previewSummary || decision.agentTask || requestText };
  }
  const known = agents.find((a) => a.id === decision.agentId) ?? agents.find((a) => a.id === context?.threadAgent) ?? agents.find((a) => a.id === context?.defaultId) ?? agents[0];
  return { ...decision, agentId: known.id, agentTask: (decision.agentTask || "").trim() || requestText };
}
