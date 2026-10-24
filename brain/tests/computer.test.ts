import { test, expect } from "bun:test";
import { describeControls, systemPrompt } from "../src/computer";
import type { ComputerRequest } from "../src/types";

const base: ComputerRequest = {
  goal: "send hi to mom on whatsapp",
  step: 2,
  app: "WhatsApp",
  windowTitle: "Mom",
  screen: { x: 0, y: 0, width: 1512, height: 982 },
  imageWidth: 1331,
  imageHeight: 864,
  history: [
    { type: "open_app", app: "WhatsApp", result: "opened WhatsApp" },
    { type: "click", x: 300.4, y: 700.6, target: "Type a message", result: "pressed “Type a message”" },
    { type: "note", result: "that exact action has now run 3 times" },
  ],
  controls: [
    { role: "field", label: "Type a message", x: 700, y: 820, w: 900, h: 36 },
    { role: "button", label: "Send", x: 1290, y: 820 },
  ],
  screenshotBase64: "aGk=",
};

test("controls are listed compactly with centers", () => {
  const text = describeControls(base.controls);
  expect(text).toBe("field “Type a message” @ 700,820\nbutton “Send” @ 1290,820");
  expect(describeControls([])).toBe("");
  expect(describeControls(undefined)).toBe("");
  const many = Array.from({ length: 200 }, (_, i) => ({ role: "button", label: `b${i}`, x: i, y: i }));
  expect(describeControls(many).split("\n")).toHaveLength(120);
});

test("the prompt tells the model the image size, the window, the controls and the history", () => {
  const prompt = systemPrompt(base);
  expect(prompt).toContain("1331×864 pixels");
  expect(prompt).toContain("window “Mom”");
  expect(prompt).toContain("button “Send” @ 1290,820");
  expect(prompt).toContain("· click (300,701) target “Type a message” → pressed “Type a message”");
  expect(prompt).toContain("! that exact action has now run 3 times");
  expect(prompt).toContain("Pointer and keyboard actions are available.");
});

test("without a screenshot or accessibility the prompt forbids pointer actions", () => {
  const blind = systemPrompt({ ...base, screenshotBase64: undefined, canSee: false, canClick: false, controls: [] });
  expect(blind).toContain("You cannot see the screen this turn");
  expect(blind).toContain("Accessibility is off");
  expect(blind).toContain("reports no accessible controls");
});

test("on the private Mac the prompt drops scripts and accessibility and keeps the picture", () => {
  const remote = systemPrompt({ ...base, remote: true, app: "", windowTitle: "", controls: [], scripting: "" });
  expect(remote).toContain("PRIVATE MAC");
  expect(remote).toContain("Do not emit script");
  expect(remote).toContain("1331×864 pixels");
  expect(remote).toContain("Setup Assistant");
  expect(remote).toContain("· open_app WhatsApp → opened WhatsApp");
  expect(remote).not.toContain("AppleScript by default");
  expect(remote).not.toContain("reports no accessible controls");
  expect(remote).not.toContain("Frontmost app:");
  // The user didn't watch, so the summary has to say where the result lives.
  expect(remote).toContain("without having seen the screen");
});

import { computerAct, drivingModel, messageContent } from "../src/computer";

