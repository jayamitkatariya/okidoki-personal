import { beforeEach, expect, test } from "bun:test";
import { browserStep, mapBrowserTool, resetBrowserSessions, type BrowserRequest } from "../src/browser";

type Sent = { body: Record<string, any> };

function fakeAPI(replies: Array<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)) });
    const next = replies.shift() as any;
    if (!next) throw new Error("no reply queued");
    if (next.__status) return new Response(JSON.stringify(next), { status: next.__status });
    if (next.__sse) {
      const text = (next.__sse as Array<[string, unknown]>).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(next);
  }) as unknown as typeof fetch;
  return { impl, sent };
}

function reply(content: unknown[]) {
  return { content, stop_reason: "tool_use", usage: { input_tokens: 400, output_tokens: 40 } };
}

const page = {
  url: "https://www.google.com/",
  title: "Google",
  elements: '[1] combobox "Search"\n[2] button "Google Search"',
  text: "Google Search I'm Feeling Lucky",
};

function request(step: number, extra: Partial<BrowserRequest> = {}): BrowserRequest {
  return { runID: "run-1", goal: "find the weather in Lisbon", step, observation: page, ...extra };
}

beforeEach(() => resetBrowserSessions());

test("a turn sends the page as text and maps tool calls to actions", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "t1", name: "type", input: { ref: 1, text: "weather lisbon", submit: true } }])]);
  const response = await browserStep(request(0, { logins: ["github.com"] }), "key", api.impl);
  expect(response.actions).toEqual([{ type: "type", ref: 1, text: "weather lisbon", submit: true }]);
  const text = api.sent[0].body.messages[0].content.at(-1).text as string;
  expect(text).toContain("Task: find the weather in Lisbon");
  expect(text).toContain('[1] combobox "Search"');
  expect(text).toContain("Saved logins: github.com");
  // No screenshot unless the Mac sends one.
  expect(api.sent[0].body.messages[0].content.some((b: any) => b.type === "image")).toBe(false);
  expect(api.sent[0].body.tools.map((t: any) => t.name)).toContain("fill_login");
});

test("the next turn answers every tool call before the new page", async () => {
  const api = fakeAPI([
    reply([
      { type: "tool_use", id: "t1", name: "type", input: { ref: 1, text: "x" } },
      { type: "tool_use", id: "t2", name: "click", input: { ref: 2 } },
    ]),
    reply([{ type: "tool_use", id: "t3", name: "finish", input: { success: true, summary: "18°C and sunny" } }]),
  ]);
  await browserStep(request(0), "key", api.impl);
  const second = await browserStep(request(1, { results: [{ ok: true }, { ok: false, detail: "element 2 is gone" }] }), "key", api.impl);
  expect(second.actions).toEqual([{ type: "finish", success: true, summary: "18°C and sunny" }]);
  const turn = api.sent[1].body.messages.at(-1).content;
  expect(turn).toHaveLength(2);
  expect(turn[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" });
  expect(turn[1]).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
  // The new page rides inside the last result, where context editing can clear it later.
  expect(turn[1].content[0]).toEqual({ type: "text", text: "failed: element 2 is gone" });
  expect(turn[1].content.at(-1).text).toContain("URL: https://www.google.com/");
});

test("a malformed call doesn't shift the results of the calls after it", async () => {
  const api = fakeAPI([
    reply([
      { type: "tool_use", id: "bad", name: "click", input: { ref: "two" } },
      { type: "tool_use", id: "good", name: "click", input: { ref: 2 } },
    ]),
    reply([{ type: "tool_use", id: "t3", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  const first = await browserStep(request(0), "key", api.impl);
  expect(first.actions).toEqual([{ type: "click", ref: 2 }]);
  await browserStep(request(1, { results: [{ ok: false, detail: "element 2 is gone" }] }), "key", api.impl);
  const turn = api.sent[1].body.messages.at(-1).content;
  expect(turn[0]).toMatchObject({ tool_use_id: "bad", is_error: true });
  expect(turn[1]).toMatchObject({ tool_use_id: "good", is_error: true });
  expect(turn[1].content[0].text).toBe("failed: element 2 is gone");
});

test("turns ask for low effort and clear old pages server-side, never by editing history", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "t1", name: "click", input: { ref: 2 } }]),
    reply([{ type: "tool_use", id: "t2", name: "click", input: { ref: 1 } }]),
    reply([{ type: "tool_use", id: "t3", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await browserStep(request(0), "key", api.impl);
  await browserStep(request(1, { results: [{ ok: true }] }), "key", api.impl);
  await browserStep(request(2, { results: [{ ok: true }] }), "key", api.impl);
  const [first, second, third] = api.sent.map((s) => s.body);
  expect(first.output_config).toEqual({ effort: "medium" });
  expect(first.context_management.edits[0].type).toBe("clear_tool_uses_20250919");
  // Append-only: each request starts with the previous one's messages, byte for byte.
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(third.messages.slice(0, second.messages.length)).toEqual(second.messages);
});

test("a model that turns down effort is asked again without it", async () => {
  const api = fakeAPI([
    { __status: 400, error: "output_config.effort is not supported" },
    reply([{ type: "tool_use", id: "t1", name: "back", input: {} }]),
  ]);
  const response = await browserStep(request(0), "key", api.impl);
  expect(response.actions).toEqual([{ type: "back" }]);
  expect(api.sent[1].body.output_config).toBeUndefined();
});

test("a streamed turn hands over each action as it's written", async () => {
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "type", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ref": 1, "text": "lisbon", "submit": true}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "teleport", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const api = fakeAPI([{ __sse: events }]);
  const streamed: unknown[] = [];
  const response = await browserStep(request(0), "key", api.impl, 55_000, (action) => streamed.push(action));
  expect(api.sent[0].body.stream).toBe(true);
  expect(streamed).toEqual([{ type: "type", ref: 1, text: "lisbon", submit: true }]);
  expect(response.actions).toEqual(streamed);
});

test("a reply without tool calls ends the run instead of hanging", async () => {
  const api = fakeAPI([reply([{ type: "text", text: "This site needs a captcha." }])]);
  const response = await browserStep(request(0), "key", api.impl);
  expect(response.actions).toEqual([{ type: "finish", success: false, summary: "This site needs a captcha." }]);
});

test("a repeated step returns the committed reply without calling the model again", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "t1", name: "back", input: {} }])]);
  const first = await browserStep(request(0), "key", api.impl);
  const again = await browserStep(request(0), "key", api.impl);
  expect(again).toEqual(first);
  expect(api.sent).toHaveLength(1);
});

