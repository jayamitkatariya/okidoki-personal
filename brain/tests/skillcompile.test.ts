import { describe, expect, test } from "bun:test";
import { compileSkill, normalizeCompile, resolveValues, routeRequest } from "../src/skillcompile";

/** A fetch that answers with one forced tool call, and remembers what it was sent. */
function modelReturning(input: unknown, status = 200) {
  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    if (status !== 200) return new Response("nope", { status });
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(input) }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const steps = [
  { i: 0, action: "navigate", text: "open acme", input: "http://x/login.html" },
  { i: 1, action: "type", text: "type “Asha Rao” in “Full name”", label: "Full name", input: "Asha Rao", url: "http://x/form.html" },
  { i: 2, action: "click", text: "click “Submit”", url: "http://x/review.html" },
];

describe("compile", () => {
  test("forces the skill tool and keeps only answers that point at real steps", async () => {
    const { fetchImpl, sent } = modelReturning({
      intent: "file a return", inputs: [{ name: "name", description: "full name", kind: "text", example: "Asha Rao" }],
      substitutions: [{ step: 1, input: "{{name}}" }, { step: 9, input: "{{ghost}}" }],
      conditions: [{ step: 7, when: "{{x}}" }], loops: [], thinkSteps: [{ before: 2, goal: "add each deduction", when: "{{deductions}}" }, { before: 40, goal: "far away" }],
      irreversible: [2, 5], drop: [], capture: { name: "reference", example: "REF-448990" },
    });
    const result = await compileSkill({ goal: "file for Asha", surface: "browser", steps }, "key", fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sent[0].tool_choice).toBeUndefined();
    expect(sent[0].output_config.format.type).toBe("json_schema");
    expect(sent[0].output_config.format.schema.additionalProperties).toBe(false);
    expect(sent[0].output_config.format.schema.properties.inputs.items.additionalProperties).toBe(false);
    expect(result.skill.substitutions).toEqual([{ step: 1, input: "{{name}}" }]);
    expect(result.skill.conditions).toEqual([]);
    expect(result.skill.thinkSteps.map((t) => t.before)).toEqual([2]);
    expect(result.skill.irreversible).toEqual([2]);
    expect(result.skill.capture?.example).toBe("REF-448990");
  });

  test("without a key or steps it says so instead of throwing", async () => {
    expect((await compileSkill({ goal: "x", surface: "browser", steps }, undefined)).ok).toBe(false);
    expect((await compileSkill({ goal: "x", surface: "browser", steps: [] }, "key")).ok).toBe(false);
    const { fetchImpl } = modelReturning({}, 529);
    const failed = await compileSkill({ goal: "x", surface: "browser", steps }, "key", fetchImpl);
    expect(failed.ok).toBe(false);
  });

  test("normalize survives a sloppy answer", () => {
    const out = normalizeCompile({ inputs: [{ name: " pan ", kind: "" } as any, { foo: 1 } as any], loops: [{ start: 1, length: 0, over: "x" }] } as any, [0, 1]);
    expect(out.inputs).toEqual([{ name: "pan", kind: "text", description: "pan" }]);
    expect(out.loops).toEqual([]);
    expect(out.intent).toBe("");
  });
});

describe("resolve", () => {
  test("builds a schema with list fields and clamps what comes back", async () => {
    const { fetchImpl, sent } = modelReturning({
      pan: { value: "BHMPM5678L", confidence: 0.98, source: "Form16.pdf p1" },
      deductions: { value: [{ section: "80C", amount: "150000" }], confidence: 7 },
    });
    const result = await resolveValues({
      item: "Bharat",
      inputs: [{ name: "pan", description: "PAN", kind: "text" }, { name: "deductions", description: "rows", kind: "list", fields: ["section", "amount"] }, { name: "gains", description: "gains", kind: "money" }],
      documents: [{ name: "Form16.pdf", text: "PAN BHMPM5678L" }],
    }, "key", fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const schema = sent[0].output_config.format.schema;
    expect(schema.properties.deductions.properties.value.items.properties).toHaveProperty("amount");
    expect(result.values.pan).toEqual({ value: "BHMPM5678L", confidence: 0.98, source: "Form16.pdf p1" });
    expect(result.values.deductions!.confidence).toBe(1);
    expect(result.values.gains).toEqual({ value: "", confidence: 0 });
  });

  test("a page to read gets the reading prompt, not the document one", async () => {
    const { fetchImpl, sent } = modelReturning({ fare: { value: "$2,492, TAP Air Portugal, nonstop", confidence: 0.96 } });
    const result = await resolveValues({
      read: true,
      item: "San Jose to Chicago",
      inputs: [{ name: "fare", description: "the cheapest nonstop fare", kind: "text" }],
      documents: [{ name: "the page", text: "7:15 PM\n2:20 PM+1\nTap Air Portugal\n11 hr 5 min\nNonstop\n$2,492" }],
      request: "the cheapest fare among results marked Nonstop",
    }, "key", fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.fare!.value).toBe("$2,492, TAP Air Portugal, nonstop");
    // The system prompt has to tell it a rendered row's lines belong together; the document prompt
    // ("if it isn't there, give ''") made it answer nothing on every fare list.
    expect(sent[0].system).toMatch(/separate lines/);
    expect(sent[0].system).not.toMatch(/An optional input that the documents show is absent/);
    expect(JSON.stringify(sent[0].messages)).toContain("Question:");
  });
});

describe("route", () => {
  const skills = [{ id: "s1", name: "file acme return", intent: "file a return on acme", itemNoun: "person", inputs: ["name", "pan"] }];

  test("keeps a known skill and its items", async () => {
    const { fetchImpl } = modelReturning({ kind: "skill", id: "s1", items: ["Jay", " Jia "], overrides: { regime: "old", bad: 3 }, confidence: 0.9 });
    const result = await routeRequest({ request: "file returns for Jay and Jia", skills }, "key", fetchImpl);
    expect(result.ok && result.route).toEqual({ kind: "skill", id: "s1", items: ["Jay", "Jia"], overrides: { regime: "old" }, confidence: 0.9 });
  });

  test("overrides arrive as name/value pairs", async () => {
    const { fetchImpl } = modelReturning({ kind: "skill", id: "s1", items: [], overrides: [{ name: "regime", value: "old" }], confidence: 0.9 });
    const result = await routeRequest({ request: "file mine, old regime", skills }, "key", fetchImpl);
    expect(result.ok && result.route.overrides).toEqual({ regime: "old" });
  });

  test("an unknown id falls back to the agent", async () => {
    const { fetchImpl } = modelReturning({ kind: "skill", id: "nope", items: [], overrides: {}, confidence: 0.99 });
    const result = await routeRequest({ request: "do it", skills }, "key", fetchImpl);
    expect(result.ok && result.route.kind).toBe("agent");
  });

  test("no skills means the agent, without a model call", async () => {
    const { fetchImpl, sent } = modelReturning({});
    const result = await routeRequest({ request: "book a flight", skills: [] }, "key", fetchImpl);
    expect(result.ok && result.route.kind).toBe("agent");
    expect(sent.length).toBe(0);
  });
});
