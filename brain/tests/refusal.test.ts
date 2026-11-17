import { expect, test } from "bun:test";
import { think } from "../src/llm";

const respond = (input: Record<string, unknown>) =>
  Response.json({ content: [{ type: "tool_use", name: "okidoki_respond", input }], stop_reason: "tool_use" });
const prose = (text: string, stop_reason = "end_turn") => Response.json({ content: [{ type: "text", text }], stop_reason });

test("the prompt routes sending through the approval card instead of forbidding it", async () => {
  const requests: any[] = [];
  const api = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return respond({ kind: "computer_use", title: "message mom", answer: "on it.", apps: ["WhatsApp"] });
  }) as typeof fetch;
  await think({ text: "message mom on whatsapp that i'm running late" }, "fixture-key", api);
  expect(requests[0].system).not.toContain("Never buy, send or delete");
  expect(requests[0].system).toContain("approval card");
});

test("a prose reply gets one nudge back to the tool, and the nudged decision is used", async () => {
  const requests: any[] = [];
  const api = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return requests.length === 1
      ? prose("I can't send messages on your behalf.")
      : respond({ kind: "computer_use", title: "send the message", answer: "sending it.", apps: ["Messages"] });
  }) as typeof fetch;
  const result = await think({ text: "text sam that i'm here" }, "fixture-key", api);
  // First call, then the nudge. No plan-review pass follows.
  expect(requests).toHaveLength(2);
  const nudge = requests[1].messages;
  expect(nudge.at(-2).role).toBe("assistant");
  expect(JSON.stringify(nudge.at(-2).content)).toContain("I can't send messages");
  expect(nudge.at(-1).content).toContain("okidoki_respond");
  expect(result.usedModel).toBe(true);
  expect(result.decision.kind).toBe("computer_use");
});

test("a refusal that survives the nudge is shown in the model's words, not as 'model unavailable'", async () => {
  const api = (async () => prose("I can't send messages on your behalf; that could be misused.")) as typeof fetch;
  const result = await think({ text: "text sam that i'm here" }, "fixture-key", api);
  expect(result.decision.kind).toBe("answer");
  expect(result.decision.title).toBe("i'd rather not");
  expect(result.decision.answer).toContain("can't send messages");
  expect(result.decision.answer).toContain("nothing was done");
  expect(result.decision.title).not.toBe("model unavailable");
});

test("stop_reason refusal is a decline straight away, with no nudge", async () => {
  let calls = 0;
  const api = (async () => { calls++; return Response.json({ content: [], stop_reason: "refusal" }); }) as typeof fetch;
  const result = await think({ text: "do the thing" }, "fixture-key", api);
  expect(calls).toBe(1);
  expect(result.decision.title).toBe("i'd rather not");
  expect(result.decision.answer).toContain("nothing was done");
});

test("prose that claims finished work still never gets through", async () => {
  const api = (async () => prose("Done. I sent it.")) as typeof fetch;
  const result = await think({ text: "send the report" }, "fixture-key", api);
  expect(result.usedModel).toBe(false);
  expect(result.decision.answer).not.toContain("I sent it");
  expect(result.error).toContain("structured decision");
});

test("an overloaded model gets one second try before the card gives up", async () => {
  let calls = 0;
  const api = (async () => ++calls === 1
    ? Response.json({ type: "error", error: { type: "overloaded_error" } }, { status: 529 })
    : respond({ kind: "answer", title: "hi", answer: "hello" })) as typeof fetch;
  const result = await think({ text: "say hi" }, "fixture-key", api);
  expect(calls).toBe(2);
  expect(result.usedModel).toBe(true);
  expect(result.decision.answer).toBe("hello");
});

test("a rejected key is still a rejected key", async () => {
  const api = (async () => Response.json({ error: "bad key" }, { status: 401 })) as typeof fetch;
  const result = await think({ text: "say hi" }, "fixture-key", api);
  expect(result.decision.title).toBe("key rejected");
});

test("a plain answer in prose (no tool call) is shown instead of failing", async () => {
  const api = (async () => prose("Your passport number is in the vault, in passport.pdf.")) as typeof fetch;
  const result = await think({ text: "where did I put my passport number?" }, "fixture-key", api);
  expect(result.usedModel).toBe(true);
  expect(result.decision.kind).toBe("answer");
  expect(result.decision.answer).toContain("passport.pdf");
});

test("prose that promises an action still stops instead of reading as an answer", async () => {
  const api = (async () => prose("Sure, I'll book the aisle seat for you now.")) as typeof fetch;
  const result = await think({ text: "book my seat" }, "fixture-key", api);
  expect(result.usedModel).toBe(false);
  expect(result.error).toContain("structured decision");
});
