import { test, expect } from "bun:test";
import { normalizeTeachStep, teachModel, teachSystemPrompt } from "../src/teach";

test("steps are written by Sonnet unless a bigger model was chosen", () => {
  expect(teachModel(undefined)).toBe("claude-sonnet-5-5");
  expect(teachModel("claude-haiku-5-5")).toBe("claude-sonnet-5-5");
  expect(teachModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  expect(teachModel("claude-opus-5-5")).toBe("claude-opus-5-5");
});

test("one drawing per step at most", () => {
  const step = normalizeTeachStep({
    action: "click",
    say: "click it",
    annotations: [{ kind: "callout", text: "here", x: 1, y: 2 }, { kind: "sketch", x: 3, y: 4 }],
  });
  expect(step.annotations).toHaveLength(1);
  expect(step.annotations[0].kind).toBe("callout");
});

test("the prompt carries the real menu bar and a landed step", () => {
  const base = { topic: "tabs", app: "Ghostty", log: [{ say: "open a tab", action: "key", label: "new tab", outcome: "pressed cmd+t — the shortcut" }], stepNumber: 2, imageWidth: 1568, imageHeight: 980 };
  const prompt = teachSystemPrompt({ ...base, menus: ["File: New Window, New Tab, Close", "View: Toggle Full Screen"], landed: true });
  expect(prompt).toContain("File: New Window, New Tab, Close");
  expect(prompt.indexOf("menu bar, exactly as it is")).toBeLessThan(prompt.indexOf("Loose outline from the planner"));
  expect(prompt).toContain("landed — okidoki saw that last action hit its target.");
  expect(teachSystemPrompt({ ...base, landed: false })).not.toContain("landed — okidoki");
});

test("a model step is cleaned into one safe action", () => {
  const step = normalizeTeachStep({
    previous_done: false,
    action: "click",
    say: "  click the frame tool — a frame is a screen.  ",
    label: "Frame Tool",
    x: 22.4,
    y: 118,
    target: "Frame",
    remaining: 4.6,
  });
  expect(step.previous_done).toBe(false);
  expect(step.action).toBe("click");
  expect(step.say).toBe("click the frame tool — a frame is a screen.");
  expect(step.label).toBe("frame tool");
  expect(step.x).toBe(22.4);
  expect(step.remaining).toBe(5);
  expect(step.w).toBeUndefined();
});

test("unknown actions fall back to look and previous_done defaults to true", () => {
  const step = normalizeTeachStep({ action: "dance", say: "notice the layers panel" });
  expect(step.action).toBe("look");
  expect(step.previous_done).toBe(true);
});

test("the tutor prompt carries the outline, the log, the image size and the controls the Mac can see", () => {
  const prompt = teachSystemPrompt({
    topic: "auto layout",
    app: "Figma",
    outline: ["select the frame", "press shift+a"],
    log: [{ say: "select the frame", action: "click", label: "frame", outcome: "clicked the target “frame” at 300,200" }],
    stepNumber: 2,
    imageWidth: 1568,
    imageHeight: 980,
    controls: [{ id: 7, label: "Auto layout", role: "button", x: 1402, y: 331, w: 28, h: 22 }],
  });
  expect(prompt).toContain('learning "auto layout" in Figma');
  expect(prompt).toContain("1. select the frame");
  expect(prompt).toContain("clicked the target “frame” at 300,200");
  expect(prompt).toContain("1568x980");
  expect(prompt).toContain("exactly ONE step");
  expect(prompt).toContain("#7 “Auto layout” (button) at 1402,331 28x22");
  expect(prompt).toContain("answer with element (its number)");
});

test("a second region and its label survive normalizing", () => {
  const step = normalizeTeachStep({ action: "key", say: "press shift+a", key: "shift+a", also_x: 1400, also_y: 300, also_w: 220, also_h: 90, also_label: "Auto Layout Panel" });
  expect(step.also_x).toBe(1400);
  expect(step.also_h).toBe(90);
  expect(step.also_label).toBe("auto layout panel");
});
