import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

// A sync is split into many small mutations (see http.ts) so no single transaction or document
// hits Convex's limits: 1 MiB per document, and capped reads/writes per transaction.
// Each step is idempotent, so a sync interrupted halfway is completed by the next one.

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

const MAX_DOC_BYTES = 800_000; // headroom under Convex's 1 MiB document limit

export function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

// Keeps the newest messages that fit in one document; the Mac still has the full thread.
function fitMessages(messages: unknown): unknown[] {
  const list = asArray(messages);
  let start = 0;
  while (start < list.length && byteSize(list.slice(start)) > MAX_DOC_BYTES - 20_000) {
    start += Math.max(1, Math.ceil((list.length - start) / 10));
  }
  return list.slice(start);
}

const iso = (value: unknown) => String(value ?? new Date().toISOString());

// One builder per synced table: Mac item → Convex document (minus updatedAt, which writes add).
const builders = {
  threads: (item: any, accountId: string) => ({
    clientId: String(item.id),
    accountId,
    title: String(item.title ?? "thread"),
    app: String(item.app ?? "mac"),
    topic: String(item.topic ?? ""),
    messages: fitMessages(item.messages),
    archived: Boolean(item.archived),
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  }),
  memories: (item: any, accountId: string) => ({
    clientId: String(item.id),
    accountId,
    section: String(item.section ?? "aboutYou"),
    text: String(item.text ?? ""),
    source: String(item.source ?? "you"),
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  }),
  runs: (item: any, accountId: string) => ({
    clientId: String(item.id),
    accountId,
    kind: String(item.kind ?? "answer"),
    title: String(item.title ?? "run"),
    prompt: String(item.prompt ?? ""),
    status: String(item.status ?? "done"),
    threadId: item.threadID ?? null,
    steps: item.steps ?? [],
    output: String(item.output ?? "").slice(-20_000), // matches what the Mac sends
    summary: String(item.summary ?? ""),
    agent: item.agent ?? null,
    workingDirectory: item.workingDirectory ?? null,
    createdAt: iso(item.createdAt),
    startedAt: item.startedAt ?? null,
    endedAt: item.endedAt ?? null,
    freedBytes: typeof item.freedBytes === "number" ? item.freedBytes : null,
    builtin: item.builtin ?? null,
    pickedPath: item.pickedPath ?? null,
    modifiedAt: iso(item.updatedAt ?? item.createdAt),
  }),
  skills: (item: any, accountId: string) => ({
    clientId: String(item.id),
    accountId,
    name: String(item.name ?? "skill"),
    summary: String(item.summary ?? ""),
    steps: item.steps ?? [],
    source: String(item.source ?? "watch me"),
    runCount: Number(item.runCount ?? 0),
    createdAt: iso(item.createdAt),
    modifiedAt: iso(item.updatedAt ?? item.createdAt),
  }),
  routines: (item: any, accountId: string) => ({
    clientId: String(item.id),
    accountId,
    name: String(item.name ?? "routine"),
    prompt: String(item.prompt ?? ""),
    cadence: String(item.cadence ?? "weekly"),
    weekday: Number(item.weekday ?? 6),
    hour: Number(item.hour ?? 17),
    minute: Number(item.minute ?? 0),
    enabled: Boolean(item.enabled),
    createdAt: iso(item.createdAt),
    lastRunAt: item.lastRunAt ?? null,
    nextRunAt: item.nextRunAt ?? null,
    modifiedAt: iso(item.updatedAt ?? item.createdAt),
  }),
};

export type SyncedTable = keyof typeof builders;
export const SYNCED_TABLES = Object.keys(builders) as SyncedTable[];
const tableArg = v.union(v.literal("threads"), v.literal("memories"), v.literal("runs"), v.literal("skills"), v.literal("routines"));

// Threads and memories carry the Mac's own updatedAt; the rest are stamped here, only when they change.
const stampsOwnTime = (table: SyncedTable) => table !== "threads" && table !== "memories";

// True when every field we'd write already matches, so unchanged items cost a read, not a write.
function unchanged(existing: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.entries(next).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value));
}

async function syncRow(ctx: QueryCtx | MutationCtx, accountId: string) {
  return await ctx.db
    .query("syncs")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .first();
}

/** The account's current sync version; 0 before its first sync. */
export async function versionOf(ctx: QueryCtx | MutationCtx, accountId: string): Promise<number> {
  return (await syncRow(ctx, accountId))?.version ?? 0;
}

