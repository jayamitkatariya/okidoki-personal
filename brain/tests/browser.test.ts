import { beforeEach, expect, test } from "bun:test";
import { browserStep, mapBrowserTool, resetBrowserSessions, type BrowserRequest } from "../src/browser";

type Sent = { body: Record<string, any> };

function fakeAPI(replies: Array<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error("no reply queued");
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
  expect(turn[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: false });
  expect(turn[1]).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
  expect(turn.at(-1).text).toContain("element 2 is gone");
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
  expect(turn[1]).toMatchObject({ tool_use_id: "good", is_error: true, content: "failed: element 2 is gone" });
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
});
