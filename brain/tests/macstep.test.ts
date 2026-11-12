import { describe, expect, test } from "bun:test";
import { macStep, macStepUser, normalizeActions } from "../src/macstep";

function modelReturning(input: unknown, status = 200) {
  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    if (status !== 200) return new Response("nope", { status });
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(input) }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const controls = [
  { id: 1, line: "TextField “Taxpayer name” = “”" },
  { id: 2, line: "Button “Continue”" },
];

describe("mac step", () => {
  test("asks with structured output, a closed schema and low effort, and keeps actions on the list", async () => {
    const { fetchImpl, sent } = modelReturning({ actions: [
      { type: "type", id: 1, text: "Bharat Mehta" }, { type: "click", id: 9 }, { type: "click", id: 2 }, { type: "finish", success: true, summary: "x" }, { type: "click", id: 1 },
    ] });
    const result = await macStep({ goal: "press the button that does what “Next” did", step: 0, app: "AcmeDesk", window: "AcmeDesk — Return details", controls }, "key", fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions.map((a) => `${a.type}${a.id ?? ""}`)).toEqual(["type1", "click2", "finish"]);
    const body = sent[0];
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.output_config.format.schema.properties.actions.items.additionalProperties).toBe(false);
    expect(body.tool_choice).toBeUndefined();
    expect(String(body.messages[0].content)).toContain("#2 Button “Continue”");
  });

  test("no usable action is an error, not an empty turn", async () => {
    const { fetchImpl } = modelReturning({ actions: [{ type: "click", id: 77 }, { type: "dance" }] });
    const result = await macStep({ goal: "x", step: 0, controls }, "key", fetchImpl);
    expect(result.ok).toBe(false);
    const failed = await macStep({ goal: "x", step: 0, controls }, "key", modelReturning({}, 500).fetchImpl);
    expect(failed.ok).toBe(false);
    expect((await macStep({ goal: " ", step: 0, controls }, "key", fetchImpl)).ok).toBe(false);
  });

  test("keys are normalised and need a key", () => {
    expect(normalizeActions({ actions: [{ type: "key", key: " Return " }, { type: "key" }] }, new Set())).toEqual([{ type: "key", key: "return" }]);
  });

  test("the prompt carries sheets, results and window text, bounded", () => {
    const text = macStepUser({ goal: "g", step: 2, window: "W", sheets: ["Stay signed in?"], text: "x".repeat(5000), controls, results: [{ ok: false, detail: "not found" }] });
    expect(text).toContain("In front of it: “Stay signed in?”");
    expect(text).toContain("1. didn't work (not found)");
    expect(text).toContain("This is turn 3.");
    expect(text.length).toBeLessThan(4000);
  });
});
