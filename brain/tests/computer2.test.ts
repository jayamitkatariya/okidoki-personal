import { beforeEach, expect, test } from "bun:test";
import {
  driveStep, HALT_TEXT, mapToolUse, normalizeKey, resetSessions, sessionFor, supportsToolset, systemPromptV2, TOOLSET_TYPE,
} from "../src/computer2";
import type { DriveRequest } from "../src/types";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, any> };

/** A fake Messages API that answers with the queued replies and remembers every request body. */
function fakeAPI(replies: Array<Record<string, unknown> | Response>) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error("no reply queued");
    return next instanceof Response ? next : Response.json(next);
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const thinking = { type: "thinking", thinking: "", signature: "sig-1" };

function reply(content: unknown[], stop = "tool_use") {
  return { content, stop_reason: stop, usage: { input_tokens: 900, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: 80 } };
}

const obs = {
  app: "WhatsApp",
  windowTitle: "WhatsApp",
  imageWidth: 1512,
  imageHeight: 982,
  screenshotBase64: "c2hvdDE=",
  mediaType: "image/jpeg",
  controls: [
    { id: 1, role: "field", label: "Search", x: 200, y: 80 },
    { id: 2, role: "button", label: "New chat", x: 300, y: 40 },
  ],
  scripting: "",
};

function request(overrides: Partial<DriveRequest> = {}): DriveRequest {
  return { runID: "run-1", goal: "send hi to You on whatsapp", step: 0, observation: obs, ...overrides };
}

beforeEach(() => resetSessions());

test("only models that take the toolset use v2", () => {
  expect(supportsToolset("claude-haiku-5-5")).toBe(true);
  expect(supportsToolset("claude-sonnet-5-5")).toBe(true);
  expect(supportsToolset("claude-opus-4-8")).toBe(true);
  expect(supportsToolset("claude-haiku-5-5-20261001")).toBe(true);
  expect(supportsToolset("claude-haiku-4-5")).toBe(false);
  expect(supportsToolset("claude-sonnet-4-6")).toBe(false);
});

test("an unsupported model falls back to v1 without calling the API", async () => {
  const api = fakeAPI([]);
  const out = await driveStep(request({ settings: { claudeModel: "claude-haiku-4-5" } }), "sk", api.impl);
  expect(out.fallback).toBe("v1");
  expect(api.sent).toHaveLength(0);
});

test("the first request: toolset and own tools, cached instructions, text before the screenshot", async () => {
  const api = fakeAPI([reply([thinking, { type: "tool_use", id: "t1", name: "left_click", toolset_name: "computer", input: { coordinate: [200, 80] } }])]);
  const out = await driveStep(request(), "sk", api.impl);
  const body = api.sent[0].body;
  expect(api.sent[0].headers["anthropic-beta"]).toBe("context-management-2025-06-27");
  expect(body.model).toBe("claude-haiku-5-5");
  expect(body.max_tokens).toBe(4096);
  expect(body.temperature).toBeUndefined();
  expect(body.output_config).toEqual({ effort: "low" });
  expect(body.cache_control).toEqual({ type: "ephemeral" });
  expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  expect(body.system[0].text).toContain("The task: send hi to You on whatsapp");
  expect(body.context_management.edits[0].type).toBe("clear_tool_uses_20250919");
  expect(body.tools[0]).toEqual({ type: TOOLSET_TYPE });
  expect(body.tools.map((t: any) => t.name).filter(Boolean)).toEqual(["run_script", "open_app", "open_url", "click_element", "finish", "ask"]);
  const content = body.messages[0].content;
  expect(content.map((c: any) => c.type)).toEqual(["text", "image"]);
  expect(content[0].text).toContain("Frontmost app: WhatsApp");
  expect(content[0].text).toContain("#1 field “Search” @ 200,80");
  expect(content[1].source).toEqual({ type: "base64", media_type: "image/jpeg", data: "c2hvdDE=" });
  expect(out.actions).toEqual([{ id: "t1", tool: "left_click", member: true, type: "click", x: 200, y: 80, modifiers: undefined }]);
  expect(out.meta?.usage).toEqual({ input: 900, cacheRead: 6000, cacheWrite: 0, output: 80 });
});

