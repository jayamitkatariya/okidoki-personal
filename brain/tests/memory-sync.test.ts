import { afterEach, expect, test } from "bun:test";
import { closeMemory, memoryStatus, recall, setEngineFactory, syncMemory, warmMemory } from "../src/memory";
import type { MemorySyncRequest } from "../src/types";
import { fakeEngine, type FakeEngine } from "./fixtures/memory-engine";

// The index's bookkeeping against an in-memory engine: what is embedded, re-embedded, removed and
// saved as the Mac's data changes, and what happens when the engine is swapped or fails.

const now = new Date().toISOString();

function request(overrides: Partial<MemorySyncRequest> = {}): MemorySyncRequest {
  return {
    projectId: "p",
    projectKey: "k",
    cacheDir: "/tmp/okidoki-test-moss",
    memories: [{ id: "n1", accountID: "acct", text: "shipping the notch this week", section: "rightNow", updatedAt: now }],
    threads: [
      {
        id: "t1",
        accountID: "acct",
        title: "video",
        messages: [
          { id: "m1", role: "user", text: "compress the launch video for discord", createdAt: now },
          { id: "m2", role: "assistant", text: "done, it's 24 MB now", createdAt: now },
        ],
      },
    ],
    ...overrides,
  };
}

function useEngines(...engines: FakeEngine[]) {
  const made: { projectId: string; cacheDir: string }[] = [];
  setEngineFactory(async (projectId, _key, cacheDir) => {
    made.push({ projectId, cacheDir });
    const next = engines.shift();
    if (!next) throw new Error("no engine left");
    return next;
  });
  return made;
}

afterEach(async () => {
  await closeMemory();
  setEngineFactory();
});

test("the first sync embeds notes and turns; the same data again embeds and saves nothing", async () => {
  const engine = fakeEngine();
  useEngines(engine);
  const first = await syncMemory(request());
  expect(first.ok).toBe(true);
  expect(first.added).toBe(3);
  expect(engine.saves).toBe(1);
  expect([...engine.docs.keys()].sort()).toEqual(["memory:n1", "message:m1", "message:m2"]);

  const again = await syncMemory(request());
  expect(again).toMatchObject({ ok: true, added: 0, removed: 0 });
  expect(engine.saves).toBe(1);
});

test("a changed item is embedded again and a removed one leaves the index", async () => {
  const engine = fakeEngine();
  useEngines(engine);
  await syncMemory(request());
  engine.added.length = 0;

  const changed = request({
    memories: [{ id: "n1", accountID: "acct", text: "shipping the notch on friday", section: "rightNow", updatedAt: now }],
    threads: [{ id: "t1", accountID: "acct", title: "video", messages: [{ id: "m1", role: "user", text: "compress the launch video for discord", createdAt: now }] }],
  });
  const result = await syncMemory(changed);
  expect(result).toMatchObject({ ok: true, added: 1, removed: 1 });
  expect(engine.added).toEqual(["memory:n1"]);
  expect(engine.removed).toEqual(["message:m2"]);
  expect(engine.docs.get("memory:n1")?.text).toBe("shipping the notch on friday");
  expect(engine.saves).toBe(2);
});

test("status counts what the index holds by kind and when it last synced", async () => {
  useEngines(fakeEngine());
  expect(memoryStatus()).toMatchObject({ ready: false, documents: 0 });
  await syncMemory(request());
  const status = memoryStatus();
  expect(status).toMatchObject({ ready: true, notes: 1, messages: 2, documents: 3 });
  expect(Date.parse(status.lastSyncAt ?? "")).toBeGreaterThan(0);
  expect(status.error).toBeUndefined();
});

test("new credentials close the old engine and pick up what the new one already holds", async () => {
  const first = fakeEngine();
  const second = fakeEngine([{ id: "message:old", text: "from the other project", metadata: { type: "message", account: "acct" } }]);
  const made = useEngines(first, second);
  await syncMemory(request());
  const result = await syncMemory(request({ projectId: "p2" }));
  expect(first.closed).toBe(true);
  expect(made.map((entry) => entry.projectId)).toEqual(["p", "p2"]);
  // Everything the Mac has is embedded into the new engine; what it no longer has is dropped from it.
  expect(result.ok).toBe(true);
  expect(second.removed).toEqual(["message:old"]);
  expect(second.docs.has("memory:n1")).toBe(true);
});

test("syncs run one at a time, so the index ends up matching the last one sent", async () => {
  const engine = fakeEngine();
  useEngines(engine);
  const a = syncMemory(request());
  const b = syncMemory(request({ memories: [] }));
  await Promise.all([a, b]);
  expect(engine.docs.has("memory:n1")).toBe(false);
  expect(engine.docs.has("message:m1")).toBe(true);
});

test("a failed start reports the error, and the next sync recovers", async () => {
  setEngineFactory(async () => {
    throw new Error("moss auth failed (HTTP 401)");
  });
  const failed = await syncMemory(request());
  expect(failed.ok).toBe(false);
  expect(failed.error).toContain("401");
  expect(memoryStatus()).toMatchObject({ ready: false, error: "moss auth failed (HTTP 401)" });

  const engine = fakeEngine();
  useEngines(engine);
  const recovered = await syncMemory(request());
  expect(recovered.ok).toBe(true);
  expect(memoryStatus().error).toBeUndefined();
});

test("warming loads the saved index and drops only the tool entries older builds left in it", async () => {
  const engine = fakeEngine([
    { id: "message:saved", text: "from yesterday", metadata: { type: "message", account: "acct" } },
    { id: "tool:sevenzip", text: "7-Zip", metadata: { type: "tool", account: "" } },
  ]);
  useEngines(engine);
  await warmMemory("p", "k");
  expect(engine.docs.has("message:saved")).toBe(true);
  expect(engine.removed).toEqual(["tool:sevenzip"]);
  expect(engine.saves).toBe(1);

  const clean = fakeEngine([{ id: "message:saved", text: "from yesterday", metadata: { type: "message", account: "acct" } }]);
  await closeMemory();
  useEngines(clean);
  await warmMemory("p", "k");
  expect(clean.removed).toEqual([]);
  expect(clean.saves).toBe(0);
});

test("recall stays inside the account", async () => {
  const engine = fakeEngine();
  useEngines(engine);
  await syncMemory(
    request({
      memories: [
        { id: "mine", accountID: "acct", text: "my launch video goes to the discord server", section: "aboutYou", updatedAt: now },
        { id: "theirs", accountID: "work", text: "the work launch video needs legal review", section: "aboutYou", updatedAt: now },
        { id: "shared", text: "launch video drafts live in Movies", section: "aboutYou", updatedAt: now },
      ],
      threads: [],
    }),
  );
  const recalled = await recall("where does the launch video go", "acct");
  expect(recalled.map((item) => item.text).sort()).toEqual(["launch video drafts live in Movies", "my launch video goes to the discord server"]);
  expect(engine.queries.at(-1)?.filter).toEqual({ field: "account", condition: { $in: ["acct", ""] } });
});

test("recall is empty while the index is off, and works once it is on", async () => {
  expect(await recall("launch video", "acct")).toEqual([]);
  useEngines(fakeEngine());
  await syncMemory(request());
  const recalled = await recall("how big was the launch video", "acct");
  expect(recalled.map((item) => item.text)).toContain("compress the launch video for discord");
});
