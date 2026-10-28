/**
 * Driving protocol v2: Anthropic's computer use toolset plus okidoki's own tools, as one append-only
 * conversation per run.
 *
 * - The model can return several actions in one turn (a batch). The Mac runs them in order, stops at
 *   the first failure, and sends back one result per action plus a fresh screenshot.
 * - The conversation is append-only: the model's turns go back exactly as they came (thinking
 *   included), and earlier turns are never edited. Old screenshots are cleared on the server
 *   (context management), which keeps the cache and the thinking blocks valid.
 * - The instructions and tools never change during a run, so they stay cached; everything that
 *   changes per step travels in the newest user turn.
 */
import { drivingModel, image, readUsage, RETRY_STATUSES, type ModelUsage } from "./computer";
import type { DriveAction, DriveObservation, DriveRequest, DriveResult } from "./types";

export const TOOLSET_TYPE = "computer_toolset_20260801";
export const CONTEXT_BETA = "context-management-2025-06-27";
/** The exact text the API expects for batch actions skipped after a failure. */
export const HALT_TEXT = "Not executed: an earlier computer action in this turn failed.";
export const ESCALATION_MODEL = "claude-sonnet-5-5";
/** Pixels one scroll-wheel click moves. */
export const SCROLL_CLICK_PX = 60;

const TOOLSET_MODELS = [
  "claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5",
  "claude-opus-4-8", "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5",
];

/** Models that take the computer use toolset. Anything else stays on the single-action protocol. */
export function supportsToolset(model: string): boolean {
  const name = model.trim().toLowerCase();
  return TOOLSET_MODELS.some((id) => name === id || name.startsWith(`${id}-2`));
}

const MEMBERS = new Set([
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll",
  "type", "key", "hold_key", "wait",
]);

// MARK: - Tools

