import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, jobEnvironment, pause, resume, shellQuote, stop, validateExecution } from "../src/executor";
import { localRouter, prefersShowing } from "../src/router";
import { agentTaskDecision, terminalDecision } from "../src/terminal";

test("fixed recipes never drop additional goals, custom parameters or negative constraints", () => {
  for (const text of [
    "compress this video and save it in Downloads",
    "resize my photos to 800 pixels",
    "convert this Word document to PDF",
    "zip a folder but exclude node_modules",
    "install python and node",
    "check free disk space then list the largest files",
    "download https://github.com/example/project without changing existing files",
  ]) expect(terminalDecision(text)).toBeUndefined();
});

test("named agent requests preserve the requested job and never become an empty chat", () => {
  for (const text of [
    "can you use hermes agent in terminal to find my bridge presentation pptx file",
    "Can you use Hermes Agent in terminal to find my Bridge presentation pptx file?",
    "use hermes to find my bridge deck",
    "can you run my hermes agent and find me book places near sf palace of fine arts",
    "install hermes and find my presentation",
    "find my bridge presentation using hermes",
    "use claude code to find my presentation",
    "run opencode to check my project",
  ]) {
    const decision = localRouter({ text });
    expect(decision.kind).toBe("terminal");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands?.[0]).not.toContain("install.sh");
    expect(decision.pickFile).toBeUndefined();
    expect(decision.builtin).toBeUndefined();
    expect(decision.title).toMatch(/find|check/);
  }
  for (const text of ["open hermes", "start hermes", "use hermes in terminal", "install hermes", "teach me how to use hermes to find files", "how do I use hermes to find files?"]) {
    expect(agentTaskDecision(text)).toBeUndefined();
  }
});

test("delegated tasks survive execution without shell interpolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okidoki-delegate-"));
  try {
    await Bun.write(join(dir, "hermes"), '#!/bin/sh\nprintf "%s\\n" "$#" "$1" "$2" > args.txt\nprintf "FOUND /verified/Bridge.pptx\\n"\n');
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "hermes"), 0o700);
    const text = "use hermes to find my 'bridge'; $(touch INJECTED) `touch ALSO_INJECTED`\npresentation 世界.pptx?";
    const decision = agentTaskDecision(text)!;
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await execute({ runId: crypto.randomUUID(), kind: "terminal", workingDirectory: dir,
      commands: ["export PATH=" + shellQuote(dir) + ":$PATH", ...decision.commands!] },
      (event, data) => events.push({ event, data }));
    expect(await readFile(join(dir, "args.txt"), "utf8")).toBe("2\n-z\n" + text + "\n");
    expect(await Bun.file(join(dir, "INJECTED")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "ALSO_INJECTED")).exists()).toBe(false);
    expect(events.filter(e => e.event === "output").map(e => e.data.text).join("")).toContain("FOUND /verified/Bridge.pptx");
    expect(events.at(-1)?.event).toBe("done");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("plain requests become concrete jobs without a key", () => {
  for (const text of ["install ffmpeg", "compress this video for Discord", "resize my photos", "make this PDF searchable", "zip a folder", "check free disk space", "download https://github.com/example/project", "show git status"]) {
    const d = localRouter({ text });
    expect(d.kind).toBe("terminal");
    expect(d.commands?.length).toBeGreaterThan(0);
  }
  expect(localRouter({ text: "teach me terminal" }).kind).toBe("teach");
  const figma = localRouter({ text: "teach me figma" });
  expect(figma.kind).toBe("teach");
  expect(figma.teachPlan?.length).toBeGreaterThan(3);
  expect(figma.teachPlan?.[0].marks[0]?.text).toBe("frame");
  expect(figma.teachPlan?.some((step) => step.marks.some((mark) => mark.kind === "arrow"))).toBe(true);
});

test("show or do is decided without asking", () => {
  expect(prefersShowing("what does padding mean", "Figma")).toBe(true);
  expect(prefersShowing("export this as png", "Figma")).toBe(false);
  expect(prefersShowing("padding", "Figma")).toBe(true);
  expect(prefersShowing("padding", "Finder")).toBe(false);
  const shown = localRouter({ text: "what does padding mean", appName: "Figma" });
  expect(shown.kind).toBe("teach");
  expect(shown.clarification).toBeUndefined();
  const done = localRouter({ text: "export this as png", appName: "Figma" });
  expect(done.kind).toBe("computer_use");
  expect(done.actions ?? []).not.toEqual(["show me", "do it"]);
});