test("a batch's results go back in order; skipped members get the exact halt text; the screen rides on the last one", async () => {
  const first = [
    thinking,
    { type: "tool_use", id: "a", name: "click_element", input: { id: 1 } },
    { type: "tool_use", id: "b", name: "type", toolset_name: "computer", input: { text: "You" } },
    { type: "tool_use", id: "c", name: "key", toolset_name: "computer", input: { text: "Return" } },
  ];
  const api = fakeAPI([reply(first), reply([{ type: "tool_use", id: "d", name: "finish", input: { success: true, summary: "sent" } }])]);
  await driveStep(request(), "sk", api.impl);
  const out = await driveStep(request({
    step: 1,
    observation: { ...obs, screenshotBase64: "c2hvdDI=" },
    results: [
      { id: "a", result: "pressed “Search”" },
      { id: "b", result: "typed 3 characters but the field shows “”", isError: true },
      { id: "c", result: "", skipped: true },
    ],
  }), "sk", api.impl);

  const second = api.sent[1].body;
  // Append-only: the whole first request, then the model's turn exactly as it came, then the results.
  expect(second.messages.slice(0, 1)).toEqual(api.sent[0].body.messages);
  expect(second.messages[1]).toEqual({ role: "assistant", content: first });
  expect(second.system).toEqual(api.sent[0].body.system);
  expect(second.tools).toEqual(api.sent[0].body.tools);
  const results = second.messages[2].content;
  expect(results.map((r: any) => r.tool_use_id)).toEqual(["a", "b", "c"]);
  expect(results[0].toolset_name).toBeUndefined();
  expect(results[0].is_error).toBeUndefined();
  expect(results[1].toolset_name).toBe("computer");
  expect(results[1].is_error).toBe(true);
  expect(results[2]).toMatchObject({ toolset_name: "computer", is_error: true });
  expect(results[2].content[0].text).toBe(HALT_TEXT);
  const last = results[2].content.map((b: any) => b.type);
  expect(last).toEqual(["text", "text", "image"]);
  expect(results[2].content[2].source.data).toBe("c2hvdDI=");
  expect(out.actions[0]).toMatchObject({ type: "done", summary: "sent" });
});

test("a computer action sent without toolset_name gets a result without one, and still runs", async () => {
  const api = fakeAPI([
    reply([
      { type: "tool_use", id: "z", name: "zoom", input: { region: [0, 0, 400, 300] } },
      { type: "tool_use", id: "k", name: "key", toolset_name: "computer", input: { text: "Return" } },
    ]),
    reply([{ type: "tool_use", id: "f", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  const first = await driveStep(request(), "sk", api.impl);
  expect(first.actions.map((a) => a.type)).toEqual(["zoom", "key"]);
  await driveStep(request({ step: 1, results: [{ id: "z", result: "zoomed", imageBase64: "em9vbQ==", mediaType: "image/png" }, { id: "k", result: "", skipped: true }] }), "sk", api.impl);
  const results = api.sent[1].body.messages[2].content;
  expect(results[0].toolset_name).toBeUndefined();
  expect(results[1].toolset_name).toBe("computer");
  expect(results[1].content[0].text).toBe(HALT_TEXT);
});

test("the scripting dictionary is sent when the frontmost app changes, not every turn", async () => {
  const withDict = { ...obs, scripting: "make new note" };
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "a", name: "key", toolset_name: "computer", input: { text: "super+n" } }]),
    reply([{ type: "tool_use", id: "b", name: "key", toolset_name: "computer", input: { text: "Return" } }]),
  ]);
  await driveStep(request({ observation: withDict }), "sk", api.impl);
  await driveStep(request({ step: 1, observation: withDict, results: [{ id: "a", result: "pressed cmd+n" }] }), "sk", api.impl);
  expect(JSON.stringify(api.sent[0].body.messages[0])).toContain("make new note");
  expect(JSON.stringify(api.sent[1].body.messages[2])).not.toContain("make new note");
});