function customTools(remote: boolean): unknown[] {
  const tools: unknown[] = [];
  if (!remote) {
    tools.push({
      name: "run_script",
      description:
        "Run AppleScript (default), JXA (lang javascript) or zsh (lang shell) on the Mac and get its output or error. " +
        "Best for anything scriptable: Notes, Reminders, Calendar, Mail, Messages, Finder, Safari, Music, menu items through System Events, volume, clipboard, Shortcuts. " +
        "One whole program per call. Never press keys or click from inside a script.",
      input_schema: {
        type: "object",
        properties: {
          script: { type: "string", description: "the complete program" },
          lang: { type: "string", enum: ["applescript", "javascript", "shell"] },
        },
        required: ["script"],
      },
    });
  }
  tools.push(
    {
      name: "open_app",
      description: "Open an app by name, or bring it to the front if it is already running. The result says when it is frontmost.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "open_url",
      description: "Open an http(s), file or mailto URL in its default app. The Mac waits for the page to load before the next screenshot.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  );
  if (!remote) {
    tools.push({
      name: "click_element",
      description:
        "Click a control from the numbered list of controls by its number. Exact: it presses that very control. " +
        "Prefer it over a pixel click whenever the control you want is listed.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "integer", description: "the control's number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          clicks: { type: "integer", enum: [1, 2, 3] },
          modifiers: { type: "string", description: 'keys to hold, e.g. "super" or "shift"' },
        },
        required: ["id"],
      },
    });
  }
  tools.push(
    {
      name: "finish",
      description:
        "End the task. success true only when the newest screenshot or result shows the whole task is done; " +
        "false after several different approaches failed. summary: one short sentence the user reads.",
      input_schema: {
        type: "object",
        properties: { success: { type: "boolean" }, summary: { type: "string" } },
        required: ["success", "summary"],
      },
    },
    {
      name: "ask",
      description:
        "Pause the task and ask the user one question when it can't go on without something only they know: " +
        "which of several matching contacts, files or accounts; a detail the task left out. " +
        "Not for permission to continue or for choices the task already covers. " +
        "question: one short sentence; their reply resumes the task.",
      input_schema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  );
  return tools;
}

export function toolsFor(remote: boolean): unknown[] {
  return [{ type: TOOLSET_TYPE }, ...customTools(remote)];
}

// MARK: - Instructions

function planText(request: DriveRequest): string {
  const plan = request.plan?.replace(/\s+/g, " ").trim();
  if (!plan || plan.toLowerCase() === request.goal.trim().toLowerCase()) return "";
  return `The plan the user approved: ${plan.slice(0, 600)}`;
}

function previousRunText(request: DriveRequest): string {
  const prev = request.previous;
  if (!prev?.goal) return "";
  const steps = (prev.steps ?? []).slice(-8).map((s) => `  ${s.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  if (prev.asked) {
    return [
      ``,
      `This continues an earlier run in the same conversation. Earlier task: ${prev.goal}`,
      `You paused it to ask: ${prev.summary ?? "a question"}`,
      `The task above is the user's answer. Carry on with the earlier task using it; don't ask the same thing again.`,
      steps ? `Its last steps:\n${steps}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    ``,
    `This continues an earlier run in the same conversation. Earlier task: ${prev.goal}`,
    prev.summary ? `How it ended: ${prev.summary}` : "",
    steps ? `Its last steps:\n${steps}` : "",
  ].filter(Boolean).join("\n");
}

export function systemPromptV2(request: DriveRequest): string {
  if (request.remote) return remoteSystemPromptV2(request);
  return [
    `You are okidoki, driving the user's real Mac to finish a task for them. They watch every move live and can press Esc to take over.`,
    ``,
    `The task: ${request.goal}`,
    planText(request),
    previousRunText(request),
    ``,
    `Finish every part of the task as asked: keep the apps, sources, destinations, formats, quantities, order and anything they said not to do. Opening an app or reaching a screen is only a step unless that is the whole task. Never quietly do an easier version.`,
    `Keep going until the whole task is done. Never stop to ask whether to continue or which way to do something the task or plan already covers: choose sensibly and do it. Long, fiddly jobs (wiring a circuit, filling a form, laying out a slide) are expected; work through them step by step, zooming in on small targets.`,
    ``,
    `How to act`,
    `- The screen is a Mac. In the computer tools, super is ⌘ Command and alt is ⌥ Option.`,
    `- Use the most exact tool for each step:`,
    `  1. run_script for anything scriptable (AppleScript by default; lang javascript is JXA, lang shell is zsh). Never press keys or click from inside a script (no System Events keystroke, key code or click): use the key, type and click tools. In JXA use delay(0.2), not $.delay. If a script says okidoki isn't allowed to control an app, stop scripting that app.`,
    `  2. open_app and open_url to launch or switch apps and open links. When the result says an app is frontmost, it is: go straight on.`,
    `  3. key for shortcuts you know: super+n, super+t, super+l (address bar), super+f, super+s, super+w, Return, Escape, Tab, arrows. super+space opens Spotlight. In Open/Save dialogs: super+shift+g, type the full path, Return.`,
    `  4. click_element with the control's number when it is in the list of numbered controls. Otherwise left_click its pixel; zoom first when text is too small to read or targets are tight.`,
    `- Batches: when the next actions are predictable from the current screen, send them together in one turn, e.g. click a field, type, press Return. The Mac runs them in order and stops at the first one that fails. Put an action that changes the screen a lot (opens a menu, dialog, app or page) last in a batch, because later clicks would be aimed at the old screen.`,
    `- After every batch the Mac waits until the screen settles and pages finish loading, then sends a fresh screenshot with the results. Don't call screenshot or wait just to look or to let something load.`,
    `- Check the results and the new screenshot before going on. A result that is an error or says nothing changed means that action did not work: try another way (another control, a shortcut, a script) instead of repeating it.`,
    `- type writes into whatever has keyboard focus, so click the field first. To replace text: click the field, super+a, then type. Long text is pasted for you.`,
    `- If a pop-up, banner or overlay (cookie notice, sign-up or donation prompt, tooltip) covers what the task needs, close it with its close button or Escape — never accept, subscribe, sign in or pay to get rid of it.`,
    `- Coordinates are pixels in the latest screenshot, origin top-left. The screenshot is the whole display at one pixel per point.`,
    ``,
    `Finishing`,
    `- Leave the result on screen for the user: bring the app forward and open or select what you made or changed so its content is readable (the note itself, not just its title in a list; the document; the page; the sent message), even when a script did the work.`,
    `- Call finish with success true once a screenshot shows the whole task done. When the last steps are certain from the current screen (type the message and press Return to send it), you may end that batch with finish: the Mac accepts it only if every action worked and the screen changed without a new page or window opening; otherwise it asks you to look first. summary says what was achieved and where.`,
    `- Call finish with success false only when something truly blocks you (a sign-in, a payment, a permission prompt, a missing app) or after several different approaches have failed, saying what blocked you. Never put a question in a finish.`,
    `- Call ask, on its own, when the task can't go on without something only the user knows: several contacts, files or accounts match and none is clearly the one; a detail the task left out (a recipient, a date). One short question; their answer comes back as a new task that continues this one. Never ask whether to continue or which way to do something the task already covers.`,
    ``,
    `Rules`,
    `- Never type passwords, secrets, payment details or 2FA codes. If a sign-in or payment screen blocks the task, finish with success false and say so.`,
    `- Never delete, erase, reset, trash, send money or buy anything unless the task asks for it.`,
    `- Never open System Settings security panes or Keychain Access, and never answer a system permission prompt (Allow / Don't Allow): finish with success false and ask the user to answer it.`,
    `- Never touch okidoki's own windows: the notch, dark capsules, the driving pill at the bottom of the screen.`,
    `- Stay inside the task. Don't open unrelated apps or change unrelated settings.`,
  ].filter((line) => line !== undefined).join("\n");
}

function remoteSystemPromptV2(request: DriveRequest): string {
  return [
    `You are okidoki, driving the user's PRIVATE MAC: a separate, clean macOS in a virtual machine that only you use. The user's own Mac is untouched and they are not watching; they read your summary.`,
    ``,
    `The task: ${request.goal}`,
    planText(request),
    previousRunText(request),
    ``,
    `Finish every part of the task as asked. Opening an app or reaching a screen is only a step unless that is the whole task. Never quietly do an easier version. Keep going until it is done; never stop to ask whether to continue.`,
    ``,
    `How to act`,
    `- The screen is a Mac. In the computer tools, super is ⌘ Command and alt is ⌥ Option.`,
    `- Only the picture, the keyboard and the mouse reach this Mac: there are no scripts and no list of controls.`,
    `- super+space opens Spotlight (type the app name, then Return). open_app and open_url do that for you.`,
    `- Batches: when the next actions are predictable from the current screen, send them together in one turn. The Mac runs them in order and stops at the first one that fails. Put an action that changes the screen a lot last in a batch.`,
    `- A fresh screenshot comes back after every batch. A black screen or an Apple logo means it is still booting: wait 3 seconds.`,
    `- type writes into whatever has keyboard focus, so click the field first. Only characters on a US keyboard can be typed.`,
    `- If you see Setup Assistant, walk through it with sensible defaults, skip Apple ID and optional services, and name a new account "okidoki" with no password if allowed; otherwise finish with success false and ask the user to finish setup in the private Mac window.`,
    `- Safari, Notes, Reminders, Calendar, Mail, TextEdit, Finder and Terminal are always installed. If an app is missing, use the web version or finish with success false.`,
    ``,
    `Finishing`,
    `- Call finish with success true on its own, in a turn after you have seen a screenshot that shows the whole task done; the summary says where the result is, because the user didn't see the screen.`,
    `- Call finish with success false after several different approaches have failed.`,
    `- Call ask, on its own, when the task can't go on without something only the user knows (several matches and none clearly the one; a detail the task left out). One short question; their answer comes back as a new task that continues this one.`,
    ``,
    `Rules`,
    `- Never type passwords, secrets, payment details or 2FA codes, and never use the user's own Apple ID.`,
    `- Never delete, erase, reset, send money or buy anything unless the task asks for it.`,
  ].join("\n");
}

// MARK: - Observations

export function observationText(obs: DriveObservation, app: { changed: boolean }, remote: boolean): string {
  const lines: string[] = [];
  if (!remote) {
    const title = obs.windowTitle ? ` — window “${obs.windowTitle.slice(0, 120)}”` : "";
    lines.push(`Frontmost app: ${obs.app || "unknown"}${title}. This is authoritative even if another window looks bigger.`);
  }
  if (obs.screenshotBase64 && obs.canSee !== false) {
    lines.push(`Screenshot: ${Math.round(obs.imageWidth)}×${Math.round(obs.imageHeight)} px.`);
  } else {
    lines.push(`No screenshot this turn: don't click, drag, scroll or zoom. Use run_script, open_app, open_url, key or type.`);
  }
  if (obs.canClick === false) {
    lines.push(`Accessibility is off, so clicks, keys and typing can't be delivered. Use run_script, open_app and open_url, or finish with success false and ask the user to turn on accessibility for okidoki.`);
  }
  for (const note of obs.notes ?? []) lines.push(note);
  const controls = obs.controls ?? [];
  if (!remote) {
    if (controls.length) {
      lines.push(`Numbered controls in ${obs.app || "the frontmost app"} (#number role “label” @ center x,y):`);
      for (const c of controls.slice(0, 120)) {
        const label = c.label.replace(/\s+/g, " ").slice(0, 60);
        lines.push(`${c.id !== undefined ? `#${c.id} ` : ""}${c.role} “${label}” @ ${Math.round(c.x)},${Math.round(c.y)}`);
      }
    } else {
      lines.push(`${obs.app || "The frontmost app"} lists no controls: work from the screenshot.`);
    }
    if (obs.scripting && app.changed) {
      lines.push(`AppleScript dictionary of ${obs.app || "the frontmost app"} (abridged), for run_script:`, obs.scripting);
    }
  }
  return lines.join("\n");
}

/** Text first, then the screenshot: the target description before the image improves click accuracy. */
function observationBlocks(obs: DriveObservation, lead: string, app: { changed: boolean }, remote: boolean): unknown[] {
  const text = [lead, observationText(obs, app, remote)].filter(Boolean).join("\n\n");
  const blocks: unknown[] = [{ type: "text", text }];
  if (obs.screenshotBase64 && obs.canSee !== false) blocks.push(image(obs.screenshotBase64, obs.mediaType));
  return blocks;
}

// MARK: - Mapping the model's calls to Mac actions

const KEY_ALIASES: Record<string, string> = {
  super: "cmd", command: "cmd", cmd: "cmd", meta: "cmd", win: "cmd", windows: "cmd", super_l: "cmd", super_r: "cmd",
  alt: "opt", option: "opt", opt: "opt", alt_l: "opt", alt_r: "opt",
  control: "ctrl", ctrl: "ctrl", control_l: "ctrl", control_r: "ctrl",
  shift: "shift", shift_l: "shift", shift_r: "shift",
  return: "return", enter: "return", kp_enter: "keypadenter",
  escape: "esc", esc: "esc",
  backspace: "backspace", delete: "delete", del: "delete",
  prior: "pageup", page_up: "pageup", pageup: "pageup", next: "pagedown", page_down: "pagedown", pagedown: "pagedown",
  up: "up", down: "down", left: "left", right: "right",
  space: "space", tab: "tab", home: "home", end: "end", insert: "help",
};

/** "super+shift+Page_Down" → "cmd+shift+pagedown". Single characters keep their case-folded self. */
export function normalizeKey(combo: string): string {
  return combo
    .split("+")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const lower = piece.toLowerCase();
      if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
      if (lower.length > 1) return lower.replace(/_/g, "");
      return lower;
    })
    .join("+");
}

