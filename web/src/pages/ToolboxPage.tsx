import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "../store";
import { joinCommand, splitCommand, parseServerJSON } from "../mcp";
import { cx, copyText, findTools, money, relativeTime, searchTools, toolBlocked, toolPrice } from "../lib";
import type { Connector, McpServer, Tool } from "../types";
import { Button, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea, TextField } from "../components/ui";

const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    blurb: "Careful, tight diffs. Great in a single repo.",
    install: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "opencode",
    name: "OpenCode",
    blurb: "Open source and works with any provider.",
    install: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    id: "omp",
    name: "omp",
    blurb: "Long, autonomous jobs with a mix of models.",
    install: "https://omp.sh",
  },
  {
    id: "hermes",
    name: "Hermes",
    blurb: "Tool-heavy workflows and MCP.",
    install: "pipx install hermes-agent",
  },
  {
    id: "codex",
    name: "Codex",
    blurb: "OpenAI's agent. Sandboxed edits, ChatGPT login.",
    install: "npm install -g @openai/codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    blurb: "Google's agent. Big context, free tier.",
    install: "npm install -g @google/gemini-cli",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    blurb: "Cursor's models from the terminal.",
    install: "curl https://cursor.com/install -fsS | bash",
  },
] as const;

const CONNECTOR_ICON: Record<string, string> = {
  calendar: "calendar",
  reminders: "bell",
  notes: "note",
  apify: "search",
  mcp: "link",
};