test("no key, no model call", async () => {
  const api = fakeAPI([]);
  const response = await browserStep(request(0), undefined, api.impl);
  expect(response.actions[0]).toMatchObject({ type: "finish", success: false });
  expect(api.sent).toHaveLength(0);
});

test("unknown or malformed tool calls are dropped", () => {
  expect(mapBrowserTool("click", { ref: "two" })).toBeUndefined();
  expect(mapBrowserTool("teleport", {})).toBeUndefined();
  expect(mapBrowserTool("scroll", { direction: "sideways" })).toEqual({ type: "scroll", direction: "down" });
  expect(mapBrowserTool("hover", { ref: 3 })).toEqual({ type: "hover", ref: 3 });
  expect(mapBrowserTool("wait", { seconds: 60 })).toEqual({ type: "wait", seconds: 10 });
});

test("dialogs and load errors reach the model", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "t1", name: "back", input: {} }])]);
  await browserStep(request(0, { observation: { ...page, dialogs: ["confirm “Delete this?” → OK"], loadError: "no internet connection" } }), "key", api.impl);
  const text = api.sent[0].body.messages[0].content.at(-1).text as string;
  expect(text).toContain("Dialogs: confirm “Delete this?” → OK");
  expect(text).toContain("Load error: no internet connection");
});

test("without context editing, a long run sends only the latest pages but keeps the task", async () => {
  const big = { ...page, text: "x".repeat(11_000), elements: "y".repeat(80_000) };
  const back = () => reply([{ type: "tool_use", id: `t${Math.random()}`, name: "back", input: {} }]);
  const api = fakeAPI([
    { __status: 400, error: "context_management: Extra inputs are not permitted" },
    ...Array.from({ length: 8 }, back),
  ]);
  for (let step = 0; step < 8; step++) {
    await browserStep(request(step, { observation: big, results: step ? [{ ok: true }] : undefined }), "key", api.impl);
  }
  const last = api.sent.at(-1)!.body;
  expect(last.context_management).toBeUndefined();
  const text = JSON.stringify(last.messages);
  expect(text).toContain("Task: find the weather in Lisbon");
  expect(text).toContain("(an earlier page, cleared)");
  // Every tool call still has its result, so the request stays valid.
  const results = last.messages.filter((m: any) => m.role === "user").flatMap((m: any) => m.content).filter((b: any) => b.type === "tool_result");
  expect(results.length).toBe(7);
  expect(text.length).toBeLessThan(500_000);
});

test("the agent hears when more of the page is further down", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "t1", name: "scroll", input: { direction: "down" } }])]);
  await browserStep(request(0, { observation: { ...page, more: 42 } }), "key", api.impl);
  expect(JSON.stringify(api.sent[0].body.messages)).toContain("(42 more further down the page: scroll down to see them)");
});

test("giving up is questioned once, and the run keeps going when there's more to try", async () => {
  const quit = reply([{ type: "tool_use", id: "q1", name: "finish", input: { success: false, summary: "size 8 is unavailable" } }]);
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "t1", name: "click", input: { ref: 2 } }]),
    quit,
    reply([{ type: "tool_use", id: "t2", name: "click", input: { ref: 1 } }]),
    reply([{ type: "tool_use", id: "q2", name: "finish", input: { success: false, summary: "none left" } }]),
  ]);
  await browserStep(request(0), "key", api.impl);
  const second = await browserStep(request(1, { results: [{ ok: true }] }), "key", api.impl);
  expect(second.actions).toEqual([{ type: "click", ref: 1 }]);
  const nudgeTurn = api.sent[2].body.messages.at(-1);
  expect(nudgeTurn.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "q1" });
  // From the nudge on, the run thinks harder.
  expect(api.sent[1].body.output_config).toEqual({ effort: "medium" });
  expect(api.sent[2].body.output_config).toEqual({ effort: "high" });
  // Not again right away: the next give-up a turn later goes through.
  const third = await browserStep(request(2, { results: [{ ok: true }] }), "key", api.impl);
  expect(third.actions).toEqual([{ type: "finish", success: false, summary: "none left" }]);
  expect(api.sent.length).toBe(4);
  // Still append-only across the nudge.
  expect(api.sent[3].body.messages.slice(0, api.sent[2].body.messages.length)).toEqual(api.sent[2].body.messages);
});

