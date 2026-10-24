import { expect, test } from "bun:test";
import { anthropicKey, mossCredentials } from "../src/keys";
import { RECALL_MIN_SCORE, recallPrompt, selectRecalled, toDocs } from "../src/memory";
import { clipboardFor, historyMessages, isDurableFact, normalize, stripMacSuffix } from "../src/llm";

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

test("moss short-term memory keeps right-now notes and the newest turns", () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: `turn ${index} is long enough`,
    createdAt: `2026-10-24T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const docs = toDocs({
    projectId: "p",
    projectKey: "k",
    memories: [
      { id: "about", text: "I study at Purdue", section: "aboutYou", updatedAt: "2026-10-01" },
      { id: "now", text: "shipping the notch this week", section: "rightNow", updatedAt: "2026-10-24" },
    ],
    threads: [{ id: "t1", accountID: "acct", title: "today", messages }],
    runs: [{ id: "r1", accountID: "acct", title: "old run", prompt: "do the thing", summary: "done" }],
    skills: [{ id: "s1", accountID: "acct", name: "export", summary: "exports a file" }],
  });
  const ids = docs.map((doc) => doc.id);
  expect(ids).toContain("memory:now");
  expect(ids).not.toContain("memory:about");
  expect(ids).not.toContain("run:r1");
  expect(ids).not.toContain("skill:s1");
  expect(ids.filter((id) => id.startsWith("message:")).length).toBe(48);
  expect(ids).toContain("message:m59");
  expect(ids).not.toContain("message:m0");
  expect(docs.find((doc) => doc.id === "message:m59")?.metadata.account).toBe("acct");
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
  expect(prompt).toContain("not this one");
  expect(prompt).toContain("[earlier · dia · 2026-10-21] blue puma shoes");
  expect(prompt).toContain("[note · 2026-10-24] shipping the notch this week");
  expect(recallPrompt([])).toBe("");
});

test("the clipboard reaches the model only when the request is about it, never as an echo of the chat", () => {
  const answer = "**Make the repo closed** means change a repository from public to private.";
  const history = [
    { role: "user" as const, text: "explain this to me" },
    { role: "assistant" as const, text: answer },
  ];
  // They pressed copy on the card, then asked a follow-up: the clipboard is the previous answer.
  expect(clipboardFor({ text: "and how do i do that on github?", history, clipboardText: answer })).toBe("");
  expect(clipboardFor({ text: "explain this to me", history: [], clipboardText: "git fetch origin main" })).toBe("git fetch origin main");
  expect(clipboardFor({ text: "summarize what i copied", history: [], clipboardText: "a long article" })).toBe("a long article");
  // An unrelated command on the clipboard is not sent along with an unrelated request.
  expect(clipboardFor({ text: "open safari private browsing", history: [], clipboardText: "git fetch origin main" })).toBe("");
  expect(clipboardFor({ text: "teach me how to use notes", history: [], clipboardText: "git fetch origin main" })).toBe("");
  // "this" with a screenshot means the screen, not the clipboard.
  expect(clipboardFor({ text: "what's this", history: [], clipboardText: "git fetch", screenshotBase64: "img" })).toBe("git fetch");
  expect(clipboardFor({ text: "explain this", history: [], clipboardText: "git fetch", screenshotBase64: "img" })).toBe("git fetch");
  expect(clipboardFor({ text: "fix this", history: [], clipboardText: "", screenshotBase64: "img" })).toBe("");
  expect(clipboardFor({ text: "do this", history: [], clipboardText: "git fetch", screenshotBase64: "img" })).toBe("");
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
