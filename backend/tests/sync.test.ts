import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { trimSnapshot } from "../convex/sync";

// The Mac's sync routes, end to end against an in-memory Convex: what lands in which table, what is
// removed, what is refused, and who can read it afterwards.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12, minute)).toISOString().replace(".000", "");

/** A Mac's state for one account, in the shape `JSONEncoder` writes it. */
function macState(accountId = "acct-1") {
  return {
    accounts: [{ id: accountId, name: "Jay", email: "jay@example.com", kind: "personal", colorHex: "1FB57A", createdAt: at(0) }],
    currentAccountID: accountId,
    settings: { syncEnabled: true, voiceID: "sarah" },
    connectors: [{ id: "calendar", name: "Apple Calendar", kind: "apple", blurb: "", enabled: true, installed: true }],
    threads: [
      {
        id: `${accountId}-t1`,
        accountID: accountId,
        title: "learning figma",
        app: "Figma",
        topic: "figma",
        messages: [{ id: "m1", role: "user", text: "teach me auto layout", createdAt: at(1) }],
        createdAt: at(1),
        updatedAt: at(2),
        archived: false,
      },
    ],
    memories: [
      { id: `${accountId}-mem1`, accountID: accountId, section: "aboutYou", text: "studies at Purdue", source: "you", createdAt: at(0), updatedAt: at(0) },
    ],
    runs: [
      {
        id: `${accountId}-r1`,
        accountID: accountId,
        kind: "terminal",
        title: "free up space",
        prompt: "my mac is full",
        threadID: `${accountId}-t1`,
        status: "done",
        preview: { summary: "clean caches", risk: "medium", steps: [], commands: ["mo clean"], apps: [], files: [], createdAt: at(3) },
        steps: [],
        output: "freed 23 GB",
        summary: "freed 23 GB",
        createdAt: at(3),
        startedAt: at(3),
        endedAt: at(4),
        workingDirectory: "/Users/jay/Desktop",
        pickedPath: "/Users/jay/Desktop/big.mov",
      },
    ],
    skills: [
      { id: `${accountId}-s1`, accountID: accountId, name: "friday cleanup", summary: "empty downloads", steps: [{ id: "st1", text: "open Downloads", app: "Finder" }], createdAt: at(5), source: "watch me", runCount: 2 },
    ],
    routines: [
      { id: `${accountId}-ro1`, accountID: accountId, name: "monday brief", prompt: "summarise my week", cadence: "weekly", weekday: 2, hour: 9, minute: 0, enabled: true, createdAt: at(6), lastRunAt: null, nextRunAt: at(60) },
    ],
  };
}

type MacState = ReturnType<typeof macState>;

