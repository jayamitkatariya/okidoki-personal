import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeMemory, recall, recallNotesFor, searchNotes, setEngineFactory, syncMemory } from "../src/memory";
import { browserStep, resetBrowserSessions } from "../src/browser";
import { driveStep, resetSessions, sessionFor, systemPromptV2 } from "../src/computer2";
import type { MemorySyncRequest } from "../src/types";
import { fakeEngine } from "./fixtures/memory-engine";

// Recall end to end against an in-memory engine: what the Mac syncs is what comes back, edits and
// deletions show at once, and agent runs (browser, computer use) get the notes they need.

const now = new Date().toISOString();
type Note = NonNullable<MemorySyncRequest["memories"]>[number];
const note = (id: string, text: string, accountID = "acct"): Note => ({ id, accountID, text, section: "aboutYou", updatedAt: now });

function sync(memories: Note[]) {
  return syncMemory({ projectId: "p", projectKey: "k", cacheDir: "/tmp/okidoki-test-moss", memories, threads: [] });
}

beforeEach(() => {
  const engine = fakeEngine();
  setEngineFactory(async () => engine);
  resetBrowserSessions();
  resetSessions();
});

afterEach(async () => {
  await closeMemory();
  setEngineFactory();
});

const facts = [
  note("passport", "my passport number is in the vault file passport.pdf"),
  note("seat", "i prefer aisle seats on flights"),
  note("manager", "my manager is priya"),
];

test("an edit is what recall finds next, and the old wording is gone", async () => {
  await sync(facts);
  expect((await recall("which seats do i prefer on flights", "acct")).map((item) => item.text)).toEqual(["i prefer aisle seats on flights"]);
  await sync([facts[0], note("seat", "i prefer window seats on flights"), facts[2]]);
  const hits = await recall("which seats do i prefer on flights", "acct");
  expect(hits.map((item) => item.text)).toEqual(["i prefer window seats on flights"]);
  expect(hits[0].id).toBe("seat");
});

test("a deleted memory never comes back from recall or search", async () => {
  await sync(facts);
  expect((await searchNotes("passport vault file", "acct"))?.map((hit) => hit.id)).toEqual(["passport"]);
  await sync([facts[1], facts[2]]);
  expect(await recall("passport vault file", "acct")).toEqual([]);
  expect(await searchNotes("passport vault file", "acct")).toEqual([]);
});

test("search returns only this account's notes, by id", async () => {
  await sync([...facts, note("other", "my manager at the other job is sam", "acct2")]);
  const hits = await searchNotes("manager", "acct");
  expect(hits?.map((hit) => hit.id)).toEqual(["manager"]);
  expect(await searchNotes("", "acct")).toEqual([]);
});

test("with the index closed (key removed), recall is empty and search says there's no index", async () => {
  await sync(facts);
  await closeMemory();
  expect(await recall("passport vault file", "acct")).toEqual([]);
  expect(await searchNotes("passport", "acct")).toBeNull();
  expect(await recallNotesFor("passport vault file", "acct")).toEqual([]);
});

test("agent runs get notes the Mac didn't already send, labelled like the Mac's own", async () => {
  await sync(facts);
  expect(await recallNotesFor("choose seats on flights", "acct")).toEqual(["about you: i prefer aisle seats on flights"]);
  expect(await recallNotesFor("choose seats on flights", "acct", ["about you: i prefer aisle seats on flights"])).toEqual([]);
});

function apiOnce(content: unknown[]) {
  const sent: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ content, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

test("a browser run's first turn carries the Mac's notes and the recalled ones", async () => {
  await sync(facts);
  const api = apiOnce([{ type: "tool_use", id: "t1", name: "back", input: {} }]);
  await browserStep({
    runID: "b1", goal: "choose seats on flights", step: 0, accountId: "acct",
    observation: { url: "https://example.com", title: "Example", elements: "", text: "" },
    memory: ["about you: my manager is priya"],
  }, "key", api.impl);
  const text = JSON.stringify(api.sent[0].messages);
  expect(text).toContain("About the user:");
  expect(text).toContain("- about you: my manager is priya");
  expect(text).toContain("- about you: i prefer aisle seats on flights");
});

test("computer use is told what okidoki knows, once per run so the instructions stay cached", async () => {
  await sync(facts);
  const prompt = systemPromptV2({ runID: "x", goal: "write an email", step: 0, observation: {} as any, memory: ["about you: my manager is priya"] });
  expect(prompt).toContain("What you know about the user");
  expect(prompt).toContain("- about you: my manager is priya");
  expect(systemPromptV2({ runID: "x", goal: "write an email", step: 0, observation: {} as any })).not.toContain("What you know about the user");

  const api = apiOnce([{ type: "tool_use", id: "t1", name: "computer", input: { action: "screenshot" } }]);
  await driveStep({
    runID: "c1", goal: "email my manager priya the notes", step: 0, accountId: "acct",
    observation: { app: "Mail", windowTitle: "", imageWidth: 100, imageHeight: 100, screenshotBase64: "c2hvdA==", mediaType: "image/png" } as any,
    settings: { claudeModel: "claude-haiku-5-5" },
  }, "sk", api.impl);
  expect(sessionFor("c1")?.system).toContain("- about you: my manager is priya");
});