export function ToolboxPage() {
  const { state, settings, updateSettings, invoke, notify, native } = useDashboard();
  useEffect(() => { if (native) invoke("refreshTools"); }, [invoke, native]);
  const [query, setQuery] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [docs, setDocs] = useState<Tool | null>(null);
  const installed = state.tools.filter((tool) => tool.installed);
  const savings = state.savings || installed.reduce((sum, tool) => sum + toolPrice(tool.id), 0);
  const tools = useMemo(() => {
    return searchTools(state.tools, query);
  }, [state.tools, query]);

  const installTool = (tool: Tool) => {
    invoke("installTool", { id: tool.id });
    notify("Install preview", `${tool.name} · approval first`, "approval");
  };

  // Turning a tool off puts its command on the blocked list, which the Mac enforces before running anything.
  const setToolEnabled = (tool: Tool, enabled: boolean) => {
    const rest = settings.blockedApps.filter((item) => item.trim().toLowerCase() !== tool.command.toLowerCase());
    updateSettings({ blockedApps: enabled ? rest : [...rest, tool.command] });
    notify(enabled ? "Tool on" : "Tool off", enabled ? tool.name : `okidoki won't run ${tool.command}`, "info");
  };

  const findResults = useMemo(() => findTools(state.tools, findQuery), [findQuery, state.tools]);
  const askFurther = () => {
    const job = findQuery.trim();
    if (!job) return;
    invoke("ask", { text: `Find me a free, open-source tool to ${job}` });
    notify("Asked okidoki", "It'll compare options and ask before installing");
  };

  return (
    <div className="toolbox-page">
      <PageTitle title="Toolbox" subtitle="Free, open-source tools that replace paid apps. okidoki asks before installing anything." />

      <div className="tb-top">
        <section className="tile tb-find">
          <header className="tile-head">
            <h2>Find a free tool</h2>
          </header>
          <p className="tb-lead">Describe the job. okidoki ranks the free tools it knows by fit and popularity, and can look further if none fit.</p>
          {!findQuery.trim() ? (
            <div className="tb-examples tb-suggest">
              {state.tools
                .slice(0, 3)
                .map((tool) => tool.examples[0])
                .filter(Boolean)
                .map((example) => (
                  <button key={example} className="tb-example" onClick={() => setFindQuery(example)}>
                    <PixelIcon name="search" size={12} />
                    <span>{example}</span>
                  </button>
                ))}
            </div>
          ) : null}
          <div className="tb-find-bar">
            <TextField value={findQuery} onChange={setFindQuery} placeholder="e.g. compress a video for Discord" icon="search" onEnter={askFurther} />
            <Button variant="primary" icon="spark" disabled={!findQuery.trim()} onClick={askFurther}>
              Ask okidoki
            </Button>
          </div>
          {findQuery.trim() ? (
            findResults.length ? (
              <div className="rows tb-results">
                {findResults.map((tool, index) => (
                  <div className="row" key={tool.id}>
                    <span className="tb-rank">{index + 1}</span>
                    <span className="row-copy">
                      <strong className="tb-tool-name">{tool.name}</strong>
                      <em>
                        Instead of {tool.replaces} · {tool.license}
                      </em>
                    </span>
                    {tool.installed ? (
                      toolBlocked(tool, settings.blockedApps) ? (
                        <span className="tb-off">Off</span>
                      ) : (
                        <span className="tb-ready">
                          <PixelIcon name="check" size={14} /> Installed
                        </span>
                      )
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => installTool(tool)}>
                        Install
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="tb-none">Nothing in the catalog fits that job. Ask okidoki to look further.</p>
            )
          ) : null}
        </section>

        <section className="tile mat tb-savings">
          <div>
            <span className="mat-label">Saved on subscriptions</span>
            <div className="mat-value">{money(savings)}</div>
            <p className="mat-sub">Per year. okidoki itself is free.</p>
          </div>
          {installed.length ? (
            <div className="tb-savings-list">
              {installed.slice(0, 4).map((tool) => (
                <div className="tb-savings-row" key={tool.id}>
                  <span>{tool.name}</span>
                  <strong>{money(toolPrice(tool.id))}</strong>
                </div>
              ))}
              {installed.length > 4 ? <div className="tb-savings-more">+{installed.length - 4} more</div> : null}
            </div>
          ) : (
            <p className="tb-savings-empty">Install a tool below to start saving.</p>
          )}
        </section>
      </div>

      <section className="tile">
        <header className="tile-head">
          <h2>Coding agent</h2>
          <span className="tb-head-note">Name another agent in a request to use it once.</span>
        </header>
        <div className="tb-agents" role="radiogroup" aria-label="Default coding agent">
          {AGENTS.map((agent) => {
            const isInstalled = state.installedAgents.includes(agent.id);
            const selected = settings.selectedAgent === agent.id;
            return (
              <button
                key={agent.id}
                role="radio"
                aria-checked={selected}
                className={cx("tb-agent", selected && "is-selected", !isInstalled && "is-missing")}
                onClick={() => {
                  updateSettings({ selectedAgent: agent.id as typeof settings.selectedAgent });
                  if (isInstalled) notify("Default agent", agent.name);
                  else notify(`${agent.name} isn't installed yet`, `Coding tasks need it first: ${agent.install}`, "warning");
                }}
              >
                <span className="tb-agent-top">
                  <span className="kind-icon small">
                    <PixelIcon name="code" size={14} />
                  </span>
                  <span className={cx("tb-radio", selected && "is-on")}>{selected ? <PixelIcon name="check" size={11} /> : null}</span>
                </span>
                <strong>{agent.name}</strong>
                <em>{agent.blurb}</em>
                {isInstalled ? (
                  <span className="tb-agent-state">{selected ? "Default" : "Installed"}</span>
                ) : (
                  <code className="tb-agent-install" title={agent.install}>
                    {agent.install}
                  </code>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="section-head tb-catalog-head">
          <h2 className="tb-section-title">Free tools</h2>
          <span className="section-count">
            {installed.length} of {state.tools.length} installed
          </span>
          <IconButton icon="refresh" label="Refresh installed tools" onClick={() => invoke("refreshTools")} />
          <span className="spacer" />
          <TextField value={query} onChange={setQuery} placeholder="Search tools" icon="search" className="tb-search" />
        </div>
        {tools.length ? (
          <div className="tb-grid">
            {tools.map((tool) => {
              const off = tool.installed && toolBlocked(tool, settings.blockedApps);
              return (
              <article className={cx("tile tb-tool", tool.installed && "is-installed", off && "is-off")} key={tool.id}>
                <div className="tb-tool-top">
                  <span className="tb-mark" style={markStyle(tool.id)}>
                    {tool.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="row-copy">
                    <strong className="tb-tool-name">{tool.name}</strong>
                    <em>{off ? `Off · okidoki won't run ${tool.command}` : `Instead of ${tool.replaces}`}</em>
                  </span>
                  {tool.installed ? <Switch label={`Use ${tool.name}`} checked={!off} onChange={(value) => setToolEnabled(tool, value)} /> : null}
                </div>
                <p className="tb-blurb">{tool.blurb}</p>
                {tool.examples.length ? (
                  <div className="tb-examples">
                    {tool.examples.slice(0, 2).map((example) => (
                      <button
                        key={example}
                        className="tb-example"
                        title="Ask okidoki"
                        onClick={() => {
                          invoke("ask", { text: example });
                          notify("Asked okidoki", example);
                        }}
                      >
                        <PixelIcon name="spark" size={12} />
                        <span>{example}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="tb-tool-foot">
                  <span className="tb-meta">
                    {tool.category} · {tool.license}
                  </span>
                  <span className="spacer" />
                  <Button variant="ghost" size="sm" onClick={() => setDocs(tool)}>
                    Docs
                  </Button>
                  {tool.installed ? null : (
                    <Button variant="primary" size="sm" icon="download" onClick={() => installTool(tool)}>
                      Install
                    </Button>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        ) : state.tools.length === 0 ? (
          <div className="tile tb-empty">
            <strong>Tools live on your Mac</strong>
            <span>Open okidoki there to see the catalog.</span>
          </div>
        ) : (
          <div className="tile tb-empty">
            <strong>No tools match “{query}”</strong>
            <span>Try the job instead of the app name, like “pdf” or “video”.</span>
          </div>
        )}
      </section>

      <UseFromAgents />

      <section className="tile">
        <header className="tile-head">
          <h2>Connectors</h2>
          <span className="tile-count">{state.connectors.filter((connector) => connector.enabled).length}</span>
        </header>
        <div className="pref-list tb-connectors">
          {state.connectors.map((connector) => (
            <ConnectorRow key={connector.id} connector={connector} />
          ))}
        </div>
      </section>

      <Modal open={Boolean(docs)} onClose={() => setDocs(null)} title={docs ? `Docs for ${docs.name}` : "Docs"} subtitle="What okidoki reads before it runs this tool." width={620}>
        {docs ? (
          <>
            <pre className="tb-docs">{docs.docs || "No docs yet."}</pre>
            <footer className="modal-actions">
              <Button
                variant="ghost"
                icon="copy"
                disabled={!docs.docs}
                onClick={() => {
                  const name = docs.name;
                  void copyText(docs.docs).then((ok) => (ok ? notify("Copied", `${name} docs`) : notify("Couldn't copy", "The clipboard isn't available here", "warning")));
                }}
              >
                Copy
              </Button>
              <Button variant="secondary" onClick={() => setDocs(null)}>
                Done
              </Button>
            </footer>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { state, invoke, notify } = useDashboard();
  // Apify can't do anything without a key, so the switch asks for one first.
  const needsKey = connector.id === "apify" && !state.keys.apify;
  const toggle = (value: boolean) => {
    if (value && needsKey) {
      notify("Apify isn't configured", "It stays off until a key is set", "warning");
      return;
    }
    if (connector.kind === "apple") {
      invoke(value ? "connectApple" : "disconnectApple", { id: connector.id });
      notify(value ? "Connecting" : "Disconnected", connector.name, "info");
    } else {
      invoke("setConnector", { id: connector.id, enabled: value });
      notify(value ? "Connector on" : "Connector off", connector.name, "info");
    }
  };
  return (
    <>
      <div className="pref-row">
        <span className={cx("kind-icon small", !connector.enabled && "is-off")}>
          <PixelIcon name={CONNECTOR_ICON[connector.id] ?? (connector.kind === "apple" ? "apple" : "link")} size={14} />
        </span>
        <span className="pref-copy">
          <strong>{connector.name}</strong>
          <em>
            {connector.blurb}
            {connector.kind === "apple" ? " Uses Apple Events." : ""}
            {connector.id === "apify" && !needsKey ? " Every run shows a preview first and uses your Apify credits." : ""}
            {needsKey ? " Apify isn't configured." : null}
          </em>
        </span>
        <Switch label={connector.name} checked={connector.enabled && !needsKey} onChange={toggle} />
      </div>
      {connector.id === "mcp" && connector.enabled ? <McpServers /> : null}
    </>
  );
}

function McpServers() {
  const { state, settings, updateSettings, invoke, notify, native } = useDashboard();
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const servers = settings.mcpServers ?? [];
  return (
    <div className="tb-mcp">
      {servers.map((server) => {
        const status = state.mcpStatus?.[server.id];
        // Status only reaches the panel on the Mac; elsewhere there's nothing to wait for.
        const tone = !server.enabled || !native ? "is-off" : !status ? "is-pending" : status.ok ? "is-ok" : "is-error";
        return (
          <div className="tb-mcp-row" key={server.id}>
            <span className={cx("tb-mcp-dot", tone)} aria-hidden />
            <span className="tb-mcp-copy">
              <strong>{server.name}</strong>
              <code className="tb-mcp-cmd">{server.transport === "http" ? server.url : joinCommand([server.command, ...server.args])}</code>
              <em className={cx(tone === "is-error" && "tb-mcp-error")}>
                {!server.enabled
                  ? "Off"
                  : !native
                    ? "Status on your Mac"
                  : !status
                    ? "Connecting…"
                    : status.ok
                      ? `${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}${status.tools.length ? ` · ${status.tools.slice(0, 3).map((tool) => tool.name).join(", ")}${status.tools.length > 3 ? "…" : ""}` : ""}`
                      : status.error || "Couldn't connect"}
              </em>
            </span>
            <Switch
              label={`Use ${server.name}`}
              checked={server.enabled}
              onChange={(value) => {
                updateSettings({ mcpServers: servers.map((item) => (item.id === server.id ? { ...item, enabled: value } : item)) });
              }}
            />
            <IconButton icon="edit" label={`Edit ${server.name}`} onClick={() => setEditing(server)} />
          </div>
        );
      })}
      <div className="tb-mcp-actions">
        <Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing("new")}>
          Add server
        </Button>
        <Button variant="ghost" size="sm" icon="download" onClick={() => setImporting(true)}>
          Paste a config
        </Button>
        {servers.length ? (
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            onClick={() => {
              invoke("refreshMcp");
              notify("Reconnecting", `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`, "info");
            }}
          >
            Reconnect
          </Button>
        ) : (
          <span className="tb-mcp-hint">Any MCP server works: a command okidoki starts, or a URL.</span>
        )}
        {servers.length && state.services?.mcp.checkedAt ? (
          <span className="tb-mcp-hint">
            {state.services.mcp.connected} of {state.services.mcp.servers} answering · checked {relativeTime(state.services.mcp.checkedAt)}
          </span>
        ) : null}
      </div>
      <McpServerModal server={editing} onClose={() => setEditing(null)} />
      <McpImportModal open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

/** The servers in a Claude Desktop, Claude Code or Cursor config: `{"mcpServers": {name: {command, args, env} | {url, headers}}}`. */
export function serversFromConfig(text: string): { server: McpServer; secrets: { env: Record<string, string>; headers: Record<string, string> } }[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const table = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, Record<string, unknown>>;
  return Object.entries(table)
    .filter(([, value]) => value && typeof value === "object" && (typeof value.command === "string" || typeof value.url === "string"))
    .map(([name, value]) => {
      const http = typeof value.url === "string";
      const strings = (raw: unknown) => Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      return {
        server: {
          id: `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name,
          transport: http ? "http" : "stdio",
          command: http ? "" : String(value.command),
          args: http ? [] : ((value.args as unknown[]) ?? []).map(String),
          url: http ? String(value.url) : "",
          enabled: true,
        } as McpServer,
        secrets: { env: strings(value.env), headers: strings(value.headers) },
      };
    });
}

function McpImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { invoke, notify } = useDashboard();
  const [text, setText] = useState("");
  let found: ReturnType<typeof serversFromConfig> = [];
  let problem = "";
  if (text.trim()) {
    try {
      found = serversFromConfig(text);
      if (!found.length) problem = "No servers in that. Paste the part with \"mcpServers\".";
    } catch {
      problem = "That isn't valid JSON yet.";
    }
  }
  const add = () => {
    for (const { server, secrets } of found) invoke("saveMcpServer", { server, secrets });
    notify(found.length === 1 ? "Server added" : `${found.length} servers added`, found.map((item) => item.server.name).join(", "), "info");
    setText("");
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Paste an MCP config" subtitle="From Claude Desktop, Claude Code or Cursor. Secrets go to this Mac's key file." width={560}>
      <TextArea value={text} onChange={setText} rows={10} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
      <p className="form-hint">{problem || (found.length ? `Found ${found.map((item) => item.server.name).join(", ")}.` : " ")}</p>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!found.length} onClick={add}>
          Add {found.length > 1 ? `${found.length} servers` : "server"}
        </Button>
      </footer>
    </Modal>
  );
}

/** How to reach okidoki from another agent: its own MCP server, over this Mac's control endpoint. */
function UseFromAgents() {
  const { notify } = useDashboard();
  const command = "claude mcp add okidoki -- bun ~/Desktop/okidoki-personal/mcp/okidoki-mcp.ts";
  return (
    <section className="tile">
      <header className="tile-head">
        <h2>Use okidoki from other agents</h2>
      </header>
      <p className="tb-mcp-hint">
        Claude Code, Cursor and any MCP client can list and replay your skills, search the vault, and add notes and reminders. Replays still ask
        for your okay here.
      </p>
      <div className="tb-mcp-row">
        <code className="tb-mcp-cmd">{command}</code>
        <IconButton icon="copy" label="Copy" onClick={() => void copyText(command).then(() => notify("Copied", "Paste it in a terminal", "info"))} />
      </div>
    </section>
  );
}

function parsePairs(text: string, separator: "=" | ":"): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) pairs[key] = line.slice(at + 1).trim();
  }
  return pairs;
}

function McpServerModal({ server, onClose }: { server: McpServer | "new" | null; onClose: () => void }) {
  const { state, invoke, notify } = useDashboard();
  const existing = server && server !== "new" ? server : null;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpServer["transport"]>("stdio");
  const [target, setTarget] = useState("");
  const [secretText, setSecretText] = useState("");
  const [clearSecrets, setClearSecrets] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const stored = existing ? (state.mcpSecretNames?.[existing.id] ?? []) : [];

  useEffect(() => {
    setName(existing?.name ?? "");
    setTransport(existing?.transport ?? "stdio");
    setTarget(existing ? (existing.transport === "http" ? existing.url : joinCommand([existing.command, ...existing.args])) : "");
    setSecretText("");
    setClearSecrets(false);
    setConfirmRemove(false);
  }, [server]);

  // Pasting a README's JSON fills the whole form.
  const onTarget = (value: string) => {
    const parsed = value.trim().startsWith("{") ? parseServerJSON(value) : null;
    if (!parsed) {
      setTarget(value);
      return;
    }
    if (parsed.name && !name) setName(parsed.name);
    if (parsed.url) {
      setTransport("http");
      setTarget(parsed.url);
      setSecretText(Object.entries(parsed.headers ?? {}).map(([key, val]) => `${key}: ${val}`).join("\n"));
    } else {
      setTransport("stdio");
      setTarget(joinCommand([parsed.command ?? "", ...(parsed.args ?? [])]));
      setSecretText(Object.entries(parsed.env ?? {}).map(([key, val]) => `${key}=${val}`).join("\n"));
    }
  };

  const words = splitCommand(target.trim());
  const valid = name.trim() && (transport === "http" ? /^https?:\/\/\S+$/.test(target.trim()) : !target.trim().startsWith("{") && words !== null && Boolean(words[0]));
  const save = () => {
    if (!valid || (transport === "stdio" && !words)) return;
    const next: McpServer = {
      id: existing?.id ?? `mcp-${Math.random().toString(16).slice(2, 10)}`,
      name: name.trim(),
      transport,
      command: transport === "stdio" ? words![0] : "",
      args: transport === "stdio" ? words!.slice(1) : [],
      url: transport === "http" ? target.trim() : "",
      enabled: existing?.enabled ?? true,
    };
    const typed = secretText.trim();
    // Secrets go only when changed, straight to the Mac's key file; leaving the box empty keeps what's saved.
    const secrets = typed
      ? transport === "http"
        ? { env: {}, headers: parsePairs(typed, ":") }
        : { env: parsePairs(typed, "="), headers: {} }
      : clearSecrets || !existing
        ? { env: {}, headers: {} }
        : undefined;
    invoke("saveMcpServer", { server: next, ...(secrets ? { secrets } : {}) });
    notify(existing ? "Server updated" : "Server added", `${next.name} · connecting`, "info");
    onClose();
  };

  return (
    <Modal
      open={Boolean(server)}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "Add an MCP server"}
      subtitle="okidoki lists its tools and asks before calling any of them."
      width={560}
    >
      <div className="form-stack tb-mcp-form">
        <div className="tb-field">
          <span className="form-label">Name</span>
          <TextField value={name} onChange={setName} placeholder="GitHub" autoFocus={!existing} />
        </div>
        <div className="tb-field">
          <span className="form-label">How it runs</span>
          <Segmented
            options={[
              { value: "stdio", label: "Command" },
              { value: "http", label: "URL" },
            ]}
            value={transport}
            onChange={setTransport}
          />
        </div>
        <div className="tb-field">
          <span className="form-label">{transport === "http" ? "Server URL" : "Command"}</span>
          <TextField
            value={target}
            onChange={onTarget}
            placeholder={transport === "http" ? "https://example.com/mcp" : "npx -y @modelcontextprotocol/server-github"}
            icon={transport === "http" ? "link" : "terminal"}
          />
          <span className="tb-mcp-hint">{transport === "http" ? "A streamable HTTP endpoint." : "Or paste the JSON from the server's README."}</span>
        </div>
        <div className="tb-field">
          <span className="form-label">{transport === "http" ? "Headers" : "Environment variables"}</span>
          <TextArea
            value={secretText}
            onChange={setSecretText}
            rows={3}
            placeholder={transport === "http" ? "Authorization: Bearer …" : "GITHUB_PERSONAL_ACCESS_TOKEN=…"}
          />
          <span className="tb-mcp-hint">
            <PixelIcon name="lock" size={12} /> Saved privately on this Mac, never synced.{" "}
            {stored.length && !clearSecrets ? (
              <>
                Saved now: {stored.join(", ")}. Leave empty to keep them, or{" "}
                <button className="text-link" onClick={() => setClearSecrets(true)}>
                  remove them
                </button>
                .
              </>
            ) : clearSecrets ? (
              "Saved values will be removed."
            ) : null}
          </span>
        </div>
      </div>
      <footer className="modal-actions">
        {existing ? (
          <Button
            variant="ghost"
            icon="trash"
            className="tb-mcp-remove"
            onClick={() => {
              if (!confirmRemove) {
                setConfirmRemove(true);
                return;
              }
              invoke("deleteMcpServer", { id: existing.id });
              notify("Server removed", existing.name, "info");
              onClose();
            }}
          >
            {confirmRemove ? "Remove for good" : "Remove"}
          </Button>
        ) : null}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid} onClick={save}>
          {existing ? "Save" : "Add server"}
        </Button>
      </footer>
    </Modal>
  );
}

// Soft, on-palette tints so each tool reads as its own thing without shouting.
const MARK_TONES = [
  { bg: "var(--accent-soft)", fg: "var(--accent-ink)" },
  { bg: "var(--sky-soft)", fg: "var(--sky)" },
  { bg: "var(--lavender-soft)", fg: "var(--lavender)" },
  { bg: "var(--amber-soft)", fg: "var(--amber)" },
  { bg: "var(--well-strong)", fg: "var(--ink-2)" },
];

function markStyle(id: string): React.CSSProperties {
  const sum = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
  const tone = MARK_TONES[sum % MARK_TONES.length];
  return { background: tone.bg, color: tone.fg };
}

