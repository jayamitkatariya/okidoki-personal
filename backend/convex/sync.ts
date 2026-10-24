import { internalMutation } from "./_generated/server";
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

// Claims the sync for this account. A payload older than the one already accepted is refused, so two
// overlapping pushes (a slow one finishing after a fast one) can't delete each other's rows.
export const begin = internalMutation({
  args: { accountId: v.string(), sentAt: v.number(), device: v.string() },
  handler: async (ctx, { accountId, sentAt, device }) => {
    const existing = await ctx.db
      .query("syncs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (existing && sentAt < existing.sentAt) return { ok: false as const, latest: existing.sentAt };
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { sentAt, device, startedAt: now, finishedAt: null });
    else await ctx.db.insert("syncs", { accountId, sentAt, device, startedAt: now, finishedAt: null });
    return { ok: true as const, latest: sentAt };
  },
});

// Still the newest sync? Checked before each destructive step so a superseded sync stops instead of deleting.
export const stillCurrent = internalMutation({
  args: { accountId: v.string(), sentAt: v.number() },
  handler: async (ctx, { accountId, sentAt }) => {
    const existing = await ctx.db
      .query("syncs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    return !existing || existing.sentAt <= sentAt;
  },
});

export const finish = internalMutation({
  args: { accountId: v.string(), sentAt: v.number() },
  handler: async (ctx, { accountId, sentAt }) => {
    const existing = await ctx.db
      .query("syncs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (existing && existing.sentAt === sentAt) await ctx.db.patch(existing._id, { finishedAt: Date.now() });
  },
});

export const pushMeta = internalMutation({
  args: {
    accountId: v.string(),
    accounts: v.array(v.any()),
    settings: v.any(),
    connectors: v.array(v.any()),
  },
  handler: async (ctx, args) => {
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
  },
});

export const upsertBatch = internalMutation({
  args: { accountId: v.string(), table: tableArg, items: v.array(v.any()) },
  handler: async (ctx, { accountId, table, items }) => {
    const now = Date.now();
    let written = 0;
    for (const item of items) {
      const document: Record<string, any> = builders[table](item, accountId);
      const existing = await ctx.db
        .query(table)
        .withIndex("by_client", (q) => q.eq("clientId", document.clientId))
        .first();
      if (existing && unchanged(existing, document)) continue;
      const row = stampsOwnTime(table) ? { ...document, updatedAt: now } : document;
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert(table, row as any);
      written++;

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
    return { written };
  },
});

// Deletes this account's rows the Mac no longer has, one page at a time; the caller loops on the cursor.
export const removeMissingPage = internalMutation({
  args: { accountId: v.string(), table: tableArg, keep: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountId, table, keep, cursor }) => {
    const keepSet = new Set(keep.split("\n").filter(Boolean));
    const page = await ctx.db
      .query(table)
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .paginate({ cursor, numItems: 100 });
    let removed = 0;
    for (const row of page.page) {
      if (keepSet.has(row.clientId)) continue;
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
      removed++;
    }
    return { cursor: page.continueCursor, isDone: page.isDone, removed };
  },
});

// Removes everything synced for an account, a page at a time; the caller loops until done is true.
// Used when the account is deleted on the Mac, so Convex doesn't keep data the person removed.
export const purgeAccountPage = internalMutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    let removed = 0;
    const budget = 200;
    for (const table of [...SYNCED_TABLES, "actionPreviews", "settings", "snapshots", "shareLinks", "syncs"] as const) {
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
  args: { accountId: v.string(), device: v.string(), state: v.any(), sentAt: v.number() },
  handler: async (ctx, { accountId, device, state, sentAt }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    // A newer snapshot already landed (another device, or a faster sync): keep it.
    if (existing?.sentAt && existing.sentAt > sentAt) return existing.updatedAt;
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
