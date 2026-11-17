import { describe, expect, test } from "bun:test";
import { MockHost } from "../src/collab/mock";
import { asksOkidoki, stripAskPrefix, type CollabEvent } from "../src/collab/protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(40);
  }
}

describe("ask prefix", () => {
  test("detects okidoki addressed asks and strips the prefix", () => {
    expect(asksOkidoki("okidoki, check the weather")).toBe(true);
    expect(asksOkidoki("  Okidoki do it")).toBe(true);
    expect(asksOkidoki("hey everyone")).toBe(false);
    expect(stripAskPrefix("okidoki, check the weather")).toBe("check the weather");
    expect(stripAskPrefix("Okidoki: do it")).toBe("do it");
  });
});

describe("mock host (the session contract)", () => {
  test("joining needs the code and returns a token, you, and a snapshot", async () => {
    const host = new MockHost();
    await expect(host.join("Asha", "NOPE")).rejects.toThrow();
    const res = await host.join("Asha", "okidoki");
    expect(res.token).toBeTruthy();
    expect(res.you.name).toBe("Asha");
    expect(res.session.participants.some((p) => p.id === res.you.id)).toBe(true);
    expect(res.session.skills.length).toBeGreaterThan(0);
    expect(res.session.vm.running).toBe(true);
    host.dispose();
  });

  test("a session is full past the participant cap", async () => {
    const host = new MockHost();
    for (let i = 0; i < 6; i++) await host.join(`p${i}`, "OKIDOKI");
    await expect(host.join("overflow", "OKIDOKI")).rejects.toThrow(/full/);
    host.dispose();
  });

  test("chat broadcasts; an ask starts a run that steps forward and reports back", async () => {
    const host = new MockHost();
    const { token } = await host.join("Asha", "OKIDOKI");
    const events: CollabEvent[] = [];
    host.subscribe(token, (e) => events.push(e));
    await sleep(20);

    await host.chat(token, "hey everyone", false);
    expect(events.some((e) => e.type === "chat" && e.message.text === "hey everyone" && e.message.kind === "chat")).toBe(true);

    await host.chat(token, "okidoki, check the weather in Lisbon", true);
    await waitFor(() => events.some((e) => e.type === "run" && e.run !== null));
    const started = events.find((e) => e.type === "run" && e.run !== null);
    expect(started && started.type === "run" && started.run?.goal).toBe("check the weather in Lisbon");

    // The scripted run finishes on its own and okidoki posts back into the chat.
    await waitFor(() => events.some((e) => e.type === "run" && e.run === null));
    await waitFor(() => events.some((e) => e.type === "chat" && e.message.kind === "okidoki"));
    host.dispose();
  });

  test("a skill card runs in the shared Mac; stop ends the run", async () => {
    const host = new MockHost();
    const { token, session } = await host.join("Asha", "OKIDOKI");
    const events: CollabEvent[] = [];
    host.subscribe(token, (e) => events.push(e));
    await sleep(20);

    const skill = session.skills[0];
    const { runID } = await host.runSkill(token, skill.id, { city: "Lisbon" });
    expect(runID).toBeTruthy();
    await waitFor(() => events.some((e) => e.type === "run" && e.run?.id === runID));

    await host.stopRun(token, runID);
    await waitFor(() => events.some((e) => e.type === "run" && e.run === null));
    host.dispose();
  });

  test("the wheel is held by one person and released", async () => {
    const host = new MockHost();
    const { token } = await host.join("Asha", "OKIDOKI");
    const events: CollabEvent[] = [];
    host.subscribe(token, (e) => events.push(e));
    await sleep(20);

    const took = await host.wheel(token, "request");
    expect(took.holder).toBeTruthy();
    await waitFor(() => events.some((e) => e.type === "wheel" && e.holder === took.holder));

    const released = await host.wheel(token, "release");
    expect(released.holder).toBeNull();
    host.dispose();
  });

  test("state refreshes for a reconnecting participant", async () => {
    const host = new MockHost();
    const { token, you } = await host.join("Asha", "OKIDOKI");
    const fresh = await host.state(token);
    expect(fresh.you.id).toBe(you.id);
    expect(fresh.session.chat.length).toBeGreaterThan(0);
    await expect(host.state("bad-token")).rejects.toThrow();
    host.dispose();
  });
});
