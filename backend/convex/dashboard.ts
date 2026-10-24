import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { ownedAccount } from "./accounts";

// Older snapshots may hold the state as a JSON string.
function parseState(state: unknown) {
  if (typeof state !== "string") return state ?? null;
  try {
    return JSON.parse(state);
  } catch {
    return null;
  }
}

async function snapshotFor(ctx: QueryCtx, accountId: string) {
  return await ctx.db
    .query("snapshots")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .first();
}

// Everything below answers only the signed-in owner of the account; anyone else gets nothing.

export const bootstrap = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    if (!(await ownedAccount(ctx, accountId))) return null;
    const snapshot = await snapshotFor(ctx, accountId);
    if (!snapshot) return null;
    const sync = await ctx.db
      .query("syncs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    return {
      state: parseState(snapshot.state),
      updatedAt: snapshot.updatedAt,
      device: snapshot.device,
      // A sync that began but never finished means the Mac is mid-push (or was interrupted).
      syncing: Boolean(sync && sync.finishedAt === null && Date.now() - sync.startedAt < 10 * 60_000),
    };
  },
});

export const state = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    if (!(await ownedAccount(ctx, accountId))) return null;
    const snapshot = await snapshotFor(ctx, accountId);
    return snapshot ? parseState(snapshot.state) : null;
  },
});

export const runs = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    if (!(await ownedAccount(ctx, accountId))) return [];
    return await ctx.db
      .query("runs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
  },
});

export const memories = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    if (!(await ownedAccount(ctx, accountId))) return [];
    return await ctx.db
      .query("memories")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
  },
});

// For the Mac's own pull over /api/bootstrap, which is guarded by the sync secret instead of a login.
export const forDevice = internalQuery({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const snapshot = await snapshotFor(ctx, accountId);
    return snapshot ? { state: parseState(snapshot.state), updatedAt: snapshot.updatedAt } : null;
  },
});
