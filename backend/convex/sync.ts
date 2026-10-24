import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export const pushSnapshot = internalMutation({
  args: {
    accountId: v.string(),
    device: v.string(),
    state: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = args.state as Record<string, any>;

    for (const account of asArray(state.accounts)) {
      const existing = await ctx.db
        .query("accounts")
        .withIndex("by_client", (q) => q.eq("clientId", String(account.id)))
        .first();
      const document = {
        clientId: String(account.id),
        name: String(account.name ?? ""),
        email: String(account.email ?? ""),
        kind: String(account.kind ?? "personal"),
        colorHex: String(account.colorHex ?? "1FB57A"),
        createdAt: String(account.createdAt ?? new Date().toISOString()),
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("accounts", document);
    }

    const existingSettings = await ctx.db
      .query("settings")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (existingSettings) await ctx.db.patch(existingSettings._id, { data: state.settings, updatedAt: now });
    else await ctx.db.insert("settings", { accountId: args.accountId, data: state.settings, updatedAt: now });

    for (const thread of asArray(state.threads)) {
      const existing = await ctx.db
        .query("threads")
        .withIndex("by_client", (q) => q.eq("clientId", String(thread.id)))
        .first();
      const document = {
        clientId: String(thread.id),
        accountId: args.accountId,
        title: String(thread.title ?? "thread"),
        app: String(thread.app ?? "mac"),
        topic: String(thread.topic ?? ""),
        messages: thread.messages ?? [],
        archived: Boolean(thread.archived),
        createdAt: String(thread.createdAt ?? new Date().toISOString()),
        updatedAt: String(thread.updatedAt ?? new Date().toISOString()),
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("threads", document);
    }

    for (const memory of asArray(state.memories)) {
      const existing = await ctx.db
        .query("memories")
        .withIndex("by_client", (q) => q.eq("clientId", String(memory.id)))
        .first();
      const document = {
        clientId: String(memory.id),
        accountId: args.accountId,
        section: String(memory.section ?? "aboutYou"),
        text: String(memory.text ?? ""),
        source: String(memory.source ?? "you"),
        createdAt: String(memory.createdAt ?? new Date().toISOString()),
        updatedAt: String(memory.updatedAt ?? new Date().toISOString()),
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("memories", document);
    }

    for (const run of asArray(state.runs)) {
      const existing = await ctx.db
        .query("runs")
        .withIndex("by_client", (q) => q.eq("clientId", String(run.id)))
        .first();
      const document = {
        clientId: String(run.id),
        accountId: args.accountId,
        kind: String(run.kind ?? "answer"),
        title: String(run.title ?? "run"),
        prompt: String(run.prompt ?? ""),
        status: String(run.status ?? "done"),
        threadId: run.threadID ?? null,
        steps: run.steps ?? [],
        output: String(run.output ?? "").slice(-60_000),
        summary: String(run.summary ?? ""),
        agent: run.agent ?? null,
        workingDirectory: run.workingDirectory ?? null,
        createdAt: String(run.createdAt ?? new Date().toISOString()),
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        freedBytes: typeof run.freedBytes === "number" ? run.freedBytes : null,
        builtin: run.builtin ?? null,
        pickedPath: run.pickedPath ?? null,
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("runs", document);

      if (run.preview) {
        const existingPreview = await ctx.db
          .query("actionPreviews")
          .withIndex("by_run", (q) => q.eq("runId", String(run.id)))
          .first();
        if (existingPreview) await ctx.db.patch(existingPreview._id, { data: run.preview, updatedAt: now });
        else await ctx.db.insert("actionPreviews", { runId: String(run.id), accountId: args.accountId, data: run.preview, updatedAt: now });
      }
    }

    for (const skill of asArray(state.skills)) {
      const existing = await ctx.db
        .query("skills")
        .withIndex("by_client", (q) => q.eq("clientId", String(skill.id)))
        .first();
      const document = {
        clientId: String(skill.id),
        accountId: args.accountId,
        name: String(skill.name ?? "skill"),
        summary: String(skill.summary ?? ""),
        steps: skill.steps ?? [],
        source: String(skill.source ?? "watch me"),
        runCount: Number(skill.runCount ?? 0),
        createdAt: String(skill.createdAt ?? new Date().toISOString()),
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("skills", document);
    }

    for (const routine of asArray(state.routines)) {
      const existing = await ctx.db
        .query("routines")
        .withIndex("by_client", (q) => q.eq("clientId", String(routine.id)))
        .first();
      const document = {
        clientId: String(routine.id),
        accountId: args.accountId,
        name: String(routine.name ?? "routine"),
        prompt: String(routine.prompt ?? ""),
        cadence: String(routine.cadence ?? "weekly"),
        weekday: Number(routine.weekday ?? 6),
        hour: Number(routine.hour ?? 17),
        minute: Number(routine.minute ?? 0),
        enabled: Boolean(routine.enabled),
        createdAt: String(routine.createdAt ?? new Date().toISOString()),
        lastRunAt: routine.lastRunAt ?? null,
        nextRunAt: routine.nextRunAt ?? null,
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("routines", document);
    }

    for (const connector of asArray(state.connectors)) {
      const existing = await ctx.db
        .query("connectors")
        .withIndex("by_client", (q) => q.eq("clientId", String(connector.id)))
        .first();
      const document = {
        clientId: String(connector.id),
        name: String(connector.name ?? connector.id),
        kind: String(connector.kind ?? "other"),
        blurb: String(connector.blurb ?? ""),
        enabled: Boolean(connector.enabled),
        installed: Boolean(connector.installed),
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, document);
      else await ctx.db.insert("connectors", document);
    }

    const existingSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    const snapshotState = {
      ...state,
      runs: asArray(state.runs).map((run) => ({ ...run, output: String(run.output ?? "").slice(-40_000) })),
    };
    if (existingSnapshot) {
      await ctx.db.patch(existingSnapshot._id, { state: snapshotState, device: args.device, updatedAt: now });
    } else {
      await ctx.db.insert("snapshots", {
        accountId: args.accountId,
        device: args.device,
        state: snapshotState,
        updatedAt: now,
      });
    }

    return { ok: true, syncedAt: now };
  },
});

export const createShare = internalMutation({
  args: {
    token: v.string(),
    accountId: v.string(),
    accountName: v.string(),
    runId: v.string(),
    run: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { run: args.run, createdAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("shareLinks", {
      token: args.token,
      accountId: args.accountId,
      accountName: args.accountName,
      runId: args.runId,
      run: args.run,
      views: 0,
      createdAt: Date.now(),
    });
  },
});
