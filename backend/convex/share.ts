import { query } from "./_generated/server";
import { v } from "convex/values";
import { ownedAccount } from "./accounts";

// A share link is public by design: its random token is the permission. Everything else needs the owner.

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
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
    if (!link || !(await ownedAccount(ctx, link.accountId))) return null;
    return link;
  },
});