function modifiers(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  return normalizeKey(text);
}

function point(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === "number")) {
    return [value[0] as number, value[1] as number];
  }
  return undefined;
}

type ToolUse = { type: "tool_use"; id: string; name: string; input?: Record<string, unknown>; toolset_name?: string };

export function isMember(use: Pick<ToolUse, "name" | "toolset_name">): boolean {
  return use.toolset_name === "computer" || (use.toolset_name === undefined && MEMBERS.has(use.name));
}

export function mapToolUse(use: ToolUse): DriveAction {
  const input = use.input ?? {};
  const base = { id: use.id, tool: use.name, member: isMember(use) };
  if (base.member) {
    const at = point(input.coordinate);
    const xy = at ? { x: at[0], y: at[1] } : {};
    switch (use.name) {
      case "screenshot":
        return { ...base, type: "screenshot" };
      case "zoom": {
        const r = Array.isArray(input.region) ? (input.region as number[]) : [];
        if (r.length < 4) return { ...base, type: "zoom" };
        const [x0, y0, x1, y1] = r;
        return { ...base, type: "zoom", x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      }
      case "left_click":
        return { ...base, type: "click", ...xy, modifiers: modifiers(input.text) };
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click":
        return { ...base, type: use.name, ...xy, modifiers: modifiers(input.text) };
      case "left_click_drag": {
        const from = point(input.start_coordinate);
        return { ...base, type: "drag", from_x: from?.[0], from_y: from?.[1], to_x: at?.[0], to_y: at?.[1], modifiers: modifiers(input.text) };
      }
      case "mouse_move":
        return { ...base, type: "move", ...xy };
      case "left_mouse_down":
        return { ...base, type: "mouse_down" };
      case "left_mouse_up":
        return { ...base, type: "mouse_up" };
      case "cursor_position":
        return { ...base, type: "cursor_position" };
      case "scroll": {
        const amount = typeof input.scroll_amount === "number" ? input.scroll_amount : 3;
        const px = amount * SCROLL_CLICK_PX;
        const dir = String(input.scroll_direction ?? "down");
        const dy = dir === "down" ? px : dir === "up" ? -px : 0;
        const dx = dir === "right" ? px : dir === "left" ? -px : 0;
        return { ...base, type: "scroll", ...xy, dx, dy, modifiers: modifiers(input.text) };
      }
      case "type":
        return { ...base, type: "type", text: String(input.text ?? "") };
      case "key": {
        const times = typeof input.repeat === "number" ? Math.min(Math.max(Math.round(input.repeat), 1), 50) : undefined;
        return { ...base, type: "key", key: normalizeKey(String(input.text ?? "")), times };
      }
      case "hold_key":
        return { ...base, type: "hold_key", key: normalizeKey(String(input.text ?? "")), seconds: Math.min(Number(input.duration ?? 1), 10) };
      case "wait":
        return { ...base, type: "wait", seconds: Math.min(Math.max(Number(input.duration ?? 1), 0.2), 10) };
      default:
        return { ...base, type: "unknown" };
    }
  }
  switch (use.name) {
    case "run_script": {
      const lang = String(input.lang ?? "applescript");
      return { ...base, type: "script", script: String(input.script ?? ""), lang };
    }
    case "open_app":
      return { ...base, type: "open_app", app: String(input.name ?? "") };
    case "open_url":
      return { ...base, type: "open_url", text: String(input.url ?? "") };
    case "click_element": {
      const clicks = typeof input.clicks === "number" ? input.clicks : 1;
      return {
        ...base, type: "click_element", element: typeof input.id === "number" ? input.id : Number(input.id),
        button: typeof input.button === "string" ? input.button : "left", times: clicks, modifiers: modifiers(input.modifiers),
      };
    }
    case "finish": {
      const summary = String(input.summary ?? "");
      return input.success === false ? { ...base, type: "fail", reason: summary || "couldn't finish" } : { ...base, type: "done", summary: summary || "done" };
    }
    case "ask": {
      const question = String(input.question ?? "").replace(/\s+/g, " ").trim();
      return { ...base, type: "ask", text: question || "what should I do next?" };
    }
    default:
      return { ...base, type: "unknown" };
  }
}

// MARK: - Sessions

type Message = { role: "user" | "assistant"; content: unknown };

type Session = {
  runID: string;
  system: string;
  tools: unknown[];
  remote: boolean;
  messages: Message[];
  /** Tool calls from the model's last turn that still need a result. */
  pending: ToolUse[];
  lastApp?: string;
  used: number;
  /** Optional request fields the API said this run's model doesn't take; left out from then on. */
  unsupported: Set<string>;
  /** The last step answered and what it answered, so a retry after a dropped stream gets the same
   * turn back instead of appending the same results a second time. */
  lastStep?: number;
  lastResponse?: DriveResponse;
};

const SESSION_TTL_MS = 20 * 60_000;
const MAX_SESSIONS = 6;
const sessions = new Map<string, Session>();

export function resetSessions() {
  sessions.clear();
}

export function sessionFor(runID: string): Session | undefined {
  return sessions.get(runID);
}

function sweep(now: number) {
  for (const [id, s] of sessions) if (now - s.used > SESSION_TTL_MS) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.used - b.used)[0];
    sessions.delete(oldest.runID);
  }
}

