import { query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!link) return null;
    return {
      run: link.run,
      accountName: link.accountName,
      createdAt: link.createdAt,
    };
  },
});

export const byRun = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    return await ctx.db
      .query("shareLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
  },
});
