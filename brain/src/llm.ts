import type { Decision, ThinkRequest } from "./types";
import { localRouter } from "./router";
import { toolDocs } from "./catalog";
import { checkConnectorDecision, connectorPrompt, mcpCatalog, type McpCatalogEntry } from "./connectors";
import { recall, recallPrompt } from "./memory";

const responseTool = {
  name: "okidoki_respond",
  description:
    "Always respond with this. Decide how to help: answer, quick_action, terminal, coding, background, teach, borrow, watch, memory, routine, computer_use, overlay, or connector.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["answer", "quick_action", "terminal", "coding", "background", "teach", "borrow", "watch", "memory", "routine", "computer_use", "overlay", "connector"],
      },
      title: { type: "string", description: "short lowercase title, max 6 words" },
      answer: { type: "string", description: "the response to show in the card; short, warm, concrete, markdown allowed" },
      speak: { type: "string", description: "what to say aloud; 1-2 sentences, or empty" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      preview_summary: { type: "string" },
      preview_steps: { type: "array", items: { type: "string" } },
      commands: {
        type: "array",
        items: { type: "string" },
        description:
          "exact shell commands. Use {{file}}, {{outputDir}}, {{basename}}, {{dir}} placeholders; the app fills them after a file picker.",
      },
      apps: { type: "array", items: { type: "string" }, description: "apps involved, e.g. [\"WhatsApp\", \"Notion\"] — for computer_use name the app(s) to drive" },
      files: { type: "array", items: { type: "string" } },
      teach_steps: { type: "array", items: { type: "string" }, description: "for teach without a plan: 4-7 steps, each one action" },
      teach_plan: {
        type: "array",
        description: "for teach: richer steps with on-screen drawing instructions",
        items: {
          type: "object",
          properties: {
            say: { type: "string", description: "the step, spoken and shown" },
            marks: {
              type: "array",
              description: "what to draw over the app window for this step",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["circle", "box", "arrow", "label", "dim", "cursor", "ink"] },
                  target: { type: "string", description: "exact label of the UI element to point at, e.g. 'Auto layout' or 'New chat' — resolved via accessibility" },
                  point: { type: "array", items: { type: "number" }, description: "fallback [x,y] as 0-1 fraction of the app window" },
                  rect: { type: "array", items: { type: "number" }, description: "fallback [x,y,w,h] as 0-1 fractions of the app window" },
                  to: { type: "array", items: { type: "number" }, description: "for arrow/cursor: destination [x,y] as 0-1 fraction" },
                  text: { type: "string", description: "for label: the text to show" },
                  seconds: { type: "number", description: "for cursor: how long the motion takes" },
                },
                required: ["kind"],
              },
            },
          },
          required: ["say"],
        },
      },
      overlay_html: {
        type: "string",
        description:
          "for overlay: ONE self-contained HTML document (inline <style>+<script> only, no external resources, no fonts, no CDNs, no network). Transparent page; draw a dark rounded canvas (#0B0B0C ~92% alpha, 1px #ffffff18 border, radius 18px) with a tiny uppercase caption. Accent #1FB57A. Runs immediately on load, animates the concept (prefer <canvas> + requestAnimationFrame).",
      },
      overlay_title: { type: "string", description: "for overlay: 2-4 word label for the pill, lowercase" },
      overlay_width: { type: "number", description: "overlay size in points, max 900" },
      overlay_height: { type: "number", description: "overlay size in points, max 640" },
      memory: { type: "array", items: { type: "string" }, description: "durable facts worth remembering" },
      routine_name: { type: "string" },
      routine_cadence: { type: "string", enum: ["hourly", "daily", "weekdays", "weekly", "manual"] },
      routine_weekday: { type: "integer" },
      routine_hour: { type: "integer" },
      routine_minute: { type: "integer" },
      quick_action: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["reminder", "note", "event", "move_event", "click"] },
          title: { type: "string" },
          body: { type: "string" },
          date: { type: "string", description: "ISO8601" },
          hour: { type: "integer" },
          weekday: { type: "integer", description: "1=Sunday ... 7=Saturday" },
        },
        required: ["type", "title"],
      },
      pick_file: { type: "string", enum: ["video", "pdf", "document", "images", "folder"] },
      connector_call: {
        type: "object",
        description: "for connector: which connected service to call. Apify needs actor + input; MCP needs server + tool + arguments.",
        properties: {
          connector: { type: "string", enum: ["apify", "mcp"] },
          actor: { type: "string", description: "Apify actor id, e.g. apify/google-search-scraper" },
          input: { type: "object", description: "the actor's input" },
          server: { type: "string", description: "MCP server id" },
          tool: { type: "string", description: "MCP tool name" },
          arguments: { type: "object", description: "the MCP tool's arguments" },
        },
        required: ["connector"],
      },
      builtin: { type: "string" },
      clarification: { type: "string" },
      actions: { type: "array", items: { type: "string" } },
    },
    required: ["kind", "title", "answer"],
  },
};

