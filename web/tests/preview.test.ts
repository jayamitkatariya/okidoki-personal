import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasNativeBridge, invoke } from "../src/bridge";
import { demoState } from "../src/demo";
import type { NativeState } from "../src/types";

const originalWindow = globalThis.window;
let snapshots: NativeState[];

beforeEach(() => {
  snapshots = [];
  const previewWindow = new EventTarget() as unknown as Window & typeof globalThis;
  globalThis.window = previewWindow;
  previewWindow.addEventListener("okidoki-native", ((event: CustomEvent<NativeState>) => {
    snapshots.push(event.detail);
  }) as EventListener);
});
afterEach(() => { globalThis.window = originalWindow; });

describe("dashboard browser preview", () => {
  test("successive edits publish independent snapshots and preserve previous settings", () => {
    invoke("updateSettings", { patch: { quietMode: true } });
    invoke("updateSettings", { patch: { quietMode: false, captions: true } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0].settings.quietMode).toBe(true);
    expect(snapshots[1].settings.quietMode).toBe(false);
    expect(snapshots[1].settings.captions).toBe(true);
    expect(snapshots[1].settings.defaultInput).toBe(demoState.settings.defaultInput);
  });

  test("an account can be added, switched away from, and selected again", () => {
    invoke("createAccount", { name: "Design review", kind: "work", email: "review@example.com" });
    const createdID = snapshots[0].currentAccountID;
    invoke("switchAccount", { id: demoState.accounts[0].id });
    invoke("switchAccount", { id: createdID });
    expect(snapshots.map((state) => state.currentAccountID)).toEqual([createdID, demoState.accounts[0].id, createdID]);
    expect(snapshots[0].currentAccountID).toBe(createdID);
  });

  test("sample data and preview events do not imply a native connection", () => {
    invoke("updateSettings", { patch: { quietMode: true } });
    expect(hasNativeBridge()).toBe(false);
    const messages: unknown[] = [];
    window.webkit = { messageHandlers: { okidoki: { postMessage: (message) => messages.push(message) } } };
    expect(hasNativeBridge()).toBe(true);
    invoke("pauseRun", { id: "native-run" });
    expect(messages).toEqual([{ type: "pauseRun", payload: { id: "native-run" } }]);
    expect(snapshots).toHaveLength(1);
  });

  test("tabs dragged into a new order line up behind it, unknown ids kept at the end", () => {
    const ids = ["tab-flights", "tab-gh", "tab-figma", "tab-netflix", "tab-lepuzz"];
    invoke("browserReorder", { ids });
    expect(snapshots[0].browser?.tabs.map((tab) => tab.id)).toEqual(ids);
    invoke("browserReorder", { ids: ["tab-gh", "tab-lepuzz"] });
    expect(snapshots[1].browser?.tabs.map((tab) => tab.id)).toEqual(["tab-gh", "tab-lepuzz", "tab-flights", "tab-figma", "tab-netflix"]);
  });
});
