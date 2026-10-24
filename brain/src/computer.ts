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
        enum: ["open_app", "activate", "click", "double_click", "right_click", "drag", "type", "key", "scroll", "wait", "done", "fail"],
      },
      x: { type: "number", description: "x in image pixels, origin top-left" },
      y: { type: "number", description: "y in image pixels, origin top-left" },
      from_x: { type: "number" },
      from_y: { type: "number" },
      to_x: { type: "number" },
      to_y: { type: "number" },
      app: { type: "string", description: "app name for open_app / activate, e.g. WhatsApp, Blender, Notes" },
      text: { type: "string", description: "text to type (no newlines — use key return separately), or app name for open_app" },
      key: {
        type: "string",
        description: 'key or combo, e.g. "return", "esc", "tab", "cmd+shift+a", "down", "cmd+v"',
      },
      dx: { type: "number", description: "horizontal scroll amount, positive = right" },
      dy: { type: "number", description: "vertical scroll amount, positive = down" },
      seconds: { type: "number", description: "for wait: 0.2-5" },
      reason: { type: "string", description: "for wait/fail: why" },
      summary: { type: "string", description: "for done: one short sentence describing what was achieved" },
      say: { type: "string", description: "2-6 words narrating this step, shown live, e.g. 'clicking send'" },
    },
    required: ["type", "say"],
  },
};

function systemPrompt(request: ComputerRequest): string {
  const screen = request.screen;
  return [
    `You are Okidoki's computer-use controller. You see a screenshot of the user's Mac and reply with exactly ONE next action through the okidoki_act tool.`,
    ``,
    `The user's goal: ${request.goal}`,
    ``,
    `How to act:`,
    `- x,y coordinates are pixels in the screenshot image, origin top-left. The screenshot covers the ENTIRE screen. Aim for the center of the element you mean.`,
    `- Look carefully: read menus, buttons, fields, list rows. Prefer precise clicks on visible controls. Use keyboard shortcuts when the UI shows them (⌘N, ⌘V, ⇧⌘4...).`,
    `- type writes into the focused field. First click the field, then type. Do NOT put a newline in text — for chat apps, type the message, then send as a separate step with key "return".`,
    `- Use key for shortcuts, enter, esc, tab, arrows.`,
    `- open_app launches or focuses an app by name (WhatsApp, Notion, Blender, Notes, FreeCAD, anything installed).`,
    `- wait 1-3 seconds when something is loading, animating, or a dialog is mid-appear.`,
    `- scroll with dy (positive = down) when the target may be off-screen.`,
    `- done only when the goal is verifiably achieved IN THE CURRENT SCREENSHOT. Look before you claim it. summary: one short sentence, the user's voice.`,
    `- fail only after genuinely trying several approaches; reason says what blocked you.`,
    ``,
    `Hard rules:`,
    `- Never enter passwords, secrets, payment info, or 2FA codes.`,
    `- Never click delete/erase/reset/trash unless the goal explicitly asks for it.`,
    `- Never open System Settings' security panes, Keychain Access, or anything about permissions.`,
    `- Never interact with Okidoki's own windows (notch, dark capsules, the driving pill at the bottom).`,
    `- say is 2-6 words shown live to the user, e.g. "opening whatsapp", "clicking send".`,
    ``,
    `So far you have taken ${request.step} step(s). Previous actions and their results:`,
    request.history.length
      ? request.history.map((entry) => `· ${entry.type}${entry.text ? ` “${entry.text.slice(0, 60)}”` : ""}${entry.key ? ` [${entry.key}]` : ""} → ${entry.result}`).join("\n")
      : "none yet.",
    ``,
    `Frontmost app: ${request.app || "unknown"}. Take the single best next action.`,
  ].join("\n");
}

function heuristicAct(request: ComputerRequest): ComputerAct {
  const goal = request.goal.trim();
  const opened = request.history.find((entry) => entry.type === "open_app");
  if (opened) {
    return { type: "done", summary: `opened ${opened.app ?? "the app"}`, say: "done" };
  }
  const match = goal.match(/^(?:please\s+)?(?:open|launch|start|show me)\s+(?:the\s+)?(.+?)(?:\s+app)?[.!?]*$/i);
  if (match && match[1]) {
    return { type: "open_app", app: match[1], say: `opening ${match[1]}` };
  }
  return {
    type: "fail",
    reason: "driving apps end-to-end needs an Anthropic key. add one in okidoki → keys and try again.",
    say: "need a key",
  };
}

export async function computerAct(
  request: ComputerRequest,
  apiKey: string | undefined,
): Promise<{ action: ComputerAct; usedModel: boolean; error?: string }> {
  if (!apiKey) {
    return { action: heuristicAct(request), usedModel: false };
  }
  const model = request.settings?.claudeModel || "claude-sonnet-4-5";
  const content: unknown[] = [];
  if (request.screenshotBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: request.screenshotBase64,
      },
    });
  } else {
    return {
      action: { type: "fail", reason: "no screenshot of the screen", say: "can't see" },
      usedModel: false,
    };
  }
  content.push({ type: "text", text: systemPrompt(request) });

  const body = {
    model,
    max_tokens: 700,
    messages: [{ role: "user", content }],
    tools: [actTool],
    tool_choice: { type: "tool", name: "okidoki_act" },
  };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
      const detail = await response.text();
      return {
        action: heuristicAct(request),
        usedModel: false,
        error: `model ${response.status}: ${detail.slice(0, 160)}`,
      };
    }
    const json = (await response.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
    for (const block of json.content ?? []) {
      if (block.type === "tool_use" && block.input) {
        return { action: block.input as unknown as ComputerAct, usedModel: true };
      }
    }
    return { action: heuristicAct(request), usedModel: false, error: "empty model response" };
  } catch (error) {
    return {
      action: heuristicAct(request),
      usedModel: false,
      error: error instanceof Error ? error.message : "model unavailable",
    };
  }
}
