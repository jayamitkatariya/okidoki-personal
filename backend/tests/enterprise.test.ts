import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Functions run against an in-memory Convex with a mocked login. A login is a row in `users`
// plus an identity whose subject is "<userId>|<sessionId>", which is what Convex Auth reads.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;

// Unread counts compare timestamps, so let the clock move between messages.
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function setup() {
  const t = convexTest(schema, modules);
  const people: Record<string, { as: ReturnType<typeof t.withIdentity>; accountId: string; token: string }> = {};
  const login = async (name: string, email: string) => {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name, email }));
    const as = t.withIdentity({ subject: `${userId}|session-${name}` });
    const accountId = `acct-${name}`;
    // Each Mac work account is claimed by its login and the Mac paired, exactly as the panel does after sign-in.
    await as.mutation(api.accounts.claim, { accounts: [{ id: accountId, name, email, kind: "work", colorHex: "44E45E", createdAt: "2026-10-24" }] });
    const { token } = await as.action(api.devices.pair, { device: `${name}'s Mac` });
    people[name] = { as, accountId, token };
    return people[name];
  };
  // The Mac's HTTP calls, each sent with the token of the login that owns the account it names.
  const tokenFor = (accountId: unknown) => Object.values(people).find((person) => person.accountId === accountId)?.token ?? "okd_nobody-has-this-token-at-all-0000000000000";
  const post = (path: string, body: unknown, token = tokenFor((body as { accountId?: unknown })?.accountId)) =>
    t.fetch(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const postJSON = (path: string, body: unknown) => post(path, body).then((r) => r.json());
  const postStatus = (path: string, body: unknown) => post(path, body).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  return { t, login, people, tokenFor, post, postJSON, postStatus };
}

describe("organizations", () => {
  test("creating an organization makes the creator its owner and links the work account", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "acme.com", accountId: jay.accountId });
    const view = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(view.org.name).toBe("Acme");
    expect(view.role).toBe("owner");
    expect(view.members.map((m: any) => [m.name, m.role, m.isYou])).toEqual([["jay", "owner", true]]);
  });

  test("a join code brings a colleague in as a member, counts its use, and stops when spent", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    const pat = await login("pat", "pat@elsewhere.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 1 });
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    const joined = await sam.as.mutation(api.orgs.join, { code: code.toLowerCase(), accountId: sam.accountId });
    expect(joined.name).toBe("Acme");
    const samView = await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId });
    expect(samView.role).toBe("member");
    // members don't see join codes or requests
    expect(samView.codes).toEqual([]);

    await expect(pat.as.mutation(api.orgs.join, { code, accountId: pat.accountId })).rejects.toThrow(/isn't valid/);
    const jayView = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(jayView.codes).toEqual([]);
    expect(jayView.members.map((m: any) => m.name)).toEqual(["jay", "sam"]);
  });

  test("domain requests wait for an admin; the last owner can't leave or be demoted", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "Acme.com", accountId: jay.accountId });
    expect((await sam.as.query(api.orgs.byMyDomain, {})).name).toBe("Acme");
    const request = await sam.as.mutation(api.orgs.requestByDomain, { accountId: sam.accountId });
    expect(request.status).toBe("pending");
    expect(await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId })).toBeNull();

    const jayView = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(jayView.pending.map((m: any) => m.email)).toEqual(["sam@acme.com"]);
    await jay.as.mutation(api.orgs.approve, { membershipId: jayView.pending[0].id });
    expect((await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId })).role).toBe("member");

    const mine = jayView.members.find((m: any) => m.isYou);
    await expect(jay.as.mutation(api.orgs.setRole, { membershipId: mine.id, role: "member" })).rejects.toThrow(/at least one owner/);
    await expect(jay.as.mutation(api.orgs.leave, { orgId: jayView.org.id })).rejects.toThrow(/someone else an owner/);

    // a member can't manage people
    await expect(sam.as.mutation(api.orgs.createCode, { orgId: jayView.org.id, days: 1, maxUses: 1 })).rejects.toThrow(/owner or admin/);
  });

  test("nobody can link an account their login doesn't own", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    await expect(sam.as.mutation(api.orgs.link, { orgId, accountId: jay.accountId })).rejects.toThrow(/isn't linked to this login/);
    expect(await sam.as.query(api.orgs.forAccount, { accountId: jay.accountId })).toBeNull();
  });
});

