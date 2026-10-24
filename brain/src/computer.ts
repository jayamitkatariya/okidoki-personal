import type { ComputerRequest, ComputerAct } from "./types";

const actTool = {
  name: "okidoki_act",
  description:
    "Reply with exactly one action per turn. You are driving the user's real Mac; they watch every move live.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [
          "open_app", "activate", "open_url", "script",
          "click", "double_click", "triple_click", "right_click", "middle_click", "move", "drag",
          "type", "key", "scroll", "zoom", "wait", "done", "fail",
        ],
      },
      x: { type: "number", description: "x in screenshot pixels, origin top-left. required for click, move, scroll, zoom" },
      y: { type: "number", description: "y in screenshot pixels, origin top-left" },
      from_x: { type: "number" },
      from_y: { type: "number" },
      to_x: { type: "number" },
      to_y: { type: "number" },
      width: { type: "number", description: "for zoom: width of the region in screenshot pixels (default 400)" },
      height: { type: "number", description: "for zoom: height of the region (default 2/3 of width)" },
      app: { type: "string", description: "app name for open_app / activate, e.g. WhatsApp, Blender, Notes. On key/type, brings that app to the front first" },
      text: { type: "string", description: "text to type (no newlines — use key return separately), url for open_url, or app name" },
      script: { type: "string", description: "full AppleScript, JXA, or shell source for a script action" },
      lang: { type: "string", enum: ["applescript", "javascript", "shell"], description: "language of script. default applescript" },
      target: { type: "string", description: "visible text or accessibility label of the control. the Mac snaps the click to its real center when it matches" },
      modifiers: { type: "string", description: 'keys held during a click, e.g. "cmd" (multi-select, open in new tab), "shift" (range select), "opt"' },
      key: {
        type: "string",
        description: 'key or combo, e.g. "return", "esc", "tab", "cmd+shift+a", "down", "cmd+v", "cmd+shift+g"',
      },
      times: { type: "number", description: "for key: how many times to press it (1–50)" },
      dx: { type: "number", description: "horizontal scroll amount, positive = right" },
      dy: { type: "number", description: "vertical scroll amount, positive = down" },
      seconds: { type: "number", description: "for wait: 0.2–10" },
      reason: { type: "string", description: "for wait/fail: why" },
      summary: { type: "string", description: "for done: one short sentence describing what was achieved" },
      say: { type: "string", description: "2-6 words narrating this step, shown live, e.g. 'clicking send'" },
    },
    required: ["type", "say"],
  },
};

const DRIVING_MODEL = "claude-sonnet-5-5";

/** Driving needs precise vision. A small routing model is swapped for Sonnet; anything the user chose explicitly is kept. */
export function drivingModel(configured: string | undefined): string {
  const name = (configured ?? "").trim();
  if (!name || /haiku/i.test(name)) return DRIVING_MODEL;
  return name;
}

