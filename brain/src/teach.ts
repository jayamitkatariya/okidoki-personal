import type { TeachRefineRequest, TeachStep, TeachStepRequest } from "./types";

const teachTool = {
  name: "okidoki_teach",
  description: "Give the learner exactly one next step on their real screen, or finish the lesson.",
  input_schema: {
    type: "object",
    properties: {
      previous_done: {
        type: "boolean",
        description: "did the learner complete the previous step? judge from the screenshot and the log. true on the first step.",
      },
      action: {
        type: "string",
        enum: ["click", "double_click", "right_click", "drag", "type", "key", "scroll", "look", "open_app", "done"],
      },
      say: { type: "string", description: "one or two short sentences, spoken aloud and shown: the control's real name, the action, and the idea" },
      why: { type: "string", description: "optional. one short sentence with the idea or mental model behind this step" },
      label: { type: "string", description: "2-4 lowercase words for the tag drawn next to the ring, e.g. 'frame tool', 'drag to playlist'" },
      x: { type: "number", description: "center of the control in screenshot pixels, origin top-left" },
      y: { type: "number" },
      w: { type: "number", description: "for a region (look, a panel, a settings group): width in screenshot pixels. omit for a button or icon" },
      h: { type: "number" },
      from_x: { type: "number", description: "drag start" },
      from_y: { type: "number" },
      to_x: { type: "number", description: "drag end" },
      to_y: { type: "number" },
      target: { type: "string", description: "the control's visible text label, exactly as written on screen or in the controls list. the Mac snaps the ring to its real bounds" },
      key: { type: "string", description: 'for key: the shortcut, e.g. "cmd+shift+a", "f", "return", "esc"' },
      text: { type: "string", description: "for type: what to type" },
      app: { type: "string", description: "for open_app: the app name" },
      summary: { type: "string", description: "for done: one warm sentence about what they just learned" },
      remaining: { type: "integer", description: "rough number of steps left after this one" },
      also_x: { type: "number", description: "optional second region worth a glance, e.g. where the result will show up. center x in screenshot pixels" },
      also_y: { type: "number" },
      also_w: { type: "number" },
      also_h: { type: "number" },
      also_label: { type: "string", description: "2-3 lowercase words for the second region" },
    },
    required: ["previous_done", "action", "say"],
  },
};

function describe(entry: TeachStepRequest["log"][number], index: number): string {
  const head = `${index + 1}. ${entry.action}${entry.label ? ` “${entry.label}”` : ""}: ${entry.say}`;
  return `${head}\n   → ${entry.outcome || "nothing yet"}`;
}

function describeControls(controls: TeachStepRequest["controls"]): string {
  if (!controls?.length) return "";
  const lines = controls.slice(0, 90).map((c) => {
    const size = c.w && c.h ? ` ${Math.round(c.w)}x${Math.round(c.h)}` : "";
    return `· “${c.label}” (${c.role}) at ${Math.round(c.x)},${Math.round(c.y)}${size}`;
  });
  return [
    ``,
    `Controls the Mac can see through accessibility, with centers in screenshot pixels. When the thing you point at is in this list, copy its label into target exactly and use its center for x,y:`,
    ...lines,
  ].join("\n");
}

export function teachSystemPrompt(request: TeachStepRequest): string {
  const outline = request.outline?.length
    ? request.outline.map((line, i) => `${i + 1}. ${line}`).join("\n")
    : "none — teach from what you see.";
  const log = request.log.length ? request.log.map(describe).join("\n") : "none yet. this is the first step.";
  return [
    `You are Okidoki's tutor. A person is learning "${request.topic}" in ${request.app || "the app on screen"} on their own Mac.`,
    `You see their screen right now. They do every action themselves. You point at the exact control and explain, one small step at a time, like a patient friend sitting beside them.`,
    `Reply with exactly ONE step through okidoki_teach.`,
    ``,
    `How to teach:`,
    `- One action per step: a click, a key, a drag, typing something, or just looking at something while you explain it.`,
    `- say is one or two short sentences, spoken aloud and shown. Name the control by the label visible on screen, give the action, and the idea in the same breath ("a frame is a screen — click the frame tool, or press F").`,
    `- why is optional: one short sentence with the concept or mental model. Skip it for obvious steps.`,
    `- label is 2-4 lowercase words for the tag beside the ring, e.g. "frame tool", "drag to playlist".`,
    `- Point exactly. x,y are pixels in the screenshot, origin top-left, at the center of the control. The image is ${request.imageWidth}x${request.imageHeight}. For a region set w,h to hug it. Set target to the control's visible text label when it has one.`,
    `- A drag: action drag with from_x, from_y, to_x, to_y.`,
    `- A shortcut: action key with key. Still set x,y to where the result will show up when you can.`,
    `- Typing: action type with text, and x,y on the field they type into.`,
    `- Something to notice (a panel, the result of the last step): action look with x,y,w,h around it.`,
    `- When the result of this step appears somewhere else, add also_x/also_y/also_w/also_h with also_label so they know where to watch.`,
    `- If they need another app: action open_app with app.`,
    `- Never box the whole window. If the control isn't visible, teach the step that reveals it first (open the menu, scroll, pick the tab). Only use look with no coordinates when there is truly nothing to point at.`,
    `- No lecturing. Short, warm, lowercase labels, no emoji.`,
    ``,
    `Checking their work:`,
    `- Look at the screenshot and the log. Set previous_done true if the last step happened: the screen shows its effect, or the log says they hit the target. Otherwise set previous_done false and give the same step again, pointing again, with a different explanation — a landmark ("top left, under the menu"), the icon's shape, or the shortcut. Never repeat yourself word for word, never scold.`,
    `- They may do it a different way, get ahead of you, or wander. Follow the screen, not the outline. If they already achieved what the next step would do, skip it.`,
    `- If something unexpected appeared (a dialog, a menu, a different app), teach them through it.`,
    `- "skipped" in the log means move on. "okidoki did it" means that step is done. "nothing yet" after a long wait means they're stuck: make the step smaller and more concrete.`,
    `- Pace to them: two clean hits in a row and you can take slightly bigger steps; a miss and you go smaller.`,
    ``,
    `Finishing:`,
    `- When the goal is reached, action done with summary and a warm one-line say that names what they can now do.`,
    `- Keep it tight: a small skill is 3-8 steps. remaining is your rough count of steps after this one.`,
    ``,
    `Loose outline from the planner (adjust freely):`,
    outline,
    describeControls(request.controls),
    ``,
    `What has happened so far:`,
    log,
  ].join("\n");
}

function unitNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unitString(value: unknown, max = 400): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function normalizeTeachStep(raw: Record<string, unknown>): TeachStep {
  const allowed = ["click", "double_click", "right_click", "drag", "type", "key", "scroll", "look", "open_app", "done"];
  const action = typeof raw.action === "string" && allowed.includes(raw.action) ? raw.action : "look";
  return {
    previous_done: raw.previous_done !== false,
    action: action as TeachStep["action"],
    say: unitString(raw.say) ?? "",
    why: unitString(raw.why, 200),
    label: unitString(raw.label, 32)?.toLowerCase(),
    x: unitNumber(raw.x),
    y: unitNumber(raw.y),
    w: unitNumber(raw.w),
    h: unitNumber(raw.h),
    from_x: unitNumber(raw.from_x),
    from_y: unitNumber(raw.from_y),
    to_x: unitNumber(raw.to_x),
    to_y: unitNumber(raw.to_y),
    target: unitString(raw.target, 80),
    key: unitString(raw.key, 40),
    text: unitString(raw.text, 400),
    app: unitString(raw.app, 60),
    summary: unitString(raw.summary, 240),
    remaining: typeof raw.remaining === "number" && Number.isFinite(raw.remaining) ? Math.max(0, Math.round(raw.remaining)) : undefined,
    also_x: unitNumber(raw.also_x),
    also_y: unitNumber(raw.also_y),
    also_w: unitNumber(raw.also_w),
    also_h: unitNumber(raw.also_h),
    also_label: unitString(raw.also_label, 28)?.toLowerCase(),
  };
}

async function callAnthropic(body: unknown, apiKey: string, timeout: number, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160);
    throw new Error(`model ${response.status}: ${detail}`);
  }
  const json = (await response.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
  return json.content?.find((b) => b.type === "tool_use" && b.input)?.input ?? null;
}

/** One live tutoring step: look at the screen and the log, then point at the next thing. */
export async function teachStep(
  request: TeachStepRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ step: TeachStep | null; usedModel: boolean; error?: string }> {
  if (!apiKey) return { step: null, usedModel: false, error: "anthropic key required" };
  const model = request.model || "claude-sonnet-4-5";
  const content: unknown[] = [];
  if (request.screenshotBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: request.screenshotBase64 },
    });
  }
  content.push({
    type: "text",
    text: request.screenshotBase64
      ? `Step ${request.stepNumber}. Frontmost app: ${request.app || "unknown"}. The screenshot is ${request.imageWidth}x${request.imageHeight} pixels. Give the next step.`
      : `Step ${request.stepNumber}. Frontmost app: ${request.app || "unknown"}. No screenshot this turn — teach with words only (action look, no coordinates).`,
  });
  try {
    const input = await callAnthropic({
      model,
      max_tokens: 800,
      system: teachSystemPrompt(request),
      messages: [{ role: "user", content }],
      tools: [teachTool],
      tool_choice: { type: "auto" },
    }, apiKey, 60_000, fetchImpl);
    if (!input) return { step: null, usedModel: false, error: "empty model response" };
    return { step: normalizeTeachStep(input), usedModel: true };
  } catch (error) {
    return { step: null, usedModel: false, error: error instanceof Error ? error.message : "model unavailable" };
  }
}

const pointTool = {
  name: "okidoki_point",
  description: "Give the exact pixel center of one control in a zoomed crop of the screen.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "false if the control is not in this crop" },
      x: { type: "number", description: "center x in crop pixels, origin top-left" },
      y: { type: "number" },
      w: { type: "number", description: "width of the control in crop pixels" },
      h: { type: "number" },
    },
    required: ["found"],
  },
};

/** Second look at a zoomed crop so a small icon's ring lands on the exact pixels. */
export async function refineTeach(
  request: TeachRefineRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ found: boolean; x?: number; y?: number; w?: number; h?: number }> {
  if (!apiKey || !request.cropBase64) return { found: false };
  const model = request.model || "claude-sonnet-4-5";
  try {
    const input = await callAnthropic({
      model,
      max_tokens: 120,
      system: `You pinpoint one control in a zoomed crop of a Mac screen (${request.cropWidth}x${request.cropHeight} pixels, origin top-left). Return its exact center and size through okidoki_point. If it is not in the crop, found is false.`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: request.cropBase64 } },
          { type: "text", text: `Find: ${request.describe}` },
        ],
      }],
      tools: [pointTool],
      tool_choice: { type: "auto" },
    }, apiKey, 25_000, fetchImpl);
    if (!input || input.found === false) return { found: false };
    const x = unitNumber(input.x);
    const y = unitNumber(input.y);
    if (x == null || y == null || x < 0 || y < 0 || x > request.cropWidth || y > request.cropHeight) return { found: false };
    return { found: true, x, y, w: unitNumber(input.w), h: unitNumber(input.h) };
  } catch {
    return { found: false };
  }
}