async function setup() {
  const t = convexTest(schema, modules);
  // The Mac belongs to jay's login and is paired: its token is what every route sees.
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "jay", email: "jay@example.com" }));
  const jay = t.withIdentity({ subject: `${userId}|s1` });
  const { token } = await jay.action(api.devices.pair, { device: "test mac" });
  const pairAnother = async (name: string) => {
    const other = await t.run((ctx) => ctx.db.insert("users", { name, email: `${name}@example.com` }));
    const as = t.withIdentity({ subject: `${other}|s-${name}` });
    return { as, token: (await as.action(api.devices.pair, { device: `${name}'s mac` })).token };
  };
  const request = async (path: string, init: { method?: string; body?: unknown; auth?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const auth = init.auth === undefined ? token : init.auth;
    if (auth !== null) headers.authorization = `Bearer ${auth}`;
    const response = await t.fetch(path, {
      method: init.method ?? "POST",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  let clock = 1_000;
  const push = (state: MacState, extra: Record<string, unknown> = {}) =>
    request("/api/sync", { body: { accountId: state.currentAccountID, device: "test mac", sentAt: (clock += 1_000), state, ...extra } });
  const rows = (table: string) => t.run(async (ctx) => (await ctx.db.query(table as any).collect()) as any[]);
  return { t, request, push, rows, jay, token, pairAnother };
}

describe("pushing from the Mac", () => {
  test("a push lands every item in its table, and the same state again writes nothing", async () => {
    const { push, rows } = await setup();
    const state = macState();
    const first = await push(state);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.written).toBe(5);

    for (const table of ["threads", "memories", "runs", "skills", "routines"]) {
      const found = await rows(table);
      expect(found.map((row) => [row.clientId, row.accountId])).toEqual([[(state as any)[table][0].id, "acct-1"]]);
    }
    expect((await rows("accounts")).map((row) => row.clientId)).toEqual(["acct-1"]);
    expect((await rows("settings"))[0].data.voiceID).toBe("sarah");
    expect((await rows("connectors")).map((row) => row.clientId)).toEqual(["calendar"]);
    expect((await rows("actionPreviews")).map((row) => row.runId)).toEqual(["acct-1-r1"]);
    expect((await rows("snapshots"))[0].state.memories[0].text).toBe("studies at Purdue");

    const again = await push(state);
    expect(again.body).toMatchObject({ ok: true, written: 0, removed: 0 });
  });

  test("an item removed on the Mac is removed from Convex, with its run's preview and share link", async () => {
    const { push, request, rows } = await setup();
    const state = macState();
    await push(state);
    const shared = await request("/api/share", { body: { accountId: "acct-1", accountName: "Jay", runId: "acct-1-r1", run: state.runs[0] } });
    expect(shared.status).toBe(200);
    expect(await rows("shareLinks")).toHaveLength(1);

    const next = { ...state, runs: [], memories: [] };
    const result = await push(next);
    expect(result.body).toMatchObject({ ok: true, removed: 2 });
    expect(await rows("runs")).toEqual([]);
    expect(await rows("memories")).toEqual([]);
    expect(await rows("actionPreviews")).toEqual([]);
    expect(await rows("shareLinks")).toEqual([]);
    expect(await rows("threads")).toHaveLength(1);
  });

  test("a payload that leaves a table out never wipes it", async () => {
    const { push, rows } = await setup();
    const state = macState();
    await push(state);
    const { threads: _threads, memories: _memories, ...partial } = state;
    const result = await push(partial as MacState);
    expect(result.status).toBe(200);
    expect(await rows("threads")).toHaveLength(1);
    expect(await rows("memories")).toHaveLength(1);
  });

  test("one account's push never touches another account's rows", async () => {
    const { push, rows } = await setup();
    await push(macState("acct-1"));
    await push(macState("acct-2"));
    await push({ ...macState("acct-1"), threads: [], memories: [], runs: [], skills: [], routines: [] });
    for (const table of ["threads", "memories", "runs", "skills", "routines"]) {
      expect((await rows(table)).map((row) => row.accountId)).toEqual(["acct-2"]);
    }
  });

  test("a push stamped older than the last accepted one is refused before it writes", async () => {
    const { request, rows } = await setup();
    const state = macState();
    const newer = await request("/api/sync", { body: { accountId: "acct-1", device: "a", sentAt: 5_000, state } });
    expect(newer.status).toBe(200);
    const older = await request("/api/sync", { body: { accountId: "acct-1", device: "b", sentAt: 4_000, state: { ...state, memories: [] } } });
    expect(older.status).toBe(409);
    expect(older.body.latest).toBe(5_000);
    expect(await rows("memories")).toHaveLength(1);
  });

  test("a thread too big for one document keeps its newest messages", async () => {
    const { push, rows } = await setup();
    const state = macState();
    const filler = "x".repeat(9_000);
    state.threads[0].messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, role: "user", text: `${index} ${filler}`, createdAt: at(index % 60) }));
    await push(state);
    const [thread] = await rows("threads");
    expect(thread.messages.length).toBeLessThan(120);
    expect(thread.messages.at(-1).id).toBe("m119");
    expect(new TextEncoder().encode(JSON.stringify(thread)).length).toBeLessThan(1_000_000);
  });

  test("bad requests are refused with a reason", async () => {
    const { request } = await setup();
    expect((await request("/api/sync", { body: { state: macState() } })).status).toBe(400);
    expect((await request("/api/sync", { body: { accountId: "acct-1" } })).status).toBe(400);
    expect((await request("/api/sync", { body: { accountId: "x".repeat(200), state: macState() } })).status).toBe(400);
  });
});

