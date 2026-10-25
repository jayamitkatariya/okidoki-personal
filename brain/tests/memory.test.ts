import { expect, test } from "bun:test";
import { anthropicKey, mossCredentials } from "../src/keys";
import { RECALL_MIN_SCORE, RIGHT_NOW_DAYS, recallFilter, recallPrompt, selectRecalled, toDocs, toolIndexDocs } from "../src/memory";
import { tools } from "../src/catalog";
import { clipboardFor, historyMessages, isDurableFact, normalize, stripMacSuffix, toolSuggestions } from "../src/llm";

test("anthropic and moss credentials prefer the request, then the environment", () => {
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedId = process.env.MOSS_PROJECT_ID;
  const savedKey = process.env.MOSS_PROJECT_KEY;
  process.env.ANTHROPIC_API_KEY = "env-anthropic";
  process.env.MOSS_PROJECT_ID = "env-id";
  process.env.MOSS_PROJECT_KEY = "env-key";
  try {
    expect(anthropicKey("  from-header  ")).toBe("from-header");
    expect(anthropicKey("")).toBe("env-anthropic");
    expect(mossCredentials(" id ", " key ")).toEqual({ projectId: "id", projectKey: "key" });
    expect(mossCredentials("", "")).toEqual({ projectId: "env-id", projectKey: "env-key" });
    expect(mossCredentials()).toEqual({ projectId: "env-id", projectKey: "env-key" });
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedId === undefined) delete process.env.MOSS_PROJECT_ID;
    else process.env.MOSS_PROJECT_ID = savedId;
    if (savedKey === undefined) delete process.env.MOSS_PROJECT_KEY;
    else process.env.MOSS_PROJECT_KEY = savedKey;
  }
});