test("toolset calls map onto the Mac's actions", () => {
  const m = (name: string, input: Record<string, unknown>, toolset: string | null = "computer") =>
    mapToolUse({ type: "tool_use", id: "x", name, input, toolset_name: toolset ?? undefined });
  expect(m("left_click", { coordinate: [10, 20], text: "super+shift" })).toMatchObject({ type: "click", x: 10, y: 20, modifiers: "cmd+shift" });
  expect(m("left_click", {})).toMatchObject({ type: "click" });
  expect(m("left_click", {}).x).toBeUndefined();
  expect(m("double_click", { coordinate: [1, 2] })).toMatchObject({ type: "double_click", x: 1, y: 2 });
  expect(m("left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] })).toMatchObject({ type: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
  expect(m("scroll", { scroll_direction: "down", scroll_amount: 5, coordinate: [100, 200] })).toMatchObject({ type: "scroll", x: 100, y: 200, dy: 300, dx: 0 });
  expect(m("scroll", { scroll_direction: "left", scroll_amount: 2 })).toMatchObject({ type: "scroll", dx: -120, dy: 0 });
  expect(m("zoom", { region: [100, 50, 500, 316] })).toMatchObject({ type: "zoom", x: 300, y: 183, width: 400, height: 266 });
  expect(m("key", { text: "ctrl+Page_Down", repeat: 3 })).toMatchObject({ type: "key", key: "ctrl+pagedown", times: 3 });
  expect(m("type", { text: "hello" })).toMatchObject({ type: "type", text: "hello" });
  expect(m("wait", { duration: 60 })).toMatchObject({ type: "wait", seconds: 10 });
  expect(m("left_mouse_down", {})).toMatchObject({ type: "mouse_down" });
  expect(m("cursor_position", {})).toMatchObject({ type: "cursor_position" });
  expect(m("click_element", { id: 7, clicks: 2 }, null)).toMatchObject({ type: "click_element", element: 7, times: 2, member: false });
  expect(m("run_script", { script: "beep" }, null)).toMatchObject({ type: "script", lang: "applescript", script: "beep" });
  expect(m("finish", { success: false, summary: "login needed" }, null)).toMatchObject({ type: "fail", reason: "login needed" });
  expect(m("ask", { question: "Two chats are called Jay —  which one?" }, null)).toMatchObject({ type: "ask", text: "Two chats are called Jay — which one?" });
});

test("a run that paused on a question tells the model the new task is the user's answer", () => {
  const prompt = systemPromptV2(request({
    goal: "the other Jay, +1 555 0100",
    previous: { goal: "send hi to Jay on WhatsApp", summary: "Two chats are called Jay — which one?", asked: true, steps: ["→ opened WhatsApp"] },
  }));
  expect(prompt).toContain("The task: the other Jay, +1 555 0100");
  expect(prompt).toContain("Earlier task: send hi to Jay on WhatsApp");
  expect(prompt).toContain("You paused it to ask: Two chats are called Jay — which one?");
  expect(prompt).toContain("don't ask the same thing again");
});

test("key names from the toolset become the Mac's names", () => {
  expect(normalizeKey("super+n")).toBe("cmd+n");
  expect(normalizeKey("Return")).toBe("return");
  expect(normalizeKey("Escape")).toBe("esc");
  expect(normalizeKey("alt+Tab")).toBe("opt+tab");
  expect(normalizeKey("KP_Enter")).toBe("keypadenter");
  expect(normalizeKey("Prior")).toBe("pageup");
  expect(normalizeKey("BackSpace")).toBe("backspace");
  expect(normalizeKey("ctrl+shift+A")).toBe("ctrl+shift+a");
  expect(normalizeKey("F5")).toBe("f5");
});

test("a reply without a tool call gets one nudge in the conversation", async () => {
  const api = fakeAPI([
    reply([{ type: "text", text: "I think it's done." }], "end_turn"),
    reply([{ type: "tool_use", id: "f", name: "finish", input: { success: true, summary: "done" } }]),
  ]);
  const out = await driveStep(request(), "sk", api.impl);
  expect(api.sent).toHaveLength(2);
  expect(api.sent[1].body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(out.actions[0].type).toBe("done");
  expect(sessionFor("run-1")?.messages).toHaveLength(4);
});

test("a lost conversation is rebuilt from the step summary", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "z", name: "finish", input: { success: true, summary: "ok" } }])]);
  await driveStep(request({
    step: 4,
    results: [{ id: "old", result: "pressed Send" }],
    history: [{ type: "open_app", app: "WhatsApp", result: "focused WhatsApp" }, { type: "click", target: "Send", result: "pressed “Send”" }],
  }), "sk", api.impl);
  const first = api.sent[0].body.messages;
  expect(first).toHaveLength(1);
  expect(first[0].content[0].text).toContain("the conversation was restarted");
  expect(first[0].content[0].text).toContain("open_app WhatsApp → focused WhatsApp");
});