describe("agent jobs and the worker", () => {
  async function team() {
    const { t, login, postJSON: post } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Ops" });
    await sam.as.mutation(api.spaces.join, { spaceId });
    await tick();
    return { t, jay, sam, spaceId, post };
  }

  test("mentioning @okidoki queues a job with a run card; a member's Mac accepts and reports it", async () => {
    const { jay, sam, spaceId, post } = await team();
    const sent = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki compress the launch video for Discord" });
    expect(sent.jobId).toBeTruthy();
    const messages = await jay.as.query(api.chat.messages, { spaceId });
    expect(messages.map((m: any) => [m.author, m.kind])).toEqual([
      ["system", "system"],
      ["system", "system"],
      ["system", "system"],
      ["user", "text"],
      ["agent", "run"],
    ]);
    let jobs = await jay.as.query(api.jobs.forSpace, { spaceId });
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].prompt).toBe("compress the launch video for Discord");

    // Sam's Mac polls: it's a member, so it sees the job; the heartbeat registers it as a worker.
    const polled = await post("/api/worker/poll", { accountId: sam.accountId, device: "Sam's MacBook", kind: "thisMac", enabled: true });
    expect(polled.ok).toBe(true);
    expect(polled.jobs.map((j: any) => j.spaceName)).toEqual(["Ops"]);
    const workers = await jay.as.query(api.jobs.workersFor, { accountId: jay.accountId });
    expect(workers.map((w: any) => [w.name, w.online])).toEqual([["sam", true]]);

    const accepted = await post("/api/worker/accept", { accountId: sam.accountId, jobId: sent.jobId, device: "Sam's MacBook" });
    expect(accepted.job.prompt).toBe("compress the launch video for Discord");
    // second taker loses
    const again = await post("/api/worker/accept", { accountId: jay.accountId, jobId: sent.jobId, device: "Jay's Mac" });
    expect(again.job).toBeNull();

    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "running", runClientId: "run-1", title: "Compress video", steps: [{ title: "ffmpeg" }] });
    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "done", summary: "Saved launch-discord.mp4 (7.9 MB)", say: "Done: launch-discord.mp4 is 7.9 MB." });
    jobs = await jay.as.query(api.jobs.forSpace, { spaceId });
    expect([jobs[0].status, jobs[0].workerName, jobs[0].summary]).toEqual(["done", "sam", "Saved launch-discord.mp4 (7.9 MB)"]);
    const lines = (await jay.as.query(api.chat.messages, { spaceId })).filter((m: any) => m.author === "agent" && m.kind === "text").map((m: any) => m.text);
    expect(lines[0]).toMatch(/running on sam's Mac/);
    expect(lines[1]).toBe("Done: launch-discord.mp4 is 7.9 MB.");

    // a finished job ignores late updates, and a stranger's "update" does nothing
    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "failed" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId: sent.jobId, status: "failed" });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("done");
  });

  test("approvals flow through the chat, and the wrong kind of worker is skipped", async () => {
    const { t, jay, sam, spaceId, post } = await team();
    const { jobId } = await sam.as.mutation(api.chat.send, { spaceId, text: "hey @okidoki, clean up my mac" });
    await post("/api/worker/accept", { accountId: jay.accountId, jobId, device: "Jay's Mac" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "waiting", preview: { summary: "Empty caches", risk: "medium" } });
    await expect(sam.as.mutation(api.jobs.decide, { jobId, decision: "maybe" })).rejects.toThrow(/unknown decision/);
    await sam.as.mutation(api.jobs.decide, { jobId, decision: "approve" });
    const polled = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true });
    expect(polled.held).toEqual([{ id: jobId, status: "waiting", decision: "approve", runClientId: null }]);
    // a second wait asks again
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "running" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "waiting" });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].decision).toBe("");

    // a private-Mac space only hands jobs to private-Mac workers
    await jay.as.mutation(api.spaces.update, { spaceId, workerPolicy: "privateMac" });
    await sam.as.mutation(api.chat.send, { spaceId, text: "@okidoki export the deck as PDF" });
    const plain = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true });
    expect(plain.jobs).toEqual([]);
    const vm = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "privateMac", enabled: true });
    expect(vm.jobs.map((j: any) => j.prompt)).toEqual(["export the deck as PDF"]);

    // a worker that switched itself off drops out of the online list and gets no jobs
    const off = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: false });
    expect(off.jobs).toEqual([]);
    expect((await sam.as.query(api.jobs.workersFor, { accountId: sam.accountId })).find((w: any) => w.name === "jay").online).toBe(false);

    // an unpaired Mac is refused at the door; a paired one naming a colleague's account is refused too
    const stranger = await post("/api/worker/poll", { accountId: "acct-nobody", device: "x", kind: "thisMac", enabled: true });
    expect(stranger.error).toBe("unauthorized");
    const borrowed = await t.fetch("/api/worker/poll", { method: "POST", headers: { authorization: `Bearer ${sam.token}`, "content-type": "application/json" }, body: JSON.stringify({ accountId: jay.accountId, device: "x", kind: "thisMac", enabled: true }) });
    expect(borrowed.status).toBe(403);
    const unauthorized = await (await import("convex-test")).convexTest(schema, modules).fetch("/api/worker/poll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
  });

  test("cancelling a queued job ends it; cancelling a held one tells the worker to stop", async () => {
    const { jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki zip the reports folder" });
    await sam.as.mutation(api.jobs.cancel, { jobId });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("cancelled");
    expect((await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true })).jobs).toEqual([]);

    const { jobId: second } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki zip it again" });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId: second, device: "m" });
    await jay.as.mutation(api.jobs.cancel, { jobId: second });
    const polled = await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true });
    expect(polled.held[0]).toMatchObject({ id: second, status: "accepted", decision: "decline" });
  });

  test("alone in a space every line is for the agent; once a colleague joins it has to be asked", async () => {
    const { login, postJSON: post } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Just me" });

    const solo = await jay.as.mutation(api.chat.send, { spaceId, text: "tidy my downloads folder" });
    expect(solo.jobId).toBeTruthy();
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].prompt).toBe("tidy my downloads folder");

    // jay's own Mac takes it: a one-person team still works end to end
    const polled = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true, state: "ready" });
    expect(polled.jobs.map((j: any) => j.id)).toEqual([solo.jobId]);
    await post("/api/worker/accept", { accountId: jay.accountId, jobId: solo.jobId, device: "Jay's Mac" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId: solo.jobId, status: "done", say: "Moved 14 files into folders." });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("done");

    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    await sam.as.mutation(api.spaces.join, { spaceId });
    const texts = (await jay.as.query(api.chat.messages, { spaceId })).map((m: any) => m.text);
    expect(texts.at(-1)).toBe("With two of you here, mention @okidoki to give it work.");
    const chat = await jay.as.mutation(api.chat.send, { spaceId, text: "morning sam" });
    expect(chat.jobId).toBeNull();
    const asked = await sam.as.mutation(api.chat.send, { spaceId, text: "@okidoki summarise the thread" });
    expect(asked.jobId).toBeTruthy();
  });

  test("a paused Mac keeps its held job but takes nothing new; the chat sees who's ready", async () => {
    const { jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki rename the screenshots" });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "Sam's MacBook" });
    await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki and empty the trash" });

    const paused = await post("/api/worker/poll", { accountId: sam.accountId, device: "Sam's MacBook", kind: "thisMac", enabled: true, state: "paused" });
    expect(paused.jobs).toEqual([]);
    expect(paused.held.map((h: any) => h.id)).toEqual([jobId]);
    let workers = await jay.as.query(api.jobs.workersFor, { accountId: jay.accountId });
    expect(workers.map((w: any) => [w.name, w.online, w.state])).toEqual([["sam", true, "paused"]]);

    const ready = await post("/api/worker/poll", { accountId: sam.accountId, device: "Sam's MacBook", kind: "thisMac", enabled: true, state: "ready" });
    expect(ready.jobs.map((j: any) => j.prompt)).toEqual(["and empty the trash"]);
    workers = await jay.as.query(api.jobs.workersFor, { accountId: jay.accountId });
    expect(workers[0].state).toBe("ready");
  });

  test("a job whose Mac went quiet is failed by the reaper, or ended at once when cancelled", async () => {
    const { t, jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki build the release" });
    await post("/api/worker/poll", { accountId: sam.accountId, device: "Sam's MacBook", kind: "thisMac", enabled: true });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "Sam's MacBook" });
    await post("/api/worker/update", { accountId: sam.accountId, jobId, status: "running" });

    // still heard from: nothing happens
    expect(await t.mutation(internal.jobs.reapLost, {})).toEqual({ reaped: 0 });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("running");

    // three minutes of silence from Sam's Mac
    await t.run(async (ctx) => {
      const worker = await ctx.db
        .query("workers")
        .withIndex("by_account", (q) => q.eq("accountClientId", sam.accountId))
        .first();
      await ctx.db.patch(worker!._id, { lastSeenAt: Date.now() - 3 * 60_000 });
    });
    expect(await t.mutation(internal.jobs.reapLost, {})).toEqual({ reaped: 1 });
    const job = (await jay.as.query(api.jobs.forSpace, { spaceId }))[0];
    expect(job.status).toBe("failed");
    const last = (await jay.as.query(api.chat.messages, { spaceId })).at(-1);
    expect(last.text).toMatch(/Lost contact with sam's Mac/);

    // cancelling one held by a quiet Mac doesn't wait for it
    const { jobId: second } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki build it again" });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId: second, device: "Sam's MacBook" });
    await t.run(async (ctx) => {
      const worker = await ctx.db
        .query("workers")
        .withIndex("by_account", (q) => q.eq("accountClientId", sam.accountId))
        .first();
      await ctx.db.patch(worker!._id, { lastSeenAt: Date.now() - 3 * 60_000 });
    });
    await jay.as.mutation(api.jobs.cancel, { jobId: second });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("cancelled");
  });

  test("a job that stops reporting is reaped even while its Mac keeps heart-beating; a cancel the Mac ignores closes on its own", async () => {
    const { t, jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki reconcile the ledger" });
    await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "m" });
    await post("/api/worker/update", { accountId: sam.accountId, jobId, status: "running" });

    // the run hung in place half an hour ago; the Mac itself is fine
    await t.run(async (ctx) => ctx.db.patch(jobId, { updatedAt: Date.now() - 31 * 60_000 }));
    await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true });
    expect(await t.mutation(internal.jobs.reapLost, {})).toEqual({ reaped: 1 });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("failed");

    // cancelled, but the Mac never confirms: closed after the grace period
    const { jobId: second } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki once more" });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId: second, device: "m" });
    await jay.as.mutation(api.jobs.cancel, { jobId: second });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0]).toMatchObject({ status: "accepted", decision: "decline" });
    expect(await t.mutation(internal.jobs.reapLost, {})).toEqual({ reaped: 0 });
    await t.run(async (ctx) => ctx.db.patch(second, { updatedAt: Date.now() - 3 * 60_000 }));
    expect(await t.mutation(internal.jobs.reapLost, {})).toEqual({ reaped: 1 });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("failed");
  });

  test("a repeated 'waiting' update keeps an answer given in between; a removed member's Mac is no longer heard", async () => {
    const { t, jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki ship it" });
    await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "m" });
    await post("/api/worker/update", { accountId: sam.accountId, jobId, status: "waiting", preview: { summary: "git push", risk: "medium" } });
    await jay.as.mutation(api.jobs.decide, { jobId, decision: "approve" });
    // the Mac's first reply was lost and it sends the same update again
    await post("/api/worker/update", { accountId: sam.accountId, jobId, status: "waiting", preview: { summary: "git push", risk: "medium" } });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].decision).toBe("approve");

    // jay removes sam; sam's Mac can't write into the space any more, and sam is out of its spaces
    const view = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    await jay.as.mutation(api.orgs.remove, { membershipId: view.members.find((m: any) => m.name === "sam").id });
    expect(await post("/api/worker/update", { accountId: sam.accountId, jobId, status: "done", say: "pushed" })).toEqual({ ok: false });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("waiting");
    const members = await t.run(async (ctx) => ctx.db.query("spaceMembers").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect());
    expect(members.map((m: any) => m.userId)).not.toContain(view.members.find((m: any) => m.name === "sam").userId);
    expect(await t.run(async (ctx) => ctx.db.query("workers").withIndex("by_account", (q) => q.eq("accountClientId", sam.accountId)).first())).toBeNull();
    // the panel's worker list names nobody's account id
    expect(Object.keys((await jay.as.query(api.jobs.workersFor, { accountId: jay.accountId }))[0] ?? {})).not.toContain("accountId");
  });
});

