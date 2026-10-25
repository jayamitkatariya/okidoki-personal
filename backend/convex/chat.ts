import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { createJob, mentionsAgent } from "./jobs";
import { memberCount, peopleIn, requireSpaceMember, spaceAccess } from "./spaces";

// The group chat inside a space. Members read and write; the agent and system lines have no author.

export const PAGE = 200;

// The newest page by default; `before` (a createdAt) asks for the page that ends there, inclusive,
// so a page boundary never loses a line — the panel drops the duplicate by id.
export const messages = query({
  args: { spaceId: v.id("spaces"), before: v.optional(v.number()) },
  handler: async (ctx, { spaceId, before }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member) return [];
    const people = await peopleIn(ctx, access.space.orgId);
    const rows = await ctx.db
      .query("spaceMessages")
      .withIndex("by_space_time", (q) => (before === undefined ? q.eq("spaceId", spaceId) : q.eq("spaceId", spaceId).lte("createdAt", before)))
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

/**
 * A member's line in the chat. Mentioning the agent hands it the message as a job; the reply is a run
 * card. Alone in a space there's nobody else to talk to, so every line goes to the agent.
 */
export async function postMessage(ctx: MutationCtx, space: Doc<"spaces">, member: Doc<"spaceMembers">, text: string) {
  const cleaned = text.trim().slice(0, 4000);
  if (!cleaned) return { jobId: null };
  const now = Date.now();
  await ctx.db.insert("spaceMessages", {
    spaceId: space._id,
    authorId: member.userId,
    author: "user",
    kind: "text",
    text: cleaned,
    runId: null,
    fileId: null,
    createdAt: now,
  });
  await ctx.db.patch(space._id, { lastMessageAt: now, lastMessage: cleaned.slice(0, 120) });
  const solo = (await memberCount(ctx, space._id)) === 1;
  const jobId = mentionsAgent(cleaned) || solo ? await createJob(ctx, space, member.userId, cleaned) : null;
  // The run card for your own ask lands a tick later; it isn't unread to you.
  await ctx.db.patch(member._id, { lastReadAt: jobId ? now + 1 : now });
  return { jobId };
}

export const send = mutation({
  args: { spaceId: v.id("spaces"), text: v.string() },
  handler: async (ctx, { spaceId, text }) => {
    const access = await requireSpaceMember(ctx, spaceId);
    return postMessage(ctx, access.space, access.member, text);
  },
});