function describe(entry: ComputerRequest["history"][number]): string {
  if (entry.type === "note") return `! ${(entry.result ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
  const bits = [entry.type];
  if (entry.app) bits.push(entry.app);
  if (entry.key) bits.push(`[${entry.key}]`);
  if (typeof entry.x === "number" && typeof entry.y === "number") bits.push(`(${Math.round(entry.x)},${Math.round(entry.y)})`);
  if (entry.target) bits.push(`target “${entry.target.slice(0, 40)}”`);
  if (entry.script) bits.push(entry.script.slice(0, 120).replace(/\s+/g, " "));
  else if (entry.text) bits.push(`“${entry.text.slice(0, 80)}”`);
  const result = (entry.result ?? "").replace(/\s+/g, " ").slice(0, 400);
  return `· ${bits.join(" ")} → ${result}`;
}

export function describeControls(controls: ComputerRequest["controls"], limit = 120): string {
  if (!controls || controls.length === 0) return "";
  return controls
    .slice(0, limit)
    .map((c) => `${c.role} “${c.label.replace(/\s+/g, " ").slice(0, 60)}” @ ${Math.round(c.x)},${Math.round(c.y)}`)
    .join("\n");
}

export function systemPrompt(request: ComputerRequest): string {
  const canSee = request.canSee !== false && Boolean(request.screenshotBase64);
  const canClick = request.canClick !== false;
  const controls = describeControls(request.controls);
  const width = Math.round(request.imageWidth || 0);
  const height = Math.round(request.imageHeight || 0);
  const zoom = request.zoom && request.zoomBase64 ? request.zoom : undefined;
  return [
    `You are Okidoki's computer-use controller on the user's real Mac. Reply with exactly ONE next action through the okidoki_act tool. The user watches every move live.`,
    ``,
    `The user's goal: ${request.goal}`,
    ``,
    `Pick the earliest tool that can really do this step:`,
    `1. script — AppleScript by default (lang "applescript"); lang "javascript" is JXA; lang "shell" is zsh.`,
    `   Scripts are exact and fast for: launching apps, opening files and urls, menu items, creating notes/events/reminders, Finder, Calendar, Reminders, Notes, Messages, Mail, Music, Safari, Terminal, System Events, volume, clipboard, Shortcuts.`,
    `   One whole program per step. The next turn shows stdout or the error.`,
    `   Menu: tell application "System Events" to tell process "Notes" to click menu item "New Note" of menu "File" of menu bar 1`,
    `   Safari url: tell application "Safari" to open location "https://…"   Chrome: tell application "Google Chrome" to open location "https://…"`,
    `   Read a window: tell application "System Events" to tell process "X" to get value of every static text of window 1`,
    `   If a script says okidoki isn't allowed to control an app, stop scripting that app and drive it with open_app, key, click, and type.`,
    `   Never guess pixel coordinates from inside a script. No sudo, killall, rm of system folders.`,
    `2. open_app / activate by name, or open_url (text = http(s) or file url). open_app brings the app to the front — do it before clicking in an app that isn't frontmost.`,
    `3. key for a shortcut you know: cmd+n, cmd+t, cmd+l (address bar), cmd+f, cmd+s, cmd+w, cmd+shift+n, return, esc, tab, arrows, cmd+z. times repeats a key. Spotlight: key cmd+space, then type, then key return.`,
    `   Open/Save dialogs: key cmd+shift+g, type the full path, key return. Select all text: cmd+a. Switch app: open_app.`,
    `4. Pointer actions for everything else — Electron apps (Slack, Discord, Notion, WhatsApp, VS Code), browsers, games, Blender, Figma, and any dialog.`,
    ``,
    canSee
      ? [
          `You can see the screen. The screenshot is ${width}×${height} pixels and covers the whole display; x,y are pixels in that image, origin top-left.`,
          request.previousScreenshotBase64
            ? `Two images are attached: first the screen BEFORE your last action, then the screen NOW. Compare them to confirm the last action worked.`
            : `The attached image is the screen now.`,
          zoom
            ? `A zoomed crop is also attached: it shows screenshot region x ${Math.round(zoom.x)}–${Math.round(zoom.x + zoom.width)}, y ${Math.round(zoom.y)}–${Math.round(zoom.y + zoom.height)} magnified to ${Math.round(zoom.imageWidth)}×${Math.round(zoom.imageHeight)}. A point (u,v) in the crop is screenshot (${Math.round(zoom.x)} + u×${(zoom.width / zoom.imageWidth).toFixed(3)}, ${Math.round(zoom.y)} + v×${(zoom.height / zoom.imageHeight).toFixed(3)}). Always answer in screenshot pixels.`
            : `When text is too small to read or controls are tight, use zoom with x,y (and width,height) to get a magnified crop next turn before clicking.`,
          `Aim at the center of the control. When the control has visible text, also set target to that exact text — the Mac snaps the click to the real control under it.`,
          `A click lands on whatever is drawn at that pixel. If a menu, popover, or dialog is open, deal with it first.`,
          `After a click or type, the next screenshot shows the effect. If nothing changed, you probably missed: try the control's listed center, a keyboard shortcut, or a script.`,
        ].join("\n")
      : `You cannot see the screen this turn. Do not emit click, double_click, right_click, middle_click, drag, move, scroll, or zoom. Use script, open_app, activate, open_url, key, type, or wait.`,
    canClick
      ? `Pointer and keyboard actions are available.`
      : `Accessibility is off, so click, type, key, drag, and scroll will fail. Stay on script, open_app, activate, and open_url.`,
    ``,
    controls
      ? [
          `Controls the frontmost app reports right now (role “label” @ center x,y in screenshot pixels). Prefer these coordinates over your own estimate, and use the label as target:`,
          controls,
        ].join("\n")
      : `The frontmost app reports no accessible controls — rely on the screenshot.`,
    ``,
    `Pointer details:`,
    `- click selects; double_click opens files, folders, and list items; triple_click selects a line or paragraph; right_click opens context menus; middle_click opens links in new tabs. drag needs from_x, from_y, to_x, to_y.`,
    `- modifiers on a click: "cmd" to multi-select or open in a new tab, "shift" to select a range, "opt" for alternates.`,
    `- type writes into the focused field — click the field first and check the caret is there. Keep text on one line; press key "return" as its own step. Long text is pasted for you.`,
    `- To replace existing text: click the field, key cmd+a, then type.`,
    `- scroll dy is pixels, positive = down, with x,y over the area to scroll. 400–900 moves about a page.`,
    `- wait 1–3 seconds when something is loading or animating. seconds is 0.2–10.`,
    `- done only when the newest screenshot or script output proves the goal is finished — not when you merely sent the last action. summary is one short sentence of what was achieved.`,
    `- fail only after trying several different approaches. reason says what blocked you.`,
    ``,
    `Hard rules:`,
    `- Never enter passwords, secrets, payment info, or 2FA codes. If a login or payment screen appears, fail and say so.`,
    `- Never delete, erase, reset, trash, send money, or submit a purchase unless the goal explicitly asks for it.`,
    `- Never open System Settings security panes, Keychain Access, or permission dialogs; never click Allow/Deny in a system permission prompt.`,
    `- Never interact with Okidoki's own windows (notch, dark capsules, the driving pill at the bottom).`,
    `- Stay inside the goal. Do not open unrelated apps or change unrelated settings.`,
    `- say is 2-6 words shown live, e.g. "opening notes", "clicking send".`,
    ``,
    `So far you have taken ${request.step} step(s). Previous actions and their results (newest last):`,
    request.history.length ? request.history.map(describe).join("\n") : "none yet.",
    ``,
    `Frontmost app: ${request.app || "unknown"}${request.windowTitle ? ` — window “${request.windowTitle.slice(0, 120)}”` : ""}. Take the single best next action.`,
  ].join("\n");
}