// Claims the sync for this account and hands out the next version.
// A Mac that sends `baseVersion` is accepted only on top of exactly that version: anything newer means
// another Mac synced since it last pulled, so it must pull and merge first (its deletes would otherwise
// remove what the other Mac just added). Older Macs send only `sentAt`, and a payload older than the
// last accepted one is refused, as before.
export const begin = internalMutation({
  args: { accountId: v.string(), sentAt: v.number(), device: v.string(), baseVersion: v.optional(v.number()) },
  handler: async (ctx, { accountId, sentAt, device, baseVersion }) => {
    const existing = await syncRow(ctx, accountId);
    const current = existing?.version ?? 0;
    if (baseVersion !== undefined) {
      if (baseVersion !== current) return { ok: false as const, reason: "behind" as const, version: current, latest: existing?.sentAt ?? 0 };
    } else if (existing && sentAt < existing.sentAt) {
      return { ok: false as const, reason: "stale" as const, version: current, latest: existing.sentAt };
    }
    const version = current + 1;
    const now = Date.now();
    const row = { sentAt: Math.max(sentAt, existing?.sentAt ?? 0), device, startedAt: now, finishedAt: null, version };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("syncs", { accountId, ...row });
    return { ok: true as const, version, latest: row.sentAt };
  },
});

export const finish = internalMutation({
  args: { accountId: v.string(), version: v.number() },
  handler: async (ctx, { accountId, version }) => {
    const existing = await syncRow(ctx, accountId);
    if (existing && existing.version === version) await ctx.db.patch(existing._id, { finishedAt: Date.now() });
  },
});

export const pushMeta = internalMutation({
  args: {
    accountId: v.string(),
    version: v.number(),
    accounts: v.array(v.any()),
    settings: v.any(),
    connectors: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    // A superseded sync must not put back an account name or setting the newer one changed.
    if ((await versionOf(ctx, args.accountId)) !== args.version) return { ok: false };
    const now = Date.now();
    for (const account of args.accounts) {
      const existing = await ctx.db
        .query("accounts")
        .withIndex("by_client", (q) => q.eq("clientId", String(account.id)))
        .first();
      const document = {
        clientId: String(account.id),
        name: String(account.name ?? ""),
        email: String(account.email ?? ""),
        kind: String(account.kind ?? "personal"),
        colorHex: String(account.colorHex ?? "1FB57A"),
        createdAt: iso(account.createdAt),
      };
      if (!existing) await ctx.db.insert("accounts", { ...document, updatedAt: now });
      else if (!unchanged(existing, document)) await ctx.db.patch(existing._id, { ...document, updatedAt: now });
    }

    const settings = args.settings ?? {};
    const existingSettings = await ctx.db
      .query("settings")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!existingSettings) await ctx.db.insert("settings", { accountId: args.accountId, data: settings, updatedAt: now });
    else if (!unchanged(existingSettings, { data: settings })) await ctx.db.patch(existingSettings._id, { data: settings, updatedAt: now });

    for (const connector of args.connectors) {
      const existing = await ctx.db
        .query("connectors")
        .withIndex("by_client", (q) => q.eq("clientId", String(connector.id)))
        .first();
      const document = {
        clientId: String(connector.id),
        name: String(connector.name ?? connector.id),
        kind: String(connector.kind ?? "other"),
        blurb: String(connector.blurb ?? ""),
        enabled: Boolean(connector.enabled),
        installed: Boolean(connector.installed),
      };
      if (!existing) await ctx.db.insert("connectors", { ...document, updatedAt: now });
      else if (!unchanged(existing, document)) await ctx.db.patch(existing._id, { ...document, updatedAt: now });
    }
    return { ok: true };
  },
});

export const upsertBatch = internalMutation({
  args: { accountId: v.string(), table: tableArg, items: v.array(v.any()), version: v.number() },
  handler: async (ctx, { accountId, table, items, version }) => {
    if ((await versionOf(ctx, accountId)) !== version) return { written: 0, superseded: true };
    const now = Date.now();
    let written = 0;
    for (const item of items) {
      const document: Record<string, any> = builders[table](item, accountId);
      const existing = await ctx.db
        .query(table)
        .withIndex("by_client", (q) => q.eq("clientId", document.clientId))
        .first();
      if (existing && unchanged(existing, document)) continue;
      const stamped = { ...document, syncVersion: version };
      const row = stampsOwnTime(table) ? { ...stamped, updatedAt: now } : stamped;
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert(table, row as any);
      written++;
      // Back again (edited on a Mac that hadn't seen the delete): it's no longer deleted.
      const tombstones = await ctx.db
        .query("deletions")
        .withIndex("by_client", (q) => q.eq("clientId", document.clientId))
        .collect();
      for (const tombstone of tombstones) await ctx.db.delete(tombstone._id);

      if (table === "runs") {
        const runId = String(item.id);
        const preview = await ctx.db
          .query("actionPreviews")
          .withIndex("by_run", (q) => q.eq("runId", runId))
          .first();
        if (item.preview) {
          if (!preview) await ctx.db.insert("actionPreviews", { runId, accountId, data: item.preview, updatedAt: now });
          else if (!unchanged(preview, { data: item.preview })) await ctx.db.patch(preview._id, { data: item.preview, updatedAt: now });
        } else if (preview) {
          // The Mac dropped the preview (the run was re-planned); don't keep showing the old one.
          await ctx.db.delete(preview._id);
        }
      }
    }
    return { written, superseded: false };
  },
});