test("a broken conversation (400 on a thinking block) starts over once instead of failing", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "a", name: "key", toolset_name: "computer", input: { text: "Return" } }]),
    new Response('{"error":{"message":"Invalid `signature` in `thinking` block"}}', { status: 400 }),
    reply([{ type: "tool_use", id: "b", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await driveStep(request(), "sk", api.impl);
  const out = await driveStep(request({ step: 1, results: [{ id: "a", result: "pressed return" }], history: [{ type: "key", key: "return", result: "pressed return" }] }), "sk", api.impl);
  expect(api.sent).toHaveLength(3);
  expect(api.sent[2].body.messages).toHaveLength(1);
  expect(out.actions[0].type).toBe("done");
});

test("escalation uses the stronger model for one turn and keeps the conversation", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "a", name: "key", toolset_name: "computer", input: { text: "Return" } }]),
    reply([{ type: "tool_use", id: "b", name: "key", toolset_name: "computer", input: { text: "Tab" } }]),
    reply([{ type: "tool_use", id: "c", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await driveStep(request(), "sk", api.impl);
  await driveStep(request({ step: 1, escalate: true, results: [{ id: "a", result: "ok" }] }), "sk", api.impl);
  await driveStep(request({ step: 2, results: [{ id: "b", result: "ok" }] }), "sk", api.impl);
  expect(api.sent.map((s) => s.body.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(api.sent[2].body.messages).toHaveLength(5);
});

test("transient errors retry; a rejected key does not", async () => {
  const api = fakeAPI([
    new Response("overloaded", { status: 529 }),
    reply([{ type: "tool_use", id: "a", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  const out = await driveStep(request(), "sk", api.impl);
  expect(api.sent).toHaveLength(2);
  expect(out.actions[0].type).toBe("done");

  resetSessions();
  const denied = fakeAPI([new Response("bad key", { status: 401 })]);
  const no = await driveStep(request(), "sk", denied.impl);
  expect(denied.sent).toHaveLength(1);
  expect(no.actions[0]).toMatchObject({ type: "fail" });
  expect(no.actions[0].reason).toContain("rejected");
});

function sse(events: Array<[string, Record<string, unknown>]>, cutAfter?: number): Response {
  const encoder = new TextEncoder();
  const chunks = events.map(([type, data]) => encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (cutAfter !== undefined && i === cutAfter) { controller.error(new Error("connection reset")); return; }
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[i++]);
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

const streamed: Array<[string, Record<string, unknown>]> = [
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 7000, cache_creation_input_tokens: 0, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "xyz" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "left_click", toolset_name: "computer", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"coordinate": [1' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '0, 20]}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t2", name: "type", toolset_name: "computer", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"text": "hi"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }],
  ["message_stop", { type: "message_stop" }],
];

test("a streamed reply hands over each action as it closes and is rebuilt exactly for the next turn", async () => {
  const api = fakeAPI([sse(streamed), reply([{ type: "tool_use", id: "f", name: "finish", input: { success: true, summary: "ok" } }])]);
  const seen: string[] = [];
  const out = await driveStep(request(), "sk", api.impl, 55_000, (action) => seen.push(`${action.id}:${action.type}`));
  expect(api.sent[0].body.stream).toBe(true);
  expect(seen).toEqual(["t1:click", "t2:type"]);
  expect(out.actions.map((a) => a.id)).toEqual(["t1", "t2"]);
  expect(out.meta?.usage).toEqual({ input: 12, cacheRead: 7000, cacheWrite: 0, output: 42 });
  expect(out.meta?.firstActionMs).toBeGreaterThanOrEqual(0);
  expect(sessionFor("run-1")?.messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig-xyz" },
      { type: "tool_use", id: "t1", name: "left_click", toolset_name: "computer", input: { coordinate: [10, 20] } },
      { type: "tool_use", id: "t2", name: "type", toolset_name: "computer", input: { text: "hi" } },
    ],
  });
  // The next (non-streamed) turn sends that rebuilt turn back unchanged.
  await driveStep(request({ step: 1, results: [{ id: "t1", result: "ok" }, { id: "t2", result: "ok" }] }), "sk", api.impl);
  expect(api.sent[1].body.messages[1]).toEqual(sessionFor("run-1")?.messages[1]);
});

test("a stream that drops after an action keeps the finished part instead of asking again", async () => {
  const api = fakeAPI([sse(streamed, 9)]);
  const seen: string[] = [];
  const out = await driveStep(request(), "sk", api.impl, 55_000, (action) => seen.push(action.id));
  expect(api.sent).toHaveLength(1);
  expect(seen).toEqual(["t1"]);
  expect(out.actions.map((a) => a.id)).toEqual(["t1"]);
  expect(sessionFor("run-1")?.pending.map((u) => u.id)).toEqual(["t1"]);
});

test("a stream cut in the middle of a tool call drops the half-written call rather than sending an empty action", async () => {
  // Cut after the first delta of t2: t1 is whole, t2 has an open block with partial JSON.
  const api = fakeAPI([sse(streamed, 10)]);
  const seen: string[] = [];
  const out = await driveStep(request(), "sk", api.impl, 55_000, (action) => seen.push(action.id));
  expect(seen).toEqual(["t1"]);
  expect(out.actions.map((a) => a.id)).toEqual(["t1"]);
  const turn = sessionFor("run-1")?.messages[1].content as Array<{ id?: string; type: string }>;
  expect(turn.filter((b) => b.type === "tool_use").map((b) => b.id)).toEqual(["t1"]);

  // Worst case: the cut lands inside a `finish` call. That must not end the run as a success.
  resetSessions();
  const finishing: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "f", name: "finish", toolset_name: "computer", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"success": true, "summ' } }],
  ];
  const retry = reply([{ type: "tool_use", id: "g", name: "left_click", input: { coordinate: [5, 5] } }]);
  const cut = fakeAPI([sse(finishing, 3), retry]);
  const again = await driveStep(request(), "sk", cut.impl, 55_000, () => {});
  expect(again.actions.map((a) => a.type)).not.toContain("done");
  expect(cut.sent.length).toBeGreaterThanOrEqual(2);
});

test("the approved plan reaches the model, and it is told to keep going rather than ask", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "a", name: "finish", input: { success: true, summary: "ok" } }])]);
  const plan = "Add a 9V battery, a resistor and an LED from the Basic components panel, then wire them in a closed series loop.";
  await driveStep(request({ goal: "make a basic circuit for me", plan }), "sk", api.impl);
  const system = api.sent[0].body.system[0].text as string;
  expect(system).toContain(`The plan the user approved: ${plan}`);
  expect(system).toContain("Never stop to ask whether to continue");
  expect(system).toContain("Never ask whether to continue");

  resetSessions();
  const same = fakeAPI([reply([{ type: "tool_use", id: "a", name: "finish", input: { success: true, summary: "ok" } }])]);
  await driveStep(request({ goal: "open notes", plan: "Open Notes" }), "sk", same.impl);
  expect(same.sent[0].body.system[0].text).not.toContain("The plan the user approved");
});