describe("pairing", () => {
  test("every route but the public share page needs a paired Mac's token", async () => {
    const { request } = await setup();
    const routes: [string, string, unknown][] = [
      ["/api/sync", "POST", { accountId: "acct-1", state: macState() }],
      ["/api/bootstrap?accountId=acct-1", "GET", undefined],
      ["/api/purge", "POST", { accountId: "acct-1" }],
      ["/api/share", "POST", { accountId: "acct-1", runId: "r", run: {} }],
    ];
    for (const [path, method, body] of routes) {
      expect((await request(path, { method, body, auth: null })).status).toBe(401);
      expect((await request(path, { method, body, auth: "okd_wrong-token-that-nobody-paired-00000000000" })).status).toBe(401);
      expect((await request(path, { method, body, auth: "" })).status).toBe(401);
    }
  });

  test("a paired Mac reaches only the accounts its login owns", async () => {
    const { request, push, pairAnother } = await setup();
    await push(macState());
    const eve = await pairAnother("eve");
    const routes: [string, string, unknown][] = [
      ["/api/sync", "POST", { accountId: "acct-1", state: macState() }],
      ["/api/version?accountId=acct-1", "GET", undefined],
      ["/api/pull", "POST", { accountId: "acct-1", table: "threads", since: 0 }],
      ["/api/bootstrap?accountId=acct-1", "GET", undefined],
      ["/api/purge", "POST", { accountId: "acct-1" }],
      ["/api/share", "POST", { accountId: "acct-1", runId: "r", run: {} }],
      ["/api/worker/poll", "POST", { accountId: "acct-1", device: "m", kind: "thisMac", enabled: true }],
      ["/api/enterprise/send", "POST", { accountId: "acct-1", spaceId: "x", text: "hi" }],
      ["/api/vault/upload-url", "POST", { accountId: "acct-1" }],
    ];
    for (const [path, method, body] of routes) {
      expect([path, (await request(path, { method, body, auth: eve.token })).status]).toEqual([path, 403]);
    }
    // nothing of jay's was touched
    expect((await request("/api/bootstrap?accountId=acct-1", { method: "GET" })).body.state.threads).toHaveLength(1);
    // eve's own, unclaimed account is hers to sync
    expect((await request("/api/sync", { body: { accountId: "acct-eve", device: "m", sentAt: 5, state: macState("acct-eve") }, auth: eve.token })).status).toBe(200);
  });

  test("a revoked token stops working at once; who-am-i tells a Mac which it is", async () => {
    const { request, jay, token } = await setup();
    expect((await request("/api/whoami", { method: "GET" })).body.device).toBe("test mac");
    const [mine] = await jay.query(api.devices.list, {});
    expect(mine.device).toBe("test mac");
    await jay.mutation(api.devices.revoke, { tokenId: mine.id });
    expect((await request("/api/whoami", { method: "GET" })).status).toBe(401);
    expect((await request("/api/sync", { body: { accountId: "acct-1", state: macState() }, auth: token })).status).toBe(401);
    expect(await jay.query(api.devices.list, {})).toEqual([]);
  });

  test("signing out on the Mac retires its token", async () => {
    const { request, jay } = await setup();
    expect((await request("/api/unpair", { method: "POST" })).status).toBe(200);
    expect((await request("/api/whoami", { method: "GET" })).status).toBe(401);
    expect(await jay.query(api.devices.list, {})).toEqual([]);
  });
});

