import type { TeachAnnotation, TeachNextGuess, TeachRefineRequest, TeachStep, TeachStepRequest } from "./types";

const ACTIONS = ["click", "double_click", "right_click", "drag", "type", "key", "scroll", "look", "open_app", "done"] as const;
const ANNOTATION_KINDS = ["callout", "badge", "bracket", "underline", "flow", "measure", "spotlight", "lens", "sketch", "ghost", "typing", "scroll"] as const;

const STEP_MODEL = "claude-sonnet-5-5";
const FAST_MODEL = "claude-haiku-5-5";

/** Writing a step means reading a busy screen and knowing the app: Sonnet, unless they chose bigger. Haiku keeps the zoom checks. */
export function teachModel(configured: string | undefined): string {
  const name = (configured ?? "").trim();
  return !name || name.toLowerCase().includes("haiku") ? STEP_MODEL : name;
}

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
      waiting: { type: "boolean", description: "true when the screen is still loading or mid-animation and you should look again in a moment instead of teaching" },
      action: { type: "string", enum: [...ACTIONS] },
      say: { type: "string", description: "one short sentence, spoken aloud and shown in a bubble by the control: its real name, the action, and the idea. two sentences only when the idea needs it" },
      why: { type: "string", description: "rare. one short sentence with the mental model behind this step, only when there is one" },
      label: { type: "string", description: "2-4 lowercase words for the tag beside the ring, e.g. 'frame tool', 'drag to playlist'" },
      element: { type: "integer", description: "the number of the marked element to point at. prefer this over x,y whenever the control has a marker" },
      x: { type: "number", description: "fallback: center of the control in screenshot pixels, origin top-left" },
      y: { type: "number" },
      w: { type: "number", description: "for a region (look, a panel, a settings group): width in screenshot pixels. omit for a button or icon" },
      h: { type: "number" },
      from_x: { type: "number", description: "drag start" },
      from_y: { type: "number" },
      to_x: { type: "number", description: "drag end" },
      to_y: { type: "number" },
      to_element: { type: "integer", description: "drag end as a marked element" },
      target: { type: "string", description: "the control's visible text label, exactly as written on screen. always fill it for click, double_click, right_click and type; okidoki checks the marker against it" },
      key: { type: "string", description: 'for key: the shortcut, e.g. "cmd+shift+a", "f", "return", "esc"' },
      text: { type: "string", description: "for type: what to type" },
      app: { type: "string", description: "for open_app: the app name" },
      risky: { type: "boolean", description: "true if this step is irreversible or costly: send, delete, buy, publish, overwrite, post" },
      summary: { type: "string", description: "for done: one warm sentence about what they can now do" },
      remaining: { type: "integer", description: "rough number of steps left after this one" },
      also_x: { type: "number", description: "optional second region worth a glance, e.g. where the result will show up. center x in screenshot pixels" },
      also_y: { type: "number" },
      also_w: { type: "number" },
      also_h: { type: "number" },
      also_label: { type: "string", description: "2-3 lowercase words for the second region" },
      annotations: {
        type: "array",
        description: "at most one extra drawing, only when it makes the step land. most steps have none. it has a kind and either element or x,y(,w,h).",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...ANNOTATION_KINDS] },
            text: { type: "string", description: "callout: one short sentence. badge: ignored (use n). measure: the value, e.g. '16px'. typing: the text. others: optional 1-3 words" },
            element: { type: "integer" },
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
            to_x: { type: "number", description: "flow/measure: end point" },
            to_y: { type: "number" },
            n: { type: "integer", description: "badge: the number to show" },
          },
          required: ["kind"],
        },
      },
      next: {
        type: "object",
        description: "your best guess at the step after this one, shown instantly when they land this step while you check. omit if unsure or if this is the last step.",
        properties: {
          say: { type: "string" },
          action: { type: "string", enum: [...ACTIONS] },
          label: { type: "string" },
          element: { type: "integer" },
          x: { type: "number" },
          y: { type: "number" },
          key: { type: "string" },
        },
        required: ["say", "action"],
      },
      milestones: {
        type: "array",
        items: { type: "string" },
        description: "only on the first step: 3-6 short chapter names for the whole lesson, e.g. ['make a frame', 'add a rectangle', 'auto layout']",
      },
      milestone: { type: "integer", description: "which chapter (0-based) this step belongs to" },
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
  const lines = controls.slice(0, 120).map((c) => {
    const size = c.w && c.h ? ` ${Math.round(c.w)}x${Math.round(c.h)}` : "";
    return `#${c.id ?? "?"} “${c.label}” (${c.role}) at ${Math.round(c.x)},${Math.round(c.y)}${size}`;
  });
  return [
    ``,
    `Marked elements. Each has a small pink number tag on the screenshot at its top-left; the list gives its label, role, center and size in screenshot pixels. When the thing you point at is marked, answer with element (its number). Use x,y only for things without a marker.`,
    ...lines,
  ].join("\n");
}