function image(base64: string) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } };
}

/** Message content: labelled images first, then the instructions. */
export function messageContent(request: ComputerRequest): unknown[] {
  const content: unknown[] = [];
  if (request.screenshotBase64 && request.previousScreenshotBase64) {
    content.push({ type: "text", text: "Screen BEFORE your last action:" }, image(request.previousScreenshotBase64));
    content.push({ type: "text", text: "Screen NOW:" }, image(request.screenshotBase64));
  } else if (request.screenshotBase64) {
    content.push(image(request.screenshotBase64));
  }
  if (request.zoomBase64 && request.zoom) {
    content.push({ type: "text", text: "Zoomed crop you asked for:" }, image(request.zoomBase64));
  }
  content.push({ type: "text", text: systemPrompt(request) });
  return content;
}

function needModel(detail: string): ComputerAct {
  return { type: "fail", reason: detail, say: "stopped" };
}

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export async function computerAct(
  request: ComputerRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ action: ComputerAct; usedModel: boolean; error?: string }> {
  if (!apiKey) {
    return {
      action: needModel("okidoki needs an anthropic key before it can drive an app. add one in keys."),
      usedModel: false,
      error: "anthropic key required",
    };
  }
  const model = drivingModel(request.settings?.claudeModel);
  const body = {
    model,
    max_tokens: 1400,
    messages: [{ role: "user", content: messageContent(request) }],
    tools: [actTool],
    tool_choice: { type: "tool", name: "okidoki_act" },
  };

  let lastError = "model unavailable";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    try {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(75_000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160);
        lastError = `model ${response.status}: ${detail}`;
        if (response.status === 401) {
          return { action: needModel("that anthropic key was rejected. add a new one in keys."), usedModel: false, error: lastError };
        }
        if (RETRY_STATUSES.has(response.status)) continue;
        return { action: needModel(`the model didn't answer, so i stopped. ${lastError}`), usedModel: false, error: lastError };
      }
      const json = (await response.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
      for (const block of json.content ?? []) {
        if (block.type === "tool_use" && block.input) {
          return { action: block.input as unknown as ComputerAct, usedModel: true };
        }
      }
      lastError = "empty model response";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "model unavailable";
      // A timed-out request already used the whole budget; a retry would outlast the app's own timeout.
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) break;
    }
  }
  return { action: needModel(`the model didn't answer, so i stopped. ${lastError}`), usedModel: false, error: lastError };
}