describe("deleting a space", () => {
  test("takes its chat, jobs, files, logins and skills with it, and the creator may do it after the first batch", async () => {
    const { t, login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });

    // sam, a plain member, owns this space and fills it
    const { spaceId } = await sam.as.mutation(api.spaces.create, { accountId: sam.accountId, name: "Scratch" });
    await sam.as.mutation(api.chat.send, { spaceId, text: "@okidoki do a thing" });
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["bytes"], { type: "text/plain" })));
    await sam.as.mutation(api.vault.saveFile, { accountId: sam.accountId, spaceId, storageId, name: "notes.txt", size: 5, mime: "text/plain" });
    await sam.as.mutation(api.vault.saveCredential, { accountId: sam.accountId, spaceId, site: "x.com", username: "u", ciphertext: "c", iv: "i", keyVersion: 1, note: "" });
    await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "sk1", name: "Thing", summary: "", steps: [{ id: "s1", text: "Open Notes", app: "Notes", action: "click", label: "Notes" }] } });
    // a long chat, so deletion needs more than one call
    await t.run(async (ctx) => {
      for (let index = 0; index < 520; index += 1) {
        await ctx.db.insert("spaceMessages", { spaceId: spaceId as any, authorId: null, author: "system", kind: "system", text: `line ${index}`, runId: null, fileId: null, createdAt: index });
      }
    });

    let result = await sam.as.mutation(api.spaces.remove, { spaceId });
    expect(result.done).toBe(false);
    // sam's member row may already be gone, but sam made the space, so the next batch is still allowed
    for (let round = 0; round < 5 && !result.done; round += 1) result = await sam.as.mutation(api.spaces.remove, { spaceId });
    expect(result.done).toBe(true);

    const counts = await t.run(async (ctx) => ({
      space: await ctx.db.get(spaceId as any),
      messages: (await ctx.db.query("spaceMessages").withIndex("by_space_time", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      jobs: (await ctx.db.query("spaceRuns").withIndex("by_space", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      files: (await ctx.db.query("spaceFiles").withIndex("by_space", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      credentials: (await ctx.db.query("spaceCredentials").withIndex("by_space", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      skills: (await ctx.db.query("spaceSkills").withIndex("by_space", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      members: (await ctx.db.query("spaceMembers").withIndex("by_space", (q) => q.eq("spaceId", spaceId as any)).collect()).length,
      blob: await ctx.storage.getUrl(storageId),
    }));
    expect(counts).toEqual({ space: null, messages: 0, jobs: 0, files: 0, credentials: 0, skills: 0, members: 0, blob: null });
  });
});

describe("shared skills", () => {
  const steps = [
    { id: "s1", text: "Open Numbers", app: "Numbers", action: "click", label: "Numbers" },
    { id: "s2", text: "Type the client", app: "Numbers", action: "type", input: "{{client name}}" },
    { id: "s3", text: "Save", app: "Numbers", action: "key", input: "cmd+s" },
    { id: "s4", text: "Switch to Mail", app: "Mail", action: "switch" },
  ];

  async function org() {
    const { t, login, postJSON: post } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    return { t, jay, sam, spaceId, post };
  }

  test("publishing lists the apps it needs and its parameters; republishing bumps the version and keeps history", async () => {
    const { jay, sam, spaceId } = await org();
    const first = await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId: null, skill: { id: "skill-1", name: "Invoice flow", summary: "Bills a client", steps } });
    expect(first.version).toBe(1);
    let shared = await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: "Invoice flow", publishedBy: "sam", requires: ["Mail", "Numbers"], params: ["client name"], stepCount: 4, spaceName: "", isMine: false, canUnpublish: true });

    const second = await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId: null, skill: { id: "skill-1", name: "Invoice flow v2", summary: "", steps: steps.slice(0, 2) } });
    expect(second.version).toBe(2);
    shared = await sam.as.query(api.sharedSkills.list, { accountId: sam.accountId });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: "Invoice flow v2", version: 2, versions: 2, stepCount: 2, isMine: true });

    await sam.as.mutation(api.sharedSkills.rollback, { sharedId: shared[0].id });
    shared = await sam.as.query(api.sharedSkills.list, { accountId: sam.accountId });
    expect(shared[0]).toMatchObject({ version: 3, stepCount: 4, requires: ["Mail", "Numbers"] });
  });

  test("space skills need membership; a plain member can't unpublish someone else's, an admin can", async () => {
    const { jay, sam, spaceId, post } = await org();
    await expect(sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "Close the books", summary: "", steps } })).rejects.toThrow(/join the space/);
    await sam.as.mutation(api.spaces.join, { spaceId });
    await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "Close the books", summary: "", steps } });
    const listed = await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId });
    expect(listed[0]).toMatchObject({ spaceName: "Finance", canUnpublish: true });
    await jay.as.mutation(api.sharedSkills.recordRun, { sharedId: listed[0].id });
    expect((await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId }))[0].runCount).toBe(1);

    // the worker gets the space's skills along with its job
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki replay close the books" });
    const accepted = await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "m" });
    expect(accepted.job.sharedSkills.map((s: any) => [s.name, s.steps.length, s.version])).toEqual([["Close the books", 4, 1]]);

    await expect(sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "x", summary: "", steps: [] } })).rejects.toThrow(/no steps/);
    await jay.as.mutation(api.sharedSkills.unpublish, { sharedId: listed[0].id });
    expect(await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId })).toEqual([]);
  });

  test("a skill shared with one space is invisible to colleagues outside it", async () => {
    const { t, jay, sam, spaceId, post } = await org();
    const pat = await (async () => {
      const userId = await t.run(async (ctx) => ctx.db.insert("users", { name: "pat", email: "pat@acme.com" }));
      const as = t.withIdentity({ subject: `${userId}|session-pat` });
      await as.mutation(api.accounts.claim, { accounts: [{ id: "acct-pat", name: "pat", email: "pat@acme.com", kind: "work", colorHex: "44E45E", createdAt: "2026-10-24" }] });
      const { token } = await as.action(api.devices.pair, { device: "pat's Mac" });
      return { as, accountId: "acct-pat", token };
    })();
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 1, maxUses: 1 });
    await pat.as.mutation(api.orgs.join, { code, accountId: pat.accountId });

    await sam.as.mutation(api.spaces.join, { spaceId });
    const { id } = await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-3", name: "Wire the payroll", summary: "", steps } });
    await jay.as.mutation(api.sharedSkills.publish, { accountId: jay.accountId, spaceId: null, skill: { id: "skill-4", name: "Everyone's", summary: "", steps } });

    // pat is in the organization but not in Finance
    expect((await pat.as.query(api.sharedSkills.list, { accountId: pat.accountId })).map((s: any) => s.name)).toEqual(["Everyone's"]);
    expect((await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId })).map((s: any) => s.name)).toEqual(["Everyone's", "Wire the payroll"]);
    await pat.as.mutation(api.sharedSkills.recordRun, { sharedId: id });
    expect((await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId })).find((s: any) => s.id === id).runCount).toBe(0);
    const pulled = await t.fetch("/api/enterprise/skill", { method: "POST", headers: { authorization: `Bearer ${pat.token}`, "content-type": "application/json" }, body: JSON.stringify({ accountId: pat.accountId, sharedId: id }) });
    expect(await pulled.json()).toEqual({ skill: null });
    void post;
  });
});

