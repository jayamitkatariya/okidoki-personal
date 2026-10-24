import { v } from "convex/values";
import { query } from "./_generated/server";

export const bootstrap = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!snapshot) return null;
    let state = snapshot.state;
    if (typeof state === "string") {
      try {
        state = JSON.parse(state);
      } catch {
        state = null;
      }
    }
    return { state, updatedAt: snapshot.updatedAt, device: snapshot.device };
  },
});

export const state = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    return snapshot?.state ?? null;
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
