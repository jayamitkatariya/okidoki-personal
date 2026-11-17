import { describe, expect, test } from "bun:test";
import { DRAG_THRESHOLD, isDrag, keyCombo, keyInput, normPoint, scrollInput, typedText } from "../src/collab/input";
import { MockHost } from "../src/collab/mock";
import type { CollabEvent } from "../src/collab/protocol";

const key = (patch: Partial<Parameters<typeof keyCombo>[0]> = {}) => ({
  key: "a", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(40);
  }
}

describe("coordinates", () => {
  test("a point in the image maps to normalized guest coordinates, clamped", () => {
    const rect = { left: 100, top: 50, width: 800, height: 500 };
    expect(normPoint(500, 300, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(normPoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(normPoint(900, 550, rect)).toEqual({ x: 1, y: 1 });
    expect(normPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normPoint(500, 300, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  test("a press becomes a drag only past the threshold", () => {
    expect(isDrag({ x: 0.5, y: 0.5 }, { x: 0.5 + DRAG_THRESHOLD / 2, y: 0.5 })).toBe(false);
    expect(isDrag({ x: 0.5, y: 0.5 }, { x: 0.5 + DRAG_THRESHOLD * 2, y: 0.5 })).toBe(true);
  });
});

describe("keyboard", () => {
  test("printable keys type, including shifted characters", () => {
    expect(typedText(key())).toBe("a");
    expect(typedText(key({ key: "A", shiftKey: true }))).toBe("A");
    expect(typedText(key({ key: "!" }))).toBe("!");
    expect(keyInput(key({ key: " " }))).toEqual({ kind: "type", text: " " });
  });

  test("shortcuts become okidoki combos", () => {
    expect(keyCombo(key({ key: "l", metaKey: true }))).toBe("cmd+l");
    expect(keyCombo(key({ key: "c", ctrlKey: true }))).toBe("ctrl+c");
    expect(keyCombo(key({ key: "t", metaKey: true, shiftKey: true }))).toBe("shift+cmd+t");
    expect(keyCombo(key({ key: "z", altKey: true }))).toBe("opt+z");
    expect(typedText(key({ key: "l", metaKey: true }))).toBeNull();
  });

  test("named keys map to the guest's vocabulary", () => {
    expect(keyInput(key({ key: "Enter" }))).toEqual({ kind: "key", key: "return" });
    expect(keyInput(key({ key: "Backspace" }))).toEqual({ kind: "key", key: "delete" });
    expect(keyInput(key({ key: "ArrowLeft" }))).toEqual({ kind: "key", key: "left" });
    expect(keyInput(key({ key: "Tab", shiftKey: true }))).toEqual({ kind: "key", key: "shift+tab" });
    expect(keyInput(key({ key: "F5" }))).toEqual({ kind: "key", key: "f5" });
    expect(keyInput(key({ key: "Dead" }))).toBeNull();
  });
});

describe("scroll", () => {
  test("deltas pass through clamped, and a zero scroll is dropped", () => {
    expect(scrollInput(0.5, 0.5, 0, 120)).toEqual({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 120 });
    expect(scrollInput(0.5, 0.5, 0, 99999)).toEqual({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 2000 });
    expect(scrollInput(0.5, 0.5, 0, 0)).toBeNull();
  });
});

describe("wheel and okidoki never drive at once (mock host)", () => {
  test("the wheel is refused mid-run, and a run reclaims the wheel", async () => {
    const host = new MockHost();
    const { token } = await host.join("Asha", "OKIDOKI");
    const events: CollabEvent[] = [];
    host.subscribe(token, (e) => events.push(e));
    await sleep(20);

    // okidoki starts working: the wheel request is refused.
    await host.chat(token, "okidoki, check the weather", true);
    await waitFor(() => events.some((e) => e.type === "run" && e.run !== null));
    await expect(host.wheel(token, "request")).rejects.toThrow(/working/);

    // Once the run ends, the wheel can be taken.
    await waitFor(() => events.some((e) => e.type === "run" && e.run === null));
    const took = await host.wheel(token, "request");
    expect(took.holder).toBeTruthy();

    // Asking while someone holds the wheel: okidoki says so instead of driving.
    await host.chat(token, "okidoki, do another thing", true);
    await waitFor(() => events.some((e) => e.type === "chat" && e.message.kind === "okidoki" && /wheel/.test(e.message.text)));
    const fresh = await host.state(token);
    expect(fresh.session.run).toBeNull();
    host.dispose();
  });

  test("input broadcasts the holder's pointer to everyone", async () => {
    const host = new MockHost();
    const a = await host.join("Asha", "OKIDOKI");
    const b = await host.join("Ravi", "OKIDOKI");
    const events: CollabEvent[] = [];
    host.subscribe(b.token, (e) => events.push(e));
    await sleep(20);

    // Without the wheel, input is ignored.
    await host.input(a.token, { kind: "move", x: 0.2, y: 0.3 });
    expect(events.some((e) => e.type === "pointer")).toBe(false);

    await host.wheel(a.token, "request");
    await host.input(a.token, { kind: "move", x: 0.2, y: 0.3 });
    await host.input(a.token, { kind: "click", x: 0.4, y: 0.6 });
    const moves = events.filter((e) => e.type === "pointer");
    expect(moves.length).toBe(2);
    expect(moves[0]).toMatchObject({ x: 0.2, y: 0.3, by: a.you.id, click: false });
    expect(moves[1]).toMatchObject({ x: 0.4, y: 0.6, click: true });
    host.dispose();
  });
});