const KEY_MAP: Record<string, string> = {
  preview_summary: "previewSummary",
  preview_steps: "previewSteps",
  teach_steps: "teachSteps",
  teach_plan: "teachPlan",
  routine_name: "routineName",
  routine_cadence: "routineCadence",
  routine_weekday: "routineWeekday",
  routine_hour: "routineHour",
  routine_minute: "routineMinute",
  quick_action: "quickAction",
  pick_file: "pickFile",
  overlay_html: "overlayHTML",
  overlay_title: "overlayTitle",
  overlay_width: "overlayWidth",
  overlay_height: "overlayHeight",
  connector_call: "connectorCall",
};

function normalize(input: Record<string, unknown>): Decision {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    mapped[KEY_MAP[key] ?? key] = value;
  }
  if (!mapped.kind) mapped.kind = "answer";
  if (!mapped.title) mapped.title = "okidoki";
  if (!mapped.answer) mapped.answer = "";
  mapped.risk = mapped.risk ?? "low";
  return mapped as unknown as Decision;
}

function systemPrompt(request: ThinkRequest, catalog: McpCatalogEntry[], recalled: string): string {
  const memory = request.memory?.length ? request.memory.map((m) => `· ${m}`).join("\n") : "nothing yet.";
  const docs = toolDocs(request.installedTools ?? []);
  const native = request.nativeContext;
  const connectors = connectorPrompt(request.connectors, catalog);
  const lines = [
    `You are Okidoki, a warm, quick Mac assistant that lives in the notch and beside your cursor.`,
    `Speak like a sharp friend: lowercase in labels, short sentences, no emoji, no corporate voice.`,
    `You always respond through the okidoki_respond tool.`,
    ``,
    `Decide how to help without asking the person to pick a mode:`,
    `- a question, or anything about what's on screen → answer (look at the screenshot if there is one)`,
    `- a small action in Reminders, Calendar or Notes → quick_action`,
    `- driving any app on their Mac end to end — "open X and ...", "message mom on whatsapp", "create a page in notion", "make blender render", anything a person would do by clicking → computer_use, with the app name(s) in apps. The Mac takes over the mouse with a live preview first.`,
    `- a terminal job using free open-source tools → terminal, always with an action preview`,
    `- writing or fixing code → coding (the app runs their chosen coding agent)`,
    `- a long batch job → background`,
    `- learning, "show me how", walkthroughs → teach, with a teach_plan of 4-7 steps and marks drawn on screen`,
    `- seeing a concept in motion — "explain with a simulation", "show me how this works", physics/dynamics/visualize → overlay, with overlay_html rendered as a floating canvas right on their screen`,
    `- a single click in the current app → borrow, with a clear preview`,
    `- "watch me" → watch`,
    `- live web data, or a job one of their connected services (below) can do → connector, with connector_call and a preview`,
    `- a durable fact → memory`,
    `- a recurring job → routine`,
    `If the request is genuinely unclear, answer with one short question in clarification and set actions to ["show", "do"]. Ask once, not twice.`,
    ``,
    `Rules:`,
    `- Never claim an action is done. The Mac app asks for approval and then executes it.`,
    `- Keep answers under 120 words unless they asked for depth.`,
    `- For risky or destructive work set risk=high and explain plainly.`,
    `- Never target Okidoki's own windows (dashboard, notch, cards, overlays). This is a hard self-guard.`,
    `- Screenshots are never stored; don't suggest keeping them.`,
    `- Prefer Apple apps and free tools. Never buy, send or delete without approval.`,
    `- When they sound stuck, offer a walkthrough rather than a lecture.`,
    `- Use file placeholders {{file}}, {{dir}}, {{outputDir}}, {{basename}} in commands when a picker is needed.`,
    `- If there is a screenshot, actually look at it. Refer to what is visible.`,
    `- computer_use only when the job truly needs driving a GUI. A quick "open X" is also computer_use. Never claim you clicked anything — the Mac app does the driving.`,
    `- overlay_html must be fully self-contained and offline; no external requests ever. Keep it under ~200 lines.`,
    ``,
    `What you remember:`,
    memory,
    recalled ? `\n${recalled}` : "",
    request.settings?.customInstructions ? `\nTheir custom instructions:\n${request.settings.customInstructions}` : "",
    request.account?.name ? `\nThey are ${request.account.name} (${request.account.kind}).` : "",
    `Current app: ${request.appName || "unknown"}`,
    `Now: ${native?.now ?? new Date().toISOString()}`,
    native?.events?.length
      ? `Today's calendar (already read from Calendar):\n${native.events.map((e) => `· ${new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — ${e.title}`).join("\n")}`
      : "",
    native?.frontWindow ? `Front window: ${native.frontWindow}` : "",
    request.documentName ? `Attached document: ${request.documentName}` : "",
    docs ? `\nOpen-source tool docs you can rely on:\n${docs}` : "",
    connectors ? `\nConnected services:\n${connectors}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function userContent(request: ThinkRequest): string {
  const parts = [`Request: ${request.text || "(no words — they circled something)"}`];
  if (request.threadID) parts.push(`Thread: ${request.threadID}. Continue it instead of starting over.`);
  if (request.documentText) parts.push(`Document text (truncated):\n${request.documentText.slice(0, 40000)}`);
  if (request.clipboardText) parts.push(`Clipboard:\n${request.clipboardText.slice(0, 6000)}`);
  return parts.join("\n\n");
}

export async function think(request: ThinkRequest, apiKey: string | undefined): Promise<{ decision: Decision; usedModel: boolean; error?: string }> {
  if (!apiKey) {
    return { decision: localRouter(request), usedModel: false };
  }
  const model = request.settings?.claudeModel || "claude-sonnet-4-5";
  const history = (request.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const message of history.slice(-10)) {
    if (messages.length && messages[messages.length - 1].role === message.role) {
      messages[messages.length - 1].content = message.text;
    } else {
      messages.push({ role: message.role, content: message.text });
    }
  }
  if (messages.length && messages[messages.length - 1].role === "user" && String(messages[messages.length - 1].content) === request.text) {
    messages.pop();
  }
  // Cached after the first listing, so this is usually instant; a slow server is left out rather than stalling.
  // Both are quick (cached servers, in-process index) and run side by side; either can come back empty.
  const [catalog, recalled] = await Promise.all([
    request.connectors?.mcpServers?.length ? mcpCatalog(request.connectors.mcpServers, 4_000) : Promise.resolve([]),
    recall(request.text, request.accountId),
  ]);
  const content: unknown[] = [];
  if (request.screenshotBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: request.screenshotMediaType || "image/png",
        data: request.screenshotBase64,
      },
    });
  }
  content.push({ type: "text", text: userContent(request) });
  messages.push({ role: "user", content });

  const body = {
    model,
    max_tokens: 1600,
    system: systemPrompt(request, catalog, recallPrompt(recalled)),
    messages,
    tools: [responseTool],
    tool_choice: { type: "tool", name: "okidoki_respond" },
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
      const local = localRouter(request);
      return { decision: local, usedModel: false, error: `model ${response.status}: ${detail.slice(0, 160)}` };
    }
    const json = (await response.json()) as { content?: { type: string; text?: string; input?: Record<string, unknown> }[] };
    const blocks = json.content ?? [];
    for (const block of blocks) {
      if (block.type === "tool_use" && block.input) {
        return { decision: checkConnectorDecision(normalize(block.input), request.connectors, catalog), usedModel: true };
      }
    }
    const text = blocks.find((b) => b.type === "text")?.text;
    if (text) return { decision: { kind: "answer", title: "okidoki", answer: text, speak: text }, usedModel: true };
    return { decision: localRouter(request), usedModel: false, error: "empty model response" };
  } catch (error) {
    return {
      decision: localRouter(request),
      usedModel: false,
      error: error instanceof Error ? error.message : "model unavailable",
    };
  }
}