describe("vault", () => {
  async function org() {
    const { t, login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    const pat = await login("pat", "pat@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    await pat.as.mutation(api.orgs.join, { code, accountId: pat.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    await sam.as.mutation(api.spaces.join, { spaceId });
    return { t, jay, sam, pat, spaceId };
  }

  test("documents scoped to a space are seen by its members only; org-wide ones by everyone", async () => {
    const { t, jay, sam, pat, spaceId } = await org();
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["q3 numbers"], { type: "text/plain" })));
    await jay.as.mutation(api.vault.saveFile, { accountId: jay.accountId, spaceId, storageId, name: "Q3.csv", size: 10, mime: "text/csv" });
    await tick();
    const wide = await t.run(async (ctx) => ctx.storage.store(new Blob(["handbook"], { type: "text/plain" })));
    await sam.as.mutation(api.vault.saveFile, { accountId: sam.accountId, spaceId: null, storageId: wide, name: "Handbook.pdf", size: 8, mime: "application/pdf" });

    expect((await sam.as.query(api.vault.files, { accountId: sam.accountId })).map((f: any) => [f.name, f.spaceName, f.canDelete])).toEqual([
      ["Handbook.pdf", "", true],
      ["Q3.csv", "Finance", false],
    ]);
    expect((await pat.as.query(api.vault.files, { accountId: pat.accountId })).map((f: any) => f.name)).toEqual(["Handbook.pdf"]);
    const files = await jay.as.query(api.vault.files, { accountId: jay.accountId });
    expect(files.every((f: any) => typeof f.url === "string")).toBe(true);

    // sharing into the chat produces a file line with a link; a stranger to the space can't
    const q3 = files.find((f: any) => f.name === "Q3.csv");
    await expect(pat.as.mutation(api.vault.shareFile, { fileId: q3.id, spaceId })).rejects.toThrow(/join the space/);
    await sam.as.mutation(api.vault.shareFile, { fileId: q3.id, spaceId });
    const last = (await jay.as.query(api.chat.messages, { spaceId })).at(-1);
    expect([last.kind, last.text, last.file.name, typeof last.file.url]).toEqual(["file", "Q3.csv", "Q3.csv", "string"]);

    // a plain member can't delete someone else's file; an admin can
    await expect(sam.as.mutation(api.vault.deleteFile, { fileId: q3.id })).rejects.toThrow(/uploader or an admin/);
    const handbook = files.find((f: any) => f.name === "Handbook.pdf");
    await jay.as.mutation(api.vault.deleteFile, { fileId: handbook.id });
    expect((await pat.as.query(api.vault.files, { accountId: pat.accountId }))).toEqual([]);
    await expect(jay.as.mutation(api.vault.saveFile, { accountId: jay.accountId, spaceId: null, storageId, name: "huge.zip", size: 60 * 1024 * 1024, mime: "application/zip" })).rejects.toThrow(/50 MB/);
  });

  test("credentials hold ciphertext only, follow space scope, and remember who used them", async () => {
    const { jay, sam, pat, spaceId } = await org();
    const saved = await jay.as.mutation(api.vault.saveCredential, { accountId: jay.accountId, spaceId, site: "stripe.com", username: "finance@acme.com", ciphertext: "b64cipher", iv: "b64iv", keyVersion: 1, note: "" });
    await expect(jay.as.mutation(api.vault.saveCredential, { accountId: jay.accountId, spaceId: null, site: "x", username: "u", ciphertext: "", iv: "", keyVersion: 1, note: "" })).rejects.toThrow(/didn't encrypt/);

    const mine = await sam.as.query(api.vault.credentials, { accountId: sam.accountId });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ site: "stripe.com", username: "finance@acme.com", ciphertext: "b64cipher", iv: "b64iv", spaceName: "Finance", canEdit: false, lastUsedBy: "" });
    expect(Object.keys(mine[0])).not.toContain("password");
    expect(await pat.as.query(api.vault.credentials, { accountId: pat.accountId })).toEqual([]);

    await sam.as.mutation(api.vault.touchCredential, { credentialId: saved.id });
    expect((await jay.as.query(api.vault.credentials, { accountId: jay.accountId }))[0].lastUsedBy).toBe("sam");
    await pat.as.mutation(api.vault.touchCredential, { credentialId: saved.id });
    expect((await jay.as.query(api.vault.credentials, { accountId: jay.accountId }))[0].lastUsedBy).toBe("sam");

    await expect(sam.as.mutation(api.vault.saveCredential, { accountId: sam.accountId, credentialId: saved.id, spaceId, site: "stripe.com", username: "u", ciphertext: "c", iv: "i", keyVersion: 1, note: "" })).rejects.toThrow(/whoever added it or an admin/);
    await expect(sam.as.mutation(api.vault.deleteCredential, { credentialId: saved.id })).rejects.toThrow(/whoever added it or an admin/);
    await jay.as.mutation(api.vault.deleteCredential, { credentialId: saved.id });
    expect(await sam.as.query(api.vault.credentials, { accountId: sam.accountId })).toEqual([]);
  });
});