// The Mac sends only its newest runs and threads. Rows older than the oldest one it sent ("floor") are
// history it chose not to send, not deletions, so they stay.
const floorKey = (table: SyncedTable, row: Record<string, any>) => (table === "runs" ? String(row.createdAt ?? "") : table === "threads" ? String(row.updatedAt ?? "") : "");

// Deletes this account's rows the Mac no longer has, one page at a time; the caller loops on the cursor.
// Each delete leaves a tombstone, so the account's other Macs drop the item too.
export const removeMissingPage = internalMutation({
  args: {
    accountId: v.string(),
    table: tableArg,
    keep: v.string(),
    cursor: v.union(v.string(), v.null()),
    version: v.number(),
    floor: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, table, keep, cursor, version, floor }) => {
    if ((await versionOf(ctx, accountId)) !== version) return { cursor: "", isDone: true, removed: 0, superseded: true };
    const keepSet = new Set(keep.split("\n").filter(Boolean));
    const page = await ctx.db
      .query(table)
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .paginate({ cursor, numItems: 100 });
    let removed = 0;
    const now = Date.now();
    for (const row of page.page) {
      if (keepSet.has(row.clientId)) continue;
      if (floor && floorKey(table, row) < floor) continue;
      if (table === "runs") {
        const previews = await ctx.db
          .query("actionPreviews")
          .withIndex("by_run", (q) => q.eq("runId", row.clientId))
          .collect();
        for (const preview of previews) await ctx.db.delete(preview._id);
        // A run deleted on the Mac shouldn't stay public through its share link.
        const links = await ctx.db
          .query("shareLinks")
          .withIndex("by_run", (q) => q.eq("runId", row.clientId))
          .collect();
        for (const link of links) await ctx.db.delete(link._id);
      }
      await ctx.db.delete(row._id);
      await ctx.db.insert("deletions", { accountId, table, clientId: row.clientId, syncVersion: version, deletedAt: now });
      removed++;
    }
    return { cursor: page.continueCursor, isDone: page.isDone, removed, superseded: false };
  },
});

// Removes everything synced for an account, a page at a time; the caller loops until done is true.
// Used when the account is deleted on the Mac, so Convex doesn't keep data the person removed.
export const purgeAccountPage = internalMutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    let removed = 0;
    const budget = 200;
    for (const table of [...SYNCED_TABLES, "actionPreviews", "settings", "snapshots", "shareLinks", "deletions", "syncs"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .take(budget - removed);
      for (const row of rows) await ctx.db.delete(row._id);
      removed += rows.length;
      if (removed >= budget) return { removed, done: false };
    }
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_client", (q) => q.eq("clientId", accountId))
      .first();
    if (account) {
      await ctx.db.delete(account._id);
      removed++;
    }
    return { removed, done: true };
  },
});

// The snapshot is what the panel and share links load in one read, so it must fit in one document.
// Newest first: recent runs keep a short output tail, threads keep their latest messages, and the
// rest is dropped until it fits. Full data stays in the per-item tables (and on the Mac).
export function trimSnapshot(state: Record<string, any>): Record<string, any> {
  const newest = (key: string) => (a: any, b: any) => String(b?.[key] ?? "").localeCompare(String(a?.[key] ?? ""));
  const runs = asArray(state.runs).slice().sort(newest("createdAt"));
  const threads = asArray(state.threads).slice().sort(newest("updatedAt"));
  let runLimit = 100;
  let threadLimit = 60;
  let messageLimit = 40;
  let outputTail = 4_000;
  for (;;) {
    const snapshot = {
      ...state,
      runs: runs.slice(0, runLimit).map((run) => ({ ...run, output: String(run.output ?? "").slice(-outputTail) })),
      threads: threads.slice(0, threadLimit).map((thread) => ({ ...thread, messages: asArray(thread.messages).slice(-messageLimit) })),
    };
    if (byteSize(snapshot) <= MAX_DOC_BYTES) return snapshot;
    if (runLimit === 0 && threadLimit === 0) {
      // Even the bare state is too big (huge settings or memory): keep only what the panel can't do without.
      return { ...snapshot, memories: asArray(state.memories).slice(0, 200), skills: [], routines: [] };
    }
    runLimit = Math.floor(runLimit / 2);
    threadLimit = Math.floor(threadLimit / 2);
    messageLimit = Math.max(10, Math.floor(messageLimit / 2));
    outputTail = Math.floor(outputTail / 2);
  }
}