test("jobs get a native password dialog for sudo and never prompt on stdin", () => {
  const previous = process.env.OKIDOKI_ASKPASS;
  process.env.OKIDOKI_ASKPASS = "/tmp/askpass.sh";
  try {
    const env = jobEnvironment();
    expect(env.SUDO_ASKPASS).toBe("/tmp/askpass.sh");
    expect(env.DISPLAY).toBeString();
    expect(env.NONINTERACTIVE).toBe("1");
    expect(env.PATH?.startsWith("/opt/homebrew/bin:")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OKIDOKI_ASKPASS; else process.env.OKIDOKI_ASKPASS = previous;
  }
  delete process.env.OKIDOKI_ASKPASS;
  expect(jobEnvironment().SUDO_ASKPASS).toBeUndefined();
  if (previous !== undefined) process.env.OKIDOKI_ASKPASS = previous;
});

test("invalid and incomplete plans never execute", async () => {
  for (const request of [null, {}, { runId: "job", kind: "terminal", commands: [] }, { runId: "job", kind: "terminal", commands: ["cat {{file}}"] }, { runId: "job", kind: "terminal", commands: ["rm -rf /"] }, { runId: "job", kind: "coding", prompt: "hello", commands: "oops" }]) {
    expect(validateExecution(request)).toBeString();
  }
});

test("one approved plan preserves cd, exports, Unicode, and streamed steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okidoki-e2e-"));
  try {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await execute({ runId: crypto.randomUUID(), kind: "terminal", workingDirectory: dir,
      commands: ["mkdir 'a folder'", "cd 'a folder'", "export OKIDOKI_TEST_VALUE='héllo 世界'", 'printf "%s" "$OKIDOKI_TEST_VALUE" > result.txt', "cat result.txt"] },
      (event, data) => events.push({ event, data }));
    expect(await readFile(join(dir, "a folder/result.txt"), "utf8")).toBe("héllo 世界");
    expect(events.filter(e => e.event === "step" && e.data.status === "done")).toHaveLength(5);
    expect(events.at(-1)?.event).toBe("done");
    expect(events.filter(e => e.event === "output").map(e => e.data.text).join("")).toContain("héllo 世界");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pipeline failure stops later commands", async () => {
  const events: string[] = [];
  await execute({ runId: crypto.randomUUID(), kind: "terminal", commands: ["false | cat", "printf SHOULD_NOT_RUN"] },
    (event, data) => events.push(event + JSON.stringify(data)));
  expect(events.join("\n")).not.toContain("SHOULD_NOT_RUN");
  expect(events.at(-1)).toStartWith("error");
});

test("stop cancels children, resumes paused jobs to terminate, and skips later steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "okidoki-stop-"));
  const runId = crypto.randomUUID();
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const events: string[] = [];
  const running = execute({ runId, kind: "terminal", workingDirectory: dir, commands: ["sleep 2; touch should-not-exist", "touch later"] },
    (event) => { events.push(event); if (event === "started") started(); });
  try {
    await ready;
    expect(pause(runId)).toBe(true);
    expect(resume(runId)).toBe(true);
    expect(pause(runId)).toBe(true);
    expect(stop(runId)).toBe(true);
    await running;
    expect(events).toContain("cancelled");
    expect(events).not.toContain("done");
    await Bun.sleep(2100);
    expect(await Bun.file(join(dir, "should-not-exist")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "later")).exists()).toBe(false);
  } finally { stop(runId); await rm(dir, { recursive: true, force: true }); }
});

test("simultaneous duplicate run IDs cannot execute twice", async () => {
  const runId = crypto.randomUUID();
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const first = execute({ runId, kind: "terminal", commands: ["sleep 1"] }, e => { if (e === "started") started(); });
  await ready;
  const events: string[] = [];
  await execute({ runId, kind: "terminal", commands: ["echo duplicate"] }, (e) => events.push(e));
  expect(events).toEqual(["error"]);
  stop(runId); await first;
});

test("coding agent options and literal prompts survive the sidecar argument boundary", async () => {
  const { agentCommand } = await import("../src/executor");
  const prompt = "fix a file; $(touch SHOULD_NOT_RUN) 'quoted'";
  const request = { runId: "options", kind: "coding" as const, prompt, agent: "claude" as const, extraArgs: '--model "test model" --directory=some\\ folder' };
  expect(validateExecution(request)).toBeUndefined();
  const args = agentCommand(request);
  expect(args[2]).toBe(prompt);
  expect(args.slice(-3)).toEqual(["--model", "test model", "--directory=some folder"]);
  expect(validateExecution({ ...request, extraArgs: '--model "unfinished' })).toBeString();
});
