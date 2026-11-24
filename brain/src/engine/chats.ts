import {
  parseDisplayMessages,
  type AgentEvent as EngineAgentEvent,
  type AgentProvider,
  type DisplayMessage,
} from "@okidoki/shared";
import type { AgentEvent, AgentOutcome, AgentRunRequest } from "../codingagents";
import { localEngine } from "./local";

const ENGINE_PROVIDERS = new Set(["claude", "codex", "cursor", "opencode", "gemini", "pi", "muse"]);

interface ActiveRun {
  chatId: string;
  abort: AbortController;
}

const active = new Map<string, ActiveRun>();

/** Stops an engine-backed run: interrupts the chat and closes its stream. */
export function stopEngineRun(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  entry.abort.abort();
  void localEngine
    .engineFetch(`/chats/${entry.chatId}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    .catch(() => undefined);
  return true;
}

export async function engineAvailable(): Promise<boolean> {
  try {
    return (await localEngine.status()).healthy;
  } catch {
    return false;
  }
}

function clip(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function describeTool(message: DisplayMessage): { name: string; detail: string } {
  switch (message.type) {
    case "command":
      return { name: "shell", detail: clip(message.command) };
    case "file_change":
      return { name: "edit", detail: clip(message.changes.map((change) => `${change.kind} ${change.path}`).join(", ")) };
    case "patch":
      return { name: "patch", detail: clip(`${message.operations.length} change${message.operations.length === 1 ? "" : "s"}`) };
    case "tool_call":
      return { name: `${message.server}.${message.tool}`, detail: clip(message.input) };
    case "web_search":
      return { name: "web search", detail: clip(message.query) };
    default:
      return { name: "tool", detail: "" };
  }
}

function chatTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || "okidoki harness chat";
}

/**
 * Runs one turn on the local harness runtime and translates its events into
 * the stream the Mac already understands. The chat id doubles as the provider
 * session, so a follow-up in the same conversation resumes it.
 */
export async function runEngineAgent(request: AgentRunRequest, onEvent: (event: AgentEvent) => void): Promise<AgentOutcome> {
  if (!ENGINE_PROVIDERS.has(request.agent)) throw new Error(`${request.agent} is not an engine harness`);
  const provider = request.agent as AgentProvider;

  let chatId = request.sessionId?.trim() ?? "";
  if (!chatId) {
    const created = await localEngine.engineFetch("/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, title: chatTitle(request.prompt) }),
    });
    if (!created.ok) throw new Error(`engine could not start ${provider}: ${clip(await created.text())}`);
    const body = (await created.json()) as { chat?: { id?: string } };
    if (!body.chat?.id) throw new Error("engine returned no chat id");
    chatId = body.chat.id;
    onEvent({ type: "session", id: chatId });
  }

  const abort = new AbortController();
  active.set(request.runId, { chatId, abort });
  const timeout = setTimeout(() => abort.abort(), request.timeoutMs ?? 30 * 60_000);
  let interrupted = false;
  let timedOut = false;
  let answer = "";
  let errorText = "";
  const collected: EngineAgentEvent[] = [];
  const texts = new Map<string, string>();
  const tools = new Map<string, { done: boolean }>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const finish = (): AgentOutcome => {
    const stopped = interrupted;
    const failed = !stopped && Boolean(errorText);
    return {
      ok: !stopped && !failed && !timedOut,
      answer: answer.trim() || (stopped ? "stopped." : failed ? "" : "done."),
      sessionId: chatId,
      exitCode: null,
      denials: [],
      stopped,
      error: stopped ? "you stopped it" : timedOut ? "it ran past the time limit and was stopped" : failed ? errorText : undefined,
      tools: tools.size,
    };
  };

  try {
    const stream = await localEngine.engineFetch("/events", {
      headers: { accept: "text/event-stream" },
      signal: abort.signal,
    });
    if (!stream.ok || !stream.body) throw new Error(`engine events unavailable (${stream.status})`);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sent = false;

    const apply = (engineEvent: EngineAgentEvent): void => {
      collected.push(engineEvent);
      let messages: DisplayMessage[] = [];
      try {
        messages = parseDisplayMessages(collected, provider);
      } catch {
        return;
      }
      for (const message of messages) {
        if (message.type === "agent") {
          const previous = texts.get(message.id) ?? "";
          if (message.content !== previous) {
            const delta = message.content.startsWith(previous) ? message.content.slice(previous.length) : message.content;
            if (delta) onEvent({ type: "text", text: delta });
            texts.set(message.id, message.content);
          }
          if (message.content.trim()) answer = message.content;
          continue;
        }
        if (message.type === "command" || message.type === "tool_call" || message.type === "file_change" || message.type === "patch" || message.type === "web_search") {
          if (!tools.has(message.id)) {
            tools.set(message.id, { done: false });
            const tool = describeTool(message);
            onEvent({ type: "tool", name: tool.name, detail: tool.detail, id: message.id });
          }
          const status = message.status;
          const finished = status === "completed" || status === "failed";
          const entry = tools.get(message.id);
          if (entry && !entry.done && finished) {
            entry.done = true;
            onEvent({ type: "tool_done", id: message.id, ok: status === "completed" });
          }
          continue;
        }
        if (message.type === "error") errorText = message.message;
      }
    };

    const recoverAnswer = async (): Promise<void> => {
      if (answer.trim()) return;
      try {
        const history = await localEngine.engineFetch(`/chats/${chatId}/history`);
        if (!history.ok) return;
        const body = (await history.json()) as { events?: EngineAgentEvent[] };
        if (!Array.isArray(body.events)) return;
        const messages = parseDisplayMessages(body.events, provider);
        const last = [...messages].reverse().find((message) => message.type === "agent" && message.content.trim());
        if (last && last.type === "agent") {
          answer = last.content;
          onEvent({ type: "text", text: last.content });
        }
      } catch {
        // The stream's own text is still the answer.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        let event: { type?: string; payload?: Record<string, unknown> };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "engine.stream.opened") {
          if (!sent) {
            sent = true;
            const accepted = await localEngine.engineFetch(`/chats/${chatId}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: request.prompt }),
            });
            if (!accepted.ok) throw new Error(`engine did not accept the message: ${clip(await accepted.text())}`);
          }
          continue;
        }
        const payload = event.payload ?? {};
        if (payload.chatId !== chatId) continue;
        if (event.type === "chat.turn.delta" && payload.event) {
          apply(payload.event as EngineAgentEvent);
          continue;
        }
        if (event.type === "chat.interrupted") {
          interrupted = true;
          return finish();
        }
        if (event.type === "chat.turn.completed") {
          await recoverAnswer();
          return finish();
        }
        if (event.type === "error") errorText = String(payload.message ?? "the harness failed");
      }
    }
    return finish();
  } catch (error) {
    if (abort.signal.aborted && !interrupted) timedOut = true;
    if (!errorText) errorText = timedOut ? "" : error instanceof Error ? error.message : "the harness failed";
    return finish();
  } finally {
    clearTimeout(timeout);
    active.delete(request.runId);
    abort.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