describe("spaces and chat", () => {
  test("members of the organization see a space, but only those who joined read its chat", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    const pat = await login("pat", "pat@elsewhere.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });

    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    await jay.as.mutation(api.chat.send, { spaceId, text: "Welcome to Finance" });

    // Everyone lands in "general" on joining; Finance is there to join.
    const samList = await sam.as.query(api.spaces.list, { accountId: sam.accountId });
    expect(samList.map((s: any) => [s.name, s.joined, s.members.length])).toEqual([["general", true, 2], ["Finance", false, 1]]);
    expect(await sam.as.query(api.chat.messages, { spaceId })).toEqual([]);
    await expect(sam.as.mutation(api.chat.send, { spaceId, text: "hi" })).rejects.toThrow(/join the space/);

    await tick();
    await sam.as.mutation(api.spaces.join, { spaceId });
    const texts = (await sam.as.query(api.chat.messages, { spaceId })).map((m: any) => [m.author, m.text]);
    // jay was alone when the welcome went out, so the agent took it as a job
    expect(texts).toEqual([
      ["system", "jay created the space"],
      ["user", "Welcome to Finance"],
      ["agent", ""],
      ["system", "sam joined"],
      ["system", "With two of you here, mention @okidoki to give it work."],
    ]);
    await tick();
    await sam.as.mutation(api.chat.send, { spaceId, text: "Thanks!" });

    // unread counts follow lastReadAt; sending marks your own chat read
    const finance = (list: any[]) => list.find((s: any) => s.name === "Finance");
    expect(finance(await jay.as.query(api.spaces.list, { accountId: jay.accountId })).unread).toBe(3);
    await jay.as.mutation(api.spaces.markRead, { spaceId });
    expect(finance(await jay.as.query(api.spaces.list, { accountId: jay.accountId })).unread).toBe(0);

    // outside the organization nothing is visible or writable
    expect(await pat.as.query(api.spaces.list, { accountId: pat.accountId })).toEqual([]);
    expect(await pat.as.query(api.chat.messages, { spaceId })).toEqual([]);
    await expect(pat.as.mutation(api.spaces.join, { spaceId })).rejects.toThrow(/not in that organization/);
  });

  test("the space owner or an org admin can delete a space; a plain member can't", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });

    const { spaceId } = await sam.as.mutation(api.spaces.create, { accountId: sam.accountId, name: "Sam's corner" });
    const { spaceId: other } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Launch" });
    await sam.as.mutation(api.spaces.join, { spaceId: other });
    await expect(sam.as.mutation(api.spaces.remove, { spaceId: other })).rejects.toThrow(/owner or an organization admin/);
    await sam.as.mutation(api.spaces.update, { spaceId, workerPolicy: "privateMac", name: "Sam's room" });
    await expect(sam.as.mutation(api.spaces.update, { spaceId, workerPolicy: "mainframe" })).rejects.toThrow(/unknown worker/);
    await expect(sam.as.mutation(api.spaces.update, { spaceId, workerPolicy: "hostedVM" })).rejects.toThrow(/aren't available yet/);

    // an org admin deletes a space they never joined
    expect((await jay.as.mutation(api.spaces.remove, { spaceId })).done).toBe(true);
    expect((await jay.as.query(api.spaces.list, { accountId: jay.accountId })).map((s: any) => s.name).sort()).toEqual(["Launch", "general"]);
  });
});

