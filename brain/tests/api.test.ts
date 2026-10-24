import { expect, test } from "bun:test";
import { computerAct } from "../src/computer";
import { groundTeach, think } from "../src/llm";
import { refineTeach, teachStep } from "../src/teach";

// Model the actual API restriction: Haiku accepts forced calls, Sonnet/Opus 5.5 do not.
// Exercise the production request builders and response parsers, without executing actions.
for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
  test(`${model}: answer, drive, teach, refine and ground use compatible tool calls`, async () => {
    const requests: Record<string, any>[] = [];
    const api = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (/claude-(sonnet|opus)-5-5/.test(body.model) && ["tool", "any"].includes(body.tool_choice?.type)) {
        return Response.json({ error: { type: "invalid_request_error", message: 'tool_choice: type "tool" and "any" are not supported for this model.' } }, { status: 400 });
      }
      const name = body.tools[0].name;
      const inputs: Record<string, object> = {
        okidoki_respond: { kind: "computer_use", title: "open notes", answer: "opening notes", apps: ["Notes"] },
        okidoki_act: { type: "open_app", app: "Notes", say: "opening notes" },
        okidoki_teach: { previous_done: true, action: "look", say: "look at the sidebar" },
        okidoki_point: { found: true, x: 24, y: 32, w: 16, h: 16 },
        okidoki_mark: { marks: [{ kind: "circle", rect: [0.1, 0.2, 0.03, 0.04], text: "new note" }] },
      };
      // Auto mode can emit thinking and prose before the tool; neither is the action.
      return Response.json({ content: [
        { type: "thinking", thinking: "Inspecting the request." },
        { type: "text", text: "I'll help with that." },
        { type: "tool_use", id: "toolu_test", name, input: inputs[name] },
      ] });
    }) as unknown as typeof fetch;

    const thought = await think({ text: "open Notes", settings: { claudeModel: model } }, "test-key", api);
    expect(thought.usedModel).toBe(true);
    expect(thought.decision.kind).toBe("computer_use");

    const action = await computerAct({ goal: "open Notes", step: 0, app: "Finder", screen: { x: 0, y: 0, width: 800, height: 600 }, imageWidth: 800, imageHeight: 600, history: [], settings: { claudeModel: model } }, "test-key", api);
    expect(action.usedModel).toBe(true);
    expect(action.action.type).toBe("open_app");
    expect(requests[1].model).toBe(model.includes("haiku") ? "claude-sonnet-5-5" : model);

    const lesson = await teachStep({ topic: "notes", outline: [], log: [], stepNumber: 1, imageWidth: 800, imageHeight: 600, model }, "test-key", api);
    expect(lesson.usedModel).toBe(true);
    expect(lesson.step?.action).toBe("look");

    const point = await refineTeach({ cropBase64: "image-fixture", cropWidth: 100, cropHeight: 100, describe: "new note", model }, "test-key", api);
    expect(point).toEqual({ found: true, x: 24, y: 32, w: 16, h: 16 });

    const ground = await groundTeach({ screenshotBase64: "image-fixture", topic: "notes", say: "new note", stepIndex: 0, stepCount: 1, space: "screen" }, "test-key", model, api);
    expect(ground.marks).toHaveLength(1);
    expect(ground.marks[0].text).toBe("new note");
    expect(requests).toHaveLength(5);
    for (const request of requests) expect(request.tool_choice).toEqual({ type: "auto" });
  });
}

test("an incompatible request or bad key is not retried as a transient error", async () => {
  for (const status of [400, 401]) {
    let calls = 0;
    const api = (async () => {
      calls++;
      return Response.json({ error: { message: "rejected" } }, { status });
    }) as unknown as typeof fetch;
    const result = await computerAct({ goal: "open Notes", step: 0, app: "Finder", screen: { x: 0, y: 0, width: 800, height: 600 }, imageWidth: 800, imageHeight: 600, history: [] }, "test-key", api);
    expect(result.usedModel).toBe(false);
    expect(result.action.type).toBe("fail");
    expect(calls).toBe(1);
  }
});

test("auto mode never treats a prose-only reply as a computer action", async () => {
  const api = (async () => Response.json({ content: [{ type: "text", text: "I opened Notes." }] })) as unknown as typeof fetch;
  const result = await computerAct({ goal: "open Notes", step: 0, screen: { x: 0, y: 0, width: 800, height: 600 }, imageWidth: 800, imageHeight: 600, history: [] }, "test-key", api);
  expect(result.usedModel).toBe(false);
  expect(result.action.type).toBe("fail");
  expect(result.error).toBe("empty model response");
});
