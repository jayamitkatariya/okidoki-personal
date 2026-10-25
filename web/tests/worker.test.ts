import { describe, expect, test } from "bun:test";
import { workerHint } from "../src/worker";

// A queued job explains itself from this Mac's point of view, and offers the one switch that fixes it.

describe("workerHint", () => {
  test("says nothing while another Mac is ready to take it", () => {
    expect(workerHint({ native: true, enabled: false, state: "off", readyElsewhere: 1, workAccountName: "Acme" })).toEqual({ text: "", action: null });
  });

  test("a solo Mac with the worker off is one click from working", () => {
    const hint = workerHint({ native: true, enabled: false, state: "off", readyElsewhere: 0, workAccountName: "Acme" });
    expect(hint.action).toBe("enable");
    expect(hint.text).toMatch(/isn't taking jobs yet/);
  });

  test("a Mac parked on a personal account says which account to switch to", () => {
    const hint = workerHint({ native: true, enabled: true, state: "paused", readyElsewhere: 0, workAccountName: "Acme" });
    expect(hint.action).toBe("switch");
    expect(hint.text).toContain("Switch to Acme");
  });

  test("the hosted panel can't flip a switch on a Mac, so it points at Settings there", () => {
    const hint = workerHint({ native: false, enabled: false, state: null, readyElsewhere: 0, workAccountName: "Acme" });
    expect(hint.action).toBeNull();
    expect(hint.text).toMatch(/Settings › Worker/);
  });

  test("ready and enabled but nothing picked it up yet is just waiting", () => {
    expect(workerHint({ native: true, enabled: true, state: "ready", readyElsewhere: 0, workAccountName: "Acme" })).toEqual({ text: "Waiting for a Mac to pick it up.", action: null });
  });
});