describe("the Mac's view of the organization", () => {
  async function team() {
    const { t, login, postStatus: post, tokenFor } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Ops" });
    const poll = (accountId: string) => post("/api/worker/poll", { accountId, device: "mac", kind: "thisMac", enabled: false });
    return { t, jay, sam, orgId, spaceId, post, poll, tokenFor };
  }

  test("the poll carries the organization: spaces with unread counts, approvals in my spaces, shared skills", async () => {
    const { t, jay, sam, orgId, spaceId, post, poll, tokenFor } = await team();
    await jay.as.mutation(api.enterprise.setWelcome, { orgId, welcome: "Start with 'replay the expense report'." });

    // Sam isn't in Ops yet: he sees the space, not its approvals. The worker switch is off and the summary still comes.
    let summary = (await poll(sam.accountId)).summary;
    expect(summary.org).toMatchObject({ name: "Acme", role: "member", welcome: "Start with 'replay the expense report'.", pendingJoins: 0 });
    expect(summary.spaces.map((s: any) => [s.name, s.joined])).toEqual([["general", true], ["Ops", false]]);

    await post("/api/enterprise/join-space", { accountId: sam.accountId, spaceId });
    await tick();
    await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki clean up the shared drive" });
    const { jobId } = (await jay.as.query(api.jobs.forSpace, { spaceId }))[0].id ? { jobId: (await jay.as.query(api.jobs.forSpace, { spaceId }))[0].id } : { jobId: "" };
    await post("/api/worker/accept", { accountId: jay.accountId, jobId, device: "Jay's Mac" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "waiting", preview: { summary: "Delete 14 stale folders", risk: "high", steps: ["list", "delete"], commands: ["rm -rf …"] } });

    summary = (await poll(sam.accountId)).summary;
    const ops = summary.spaces.find((s: any) => s.name === "Ops");
    expect(ops.joined).toBe(true);
    expect(ops.unread).toBeGreaterThan(0);
    expect(summary.approvals).toHaveLength(1);
    expect(summary.approvals[0]).toMatchObject({ spaceName: "Ops", requestedBy: "jay", workerName: "jay", workerIsYou: false, preview: { summary: "Delete 14 stale folders", risk: "high", commands: ["rm -rf …"] } });

    // Sam answers from his notch; the chat hears it and the approval leaves the summary.
    const decided = await post("/api/enterprise/decide", { accountId: sam.accountId, jobId, decision: "approve" });
    expect(decided.ok).toBe(true);
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].decision).toBe("approve");
    expect((await poll(sam.accountId)).summary.approvals).toEqual([]);
    const lines = (await jay.as.query(api.chat.messages, { spaceId })).filter((m: any) => m.author === "agent" && m.kind === "text").map((m: any) => m.text);
    expect(lines.at(-1)).toMatch(/sam approved it/);

    // Reading marks the chat read; a stranger's Mac can't do any of this.
    await post("/api/enterprise/read", { accountId: sam.accountId, spaceId });
    expect((await poll(sam.accountId)).summary.spaces.find((s: any) => s.name === "Ops").unread).toBe(0);
    expect((await post("/api/enterprise/decide", { accountId: "acct-nobody", jobId, decision: "approve" })).status).toBe(401);
    // sam's Mac can't answer as jay
    expect((await t.fetch("/api/enterprise/decide", { method: "POST", headers: { authorization: `Bearer ${tokenFor(sam.accountId)}`, "content-type": "application/json" }, body: JSON.stringify({ accountId: jay.accountId, jobId, decision: "approve" }) })).status).toBe(403);
  });

  test("a request typed at the cursor becomes a job in the space; shared skills are pulled by id", async () => {
    const { jay, sam, spaceId, post, poll } = await team();
    await post("/api/enterprise/join-space", { accountId: sam.accountId, spaceId });
    const sent = await post("/api/enterprise/send", { accountId: sam.accountId, spaceId, text: "@okidoki export the deck as PDF" });
    expect(sent.jobId).toBeTruthy();
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0]).toMatchObject({ prompt: "export the deck as PDF", requestedBy: "sam", status: "queued" });
    // not a member of a space you never joined
    const { spaceId: finance } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    expect((await post("/api/enterprise/send", { accountId: sam.accountId, spaceId: finance, text: "hi" })).error).toMatch(/join the space/);

    const steps = [{ id: "s1", text: "Open Numbers", app: "Numbers", action: "click", label: "Numbers" }];
    const published = await post("/api/enterprise/publish", { accountId: jay.accountId, spaceId: null, skill: { id: "skill-1", name: "expense report", summary: "monthly", steps } });
    expect(published.version).toBe(1);
    const summary = (await poll(sam.accountId)).summary;
    expect(summary.sharedSkills.map((s: any) => [s.name, s.publishedBy, s.stepCount, s.isMine])).toEqual([["expense report", "jay", 1, false]]);
    expect(summary.sharedSkills[0].steps).toBeUndefined();
    const pulled = await post("/api/enterprise/skill", { accountId: sam.accountId, sharedId: published.id });
    expect(pulled.skill.steps).toEqual(steps);
    await post("/api/enterprise/skill-run", { accountId: sam.accountId, sharedId: published.id });
    expect((await poll(sam.accountId)).summary.sharedSkills[0].runCount).toBe(1);
  });

  test("admins see the rollout: who's installed, who's online, who shares skills", async () => {
    const { jay, sam, post, poll } = await team();
    await poll(sam.accountId);
    const rollout = await jay.as.query(api.enterprise.rollout, { accountId: jay.accountId });
    expect(rollout.installed).toBe(2);
    expect(rollout.members.map((m: any) => [m.name, m.installed, m.online, m.workerOn])).toEqual([["sam", true, true, false], ["jay", true, false, false]]);
    await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true });
    const again = await jay.as.query(api.enterprise.rollout, { accountId: jay.accountId });
    expect(again.workersOn).toBe(1);
    // members get nothing
    expect(await sam.as.query(api.enterprise.rollout, { accountId: sam.accountId })).toBeNull();
    // only admins set the welcome
    await expect(sam.as.mutation(api.enterprise.setWelcome, { orgId: rollout ? (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id : "", welcome: "x" })).rejects.toThrow(/owner or admin/);
  });
});