function modeLines(mode: string): string[] {
  if (mode === "practice") {
    return [
      `Mode: PRACTICE. They already saw this once and are trying alone. say names only the goal of the step ("make a frame") with no location hints. Still fill element/x,y so the ring can appear if they get stuck. If they do it, previous_done true and move on quickly.`,
    ];
  }
  return [
    `Mode: GUIDE ME. They do every action themselves. You point at the exact control and explain, one small step at a time, like a patient friend sitting beside them. The ring is how they find the control, so always give element or x,y — a step with no point leaves them searching.`,
  ];
}

export function teachSystemPrompt(request: TeachStepRequest): string {
  const outline = request.outline?.length
    ? request.outline.map((line, i) => `${i + 1}. ${line}`).join("\n")
    : "none — teach from what you see.";
  const log = request.log.length ? request.log.map(describe).join("\n") : "none yet. this is the first step.";
  const known = request.known?.length ? request.known.map((k) => `· ${k}`).join("\n") : "";
  const milestones = request.milestones?.length ? request.milestones.map((m, i) => `${i}. ${m}`).join("\n") : "";
  const page = [request.pageTitle ?? "", request.pageURL ?? ""].map((s) => s.trim()).filter(Boolean).join(" — ");
  const menus = request.menus?.length ? request.menus.join("\n") : "";
  return [
    `You are Okidoki's tutor. A person is learning "${request.topic}" in ${request.app || "the app on screen"} on their own Mac.`,
    `You see their screen right now.`,
    page
      ? `The browser tab in front is ${page}. The lesson is about that site, not the browser: teach with its own panels, menus and controls, never the browser's.`
      : ``,
    ...modeLines(request.mode || "guide"),
    `Reply with exactly ONE step through okidoki_teach.`,
    request.language ? `Write say, why and labels in ${request.language}.` : ``,
    ``,
    `How to teach:`,
    `- One action per step: a click, a key, a drag, typing something, or just looking at something while you explain it.`,
    `- say is one short sentence; two only when the idea needs it. Name the control by the label visible on screen, give the action, and the idea in the same breath ("a frame is a screen — click the frame tool, or press F").`,
    `- why is rare: one short sentence with the mental model, only when there is one. Most steps have none.`,
    `- label is 2-4 lowercase words for the tag beside the ring.`,
    `- Point exactly. Prefer element (a marker number). Otherwise x,y are pixels in the ${request.imageWidth}x${request.imageHeight} screenshot, origin top-left, at the center of the control. For a region set w,h to hug it. Always set target to the control's visible text label for click, double_click, right_click and type; okidoki checks the marker against it.`,
    `- A drag: action drag with from_x, from_y and to_x, to_y or to_element.`,
    `- A shortcut: action key with key. Still point (element or x,y) at where the result will show up when you can.`,
    `- Typing: action type with text, pointing at the field.`,
    `- Something to notice (a panel, the result of the last step): action look with a region.`,
    `- When the result of this step appears somewhere else, add also_x/also_y/also_w/also_h with also_label so they know where to watch.`,
    `- If they need another app: action open_app with app.`,
    `- Never box the whole window. If the control isn't visible, teach the step that reveals it first (open the menu, scroll, pick the tab). Only use look with no coordinates when there is truly nothing to point at.`,
    `- Only real things: name menus, items and controls that are in the marked elements, on the screenshot, or in the menu bar listed below. Never a path you only remember.`,
    `- No lecturing. Short, warm, lowercase labels, no emoji.`,
    ``,
    `Extra drawings (annotations): most steps need none. At most one, only when it makes the step land. spotlight at most once a lesson.`,
    `- callout: a short note with a leader line to a spot ("this number is the gap between items"). text required.`,
    `- badge: a numbered dot (n) for a sequence of places to click in order.`,
    `- bracket: a brace spanning a group (w,h) with a 1-3 word text ("the toolbar").`,
    `- underline: a hand-drawn underline under a label or menu item.`,
    `- flow: a cause→effect arrow from x,y to to_x,to_y ("this slider → that number").`,
    `- measure: a dimension line from x,y to to_x,to_y with text as the value ("16px").`,
    `- spotlight: dim everything except this region (x,y,w,h). Use once, for the key moment.`,
    `- lens: a magnifier over a tiny icon (element or x,y).`,
    `- sketch: a loose hand-drawn circle around something to glance at.`,
    `- ghost: a looping cursor demo of this step's click or drag (no coordinates needed; it uses the step's target).`,
    `- typing: a preview of what to type, floating by the field (text).`,
    `- scroll: chevrons showing which way to scroll (x,y; text "down" or "up").`,
    ``,
    `Checking their work:`,
    `- Look at the screenshot and the log. Set previous_done true if the last step happened: the screen shows its effect, or the log says they hit the target. Otherwise set previous_done false and give the same step again, pointing again, with a DIFFERENT explanation — a landmark ("top left, under the menu"), the icon's shape, or the shortcut. Never repeat yourself word for word, never scold.`,
    `- "landed" at the end of the log means okidoki saw their action hit the target. Its effect may not show (a tool selected, a mode toggled): previous_done is true, don't teach it again. Give the next step, or handle whatever appeared.`,
    `- "while i was checking" in the log lists what they did as you looked: the screenshot is newer than your last step, so judge from it.`,
    `- Start from where they are: if something is already set up or already done, don't redo it. If they already achieved what the next step would do, skip it.`,
    `- They may do it a different way, get ahead of you, or wander. Follow the screen, not the outline.`,
    `- If the screen is mid-load (spinner, blank page, half-drawn window), set waiting true with a short say and no action; you'll be asked again in a moment.`,
    `- If something unexpected appeared (a dialog, a menu, a different app), teach them through it.`,
    `- "skipped" in the log means they chose to move past that step: never give it again in any form, set previous_done true and teach the step after it (or whatever the screen needs next). "okidoki did it" means that step is done. "nothing yet" after a long wait means they're stuck: make the step smaller and more concrete.`,
    `- Never give a step that just failed in the same form. Change the approach.`,
    `- Pace to them: two clean hits in a row and you can take slightly bigger steps; a miss and you go smaller.`,
    ``,
    `Structure:`,
    `- On the FIRST step only, fill milestones: 3-6 short chapter names for the whole lesson. On every step set milestone to the chapter this step belongs to.`,
    `- Fill next with your best guess at the following step when you are fairly sure; it appears instantly when they land this step. Give it element or x,y too, so its ring can show at once — a guess with words only shows nothing to click.`,
    `- Set risky true for anything irreversible or costly (send, delete, buy, publish, overwrite, post). Okidoki will ask before doing those.`,
    ``,
    `Finishing:`,
    `- When the goal is reached, action done with summary and a warm one-line say that names what they can now do.`,
    `- Keep it tight: a small skill is 3-8 steps. remaining is your rough count of steps after this one.`,
    menus ? `\nThe app's menu bar, exactly as it is (never name a menu or item that isn't here):\n${menus}` : ``,
    ``,
    `Loose outline from the planner (adjust freely):`,
    outline,
    milestones ? `\nChapters so far:\n${milestones}` : ``,
    known ? `\nWhat they already know here (skip the basics of these):\n${known}` : ``,
    describeControls(request.controls),
    ``,
    `What has happened so far:`,
    log,
    request.landed && request.log.length ? `landed — okidoki saw that last action hit its target.` : ``,
  ].filter((line) => line !== undefined).join("\n");
}

function unitNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unitInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function unitString(value: unknown, max = 400): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function normalizeAnnotation(raw: unknown): TeachAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const kind = typeof a.kind === "string" && (ANNOTATION_KINDS as readonly string[]).includes(a.kind) ? a.kind : null;
  if (!kind) return null;
  return {
    kind: kind as TeachAnnotation["kind"],
    text: unitString(a.text, 120),
    element: unitInt(a.element),
    x: unitNumber(a.x),
    y: unitNumber(a.y),
    w: unitNumber(a.w),
    h: unitNumber(a.h),
    to_x: unitNumber(a.to_x),
    to_y: unitNumber(a.to_y),
    n: unitInt(a.n),
  };
}

function normalizeNext(raw: unknown): TeachNextGuess | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const n = raw as Record<string, unknown>;
  const say = unitString(n.say, 240);
  if (!say) return undefined;
  const action = typeof n.action === "string" && (ACTIONS as readonly string[]).includes(n.action) ? n.action : "look";
  return {
    say,
    action: action as TeachNextGuess["action"],
    label: unitString(n.label, 32)?.toLowerCase(),
    element: unitInt(n.element),
    x: unitNumber(n.x),
    y: unitNumber(n.y),
    key: unitString(n.key, 40),
  };
}

export function normalizeTeachStep(raw: Record<string, unknown>): TeachStep {
  const action = typeof raw.action === "string" && (ACTIONS as readonly string[]).includes(raw.action) ? raw.action : "look";
  const annotations = Array.isArray(raw.annotations)
    ? raw.annotations.map(normalizeAnnotation).filter((a): a is TeachAnnotation => a !== null).slice(0, 1)
    : [];
  const milestones = Array.isArray(raw.milestones)
    ? raw.milestones.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim().slice(0, 40)).slice(0, 6)
    : undefined;
  return {
    previous_done: raw.previous_done !== false,
    waiting: raw.waiting === true,
    action: action as TeachStep["action"],
    say: unitString(raw.say) ?? "",
    why: unitString(raw.why, 200),
    label: unitString(raw.label, 32)?.toLowerCase(),
    element: unitInt(raw.element),
    x: unitNumber(raw.x),
    y: unitNumber(raw.y),
    w: unitNumber(raw.w),
    h: unitNumber(raw.h),
    from_x: unitNumber(raw.from_x),
    from_y: unitNumber(raw.from_y),
    to_x: unitNumber(raw.to_x),
    to_y: unitNumber(raw.to_y),
    to_element: unitInt(raw.to_element),
    target: unitString(raw.target, 80),
    key: unitString(raw.key, 40),
    text: unitString(raw.text, 400),
    app: unitString(raw.app, 60),
    risky: raw.risky === true,
    summary: unitString(raw.summary, 240),
    remaining: unitInt(raw.remaining) === undefined ? undefined : Math.max(0, unitInt(raw.remaining) as number),
    also_x: unitNumber(raw.also_x),
    also_y: unitNumber(raw.also_y),
    also_w: unitNumber(raw.also_w),
    also_h: unitNumber(raw.also_h),
    also_label: unitString(raw.also_label, 28)?.toLowerCase(),
    annotations,
    next: normalizeNext(raw.next),
    milestones: milestones && milestones.length ? milestones : undefined,
    milestone: unitInt(raw.milestone),
  };
}

