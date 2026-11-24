import { useEffect, useState } from "react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import type { CodingAgentConfig, CodingAgentSettings, DetectedCodingAgent } from "../types";
import { Button, IconButton, Modal, PixelIcon, Segmented, Switch, TextField } from "../components/ui";

const EMPTY: CodingAgentSettings = { agents: [], defaultID: "", workingFolder: "", autoRoute: true, useEngine: false };

/** What each access level means per agent, said the same way the Mac says it in a run's preview. */
const ACCESS: Record<string, { workspace: string; full: string }> = {
  claude: {
    workspace: "Edits files in the working folder and runs safe commands there. Deleting, installing and sending come back to you.",
    full: "Bypasses Claude Code’s permission checks: any file, any command.",
  },
  codex: { workspace: "Writes only inside the working folder, with no network (Codex’s workspace sandbox).", full: "No sandbox, no approvals: any file, any command, the network." },
  amp: { workspace: "Amp’s own permission rules apply.", full: "Amp’s own permission rules apply." },
  pi: { workspace: "Pi has no permission layer, so every job waits for your OK.", full: "Pi has no permission layer, so every job waits for your OK." },
  opencode: { workspace: "OpenCode’s own permission config applies.", full: "Auto-approves everything you haven’t denied in OpenCode." },
  gemini: { workspace: "Edits files in the working folder; shell commands are not allowed.", full: "Every tool runs without asking (yolo)." },
  cursor: { workspace: "Cursor’s sandbox and allow-list apply.", full: "Runs every command you haven’t denied in Cursor (--force)." },
};

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");
const sentence = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "");

/**
 * Coding agents okidoki hands work to: Claude Code, Codex, Amp, Pi, OpenCode, Gemini CLI, Cursor Agent,
 * or any command. Found ones are listed with a switch; one is the default; all work in one folder.
 */
