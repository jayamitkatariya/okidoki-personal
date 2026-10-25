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

  // One row per paired Mac. The Mac holds the token; the backend keeps only its SHA-256, and every
  // HTTP route resolves the token to the login that paired it before touching any account.
  deviceTokens: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    device: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    revokedAt: v.union(v.number(), v.null()),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_user", ["userId"]),

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
    // The account's sync version that last wrote this row, so a Mac can pull only what changed.
    syncVersion: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
    .index("by_client", ["clientId"]),

  memories: defineTable({
    clientId: v.string(),
    accountId: v.string(),
    section: v.string(),
    text: v.string(),
    source: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
    // The account's sync version that last wrote this row, so a Mac can pull only what changed.
    syncVersion: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
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
    // The Mac's own last-edit time (ISO), for merging the same item edited on two Macs.
    modifiedAt: v.optional(v.string()),
    // The account's sync version that last wrote this row, so a Mac can pull only what changed.
    syncVersion: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
    .index("by_client", ["clientId"])
    .index("by_status", ["accountId", "status"]),

  actionPreviews: defineTable({
    runId: v.string(),
    accountId: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_account", ["accountId"]),

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
    // The Mac's own last-edit time (ISO), for merging the same item edited on two Macs.
    modifiedAt: v.optional(v.string()),
    // The account's sync version that last wrote this row, so a Mac can pull only what changed.
    syncVersion: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
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
    // The Mac's own last-edit time (ISO), for merging the same item edited on two Macs.
    modifiedAt: v.optional(v.string()),
    // The account's sync version that last wrote this row, so a Mac can pull only what changed.
    syncVersion: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
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
    // When the Mac assembled this state. Used so an older sync that finishes late can't overwrite a newer one.
    sentAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One row per account: the newest sync the backend has accepted. Older syncs are rejected at the door.
  syncs: defineTable({
    accountId: v.string(),
    sentAt: v.number(),
    device: v.string(),
    startedAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
    // Goes up by one with every accepted sync. A Mac pushes on top of the version it last pulled;
    // anything else is refused so it pulls and merges first.
    version: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // Items a sync removed, so other Macs on the same account remove them too instead of pushing them back.
  deletions: defineTable({
    accountId: v.string(),
    table: v.string(),
    clientId: v.string(),
    syncVersion: v.number(),
    deletedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_account_version", ["accountId", "syncVersion"])
    .index("by_client", ["clientId"]),

  shareLinks: defineTable({
    token: v.string(),
    accountId: v.string(),
    accountName: v.string(),
    runId: v.string(),
    run: v.any(),
    views: v.number(),
    createdAt: v.number(),
    // Views are counted at most once every few seconds, so a reload loop can't hammer the row.
    lastViewedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_account", ["accountId"])
    .index("by_run", ["runId"]),

  // Enterprise: a company. Work accounts link to it through a membership of the signed-in login.
  organizations: defineTable({
    name: v.string(),
    // Lowercase email domain, or "" when the org doesn't take domain join requests.
    domain: v.string(),
    plan: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    // What a new member's Mac says the first time it links: an admin's note on where to start.
    welcome: v.optional(v.string()),
  }).index("by_domain", ["domain"]),

  // One row per login per organization. `accountClientId` is the Mac work account this membership is linked to.
  memberships: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: v.string(), // owner · admin · member · agent
    status: v.string(), // active · pending
    accountClientId: v.union(v.string(), v.null()),
    joinedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_user", ["userId"])
    .index("by_account", ["accountClientId"]),

  // A space: a group inside an organization with a chat, shared files, skills and a worker.
  spaces: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    colorHex: v.string(),
    // Which Mac runs the space's jobs: "thisMac" (whoever accepts), "privateMac", "hostedVM".
    workerPolicy: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    lastMessage: v.string(),
  }).index("by_org", ["orgId"]),

  spaceMembers: defineTable({
    spaceId: v.id("spaces"),
    userId: v.id("users"),
    role: v.string(), // owner · member
    lastReadAt: v.number(),
    joinedAt: v.number(),
  })
    .index("by_space", ["spaceId"])
    .index("by_space_user", ["spaceId", "userId"])
    .index("by_user", ["userId"]),

  spaceMessages: defineTable({
    spaceId: v.id("spaces"),
    // Who wrote it: a user id, or null for the agent and system lines.
    authorId: v.union(v.id("users"), v.null()),
    author: v.string(), // user · agent · system
    kind: v.string(), // text · run · file · approval · system
    text: v.string(),
    runId: v.union(v.string(), v.null()),
    fileId: v.union(v.string(), v.null()),
    createdAt: v.number(),
  }).index("by_space_time", ["spaceId", "createdAt"]),

  // Work handed to the agent in a space. A member's Mac (the worker) accepts it and runs it as an ordinary run.
  spaceRuns: defineTable({
    spaceId: v.id("spaces"),
    orgId: v.id("organizations"),
    requestedBy: v.id("users"),
    prompt: v.string(),
    // queued · accepted · running · waiting · done · failed · cancelled
    status: v.string(),
    // "" · approve · decline — the chat's answer to a run that's waiting for approval.
    decision: v.string(),
    workerAccountId: v.union(v.string(), v.null()),
    workerDevice: v.string(),
    workerName: v.string(),
    runClientId: v.union(v.string(), v.null()),
    title: v.string(),
    summary: v.string(),
    output: v.string(),
    steps: v.any(),
    preview: v.any(),
    messageId: v.union(v.id("spaceMessages"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.union(v.number(), v.null()),
    endedAt: v.union(v.number(), v.null()),
  })
    .index("by_space", ["spaceId", "createdAt"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_status", ["status", "updatedAt"])
    .index("by_worker", ["workerAccountId", "status"]),

  // One row per Mac work account that accepts jobs. `lastSeenAt` is its heartbeat.
  workers: defineTable({
    accountClientId: v.string(),
    userId: v.id("users"),
    orgId: v.id("organizations"),
    device: v.string(),
    kind: v.string(), // thisMac · privateMac
    enabled: v.boolean(),
    // off · paused (the Mac is on a personal account right now) · ready. Missing on rows from older builds.
    state: v.optional(v.string()),
    lastSeenAt: v.number(),
  })
    .index("by_account", ["accountClientId"])
    .index("by_org", ["orgId"]),

  // A skill published to a space or to the whole organization. Members pull it onto their Macs to replay it.
  spaceSkills: defineTable({
    orgId: v.id("organizations"),
    spaceId: v.union(v.id("spaces"), v.null()),
    // The Mac skill it was published from, so republishing bumps the version instead of duplicating.
    sourceSkillId: v.string(),
    name: v.string(),
    summary: v.string(),
    steps: v.any(),
    // Apps the recording touched, so a colleague sees what they need before replaying.
    requires: v.array(v.string()),
    publishedBy: v.id("users"),
    version: v.number(),
    runCount: v.number(),
    // Earlier versions' steps, newest first, capped.
    history: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_space", ["spaceId"])
    .index("by_source", ["sourceSkillId"]),

  // Confidential documents, kept in Convex file storage. A file belongs to a space or to the whole organization.
  spaceFiles: defineTable({
    orgId: v.id("organizations"),
    spaceId: v.union(v.id("spaces"), v.null()),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    mime: v.string(),
    uploadedBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_space", ["spaceId"]),

  // Logins for sites and tools. The secret is encrypted in the browser with the organization's
  // vault passphrase before it's sent; the backend only ever holds ciphertext.
  spaceCredentials: defineTable({
    orgId: v.id("organizations"),
    spaceId: v.union(v.id("spaces"), v.null()),
    site: v.string(),
    username: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    keyVersion: v.number(),
    note: v.string(),
    createdBy: v.id("users"),
    lastUsedAt: v.union(v.number(), v.null()),
    lastUsedBy: v.union(v.id("users"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_space", ["spaceId"]),

  joinCodes: defineTable({
    code: v.string(),
    orgId: v.id("organizations"),
    spaceId: v.union(v.string(), v.null()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
    uses: v.number(),
    maxUses: v.number(),
    revoked: v.boolean(),
  })
    .index("by_code", ["code"])
    .index("by_org", ["orgId"]),
});