export const writeSnapshot = internalMutation({
  args: { accountId: v.string(), device: v.string(), state: v.any(), sentAt: v.number(), version: v.number() },
  handler: async (ctx, { accountId, device, state, sentAt, version }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    // A newer sync already took over (another device, or a faster push): keep its snapshot.
    if ((await versionOf(ctx, accountId)) !== version) return existing?.updatedAt ?? now;
    if (existing) await ctx.db.patch(existing._id, { state, device, updatedAt: now, sentAt });
    else await ctx.db.insert("snapshots", { accountId, device, state, updatedAt: now, sentAt });
    return now;
  },
});

// Sharing the same run twice returns the same link; the run's content is refreshed each time.
export const createShare = internalMutation({
  args: {
    token: v.string(),
    accountId: v.string(),
    accountName: v.string(),
    runId: v.string(),
    run: v.any(),
  },
  handler: async (ctx, args) => {
    // The page is public: leave out the account id and local paths the Mac keeps on the run.
    const { accountID, workingDirectory, pickedPath, ...run } = args.run as Record<string, unknown>;
    const existing = await ctx.db
      .query("shareLinks")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .first();
    if (existing && existing.accountId === args.accountId) {
      await ctx.db.patch(existing._id, { run, accountName: args.accountName });
      return { token: existing.token, created: false };
    }
    await ctx.db.insert("shareLinks", {
      token: args.token,
      accountId: args.accountId,
      accountName: args.accountName,
      runId: args.runId,
      run,
      views: 0,
      createdAt: Date.now(),
    });
    return { token: args.token, created: true };
  },
});

// ---- Pull: what changed for an account since a version, in the Mac's own shape. ----

const pullTableArg = v.union(tableArg, v.literal("deletions"));
// Small pages for threads: one thread can be most of a megabyte.
const PULL_PAGE: Record<SyncedTable, number> = { threads: 8, memories: 200, runs: 40, skills: 40, routines: 200 };

/** A synced row as the Mac stores it, so it decodes straight into the Mac's own types. */
export function toMac(table: SyncedTable, row: Record<string, any>, preview: unknown = null): Record<string, unknown> {
  const { _id, _creationTime, clientId, accountId, syncVersion, modifiedAt, ...rest } = row;
  const item: Record<string, any> = { id: clientId, accountID: accountId, ...rest };
  if (table === "threads" || table === "memories") return item; // they carry the Mac's own updatedAt
  // The others' updatedAt is the server's write time; the Mac's own edit time is modifiedAt.
  const { updatedAt: _written, ...other } = item;
  const edited = modifiedAt ?? row.createdAt;
  if (table === "runs") {
    const { threadId, ...run } = other;
    return { ...run, threadID: threadId ?? null, preview: preview ?? null, updatedAt: edited };
  }
  return { ...other, updatedAt: edited };
}

export const currentVersion = internalQuery({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const row = await syncRow(ctx, accountId);
    return { version: row?.version ?? 0, syncing: Boolean(row && row.finishedAt === null && Date.now() - row.startedAt < 10 * 60_000) };
  },
});

// `since` 0 is a full pull (every row, including ones written before versions existed); otherwise only
// rows written by a later sync. Tombstones always come by version: they only exist since versions do.
export const pullPage = internalQuery({
  args: { accountId: v.string(), table: pullTableArg, since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountId, table, since, cursor }) => {
    const version = await versionOf(ctx, accountId);
    if (table === "deletions") {
      const page = await ctx.db
        .query("deletions")
        .withIndex("by_account_version", (q) => q.eq("accountId", accountId).gt("syncVersion", since))
        .paginate({ cursor, numItems: 500 });
      return {
        version,
        items: page.page.map((row) => ({ table: row.table, id: row.clientId, deletedAt: new Date(row.deletedAt).toISOString() })),
        cursor: page.continueCursor,
        isDone: page.isDone,
      };
    }
    const options = { cursor, numItems: PULL_PAGE[table] };
    const page =
      since > 0
        ? await ctx.db
            .query(table)
            .withIndex("by_account_version", (q) => q.eq("accountId", accountId).gt("syncVersion", since))
            .paginate(options)
        : await ctx.db
            .query(table)
            .withIndex("by_account", (q) => q.eq("accountId", accountId))
            .paginate(options);
    const items: Record<string, unknown>[] = [];
    for (const row of page.page) {
      let preview: unknown = null;
      if (table === "runs") {
        preview =
          (
            await ctx.db
              .query("actionPreviews")
              .withIndex("by_run", (q) => q.eq("runId", row.clientId))
              .first()
          )?.data ?? null;
      }
      items.push(toMac(table, row, preview));
    }
    return { version, items, cursor: page.continueCursor, isDone: page.isDone };
  },
});