/**
 * One tool call with `tool_choice: auto`: Sonnet/Opus 5.5 reject forced tool choice, and in auto mode
 * the model may emit thinking or prose before the tool block, so the first tool_use block is the answer.
 */
export async function callAnthropic(body: unknown, apiKey: string, timeout: number, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
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

/** The fixed teaching rules go first so the API can cache them across steps. */
function splitSystem(full: string): { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] {
  const marker = "\nLoose outline from the planner";
  const at = full.indexOf(marker);
  if (at < 0) return [{ type: "text", text: full }];
  return [
    { type: "text", text: full.slice(0, at), cache_control: { type: "ephemeral" } },
    { type: "text", text: full.slice(at) },
  ];
}

/** One live tutoring step: look at the screen and the log, then point at the next thing. */
export async function teachStep(
  request: TeachStepRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ step: TeachStep | null; usedModel: boolean; error?: string }> {
  if (!apiKey) return { step: null, usedModel: false, error: "anthropic key required" };
  const model = teachModel(request.model);
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
      ? `Step ${request.stepNumber}. Frontmost app: ${request.app || "unknown"}. The screenshot is ${request.imageWidth}x${request.imageHeight} pixels${request.controls?.length ? ` with ${request.controls.length} marked elements` : ""}. Give the next step.`
      : `Step ${request.stepNumber}. Frontmost app: ${request.app || "unknown"}. No screenshot this turn — teach with words only (action look, no coordinates).`,
  });
  try {
    const input = await callAnthropic({
      model,
      max_tokens: 1100,
      system: splitSystem(teachSystemPrompt(request)),
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
  const model = request.model || FAST_MODEL;
  try {
    const input = await callAnthropic({
      model,
      max_tokens: 160,
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