describe("reading synced data back", () => {
  test("bootstrap hands the Mac its last snapshot", async () => {
    const { push, request } = await setup();
    expect((await request("/api/bootstrap?accountId=acct-1", { method: "GET" })).body).toEqual({ state: null, updatedAt: 0 });
    await push(macState());
    const boot = await request("/api/bootstrap?accountId=acct-1", { method: "GET" });
    expect(boot.body.state.threads[0].title).toBe("learning figma");
    expect(boot.body.updatedAt).toBeGreaterThan(0);
  });

  test("only the login that claimed an account can read it", async () => {
    const { t, push, jay } = await setup();
    // The first push from jay's paired Mac places the account under jay's login.
    await push(macState());
    const stranger = await t.run((ctx) => ctx.db.insert("users", { name: "eve", email: "eve@example.com" }));
    const eve = t.withIdentity({ subject: `${stranger}|s2` });
    const account = { id: "acct-1", name: "Jay", email: "jay@example.com", kind: "personal", colorHex: "1FB57A", createdAt: at(0) };

    expect(await jay.mutation(api.accounts.claim, { accounts: [account] })).toEqual({ claimed: ["acct-1"], taken: [] });
    expect(await eve.mutation(api.accounts.claim, { accounts: [account] })).toEqual({ claimed: [], taken: ["acct-1"] });

    expect((await jay.query(api.dashboard.bootstrap, { accountId: "acct-1" })).state.memories).toHaveLength(1);
    expect(await jay.query(api.dashboard.memories, { accountId: "acct-1" })).toHaveLength(1);
    expect(await jay.query(api.dashboard.runs, { accountId: "acct-1" })).toHaveLength(1);
    expect(await eve.query(api.dashboard.bootstrap, { accountId: "acct-1" })).toBeNull();
    expect(await eve.query(api.dashboard.memories, { accountId: "acct-1" })).toEqual([]);
    expect(await t.query(api.dashboard.state, { accountId: "acct-1" })).toBeNull();

    // A push after the claim keeps the owner.
    await push({ ...macState(), accounts: [{ ...account, name: "Jay K" }] });
    expect(await jay.query(api.accounts.mine, {})).toEqual([expect.objectContaining({ id: "acct-1", name: "Jay K" })]);

    expect(await jay.mutation(api.accounts.release, { accountId: "acct-1" })).toEqual({ released: true });
    expect(await jay.query(api.dashboard.bootstrap, { accountId: "acct-1" })).toBeNull();
  });
});

describe("purge and share", () => {
  test("purging an account removes all of it, page by page, and leaves other accounts alone", async () => {
    const { push, request, rows } = await setup();
    const big = macState("acct-1");
    big.runs = Array.from({ length: 260 }, (_, index) => ({ ...big.runs[0], id: `run-${index}`, preview: undefined as any }));
    await push(big);
    await push(macState("acct-2"));
    expect(await rows("runs")).toHaveLength(261);

    const purged = await request("/api/purge", { body: { accountId: "acct-1" } });
    expect(purged.status).toBe(200);
    expect(purged.body.ok).toBe(true);
    for (const table of ["threads", "memories", "runs", "skills", "routines", "snapshots", "syncs", "settings"]) {
      expect((await rows(table)).every((row) => row.accountId === "acct-2")).toBe(true);
    }
    expect((await rows("accounts")).map((row) => row.clientId)).toEqual(["acct-2"]);
    expect(await rows("runs")).toHaveLength(1);
  });

  test("sharing a run twice keeps one link, refreshes it, and the public page leaves private fields out", async () => {
    const { push, request, rows } = await setup();
    const state = macState();
    await push(state);
    const run = { ...state.runs[0], accountID: "acct-1" };
    const first = await request("/api/share", { body: { accountId: "acct-1", accountName: "Jay", runId: run.id, run } });
    const second = await request("/api/share", { body: { accountId: "acct-1", accountName: "Jay", runId: run.id, run: { ...run, summary: "freed 24 GB" } } });
    expect(second.body.token).toBe(first.body.token);
    expect(first.body.url).toBeNull();
    expect(await rows("shareLinks")).toHaveLength(1);

    const page = await request(`/api/share?token=${first.body.token}`, { method: "GET", auth: null });
    expect(page.status).toBe(200);
    expect(page.body.run.summary).toBe("freed 24 GB");
    expect(page.body.run.accountID).toBeUndefined();
    expect(page.body.run.workingDirectory).toBeUndefined();
    expect(page.body.run.pickedPath).toBeUndefined();
    expect((await request("/api/share?token=nope", { method: "GET", auth: null })).status).toBe(404);

    const tooBig = await request("/api/share", { body: { accountId: "acct-1", runId: run.id, run: { ...run, output: "y".repeat(900_000) } } });
    expect(tooBig.status).toBe(413);
  });
});