test("thinking off forces the tool call only on Haiku; an escalated Sonnet turn asks normally", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "a", name: "key", toolset_name: "computer", input: { text: "Return" } }]),
    reply([{ type: "tool_use", id: "b", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await driveStep(request({ effort: "none" }), "sk", api.impl);
  await driveStep(request({ step: 1, effort: "none", escalate: true, results: [{ id: "a", result: "ok" }] }), "sk", api.impl);
  expect(api.sent[0].body.tool_choice).toEqual({ type: "any" });
  expect(api.sent[0].body.output_config).toBeUndefined();
  expect(api.sent[1].body.model).toBe("claude-sonnet-5-5");
  expect(api.sent[1].body.tool_choice).toEqual({ type: "auto" });
  expect(api.sent[1].body.output_config).toEqual({ effort: "low" });
});

test("a field the model doesn't take is dropped and remembered instead of ending the run", async () => {
  const rejected = '{"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}';
  const api = fakeAPI([
    new Response(rejected, { status: 400 }),
    reply([{ type: "tool_use", id: "a", name: "key", toolset_name: "computer", input: { text: "Return" } }]),
    reply([{ type: "tool_use", id: "b", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  const out = await driveStep(request({ effort: "none" }), "sk", api.impl);
  expect(out.actions[0].type).toBe("key");
  expect(api.sent.map((s) => s.body.tool_choice)).toEqual([{ type: "any" }, { type: "auto" }]);
  await driveStep(request({ step: 1, effort: "none", results: [{ id: "a", result: "ok" }] }), "sk", api.impl);
  expect(api.sent[2].body.tool_choice).toEqual({ type: "auto" });

  resetSessions();
  const effort = fakeAPI([
    new Response('{"error":{"message":"output_config.effort: Extra inputs are not permitted"}}', { status: 400 }),
    reply([{ type: "tool_use", id: "a", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await driveStep(request({ settings: { claudeModel: "claude-opus-4-8" } }), "sk", effort.impl);
  expect(effort.sent[0].body.output_config).toEqual({ effort: "low" });
  expect(effort.sent[1].body.output_config).toBeUndefined();
});

test("the private Mac gets the toolset without scripts or numbered controls", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "a", name: "finish", input: { success: true, summary: "ok" } }])]);
  await driveStep(request({ remote: true }), "sk", api.impl);
  const body = api.sent[0].body;
  expect(body.tools.map((t: any) => t.name ?? t.type)).toEqual([TOOLSET_TYPE, "open_app", "open_url", "finish", "ask"]);
  expect(body.system[0].text).toContain("PRIVATE MAC");
  expect(body.messages[0].content[0].text).not.toContain("Frontmost app");
});