export function CodingAgents() {
  const { state, settings, updateSettings, invoke, native } = useDashboard();
  const config = settings.codingAgents ?? EMPTY;
  const detected = state.codingAgents?.detected ?? [];
  const [editing, setEditing] = useState<{ agent: CodingAgentConfig; detected?: DetectedCodingAgent } | "new" | null>(null);

  const save = (next: Partial<CodingAgentSettings>) => updateSettings({ codingAgents: { ...config, ...next } });
  const configured = (id: string) => config.agents.find((agent) => agent.id === id);
  const upsert = (agent: CodingAgentConfig) => {
    const agents = configured(agent.id) ? config.agents.map((item) => (item.id === agent.id ? agent : item)) : [...config.agents, agent];
    const on = agents.filter((item) => item.enabled);
    // The default follows what's on: the first one turned on becomes it, and turning the default off moves it.
    const defaultID = on.some((item) => item.id === config.defaultID) ? config.defaultID : (on[0]?.id ?? "");
    save({ agents, defaultID });
  };
  const remove = (id: string) => {
    const agents = config.agents.filter((item) => item.id !== id);
    save({ agents, defaultID: config.defaultID === id ? (agents.find((item) => item.enabled)?.id ?? "") : config.defaultID });
  };

  // Known agents first (installed ones on top), then custom commands.
  const known = [...detected].sort((a, b) => Number(Boolean(b.path)) - Number(Boolean(a.path)));
  const custom = config.agents.filter((agent) => !detected.some((item) => item.id === agent.id));
  const enabled = config.agents.filter((agent) => agent.enabled);
  const folder = state.codingAgents?.folder ?? (config.workingFolder || settings.vaultFolder || "~");

  return (
    <div className="pref-group">
      <div className="mcp-list coding-agents">
        {!native && !detected.length ? <span className="mcp-hint">Open this in the okidoki app on your Mac to find the agents installed there.</span> : null}
        {known.map((item) => {
          const agent = configured(item.id) ?? { id: item.id, name: item.name, enabled: false, command: "", access: "workspace" as const };
          const tone = agent.enabled ? "is-ok" : "is-off";
          const isDefault = agent.enabled && config.defaultID === agent.id;
          return (
            <div className={cx("mcp-row", !item.path && "is-missing")} key={item.id}>
              <span className={cx("mcp-dot", tone)} aria-hidden />
              <span className="mcp-copy">
                <strong>
                  {item.name}
                  {isDefault ? <span className="agent-default">Default</span> : null}
                </strong>
                {item.path ? <code className="mcp-cmd">{home(item.path)}</code> : null}
                <em>
                  {!item.path
                    ? "Not found on this Mac"
                    : agent.enabled
                      ? sentence(state.codingAgents?.access[item.id] ?? ACCESS[item.id]?.[agent.access] ?? "")
                      : item.verified === "docs"
                        ? "Found · flags from its docs"
                        : "Found"}
                </em>
              </span>
              {agent.enabled && !isDefault && enabled.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => save({ defaultID: agent.id })}>
                  Make default
                </Button>
              ) : null}
              {item.path || agent.command || agent.enabled ? (
                <Switch label={`Use ${item.name}`} checked={agent.enabled} onChange={(value) => upsert({ ...agent, enabled: value })} />
              ) : (
                <Button variant="ghost" size="sm" icon="external" onClick={() => invoke("openExternal", { url: item.site })}>
                  Get it
                </Button>
              )}
              <IconButton icon="edit" label={`Set up ${item.name}`} onClick={() => setEditing({ agent, detected: item })} />
            </div>
          );
        })}
        {custom.map((agent) => (
          <div className="mcp-row" key={agent.id}>
            <span className={cx("mcp-dot", agent.enabled ? "is-ok" : "is-off")} aria-hidden />
            <span className="mcp-copy">
              <strong>
                {agent.name}
                {agent.enabled && config.defaultID === agent.id ? <span className="agent-default">Default</span> : null}
              </strong>
              <code className="mcp-cmd">{agent.command}</code>
              <em>Custom command · it can do anything your user can, so every job waits for your OK</em>
            </span>
            {agent.enabled && config.defaultID !== agent.id && enabled.length > 1 ? (
              <Button variant="ghost" size="sm" onClick={() => save({ defaultID: agent.id })}>
                Make default
              </Button>
            ) : null}
            <Switch label={`Use ${agent.name}`} checked={agent.enabled} onChange={(value) => upsert({ ...agent, enabled: value })} />
            <IconButton icon="edit" label={`Edit ${agent.name}`} onClick={() => setEditing({ agent })} />
          </div>
        ))}
        <div className="mcp-actions">
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing("new")}>
            Add custom agent
          </Button>
          {native ? (
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => invoke("rescanCodingAgents")}>
              Look again
            </Button>
          ) : null}
          <span className="mcp-hint">Each agent uses its own sign-in. okidoki never passes it a key.</span>
        </div>
      </div>

      <PrefRow title="Working folder" detail={`Where agents work: ${home(folder)}${config.workingFolder ? "" : " (your vault)"}. Use a folder you’re happy for them to change.`}>
        {config.workingFolder ? (
          <Button variant="ghost" size="sm" onClick={() => save({ workingFolder: "" })}>
            Use vault
          </Button>
        ) : null}
        {native ? (
          <Button variant="secondary" size="sm" icon="folder" onClick={() => invoke("pickCodingAgentFolder")}>
            Choose
          </Button>
        ) : (
          <span className="pref-hint">Mac only</span>
        )}
      </PrefRow>
      <PrefRow
        title="Send file and code jobs on its own"
        detail={
          enabled.length
            ? "Organising, renaming, converting, extracting from documents, scripts and code go to the default agent. Pick “Agent” under Where to send anything."
            : "Turn an agent on first."
        }
      >
        <Switch label="Send file and code jobs on its own" checked={config.autoRoute} onChange={(value) => save({ autoRoute: value })} />
      </PrefRow>
      <PrefRow title="Use the harness runtime" detail="Run enabled agents inside okidoki's own runtime: one queue, mid-turn steering, subagents and shared history. Falls back to the CLI if it can't start.">
        <Switch label="Use the harness runtime" checked={config.useEngine ?? false} onChange={(value) => save({ useEngine: value })} />
      </PrefRow>

      <AgentModal
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={(agent) => {
          upsert(agent);
          setEditing(null);
        }}
        onRemove={(id) => {
          remove(id);
          setEditing(null);
        }}
      />
    </div>
  );
}

