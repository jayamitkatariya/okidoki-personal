import { mutation, query } from "./_generated/server";
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
      views: link.views,
    };
  },
});

const VIEW_WINDOW_MS = 10_000;

// Counts an open of the share page. Unauthenticated on purpose: the page itself is public. Opens within
// a few seconds of the last counted one aren't counted, so reloading in a loop can't hammer the row.
export const viewed = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!link) return;
    const now = Date.now();
    if (link.lastViewedAt && now - link.lastViewedAt < VIEW_WINDOW_MS) return;
    await ctx.db.patch(link._id, { views: link.views + 1, lastViewedAt: now });
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
    return { token: link.token, runId: link.runId, views: link.views, createdAt: link.createdAt };
  },
});

// Owners can take a link down; the token stops resolving at once.
export const revoke = mutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const links = await ctx.db
      .query("shareLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
    let removed = 0;
    for (const link of links) {
      if (!(await ownedAccount(ctx, link.accountId))) continue;
      await ctx.db.delete(link._id);
      removed++;
    }
    return { removed };
  },
});
