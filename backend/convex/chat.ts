import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
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
    const out = [];
    for (const row of rows.reverse()) {
      const person = row.authorId ? people.get(row.authorId) : null;
      // A file line carries a fresh download link; a deleted file stays as its name.
      let file: { name: string; size: number; mime: string; url: string | null } | null = null;
      if (row.kind === "file" && row.fileId) {
        const doc = await ctx.db.get(row.fileId as Id<"spaceFiles">);
        if (doc) file = { name: doc.name, size: doc.size, mime: doc.mime, url: await ctx.storage.getUrl(doc.storageId) };
      }
      out.push({
        id: row._id,
        author: row.author,
        authorId: row.authorId,
        name: row.author === "agent" ? "okidoki" : row.author === "system" ? "" : (person?.name ?? "Someone"),
        colorHex: person?.colorHex ?? "",
        kind: row.kind,
        text: row.text,
        runId: row.runId,
        fileId: row.fileId,
        file,
        createdAt: row.createdAt,
        isYou: row.authorId === access.userId,
      });
    }
    return out;
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