function newSession(request: DriveRequest): Session {
  return {
    runID: request.runID,
    system: systemPromptV2(request),
    tools: toolsFor(Boolean(request.remote)),
    remote: Boolean(request.remote),
    messages: [],
    pending: [],
    used: Date.now(),
    unsupported: new Set(),
  };
}

function historyText(request: DriveRequest): string {
  const lines = (request.history ?? []).slice(-24).map((h) => {
    if (h.type === "note") return `! ${(h.result ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
    const what = [h.type, h.app, h.key && `[${h.key}]`, h.target && `“${h.target.slice(0, 40)}”`,
      (h.script ?? h.text)?.replace(/\s+/g, " ").slice(0, 80)].filter(Boolean).join(" ");
    return `· ${what} → ${(h.result ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
  });
  return lines.length ? `Steps already taken in this run (the conversation was restarted, so you only see a summary):\n${lines.join("\n")}` : "";
}

function resultContent(result: DriveResult | undefined, member: boolean): { content: unknown[]; isError: boolean } {
  if (!result || result.skipped) {
    return { content: [{ type: "text", text: member ? HALT_TEXT : "Not executed: an earlier action in this turn failed." }], isError: true };
  }
  const blocks: unknown[] = [{ type: "text", text: result.result || (result.isError ? "failed" : "OK") }];
  if (result.imageBase64) blocks.push(image(result.imageBase64, result.mediaType));
  return { content: blocks, isError: Boolean(result.isError) };
}

/** The user turn for this step: results for every pending call (observation on the last), or a fresh look. */
export function userTurn(session: Session, request: DriveRequest): Message {
  const obs = request.observation;
  const app = { changed: (obs.app ?? "") !== (session.lastApp ?? "") };
  if (session.pending.length === 0) {
    const lead = session.messages.length === 0
      ? [historyText(request), `Here is the screen now. Take the next actions for the task.`].filter(Boolean).join("\n\n")
      : `Here is the screen now. Continue the task with tool calls; call finish when it is done.`;
    return { role: "user", content: observationBlocks(obs, lead, app, session.remote) };
  }
  const byID = new Map((request.results ?? []).map((r) => [r.id, r]));
  const content = session.pending.map((use, index) => {
    // The result must name a toolset exactly when its call did: the API rejects a guess either way,
    // and the model sometimes sends a computer action without toolset_name.
    const { content: blocks, isError } = resultContent(byID.get(use.id), Boolean(use.toolset_name));
    const last = index === session.pending.length - 1;
    const block: Record<string, unknown> = {
      type: "tool_result",
      tool_use_id: use.id,
      content: last ? [...blocks, ...observationBlocks(obs, "", app, session.remote)] : blocks,
    };
    if (use.toolset_name) block.toolset_name = use.toolset_name;
    if (isError) block.is_error = true;
    return block;
  });
  return { role: "user", content };
}

// MARK: - The request

export type DriveMeta = { model: string; modelMs: number; firstActionMs?: number; usage?: ModelUsage; stopReason?: string };

export type DriveResponse = { actions: DriveAction[]; meta?: DriveMeta; error?: string; fallback?: "v1" };

function failure(reason: string, error?: string): DriveResponse {
  return { actions: [{ id: "", tool: "finish", member: false, type: "fail", reason }], error: error ?? reason };
}

/**
 * effort "low" | "medium" | "high" lets the model think (adaptive thinking, the 5.5 default) that much.
 * "none" forces a tool call, which on the 5.5 models skips thinking entirely: fastest, least deliberate.
 */
/** Only Haiku 5.5 takes a forced tool call; Sonnet and Opus 5.5 reject it. */
export function acceptsForcedToolChoice(model: string): boolean {
  return model.trim().toLowerCase().startsWith("claude-haiku-5-5");
}

export function requestBody(session: Session, messages: Message[], model: string, effort: string) {
  const off = (field: string) => session.unsupported.has(`${model}|${field}`);
  const forced = effort === "none" && acceptsForcedToolChoice(model) && !off("tool_choice");
  // "none" on a model that can't be forced falls back to the lightest thinking.
  const level = effort === "none" ? "low" : effort;
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    system: [{ type: "text", text: session.system, cache_control: { type: "ephemeral" } }],
    tools: session.tools,
    messages,
    // Automatic caching moves the breakpoint to the newest block, so each turn reads the last one's prefix.
    cache_control: { type: "ephemeral" },
    tool_choice: forced ? { type: "any" } : { type: "auto" },
  };
  if (!forced && !off("output_config")) body.output_config = { effort: level };
  if (!off("context_management")) {
    body.context_management = {
      edits: [{
        type: "clear_tool_uses_20250919",
        // Old screenshots are most of each request; clearing them early keeps every turn small and quick.
        trigger: { type: "input_tokens", value: 15_000 },
        keep: { type: "tool_uses", value: 2 },
        clear_at_least: { type: "input_tokens", value: 5_000 },
      }],
    };
  }
  return body;
}

/** Which optional request field a 400 says the model doesn't take, if that's what it says. */
export function unsupportedField(error: string | undefined): "tool_choice" | "output_config" | "context_management" | undefined {
  if (!error || !/model 400/.test(error)) return undefined;
  if (/tool_choice/i.test(error)) return "tool_choice";
  if (/output_config|effort/i.test(error)) return "output_config";
  if (/context_management|clear_tool_uses|context-management/i.test(error)) return "context_management";
  return undefined;
}

type ModelReply = { content?: Array<Record<string, unknown>>; usage?: unknown; stop_reason?: string };

/** Called with each tool call as soon as the model has finished writing it (streaming only). */
export type OnToolUse = (use: ToolUse) => void;

/**
 * Rebuilds a streamed Messages reply block by block, exactly as the non-streaming API would return it
 * (thinking blocks keep their signature, so they can go back in the next turn), and reports each
 * tool call the moment its block closes.
 */
export class ReplyAssembler {
  private blocks: Array<Record<string, unknown>> = [];
  private json: string[] = [];
  private usage: Record<string, unknown> = {};
  private stop?: string;
  emitted = 0;

  constructor(private onToolUse?: OnToolUse) {}

  event(type: string, data: Record<string, any>) {
    switch (type) {
      case "message_start":
        Object.assign(this.usage, data.message?.usage ?? {});
        break;
      case "content_block_start": {
        const block = { ...(data.content_block ?? {}) } as Record<string, unknown>;
        // Open until its stop arrives: a stream cut mid-call must not leave a half-written action behind.
        if (block.type === "tool_use") {
          block.input = {};
          block.__open = true;
        }
        this.blocks[data.index] = block;
        this.json[data.index] = "";
        break;
      }
      case "content_block_delta": {
        const block = this.blocks[data.index];
        const delta = data.delta ?? {};
        if (!block) break;
        if (delta.type === "text_delta") block.text = String(block.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + delta.thinking;
        else if (delta.type === "signature_delta") block.signature = String(block.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta") this.json[data.index] += delta.partial_json ?? "";
        else if (delta.type === "citations_delta") block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
        break;
      }
      case "content_block_stop": {
        const block = this.blocks[data.index];
        if (block?.type === "tool_use") {
          delete block.__open;
          const raw = this.json[data.index];
          try {
            block.input = raw ? JSON.parse(raw) : {};
          } catch {
            block.input = {};
            block.__broken = true;
          }
          if (!block.__broken) {
            this.emitted += 1;
            this.onToolUse?.(block as unknown as ToolUse);
          }
        }
        break;
      }
      case "message_delta":
        if (data.delta?.stop_reason) this.stop = data.delta.stop_reason;
        Object.assign(this.usage, data.usage ?? {});
        break;
    }
  }

  /** The reply so far. Unfinished or unreadable tool calls are left out, so what remains is a valid turn. */
  reply(): ModelReply {
    const content = this.blocks.filter((b) => b && !b.__broken && !b.__open);
    return { content, usage: this.usage, stop_reason: this.stop };
  }
}

/** Splits a server-sent-event body into (event, data) pairs. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (type: string, data: Record<string, any>) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        const parsed = JSON.parse(data.join("\n"));
        if (type === "error" || parsed?.type === "error") throw new Error(`model stream error: ${JSON.stringify(parsed.error ?? parsed).slice(0, 300)}`);
        onEvent(type, parsed);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("model stream error")) throw error;
      }
    }
  }
}

async function callModel(
  body: Record<string, unknown>, apiKey: string, fetchImpl: typeof fetch, deadline: number, onToolUse?: OnToolUse,
): Promise<{ reply?: ModelReply; status?: number; error?: string; emitted?: number }> {
  let lastError = "model unavailable";
  let status: number | undefined;
  const streaming = Boolean(onToolUse);
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break;
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(800 * attempt, remaining / 4)));
    const assembler = new ReplyAssembler(onToolUse);
    try {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": CONTEXT_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify(streaming ? { ...body, stream: true } : body),
        signal: AbortSignal.timeout(Math.max(2_000, deadline - Date.now())),
      });
      status = response.status;
      if (!response.ok) {
        lastError = `model ${response.status}: ${(await response.text()).slice(0, 300)}`;
        if (RETRY_STATUSES.has(response.status)) continue;
        return { status, error: lastError };
      }
      if (!streaming || !response.body) return { reply: (await response.json()) as ModelReply, status };
      await readEvents(response.body, (type, data) => assembler.event(type, data));
      return { reply: assembler.reply(), status, emitted: assembler.emitted };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "model unavailable";
      // Actions already went to the Mac: keep the finished part of the turn rather than ask again.
      if (assembler.emitted > 0) return { reply: assembler.reply(), status, emitted: assembler.emitted, error: lastError };
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) break;
    }
  }
  return { status, error: lastError };
}

/** A 400 that comes from the conversation itself (a stale thinking block, a broken prefix), not the step. */
function conversationBroken(error: string | undefined): boolean {
  return Boolean(error && /model 400/.test(error) && /(thinking|signature|prefix|tool_use|tool_result|toolset_name)/i.test(error));
}

/**
 * One turn. With `onAction`, the reply streams and each action is handed over the moment the model
 * finishes writing it, so the Mac can start on the first while the rest are still being written.
 */
export async function driveStep(
  request: DriveRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  budgetMs = 55_000,
  onAction?: (action: DriveAction) => void,
): Promise<DriveResponse> {
  if (!apiKey) return failure("the model isn't available right now, so i can't drive an app yet.", "anthropic key required");
  const baseModel = drivingModel(request.settings?.claudeModel);
  if (!supportsToolset(baseModel)) return { actions: [], fallback: "v1", error: `${baseModel} doesn't take the computer use toolset` };
  const model = request.escalate ? ESCALATION_MODEL : baseModel;
  const effort = request.effort ?? "low";
  const now = Date.now();
  sweep(now);
  const deadline = now + budgetMs;
  const started = now;

  let session = sessions.get(request.runID);
  if (!session) {
    session = newSession(request);
    sessions.set(request.runID, session);
  }
  session.used = now;

  // The Mac lost the stream after this turn was already committed: hand it back as it was.
  if (session.lastResponse && session.lastStep === request.step) {
    for (const action of session.lastResponse.actions) onAction?.(action);
    return session.lastResponse;
  }

  let firstActionMs: number | undefined;
  const onToolUse: OnToolUse | undefined = onAction
    ? (use) => {
        if (firstActionMs === undefined) firstActionMs = Date.now() - started;
        onAction(mapToolUse(use));
      }
    : undefined;

  let messages = [...session.messages, userTurn(session, request)];
  let result = await callModel(requestBody(session, messages, model, effort), apiKey, fetchImpl, deadline, onToolUse);
  // A model that doesn't take an optional field (a forced tool call, effort, context management):
  // leave it out for the rest of the run and ask again, rather than end the run.
  for (let i = 0; i < 3 && !result.reply; i++) {
    const field = unsupportedField(result.error);
    if (!field || session.unsupported.has(`${model}|${field}`)) break;
    session.unsupported.add(`${model}|${field}`);
    result = await callModel(requestBody(session, messages, model, effort), apiKey, fetchImpl, deadline, onToolUse);
  }

  if (!result.reply && conversationBroken(result.error)) {
    // Start the conversation over from the step summary rather than fail the run.
    session = newSession(request);
    sessions.set(request.runID, session);
    messages = [userTurn(session, request)];
    result = await callModel(requestBody(session, messages, model, effort), apiKey, fetchImpl, deadline, onToolUse);
  }
  if (!result.reply) {
    if (result.status === 401) return failure("that anthropic key was rejected.", result.error);
    return failure(`the model didn't answer, so i stopped. ${result.error ?? ""}`.trim(), result.error);
  }

  let reply = result.reply;
  let content = reply.content ?? [];
  let uses = content.filter((b) => b.type === "tool_use") as unknown as ToolUse[];
  let usage = readUsage(reply.usage);

  if (uses.length === 0 && Date.now() < deadline - 3_000) {
    // A reply with no tool call: one nudge, kept in the conversation.
    messages = [
      ...messages,
      { role: "assistant", content },
      { role: "user", content: [{ type: "text", text: "Reply with tool calls for the next actions, call finish (success true or false) with a summary, or call ask if only the user can say what comes next." }] },
    ];
    const again = await callModel(requestBody(session, messages, model, effort), apiKey, fetchImpl, deadline, onToolUse);
    if (again.reply) {
      reply = again.reply;
      content = reply.content ?? [];
      uses = content.filter((b) => b.type === "tool_use") as unknown as ToolUse[];
      const more = readUsage(reply.usage);
      if (usage && more) {
        usage = { input: usage.input + more.input, cacheRead: usage.cacheRead + more.cacheRead, cacheWrite: usage.cacheWrite + more.cacheWrite, output: usage.output + more.output };
      }
    }
  }

  // Commit the turn: the model's content goes back exactly as it came.
  session.messages = [...messages, { role: "assistant", content }];
  session.pending = uses;
  session.lastApp = request.observation.app ?? session.lastApp;
  const meta: DriveMeta = { model, modelMs: Date.now() - started, firstActionMs, usage, stopReason: reply.stop_reason };

  if (uses.length === 0) {
    const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join(" ").trim();
    return { ...failure(text ? `the model stopped without acting: ${text.slice(0, 200)}` : "the model stopped without acting", "no tool call"), meta };
  }
  const response: DriveResponse = { actions: uses.map(mapToolUse), meta };
  session.lastStep = request.step;
  session.lastResponse = response;
  return response;
}
