import { v } from "convex/values";
import { query } from "./_generated/server";

// Older snapshots may hold the state as a JSON string.
function parseState(state: unknown) {
  if (typeof state !== "string") return state ?? null;
  try {
    return JSON.parse(state);
  } catch {
    return null;
  }
}

export const bootstrap = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!snapshot) return null;
    return { state: parseState(snapshot.state), updatedAt: snapshot.updatedAt, device: snapshot.device };
  },
});

export const state = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    return snapshot ? parseState(snapshot.state) : null;
  },
});

export const runs = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
  },
});

export const memories = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    return await ctx.db
      .query("memories")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
  },
});