function PrefRow({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="pref-row">
      <span className="pref-copy">
        <strong>{title}</strong>
        {detail ? <em>{detail}</em> : null}
      </span>
      <span className="pref-control">{children}</span>
    </div>
  );
}

const CUSTOM_EXAMPLE = "aider --message {prompt} --yes-always";

function AgentModal({
  editing,
  onClose,
  onSave,
  onRemove,
}: {
  editing: { agent: CodingAgentConfig; detected?: DetectedCodingAgent } | "new" | null;
  onClose: () => void;
  onSave: (agent: CodingAgentConfig) => void;
  onRemove: (id: string) => void;
}) {
  const current = editing && editing !== "new" ? editing : null;
  const preset = Boolean(current?.detected);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [access, setAccess] = useState<CodingAgentConfig["access"]>("workspace");

  useEffect(() => {
    setName(current?.agent.name ?? "");
    setCommand(current?.agent.command ?? "");
    setAccess(current?.agent.access ?? "workspace");
  }, [editing]);

  const blocked = preset ? null : !name.trim() ? "Give it a name." : !command.trim() ? "Add the command." : null;
  const levels = current?.detected ? ACCESS[current.detected.id] : undefined;

  return (
    <Modal
      open={Boolean(editing)}
      onClose={onClose}
      title={preset ? current!.agent.name : current ? `Edit ${current.agent.name}` : "Add a coding agent"}
      subtitle={
        preset
          ? "okidoki runs it without a window in your working folder, shows what it does in the chat, and resumes the same session for follow-ups."
          : "Any command-line agent. okidoki runs it in your working folder and shows its output as it works."
      }
      width={560}
    >
      <div className="form-stack mcp-form">
        {preset ? null : (
          <div className="mcp-field">
            <span className="form-label">Name</span>
            <TextField value={name} onChange={setName} placeholder="Aider" autoFocus />
          </div>
        )}
        <div className="mcp-field">
          <span className="form-label">{preset ? "Program" : "Command"}</span>
          <TextField
            value={command}
            onChange={setCommand}
            icon="terminal"
            placeholder={preset ? (current?.detected?.path ? home(current.detected.path) : `path to ${current?.detected?.name ?? "the program"}`) : CUSTOM_EXAMPLE}
          />
          <span className="mcp-hint">
            {preset
              ? current?.detected?.path
                ? "Found on its own. Set a path only to use a different copy."
                : "Not found in the usual places. Paste the full path to it, or install it and press Look again."
              : "{prompt} is replaced with the job and {cwd} with the working folder, both safely quoted. Without {prompt}, the job goes at the end."}
          </span>
        </div>
        {preset && levels ? (
          <div className="mcp-field">
            <span className="form-label">Access</span>
            <Segmented
              options={[
                { value: "workspace", label: "Working folder" },
                { value: "full", label: "Full access" },
              ]}
              value={access}
              onChange={setAccess}
            />
            <span className={cx("mcp-hint", access === "full" && "agent-warn")}>
              {access === "full" ? <PixelIcon name="lock" size={12} /> : null} {levels[access]}
              {access === "full" ? " Every job waits for your OK first." : ""}
            </span>
          </div>
        ) : null}
        {!preset ? (
          <span className="mcp-hint agent-warn">
            <PixelIcon name="lock" size={12} /> A custom command can do anything your user can, so every job waits for your OK.
          </span>
        ) : null}
      </div>
      <footer className="modal-actions">
        {current && !preset ? (
          <Button variant="ghost" icon="trash" className="mcp-remove" onClick={() => onRemove(current.agent.id)}>
            Remove
          </Button>
        ) : null}
        <span className="spacer" />
        {blocked ? <em className="field-hint">{blocked}</em> : null}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={Boolean(blocked)}
          onClick={() => {
            const agent: CodingAgentConfig = current
              ? { ...current.agent, name: preset ? current.agent.name : name.trim(), command: command.trim(), access }
              : { id: `agent-${Math.random().toString(16).slice(2, 10)}`, name: name.trim(), enabled: true, command: command.trim(), access: "workspace" };
            onSave(agent);
          }}
        >
          {current ? "Save" : "Add agent"}
        </Button>
      </footer>
    </Modal>
  );
}
