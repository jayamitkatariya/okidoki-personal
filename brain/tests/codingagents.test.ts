import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommand, checkCodingAgentDecision, commandRules, codingAgentPrompt, looksLikeAgentWork, OutcomeBuilder, parseLine,
  runCodingAgent, shellQuote, stopCodingAgent, type AgentEvent, type AgentFormat,
} from "../src/codingagents";
import { localRouter } from "../src/router";

const base = { runId: "r1", prompt: "sort my pdfs by year", cwd: "/tmp/work" };

function fold(format: AgentFormat, lines: string[]) {
  const builder = new OutcomeBuilder(format);
  const events: AgentEvent[] = [];
  for (const line of lines) for (const event of parseLine(format, line)) { events.push(event); builder.add(event); }
  return { events, outcome: builder.finish(0, "", false) };
}

describe("command building", () => {
  test("claude code: print mode, stream json, safe permissions, okidoki note", () => {
    const argv = buildCommand({ ...base, agent: "claude", binary: "/Users/x/.local/bin/claude" });
    expect(argv.slice(0, 3)).toEqual(["/Users/x/.local/bin/claude", "-p", "sort my pdfs by year"]);
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(argv).toContain("Bash(mkdir *)");
    expect(argv.indexOf("Bash(mkdir *)")).toBeGreaterThan(argv.indexOf("--allowedTools"));
    expect(argv.indexOf("Bash(mkdir *)")).toBeLessThan(argv.indexOf("--disallowedTools"));
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--disallowedTools"))).not.toContain("Bash(rm *)");
    expect(argv.slice(argv.indexOf("--disallowedTools"))).toContain("Bash(rm *)");
    // Every variadic list is closed by a flag, so nothing swallows what follows.
    expect(argv.at(-2)).toBe("--permission-mode");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("okidoki browse");
    expect(argv).not.toContain("--resume");
  });

  test("claude code: resumes the thread's session, and an okayed command lifts its deny rule", () => {
    const argv = buildCommand({ ...base, agent: "claude", sessionId: "abc", allow: ["Bash(rm *)"] });
    expect(argv[argv.indexOf("--resume") + 1]).toBe("abc");
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--disallowedTools"))).toContain("Bash(rm *)");
    expect(argv.slice(argv.indexOf("--disallowedTools"))).not.toContain("Bash(rm *)");
    expect(argv.slice(argv.indexOf("--disallowedTools"))).toContain("Bash(sudo *)");
  });

  test("claude code: an exact okayed command lifts the deny rule but allows only that command", () => {
    const argv = buildCommand({ ...base, agent: "claude", allow: ["Bash(rm notes.txt)"] });
    const allowed = argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--disallowedTools"));
    expect(allowed).toContain("Bash(rm notes.txt)");
    expect(allowed).not.toContain("Bash(rm *)");
    expect(argv.slice(argv.indexOf("--disallowedTools"))).not.toContain("Bash(rm *)");
    expect(argv.slice(argv.indexOf("--disallowedTools"))).toContain("Bash(curl *)");
  });

  test("claude code: full access bypasses its permission checks", () => {
    const argv = buildCommand({ ...base, agent: "claude", access: "full" });
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(argv).not.toContain("--allowedTools");
  });

  test("codex: exec with the workspace-write sandbox, resume by thread id", () => {
    const fresh = buildCommand({ ...base, agent: "codex" });
    expect(fresh.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(fresh[fresh.indexOf("-s") + 1]).toBe("workspace-write");
    expect(fresh[fresh.indexOf("-C") + 1]).toBe("/tmp/work");
    const resumed = buildCommand({ ...base, agent: "codex", sessionId: "t-1" });
    expect(resumed.slice(0, 4)).toEqual(["codex", "exec", "resume", "--json"]);
    expect(resumed).toContain(`sandbox_mode="workspace-write"`);
    expect(resumed.at(-2)).toBe("t-1");
    expect(buildCommand({ ...base, agent: "codex", access: "full" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("pi, opencode, gemini, cursor, amp", () => {
    const pi = buildCommand({ ...base, agent: "pi", sessionId: "s" });
    expect(pi).toEqual(expect.arrayContaining(["-p", "--mode", "json", "--session", "s", "--"]));
    expect(pi.at(-1)).toBe("sort my pdfs by year");
    const oc = buildCommand({ ...base, agent: "opencode", sessionId: "ses_1" });
    expect(oc.slice(0, 4)).toEqual(["opencode", "run", "--format", "json"]);
    expect(oc[oc.indexOf("--session") + 1]).toBe("ses_1");
    expect(oc).not.toContain("--auto");
    const gem = buildCommand({ ...base, agent: "gemini" });
    expect(gem[gem.indexOf("--approval-mode") + 1]).toBe("auto_edit");
    expect(gem[gem.indexOf("--output-format") + 1]).toBe("stream-json");
    const cur = buildCommand({ ...base, agent: "cursor", access: "full" });
    expect(cur).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--trust", "--workspace", "/tmp/work", "--force"]));
    expect(buildCommand({ ...base, agent: "amp", sessionId: "T-9" }).slice(0, 4)).toEqual(["amp", "threads", "continue", "T-9"]);
  });

  test("custom command quotes {prompt} and {cwd} so nothing escapes", () => {
    const argv = buildCommand({ ...base, agent: "custom", prompt: "it's $(rm -rf ~)", template: "aider --message {prompt} --dir {cwd}" });
    expect(argv.slice(0, 2)).toEqual(["/bin/zsh", "-c"]);
    expect(argv[2]).toStartWith("aider --message 'it'\\''s $(rm -rf ~)");
    expect(argv[2]).toContain("--dir '/tmp/work'");
    expect(buildCommand({ ...base, agent: "custom", template: "myagent" })[2]).toStartWith("myagent '");
    expect(() => buildCommand({ ...base, agent: "custom", template: " " })).toThrow();
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("command rules", () => {
  test("each program in a compound command, keywords and variables skipped", () => {
    expect(commandRules(`for f in *.pdf; do y=$(echo "$f" | grep -oE '20[0-9]{2}'); mkdir -p "By year/$y" && cp -p "$f" "By year/$y/"; done && rm notes.txt`))
      .toEqual(["Bash(echo *)", "Bash(grep *)", "Bash(mkdir *)", "Bash(cp *)", "Bash(rm notes.txt)"]);
    expect(commandRules("git push origin main || npm install left-pad")).toEqual(["Bash(git push origin main)", "Bash(npm install left-pad)"]);
    expect(commandRules("git status && npm test")).toEqual(["Bash(git status *)", "Bash(npm test *)"]);
    expect(commandRules("X=1 python3 make.py")).toEqual(["Bash(python3 *)"]);
  });
});

describe("stream parsing", () => {
  test("claude code stream-json", () => {
    const { events, outcome } = fold("claude", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", tools: ["Bash"] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la", description: "List" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.pdf\nb.pdf" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Permission to use Bash with command rm a.pdf has been denied." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sorted 2 PDFs." }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Sorted 2 PDFs into 2024/.", session_id: "sess-1",
        permission_denials: [
          { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "rm a.pdf" } },
          // Denied for its shape only (programs it may run): the agent worked around it, nothing to approve.
          { tool_name: "Bash", tool_use_id: "t3", tool_input: { command: "mkdir -p 2024 && cp -p a.pdf 2024/" } },
        ] }),
    ]);
    expect(events.find((e) => e.type === "tool")).toEqual({ type: "tool", name: "Bash", detail: "ls -la", id: "t1" });
    expect(events.find((e) => e.type === "tool_done")).toMatchObject({ ok: true, id: "t1" });
    expect(events.filter((e) => e.type === "tool_done")[1]).toMatchObject({ ok: false, id: "t2" });
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe("sess-1");
    expect(outcome.answer).toBe("Sorted 2 PDFs into 2024/.");
    expect(outcome.denials).toEqual([{ tool: "Bash", detail: "rm a.pdf", rules: ["Bash(rm a.pdf)"] }]);
    expect(outcome.tools).toBe(1);
  });

  test("codex --json", () => {
    const { events, outcome } = fold("codex", [
      `{"type":"thread.started","thread_id":"01a1"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'ls -la'","status":"in_progress"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'ls -la'","aggregated_output":"a.txt","exit_code":0,"status":"completed"}}`,
      `{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/work/x.md","kind":"add"}],"status":"completed"}}`,
      `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"done"}}`,
      `{"type":"turn.completed","usage":{}}`,
    ]);
    expect(events.filter((e) => e.type === "tool").map((e) => (e as { detail: string }).detail)).toEqual(["'ls -la'", "add /tmp/work/x.md"]);
    expect(outcome).toMatchObject({ ok: true, sessionId: "01a1", answer: "done", tools: 2 });
  });

  test("pi --mode json", () => {
    const { outcome, events } = fold("pi", [
      `{"type":"session","version":3,"id":"01a1cf0e","cwd":"/tmp"}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Listing"}}`,
      `{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls -la"}}`,
      `{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"a.txt"}]}}`,
      `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"done"}]}}`,
      `{"type":"agent_settled","aborted":false}`,
    ]);
    expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "bash", detail: "ls -la" });
    expect(outcome).toMatchObject({ ok: true, sessionId: "01a1cf0e", answer: "done" });
  });

  test("opencode --format json", () => {
    const { outcome } = fold("opencode", [
      `{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}`,
      `{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","id":"p1","tool":"read","state":{"status":"completed","input":{"path":"/tmp/work"},"output":"a.txt"}}}`,
      `{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"Files: a.txt\\n\\ndone"}}`,
    ]);
    expect(outcome).toMatchObject({ ok: true, sessionId: "ses_1", answer: "Files: a.txt\n\ndone", tools: 1 });
  });

  test("gemini stream-json joins streamed chunks", () => {
    const { outcome } = fold("gemini", [
      `{"type":"init","session_id":"g1","model":"gemini"}`,
      `{"type":"message","role":"assistant","content":"Hello ","delta":true}`,
      `{"type":"message","role":"assistant","content":"there","delta":true}`,
      `{"type":"result","status":"success","stats":{}}`,
    ]);
    expect(outcome).toMatchObject({ ok: true, sessionId: "g1", answer: "Hello there" });
  });

  test("errors and junk", () => {
    expect(parseLine("claude", "not json")).toEqual([{ type: "log", text: "not json" }]);
    expect(parseLine("claude", "")).toEqual([]);
    const { outcome } = fold("claude", [JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, error: "too many turns" })]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("too many turns");
    const failed = new OutcomeBuilder("text");
    failed.add({ type: "log", text: "oops" });
    expect(failed.finish(2, "boom\n", false)).toMatchObject({ ok: false, error: "boom", answer: "oops" });
  });
});

describe("routing", () => {
  const ctx = { agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], defaultId: "codex", folder: "/v" };

  test("file, code and terminal jobs look like agent work; web and chat don't", () => {
    expect(looksLikeAgentWork("make a folder of my vault PDFs sorted by year")).toBe(true);
    expect(looksLikeAgentWork("rename these files to dates")).toBe(true);
    expect(looksLikeAgentWork("make a new note in Notes about the build")).toBe(false);
    expect(looksLikeAgentWork("download the PDF from irs.gov and extract the tables")).toBe(false);
    expect(looksLikeAgentWork("fix the failing tests in my repo")).toBe(true);
    expect(looksLikeAgentWork("book a flight to tokyo")).toBe(false);
    expect(looksLikeAgentWork("what's the weather")).toBe(false);
  });

  test("the local router hands file work to the default agent only when one is on", () => {
    const decision = localRouter({ text: "make a folder of my vault PDFs sorted by year", codingAgents: ctx });
    expect(decision.kind).toBe("coding_agent");
    expect(decision.agentId).toBe("codex");
    expect(decision.agentTask).toContain("sorted by year");
    expect(localRouter({ text: "make a folder of my vault PDFs sorted by year" }).kind).not.toBe("coding_agent");
    expect(localRouter({ text: "say hi to mom", mode: "agent", codingAgents: ctx }).kind).toBe("coding_agent");
  });

  test("decisions are checked: named agent kept, unknown falls back, none on means computer use", () => {
    const named = checkCodingAgentDecision({ kind: "coding_agent", title: "t", answer: "", agentId: "claude", agentTask: "x" }, ctx, "req");
    expect(named.agentId).toBe("claude");
    const unknown = checkCodingAgentDecision({ kind: "coding_agent", title: "t", answer: "", agentId: "nope" }, { ...ctx, threadAgent: "claude" }, "req");
    expect(unknown).toMatchObject({ agentId: "claude", agentTask: "req" });
    expect(checkCodingAgentDecision({ kind: "coding_agent", title: "t", answer: "" }, undefined, "req").kind).toBe("computer_use");
    expect(codingAgentPrompt(undefined)).toBe("");
    expect(codingAgentPrompt({ ...ctx, threadAgent: "claude" })).toContain("already working with Claude Code");
  });
});

describe("running", () => {
  test("a custom command runs in the working folder and streams its lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okidoki-agent-"));
    writeFileSync(join(dir, "a.pdf"), "x");
    const events: AgentEvent[] = [];
    const outcome = await runCodingAgent({ runId: "run-a", agent: "custom", prompt: "hi", cwd: dir, template: "ls; echo finished" }, (e) => events.push(e));
    expect(outcome.ok).toBe(true);
    expect(events.map((e) => (e as { text?: string }).text)).toContain("a.pdf");
    expect(outcome.answer).toContain("finished");
  });

  test("stop ends the agent and the shells it started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okidoki-agent-"));
    const run = runCodingAgent({ runId: "run-b", agent: "custom", prompt: "x", cwd: dir, template: "echo started; sleep 30 & wait; true" }, () => {});
    await Bun.sleep(300);
    expect(stopCodingAgent("run-b")).toBe(true);
    const outcome = await run;
    expect(outcome.stopped).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(stopCodingAgent("run-b")).toBe(false);
  }, 10_000);

  test("a missing program fails cleanly", async () => {
    const outcome = await runCodingAgent({ runId: "run-c", agent: "claude", binary: "/nonexistent/claude", prompt: "x", cwd: tmpdir() }, () => {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("could not start");
  });
});