describe("the panel's snapshot", () => {
  test("is trimmed to fit one document, newest first", () => {
    const runs = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}`, createdAt: at(index % 60).replace("12:", String(10 + Math.floor(index / 60)) + ":"), output: "o".repeat(10_000) }));
    const threads = Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, updatedAt: at(index % 60), messages: Array.from({ length: 80 }, (_, m) => ({ id: `m${m}`, text: "w".repeat(200) })) }));
    const snapshot = trimSnapshot({ runs, threads, memories: [{ id: "keep" }], skills: [{ id: "s" }], routines: [] });
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(800_000);
    expect(snapshot.runs.length).toBeLessThanOrEqual(100);
    expect(snapshot.runs[0].id).toBe("r299");
    expect(snapshot.threads.every((thread: any) => thread.messages.length <= 40)).toBe(true);
    expect(snapshot.memories).toEqual([{ id: "keep" }]);
    expect(snapshot.skills).toEqual([{ id: "s" }]);
  });
});

describe("versions, pulls and merges between Macs", () => {
  const internal = anyApi as any;

  async function pullAll(request: ReturnType<typeof setup>["request"], accountId: string, table: string, since: number) {
    const items: any[] = [];
    let cursor: string | null = null;
    let version = 0;
    for (let pages = 0; pages < 100; pages++) {
      const page = await request("/api/pull", { body: { accountId, table, since, cursor } });
      expect(page.status).toBe(200);
      items.push(...page.body.items);
      version = page.body.version;
      if (page.body.isDone) break;
      cursor = page.body.cursor;
    }
    return { items, version };
  }

  test("a push on top of the version it pulled is accepted; one that's behind is refused before it writes", async () => {
    const { push, request, rows } = await setup();
    const state = macState();
    expect((await request("/api/version?accountId=acct-1", { method: "GET" })).body).toEqual({ version: 0, syncing: false });

    const first = await push(state, { baseVersion: 0 });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);
    expect((await request("/api/version?accountId=acct-1", { method: "GET" })).body.version).toBe(1);

    // Another Mac that last pulled at version 0 and deleted everything: refused, nothing removed.
    const behind = await push({ ...state, memories: [], runs: [] }, { baseVersion: 0 });
    expect(behind.status).toBe(409);
    expect(behind.body).toMatchObject({ error: "behind", version: 1 });
    expect(await rows("memories")).toHaveLength(1);
    expect(await rows("runs")).toHaveLength(1);

    const caughtUp = await push({ ...state, memories: [] }, { baseVersion: 1 });
    expect(caughtUp.body).toMatchObject({ ok: true, version: 2, removed: 1 });
  });

  test("a pull since a version returns only what changed after it, shaped like the Mac's own items", async () => {
    const { push, request } = await setup();
    const state = macState();
    await push(state, { baseVersion: 0 });

    const full = await pullAll(request, "acct-1", "runs", 0);
    expect(full.version).toBe(1);
    expect(full.items).toEqual([
      expect.objectContaining({
        id: "acct-1-r1",
        accountID: "acct-1",
        threadID: "acct-1-t1",
        title: "free up space",
        preview: expect.objectContaining({ summary: "clean caches" }),
        updatedAt: at(3), // no edit time from the Mac: its creation time
      }),
    ]);
    for (const field of ["_id", "_creationTime", "clientId", "accountId", "syncVersion", "modifiedAt", "threadId"]) {
      expect(full.items[0]).not.toHaveProperty(field);
    }
    const memories = await pullAll(request, "acct-1", "memories", 0);
    expect(memories.items).toEqual([{ id: "acct-1-mem1", accountID: "acct-1", section: "aboutYou", text: "studies at Purdue", source: "you", createdAt: at(0), updatedAt: at(0) }]);

    const edited = structuredClone(state);
    edited.memories[0].text = "studies business at Purdue";
    edited.memories[0].updatedAt = at(30);
    (edited.skills[0] as any).updatedAt = at(31);
    edited.skills[0].runCount = 3;
    await push(edited, { baseVersion: 1 });

    expect((await pullAll(request, "acct-1", "memories", 1)).items.map((item) => item.text)).toEqual(["studies business at Purdue"]);
    expect((await pullAll(request, "acct-1", "skills", 1)).items).toEqual([expect.objectContaining({ id: "acct-1-s1", runCount: 3, updatedAt: at(31) })]);
    expect((await pullAll(request, "acct-1", "threads", 1)).items).toEqual([]);
    expect((await pullAll(request, "acct-1", "runs", 2)).items).toEqual([]);
  });

  test("a delete leaves a tombstone the account's other Macs pull; the item coming back clears it", async () => {
    const { push, request, rows } = await setup();
    const state = macState();
    await push(state, { baseVersion: 0 });
    await push({ ...state, memories: [], skills: [] }, { baseVersion: 1 });

    const deletions = await pullAll(request, "acct-1", "deletions", 1);
    expect(deletions.items.map((item) => [item.table, item.id]).sort()).toEqual([
      ["memories", "acct-1-mem1"],
      ["skills", "acct-1-s1"],
    ]);
    expect(Date.parse(deletions.items[0].deletedAt)).toBeGreaterThan(0);
    // A Mac that pulled after the delete gets nothing new.
    expect((await pullAll(request, "acct-1", "deletions", 2)).items).toEqual([]);
    // A first pull still hears about it, so a Mac that had the item drops it.
    expect((await pullAll(request, "acct-1", "deletions", 0)).items).toHaveLength(2);

    await push({ ...state, skills: [] }, { baseVersion: 2 });
    expect((await rows("deletions")).map((row) => row.clientId)).toEqual(["acct-1-s1"]);
  });

  test("runs older than the Mac's floor stay when it sends only its newest ones", async () => {
    const { push, rows } = await setup();
    const state = macState();
    state.runs = [0, 1, 2].map((index) => ({ ...state.runs[0], id: `run-${index}`, createdAt: at(10 + index), preview: undefined as any }));
    await push(state, { baseVersion: 0 });

    const newestOnly = { ...state, runs: [state.runs[2]] };
    const capped = await push(newestOnly, { baseVersion: 1, floors: { runs: at(12) } });
    expect(capped.body.removed).toBe(0);
    expect((await rows("runs")).map((row) => row.clientId).sort()).toEqual(["run-0", "run-1", "run-2"]);

    // A run newer than the floor that the Mac no longer has is a real delete.
    const deleted = await push({ ...state, runs: [state.runs[0]] }, { baseVersion: 2, floors: { runs: at(10) } });
    expect(deleted.body.removed).toBe(2);
    expect((await rows("runs")).map((row) => row.clientId)).toEqual(["run-0"]);
  });

  test("an older Mac without versions still syncs, and moves the version on so newer Macs pull", async () => {
    const { push, request } = await setup();
    const legacy = await push(macState());
    expect(legacy.body).toMatchObject({ ok: true, version: 1 });
    expect((await request("/api/version?accountId=acct-1", { method: "GET" })).body.version).toBe(1);
    expect((await push(macState(), { baseVersion: 0 })).status).toBe(409);
    expect((await push(macState(), { baseVersion: 1 })).body.version).toBe(2);
  });

  test("a sync overtaken by a newer one stops before it writes, deletes, or replaces the snapshot", async () => {
    const { t, push, rows } = await setup();
    await push(macState(), { baseVersion: 0 });
    const mine = await t.mutation(internal.sync.begin, { accountId: "acct-1", sentAt: 1, device: "slow mac", baseVersion: 1 });
    expect(mine).toMatchObject({ ok: true, version: 2 });
    const theirs = await t.mutation(internal.sync.begin, { accountId: "acct-1", sentAt: 2, device: "fast mac", baseVersion: 2 });
    expect(theirs).toMatchObject({ ok: true, version: 3 });

    const renamed = { ...macState().accounts[0], name: "Stale name" };
    expect(await t.mutation(internal.sync.pushMeta, { accountId: "acct-1", version: 2, accounts: [renamed], settings: {}, connectors: [] })).toEqual({ ok: false });
    expect((await rows("accounts"))[0].name).toBe("Jay");
    const write = await t.mutation(internal.sync.upsertBatch, { accountId: "acct-1", table: "memories", items: [{ id: "new", text: "late" }], version: 2 });
    expect(write).toEqual({ written: 0, superseded: true });
    const remove = await t.mutation(internal.sync.removeMissingPage, { accountId: "acct-1", table: "memories", keep: "", cursor: null, version: 2 });
    expect(remove.superseded).toBe(true);
    expect(await rows("memories")).toHaveLength(1);
    await t.mutation(internal.sync.writeSnapshot, { accountId: "acct-1", device: "slow mac", state: { memories: [] }, sentAt: 1, version: 2 });
    expect((await rows("snapshots"))[0].state.memories).toHaveLength(1);
  });

  test("a pull pages through a big table and a full pull includes rows from before versions existed", async () => {
    const { t, push, request } = await setup();
    const state = macState();
    state.threads = Array.from({ length: 25 }, (_, index) => ({ ...state.threads[0], id: `thread-${index}` }));
    await push(state, { baseVersion: 0 });
    // A row written by an older backend has no version.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("threads").withIndex("by_client", (q) => q.eq("clientId", "thread-0")).first();
      await ctx.db.patch(row!._id, { syncVersion: undefined });
    });
    const full = await pullAll(request, "acct-1", "threads", 0);
    expect(full.items.map((item) => item.id).sort()).toEqual(state.threads.map((thread) => thread.id).sort());
    expect((await pullAll(request, "acct-1", "threads", 1)).items).toEqual([]);
    expect((await request("/api/pull", { body: { accountId: "acct-1", table: "secrets" } })).status).toBe(400);
  });

  test("purging an account removes its tombstones and sync version too", async () => {
    const { push, request, rows } = await setup();
    await push(macState(), { baseVersion: 0 });
    await push({ ...macState(), memories: [] }, { baseVersion: 1 });
    expect(await rows("deletions")).toHaveLength(1);
    await request("/api/purge", { body: { accountId: "acct-1" } });
    expect(await rows("deletions")).toEqual([]);
    expect((await request("/api/version?accountId=acct-1", { method: "GET" })).body.version).toBe(0);
  });

  test("share page views are counted at most once every few seconds", async () => {
    const { t, push, request, rows } = await setup();
    const state = macState();
    await push(state);
    const { body } = await request("/api/share", { body: { accountId: "acct-1", runId: state.runs[0].id, run: state.runs[0] } });
    for (let i = 0; i < 5; i++) await t.mutation(api.share.viewed, { token: body.token });
    expect((await rows("shareLinks"))[0].views).toBe(1);
  });
});