test("a give-up that offers the user a choice becomes a question", () => {
  const offer = "Size 8 is unavailable in blue. The closest is the black-blue pair at ₹2,299. Tell me if you want that one added.";
  expect(mapBrowserTool("finish", { success: false, summary: offer })).toEqual({ type: "ask", question: offer });
  expect(mapBrowserTool("finish", { success: false, summary: "the site is down." })).toEqual({ type: "finish", success: false, summary: "the site is down." });
  expect(mapBrowserTool("finish", { success: true, summary: "Added it. Want anything else?" })).toMatchObject({ type: "finish", success: true });
});

test("a session lost mid-run starts again with the task and a recap, not a bare page", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "t1", name: "click", input: { ref: 2 } }]),
    reply([{ type: "tool_use", id: "t2", name: "finish", input: { success: true, summary: "done" } }]),
  ]);
  await browserStep(request(0), "key", api.impl);
  resetBrowserSessions();
  await browserStep(request(1, { results: [{ ok: true }] }), "key", api.impl);
  const text = JSON.stringify(api.sent[1].body.messages);
  expect(text).toContain("Task: find the weather in Lisbon");
});

test("follow-ups carry the conversation, memory and tabs on the first turn", async () => {
  const api = fakeAPI([reply([{ type: "tool_use", id: "t1", name: "click", input: { ref: 2 } }])]);
  await browserStep(request(0, {
    goal: "add the cheapest one to the cart",
    context: [{ role: "user", text: "find blue puma football boots" }, { role: "assistant", text: "found three, from £40" }],
    memory: ["shoe size UK 9"],
    observation: { ...page, tabs: "[1] * Puma boots — https://puma.com\n[2] Cart — https://puma.com/cart" },
  }), "key", api.impl);
  const text = api.sent[0].body.messages[0].content.at(-1).text as string;
  expect(text).toContain("Earlier in this conversation:");
  expect(text).toContain("User: find blue puma football boots");
  expect(text).toContain("- shoe size UK 9");
  expect(text).toContain("[2] Cart");
  expect(text.indexOf("Earlier in this conversation")).toBeLessThan(text.indexOf("Task: add the cheapest"));
});

test("a reply with only words is told to act instead of ending the run", async () => {
  const api = fakeAPI([
    { content: [{ type: "text", text: "Let me look at the results." }], stop_reason: "end_turn", usage: {} },
    reply([{ type: "tool_use", id: "t1", name: "click", input: { ref: 2 } }]),
  ]);
  const response = await browserStep(request(0), "key", api.impl);
  expect(response.actions).toEqual([{ type: "click", ref: 2 }]);
  expect(api.sent).toHaveLength(2);
});

test("a refused history restarts the conversation with a recap instead of failing", async () => {
  const api = fakeAPI([
    reply([{ type: "tool_use", id: "t1", name: "navigate", input: { url: "https://example.com" } }]),
    { __status: 400, error: { message: "messages.1.content.0: invalid thinking signature" } },
    reply([{ type: "tool_use", id: "t2", name: "finish", input: { success: true, summary: "ok" } }]),
  ]);
  await browserStep(request(0), "key", api.impl);
  const second = await browserStep(request(1, { results: [{ ok: true }] }), "key", api.impl);
  expect(second.actions[0]).toMatchObject({ type: "finish", success: true });
  const retry = JSON.stringify(api.sent[2].body.messages);
  expect(api.sent[2].body.messages).toHaveLength(1);
  expect(retry).toContain("opened https://example.com");
  expect(retry).toContain("Task: find the weather in Lisbon");
});

test("no answer from the model leaves the run open for the Mac to ask again", async () => {
  const api = fakeAPI([{ __status: 400, error: { message: "something else" } }]);
  const response = await browserStep(request(0), "key", api.impl);
  expect(response.actions).toEqual([]);
  expect(response.error).toBeTruthy();
});

test("tab and memory tools map to actions", () => {
  expect(mapBrowserTool("new_tab", { url: "https://a.com" })).toEqual({ type: "new_tab", url: "https://a.com" });
  expect(mapBrowserTool("switch_tab", { tab: 2 })).toEqual({ type: "switch_tab", tab: 2 });
  expect(mapBrowserTool("close_tab", { tab: "x" })).toBeUndefined();
  expect(mapBrowserTool("remember", { fact: " shoe size UK 9 " })).toEqual({ type: "remember", fact: "shoe size UK 9" });
});
