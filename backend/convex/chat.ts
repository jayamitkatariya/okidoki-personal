import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { createJob, mentionsAgent } from "./jobs";
import { peopleIn, requireSpaceMember, spaceAccess } from "./spaces";

// The group chat inside a space. Members read and write; the agent and system lines have no author.

const PAGE = 200;

export const messages = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member) return [];
    const people = await peopleIn(ctx, access.space.orgId);
    const rows = await ctx.db
      .query("spaceMessages")
      .withIndex("by_space_time", (q) => q.eq("spaceId", spaceId))
      .order("desc")
      .take(PAGE);
    return rows.reverse().map((row) => {
      const person = row.authorId ? people.get(row.authorId) : null;
      return {
        id: row._id,
        author: row.author,
        authorId: row.authorId,
        name: row.author === "agent" ? "okidoki" : row.author === "system" ? "" : (person?.name ?? "Someone"),
        colorHex: person?.colorHex ?? "",
        kind: row.kind,
        text: row.text,
        runId: row.runId,
        fileId: row.fileId,
        createdAt: row.createdAt,
        isYou: row.authorId === access.userId,
      };
    });
  },
});

export const send = mutation({
  args: { spaceId: v.id("spaces"), text: v.string() },
  handler: async (ctx, { spaceId, text }) => {
    const access = await requireSpaceMember(ctx, spaceId);
    const cleaned = text.trim().slice(0, 4000);
    if (!cleaned) return;
    const now = Date.now();
    await ctx.db.insert("spaceMessages", {
      spaceId,
      authorId: access.userId,
      author: "user",
      kind: "text",
      text: cleaned,
      runId: null,
      fileId: null,
      createdAt: now,
    });
    await ctx.db.patch(access.space._id, { lastMessageAt: now, lastMessage: cleaned.slice(0, 120) });
    // Mentioning the agent hands it the message as a job; the reply is a run card in the chat.
    const jobId = mentionsAgent(cleaned) ? await createJob(ctx, access.space, access.userId, cleaned) : null;
    await ctx.db.patch(access.member._id, { lastReadAt: now });
    return { jobId };
  },
});