test("driving swaps a small routing model for sonnet but keeps an explicit choice", () => {
  expect(drivingModel(undefined)).toBe("claude-sonnet-5-5");
  expect(drivingModel("")).toBe("claude-sonnet-5-5");
  expect(drivingModel("claude-haiku-5-5")).toBe("claude-sonnet-5-5");
  expect(drivingModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(drivingModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
});

test("images go before the instructions: before, now, then the zoom crop", () => {
  const content = messageContent({
    ...base,
    previousScreenshotBase64: "YmVmb3Jl",
    zoomBase64: "em9vbQ==",
    zoom: { x: 100, y: 50, width: 400, height: 266, imageWidth: 800, imageHeight: 532 },
  }) as { type: string; text?: string; source?: { data: string } }[];
  expect(content.map((c) => c.type)).toEqual(["text", "image", "text", "image", "text", "image", "text"]);
  expect(content[1].source?.data).toBe("YmVmb3Jl");
  expect(content[3].source?.data).toBe("aGk=");
  expect(content[5].source?.data).toBe("em9vbQ==");
  const prompt = content[6].text ?? "";
  expect(prompt).toContain("BEFORE your last action");
  expect(prompt).toContain("x 100–500, y 50–316");
  expect(prompt).toContain("u×0.500");

  const plain = messageContent(base) as { type: string }[];
  expect(plain.map((c) => c.type)).toEqual(["image", "text"]);
});

test("transient model errors are retried, a bad key is not", async () => {
  const calls: number[] = [];
  const flaky = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls.push(Date.now());
    if (calls.length < 3) return new Response("overloaded", { status: 529 });
    return Response.json({ content: [{ type: "tool_use", input: { type: "wait", seconds: 1, say: "waiting" } }] });
  }) as unknown as typeof fetch;
  const result = await computerAct(base, "sk-test", flaky);
  expect(calls).toHaveLength(3);
  expect(result.usedModel).toBe(true);
  expect(result.action.type).toBe("wait");

  let attempts = 0;
  const rejected = (async () => { attempts++; return new Response("bad key", { status: 401 }); }) as unknown as typeof fetch;
  const denied = await computerAct(base, "sk-bad", rejected);
  expect(attempts).toBe(1);
  expect(denied.action.type).toBe("fail");
  expect(denied.action.reason).toContain("rejected");

  const explicit = { ...base, settings: { claudeModel: "claude-opus-5-5" } };
  let sentModel = "";
  const spy = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return Response.json({ content: [{ type: "tool_use", input: { type: "done", summary: "ok", say: "done" } }] });
  }) as unknown as typeof fetch;
  await computerAct(explicit, "sk-test", spy);
  expect(sentModel).toBe("claude-opus-5-5");
  await computerAct(base, "sk-test", spy);
  expect(sentModel).toBe("claude-sonnet-5-5");
});

import { actionFromText } from "../src/computer";

test("an action written as JSON inside prose is salvaged", () => {
  expect(actionFromText('Sure. {"type":"click","x":10,"y":20,"say":"clicking"} done')).toEqual({ type: "click", x: 10, y: 20, say: "clicking" });
  expect(actionFromText('{"type":"wait","seconds":2}')?.say).toBe("wait");
  expect(actionFromText("I'll click the button at {x: 10}")).toBeUndefined();
  expect(actionFromText('{"type":"nonsense"}')).toBeUndefined();
  expect(actionFromText("no json here")).toBeUndefined();
});

test("a prose-only reply gets one correction turn, then the action", async () => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const chatty = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({ content: [{ type: "text", text: "Let me open Notes first." }] });
    return Response.json({ content: [{ type: "tool_use", input: { type: "open_app", app: "Notes", say: "opening notes" } }] });
  }) as unknown as typeof fetch;
  const result = await computerAct(base, "sk-test", chatty);
  expect(result.usedModel).toBe(true);
  expect(result.action.type).toBe("open_app");
  expect(bodies).toHaveLength(2);
  expect(bodies[1].messages).toHaveLength(3);
  expect(bodies[1].messages[1]).toEqual({ role: "assistant", content: "Let me open Notes first." });

  let calls = 0;
  const stubborn = (async () => { calls++; return Response.json({ content: [{ type: "text", text: "Just words." }] }); }) as unknown as typeof fetch;
  const failed = await computerAct(base, "sk-test", stubborn);
  expect(calls).toBe(2);
  expect(failed.action.type).toBe("fail");
  expect(failed.action.reason).toContain("text without an action");
});

test("the scripting dictionary is shown when present", () => {
  const prompt = systemPrompt({ ...base, scripting: "Notes Suite: classes — note (name, body)" });
  expect(prompt).toContain("AppleScript dictionary of WhatsApp (abridged)");
  expect(prompt).toContain("note (name, body)");
  expect(systemPrompt(base)).not.toContain("AppleScript dictionary of");
});