test("the index holds every note, the newest turns, recent tasks and skills, each with its account", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: `turn ${index} is long enough`,
    createdAt: `2026-10-24T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const docs = toDocs(
    {
      projectId: "p",
      projectKey: "k",
      memories: [
        { id: "about", accountID: "acct", text: "I study at Purdue", section: "aboutYou", updatedAt: "2026-01-01" },
        { id: "now", accountID: "acct", text: "shipping the notch this week", section: "rightNow", updatedAt: "2026-10-24" },
        { id: "legacy", text: "an older Mac's note", section: "aboutYou", updatedAt: "2026-10-01" },
      ],
      threads: [{ id: "t1", accountID: "acct", title: "today", messages }],
      runs: [{ id: "r1", accountID: "acct", kind: "terminal", status: "done", title: "compress video", prompt: "compress the launch video for discord", summary: "24 MB", createdAt: "2026-10-23T10:00:00Z" }],
      skills: [{ id: "s1", accountID: "work", name: "expense report", summary: "files receipts in Concur", steps: [{ text: "open Concur" }, { text: "attach receipts" }], createdAt: "2026-09-01" }],
    },
    now,
  );
  const ids = docs.map((doc) => doc.id);
  expect(ids).toEqual(expect.arrayContaining(["memory:about", "memory:now", "memory:legacy", "run:r1", "skill:s1"]));
  expect(ids.filter((id) => id.startsWith("message:")).length).toBe(48);
  expect(ids).toContain("message:m59");
  expect(ids).not.toContain("message:m0");
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  expect(byId.get("message:m59")?.metadata.account).toBe("acct");
  expect(byId.get("memory:about")?.metadata).toMatchObject({ type: "memory", account: "acct", section: "aboutYou" });
  expect(byId.get("memory:legacy")?.metadata.account).toBe("");
  expect(byId.get("run:r1")?.text).toBe("compress video: compress the launch video for discord → 24 MB");
  expect(byId.get("run:r1")?.metadata).toMatchObject({ type: "run", account: "acct", status: "done", date: "2026-10-23" });
  expect(byId.get("skill:s1")?.text).toBe("expense report: files receipts in Concur. Steps: open Concur; attach receipts");
  expect(byId.get("skill:s1")?.metadata).toMatchObject({ type: "skill", account: "work", title: "expense report" });
});

test("stale right-now notes, plain answers, unapproved plans and old tasks stay out of the index", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const docs = toDocs(
    {
      projectId: "p",
      projectKey: "k",
      memories: [
        { id: "stale", accountID: "acct", text: "packing for the Chicago trip", section: "rightNow", updatedAt: "2026-09-01T00:00:00Z" },
        { id: "fresh", accountID: "acct", text: "studying for the econ midterm", section: "rightNow", updatedAt: "2026-10-20T00:00:00Z" },
        { id: "blank", accountID: "acct", text: "   ", section: "aboutYou" },
      ],
      runs: [
        { id: "answer", accountID: "acct", kind: "answer", status: "done", title: "what's the capital of peru", createdAt: "2026-10-24T00:00:00Z" },
        { id: "preview", accountID: "acct", kind: "terminal", status: "previewing", title: "install node", createdAt: "2026-10-24T00:00:00Z" },
        { id: "old", accountID: "acct", kind: "terminal", status: "done", title: "clean up my mac", createdAt: "2026-06-01T00:00:00Z" },
        { id: "kept", accountID: "acct", kind: "computer_use", status: "failed", title: "send mom a message", prompt: "send mom a message on whatsapp", createdAt: "2026-10-22T00:00:00Z" },
      ],
    },
    now,
  );
  expect(docs.map((doc) => doc.id).sort()).toEqual(["memory:fresh", "run:kept"]);
  expect(RIGHT_NOW_DAYS).toBe(14);
});

test("short-term memory skips the Mac's own status lines and turns older than two weeks", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const docs = toDocs(
    {
      projectId: "p",
      projectKey: "k",
      threads: [
        {
          id: "t1",
          accountID: "acct",
          title: "safari",
          messages: [
            { id: "old", role: "user", text: "something from last month", createdAt: "2026-09-20T12:00:00.000Z" },
            { id: "fresh", role: "user", text: "open safari private browsing", createdAt: "2026-10-24T11:00:00.000Z" },
            { id: "status1", role: "assistant", text: "on it. i'll open a private window. esc stops me.", createdAt: "2026-10-24T11:00:01.000Z" },
            { id: "status2", role: "assistant", text: "i did it — Safari is open", createdAt: "2026-10-24T11:00:05.000Z" },
            { id: "status3", role: "assistant", text: "i couldn't finish — okidoki needs accessibility", createdAt: "2026-10-24T11:00:06.000Z" },
            { id: "real", role: "assistant", text: "private browsing keeps history out of safari's sidebar.", createdAt: "2026-10-24T11:01:00.000Z" },
          ],
        },
      ],
    },
    now,
  );
  const ids = docs.map((doc) => doc.id);
  expect(ids).toEqual(["message:real", "message:fresh"]);
});

test("recall keeps only relevant hits from this account, never the current thread or the request itself", () => {
  const hits = [
    { id: "message:a", text: "find me nike boots size 9", metadata: { type: "message", account: "acct", threadId: "t1", thread: "dia", date: "2026-10-24" }, score: 0.9 },
    { id: "message:b", text: "find me nike boots size 9", metadata: { type: "message", account: "acct", threadId: "t2", thread: "dia", date: "2026-10-23" }, score: 0.88 },
    { id: "message:c", text: "Find me Nike boots size 9", metadata: { type: "message", account: "acct", threadId: "t3", thread: "safari", date: "2026-10-22" }, score: 0.87 },
    { id: "message:d", text: "blue puma shoes", metadata: { type: "message", account: "acct", threadId: "t4", thread: "dia", date: "2026-10-21" }, score: 0.6 },
    { id: "message:e", text: "teach me ghostty tabs", metadata: { type: "message", account: "acct", threadId: "t5", thread: "ghostty", date: "2026-10-20" }, score: 0.2 },
    { id: "message:f", text: "work account thing", metadata: { type: "message", account: "work", threadId: "t6", thread: "slack", date: "2026-10-20" }, score: 0.8 },
    { id: "memory:now", text: "shipping the notch this week", metadata: { type: "memory", account: "", section: "rightNow", date: "2026-10-24" }, score: 0.5 },
  ];
  const picked = selectRecalled(hits, "find me nike boots size 9", "acct", { threadId: "t1" });
  expect(picked.map((item) => item.text)).toEqual(["blue puma shoes", "shipping the notch this week"]);
  expect(RECALL_MIN_SCORE).toBeGreaterThan(0.2);
  const prompt = recallPrompt(picked);
  expect(prompt).toContain("not this conversation");
  expect(prompt).toContain("[earlier · dia · 2026-10-21] blue puma shoes");
  expect(prompt).toContain("[note · right now · 2026-10-24] shipping the notch this week");
  expect(recallPrompt([])).toBe("");
});

test("recall leaves out notes the prompt already lists, and labels tasks and skills", () => {
  const hits = [
    { id: "memory:a", text: "I study at Purdue", metadata: { type: "memory", account: "acct", section: "aboutYou", date: "2026-10-01" }, score: 0.9 },
    { id: "run:r1", text: "compress video: compress the launch video → 24 MB", metadata: { type: "run", account: "acct", title: "compress video", status: "done", date: "2026-10-23" }, score: 0.7 },
    { id: "skill:s1", text: "expense report: files receipts in Concur", metadata: { type: "skill", account: "acct", title: "expense report", date: "2026-09-01" }, score: 0.6 },
    { id: "skill:s2", text: "someone else's skill", metadata: { type: "skill", account: "work", title: "other", date: "2026-09-01" }, score: 0.95 },
  ];
  const picked = selectRecalled(hits, "do that thing again", "acct", { exclude: ["about you: I study at Purdue"] });
  expect(picked.map((item) => item.type)).toEqual(["run", "skill"]);
  const prompt = recallPrompt(picked);
  expect(prompt).toContain("[task you asked for · done · 2026-10-23] compress video");
  expect(prompt).toContain("[saved skill · expense report · 2026-09-01] expense report");
  expect(prompt).toContain("replayed by its name");
});

test("recall asks the index for this account's items and shared notes, never tools", () => {
  expect(recallFilter("acct")).toEqual({
    $and: [
      { field: "type", condition: { $ne: "tool" } },
      { field: "account", condition: { $in: ["acct", ""] } },
    ],
  });
  expect(recallFilter(undefined)).toEqual({ field: "type", condition: { $ne: "tool" } });
});

test("the clipboard reaches the model only when the request names it, never as an echo of the chat", () => {
  const answer = "**Make the repo closed** means change a repository from public to private.";
  const history = [
    { role: "user" as const, text: "explain this to me" },
    { role: "assistant" as const, text: answer },
  ];
  // They pressed copy on the card, then asked a follow-up: the clipboard is the previous answer.
  expect(clipboardFor({ text: "and how do i do that on github?", history, clipboardText: answer })).toBe("");
  expect(clipboardFor({ text: "what did i copy? it's on my clipboard", history, clipboardText: answer })).toBe("");
  // Named outright: it goes along.
  expect(clipboardFor({ text: "summarize what i copied", history: [], clipboardText: "a long article" })).toBe("a long article");
  expect(clipboardFor({ text: "explain my clipboard", history: [], clipboardText: "git fetch origin main" })).toBe("git fetch origin main");
  expect(clipboardFor({ text: "paste this into notes", history: [], clipboardText: "git fetch origin main" })).toBe("git fetch origin main");
  expect(clipboardFor({ text: "note this", history: [], clipboardText: "call mom at 5" })).toBe("call mom at 5");
  // Typed questions stand on their own; whatever is on the clipboard stays out of them.
  expect(clipboardFor({ text: "open safari private browsing", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "teach me how to use notes", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "explain this to me", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "fix this error", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "summarize this page", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "copy that file to the desktop", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "what's this", history: [], clipboardText: "git fetch", screenshotBase64: "img" })).toBe("");
  expect(clipboardFor({ text: "do this", history: [], clipboardText: "git fetch", screenshotBase64: "img" })).toBe("");
  // The same stale clipboard doesn't come back on the next question either.
  expect(clipboardFor({ text: "and how do i undo that?", history, clipboardText: "git fetch origin main" })).toBe("");
});

test("history drops the Mac's esc suffix, merges same-role runs and never ends with the live request", () => {
  const messages = historyMessages({
    text: "open safari private browsing",
    history: [
      { role: "user", text: "open a safari private tab" },
      { role: "assistant", text: "On it. I'm opening a private window. esc stops me. esc stops me." },
      { role: "assistant", text: "i did it — Safari is open." },
      { role: "user", text: "open safari private browsing" },
    ],
  });
  expect(messages).toEqual([
    { role: "user", content: "open a safari private tab" },
    { role: "assistant", content: "On it. I'm opening a private window.\n\ni did it — Safari is open." },
  ]);
  expect(stripMacSuffix("opening notes. esc stops me.")).toBe("opening notes.");
  expect(stripMacSuffix("opening notes esc stops me")).toBe("opening notes");
  expect(stripMacSuffix("esc stops me.")).toBe("");
  expect(stripMacSuffix("press esc to stop me later")).toBe("press esc to stop me later");
  expect(historyMessages({ text: "hi", history: [{ role: "assistant", text: "hello" }] })).toEqual([]);
});

test("a decision never carries the esc suffix or junk memories", () => {
  const decision = normalize({
    kind: "computer_use",
    title: "open safari",
    answer: "on it. opening a private window. esc stops me.",
    speak: "Opening Safari. esc stops me.",
    memory: [
      "Jay studies at Purdue",
      "Do not run the git fetch on the clipboard unless Jay explicitly asks",
      "Okidoki cannot open its own windows",
      "I couldn't finish because accessibility is off",
      "",
    ],
  });
  expect(decision.answer).toBe("on it. opening a private window.");
  expect(decision.speak).toBe("Opening Safari.");
  expect(decision.memory).toEqual(["Jay studies at Purdue"]);
  expect(isDurableFact("Jay prefers Dia over Safari")).toBe(true);
  expect(isDurableFact("the screenshot showed a terminal")).toBe(false);
});

test("every toolbox tool is indexed by what it's for, apart from memories", () => {
  const docs = toolIndexDocs();
  expect(docs.length).toBe(tools.length);
  expect(new Set(docs.map((doc) => doc.id)).size).toBe(docs.length);
  const zip = docs.find((doc) => doc.id === "tool:sevenzip");
  expect(zip?.metadata).toMatchObject({ type: "tool", account: "", toolId: "sevenzip", title: "7-Zip" });
  expect(zip?.text).toContain("paid archive apps");
  expect(zip?.text).toContain("make a 7z of this folder");
  // How to run a tool stays out of the index; that's for the prompt once it's picked.
  expect(docs.every((doc) => !doc.text.includes("brew install"))).toBe(true);
});

test("tool suggestions only describe tools that aren't installed", () => {
  const pick = tools.filter((tool) => ["ghostscript", "qpdf"].includes(tool.id));
  const text = toolSuggestions(pick, ["qpdf"]);
  expect(text).toContain("Ghostscript (not installed; install with: brew install ghostscript)");
  expect(text).not.toContain("qpdf (not installed");
  expect(toolSuggestions(pick, ["qpdf", "ghostscript"])).toBe("");
  expect(toolSuggestions([], [])).toBe("");
});
