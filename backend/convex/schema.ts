import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  // Convex Auth: users, sessions, sign-in accounts, refresh tokens.
  ...authTables,

  // okidoki accounts (Personal, Work…), owned by the signed-in user who claimed them.
  accounts: defineTable({
    clientId: v.string(),
    name: v.string(),
    email: v.string(),
    kind: v.string(),
    colorHex: v.string(),
    createdAt: v.string(),
    updatedAt: v.number(),
    ownerId: v.optional(v.id("users")),
  })
    .index("by_client", ["clientId"])
    .index("by_owner", ["ownerId"]),

  settings: defineTable({
    accountId: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  threads: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    title: v.string(),
    app: v.string(),
    topic: v.string(),
    messages: v.any(),
    archived: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_account", ["accountId"])
    .index("by_client", ["clientId"]),

  memories: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    section: v.string(),
    text: v.string(),
    source: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_account", ["accountId"])
    .index("by_client", ["clientId"]),

  runs: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    kind: v.string(),
    title: v.string(),
    prompt: v.string(),
    status: v.string(),
    threadId: v.union(v.string(), v.null()),
    steps: v.any(),
    output: v.string(),
    summary: v.string(),
    agent: v.union(v.string(), v.null()),
    workingDirectory: v.union(v.string(), v.null()),
    createdAt: v.string(),
    startedAt: v.union(v.string(), v.null()),
    endedAt: v.union(v.string(), v.null()),
    freedBytes: v.union(v.number(), v.null()),
    builtin: v.union(v.string(), v.null()),
    pickedPath: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_client", ["clientId"])
    .index("by_status", ["accountId", "status"]),

  actionPreviews: defineTable({
    runId: v.string(),
    accountId: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  }).index("by_run", ["runId"]),

  skills: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    name: v.string(),
    summary: v.string(),
    steps: v.any(),
    source: v.string(),
    runCount: v.number(),
    createdAt: v.string(),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_client", ["clientId"]),

  routines: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    name: v.string(),
    prompt: v.string(),
    cadence: v.string(),
    weekday: v.number(),
    hour: v.number(),
    minute: v.number(),
    enabled: v.boolean(),
    createdAt: v.string(),
    lastRunAt: v.union(v.string(), v.null()),
    nextRunAt: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_client", ["clientId"]),

  connectors: defineTable({
    clientId: v.string(),
    name: v.string(),
    kind: v.string(),
    blurb: v.string(),
    enabled: v.boolean(),
    installed: v.boolean(),
    updatedAt: v.number(),
  }).index("by_client", ["clientId"]),

  snapshots: defineTable({
    accountId: v.string(),
    device: v.string(),
    state: v.any(),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  shareLinks: defineTable({
    token: v.string(),
    accountId: v.string(),
    accountName: v.string(),
    runId: v.string(),
    run: v.any(),
    views: v.number(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_account", ["accountId"])
    .index("by_run", ["runId"]),
});
