import { expect, test } from "bun:test";
import { conceptFollowUp, conceptLesson, partialField, sanitizeScene } from "../src/concept";

test("a scene keeps only well-formed parts and actions", () => {
  const { scene, parts, warnings } = sanitizeScene({
    title: "engine",
    mode: "3d",
    camera: { position: [5, 3, 7], target: [0, 0, 0] },
    parts: [
      { id: "crank", type: "cylinder", name: "crankshaft", description: "turns the up-and-down into round-and-round", radius: 0.3, height: 4, rotation: [0, 0, 1.5708] },
      { id: "piston1", type: "cylinder", name: "piston", radius: 0.5, height: 0.8, position: [-1.5, 2, 0], visible: false, parent: "crank" },
      { id: "ghost", type: "hologram", name: "nope" },
      { id: "crank", type: "box", size: [1, 1, 1] },
      { type: "box", size: [1, 1, 1] },
      { id: "orphan", type: "sphere", radius: 1, parent: "missing" },
    ],
    beats: [
      { say: "here's the crank", actions: [{ type: "show", ids: ["crank", "nothing"], effect: "grow" }, { type: "spin", id: "crank", axis: "z", rpm: 999999, on: true }], points: [[0.5, 0.5], [2, 2]] },
      { say: "", actions: [] },
      { say: "and a piston", actions: [{ type: "teleport", id: "piston1" }, { type: "move", id: "nobody", to: [0, 0, 0] }, { type: "explode", factor: 9 }] },
    ],
  });
  const ids = (scene.parts as { id: string }[]).map((p) => p.id);
  expect(ids).toEqual(["crank", "piston1", "orphan"]);
  expect((scene.parts as { parent?: string }[])[2].parent).toBeUndefined();
  expect(parts.map((p) => p.name)).toEqual(["crankshaft", "piston"]);
  expect(warnings.some((w) => w.includes("hologram"))).toBe(true);
  const beats = scene.beats as { say: string; actions: { type: string; ids?: string[]; rpm?: number; factor?: number }[]; points: number[][] }[];
  expect(beats).toHaveLength(2);
  expect(beats[0].actions[0].ids).toEqual(["crank"]);
  expect(beats[0].actions[1].rpm).toBe(600);
  expect(beats[0].points).toEqual([[0.5, 0.5]]);
  expect(beats[1].actions.map((a) => a.type)).toEqual(["explode"]);
  expect(beats[1].actions[0].factor).toBe(3);
});

/** The Anthropic streaming shape: a tool_use block whose JSON arrives in input_json_delta pieces. */
function sseToolStream(input: unknown, pieces = 6): Response {
  const text = JSON.stringify(input);
  const size = Math.ceil(text.length / pieces);
  const lines: string[] = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "okidoki_concept", input: {} } })}\n\n`,
  ];
  for (let i = 0; i < text.length; i += size) {
    lines.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: text.slice(i, i + size) } })}\n\n`);
  }
  lines.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  lines.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) controller.enqueue(encoder.encode(lines[i++]));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const engineInput = {
  title: "four-stroke engine",
  intro: "an engine is a pump that runs on tiny explosions.",
  mode: "3d",
  parts: [
    { id: "block", type: "box", name: "engine block", description: "the housing", size: [3, 2, 2] },
    { id: "label", type: "label", text: "block", anchor: "block" },
  ],
  beats: [
    { say: "this is the block.", actions: [{ type: "show", ids: ["block"], effect: "grow" }] },
    { say: "now we look inside.", caption: "cutaway", actions: [{ type: "cutaway", axis: "x", at: 0, on: true }], duration: 3 },
  ],
};

test("a concept lesson is built from the streamed tool reply and carries beats and parts", async () => {
  const api = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.tools[0].name).toBe("okidoki_concept");
    return sseToolStream(engineInput);
  }) as unknown as typeof fetch;
  const result = await conceptLesson({ topic: "how an engine works" }, "test-key", api);
  expect(result.usedModel).toBe(true);
  expect(result.lesson?.title).toBe("four-stroke engine");
  expect(result.lesson?.beats).toHaveLength(2);
  expect(result.lesson?.beats[1].caption).toBe("cutaway");
  expect(result.lesson?.parts).toEqual(["block: engine block"]);
  const scene = JSON.parse(result.lesson!.sceneJSON);
  expect(scene.parts).toHaveLength(2);
  expect(scene.camera.position).toEqual([6, 4, 8]);
});

test("the title and intro are reported before the lesson finishes streaming", async () => {
  const api = (async () => sseToolStream(engineInput, 40)) as unknown as typeof fetch;
  const order: string[] = [];
  const result = await conceptLesson({ topic: "engine" }, "test-key", api, {
    intro: (title, intro) => order.push(`intro:${title}|${intro}`),
  });
  order.push("lesson");
  expect(order).toEqual(["intro:four-stroke engine|an engine is a pump that runs on tiny explosions.", "lesson"]);
  expect(result.lesson?.intro).toBe("an engine is a pump that runs on tiny explosions.");
});

test("partialField waits for the closing quote and unescapes", () => {
  expect(partialField('{"title": "four-str', "title")).toBeUndefined();
  expect(partialField('{"title": "four-stroke engine", "intro": "say \\"hi\\"', "title")).toBe("four-stroke engine");
  expect(partialField('{"title": "x", "intro": "say \\"hi\\" now"}', "intro")).toBe('say "hi" now');
});

test("a follow-up answers and appends beats that reference existing parts", async () => {
  const api = (async () => Response.json({ content: [{ type: "tool_use", id: "t", name: "okidoki_concept_more", input: {
    answer: "the piston is what the explosion pushes.",
    beats: [{ say: "watch it move", actions: [{ type: "highlight", ids: ["piston1"], on: true }, { type: "camera", position: [2, 2, 3], target: [0, 1, 0] }] }],
  } }] })) as unknown as typeof fetch;
  const result = await conceptFollowUp({ topic: "engine", question: "what's the piston?", partId: "piston1", partName: "piston", sceneSummary: "parts: piston1: piston" }, "test-key", api);
  expect(result.usedModel).toBe(true);
  expect(result.follow?.answer).toContain("piston");
  expect(result.follow?.beats).toHaveLength(1);
  const append = JSON.parse(result.follow!.appendJSON);
  expect(append.beats[0].actions).toHaveLength(2);
});

test("concept routes refuse without a key", async () => {
  const result = await conceptLesson({ topic: "x" }, undefined);
  expect(result.lesson).toBeNull();
  expect(result.error).toContain("anthropic key");
});
