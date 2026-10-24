import { useMemo, useState } from "react";
import { useDashboard } from "../store";
import { cx, copyText, money } from "../lib";
import type { Tool } from "../types";
import { Button, Modal, PageTitle, PixelIcon, Switch, TextField } from "../components/ui";

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
] as const;

const CONNECTOR_ICON: Record<string, string> = {
  calendar: "calendar",
  reminders: "bell",
  notes: "note",
  apify: "search",
  mcp: "link",
};

export function ToolboxPage() {
  const { state, settings, updateSettings, invoke, notify } = useDashboard();
  const [query, setQuery] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [docs, setDocs] = useState<Tool | null>(null);
  const installed = state.tools.filter((tool) => tool.installed);
  const savings = state.savings || installed.reduce((sum, tool) => sum + price(tool.id), 0);
  const tools = useMemo(() => {
    if (!query.trim()) return state.tools;
    const q = query.toLowerCase();
    return state.tools.filter((tool) => `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")}`.toLowerCase().includes(q));
  }, [state.tools, query]);

  const installTool = (tool: Tool) => {
    invoke("installTool", { id: tool.id });
    notify("Install preview", `${tool.name} · approval first`, "approval");
  };

  const findResults = useMemo(() => {
    if (!findQuery.trim()) return [];
    const q = findQuery.toLowerCase();
    return state.tools
      .map((tool) => {
        const hay = `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")}`.toLowerCase();
        const score = q.split(/[^a-z0-9]+/).filter((token) => token.length > 2).reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((entry) => entry.tool);
  }, [findQuery, state.tools]);

  return (
    <div className="toolbox-page">
      <PageTitle title="Toolbox" subtitle="Free, open-source tools that replace paid apps. okidoki asks before installing anything." />

      <div className="tb-top">
        <section className="tile tb-find">
          <header className="tile-head">
            <h2>Find a free tool</h2>
          </header>
          <p className="tb-lead">Describe the job. okidoki ranks open-source options by popularity, upkeep and license.</p>
          <div className="tb-find-bar">
            <TextField
              value={findQuery}
              onChange={setFindQuery}
              placeholder="e.g. compress a video for Discord"
              icon="search"
              onEnter={() => setFindQuery(findQuery || "video compression")}
            />
            <Button variant="primary" onClick={() => setFindQuery(findQuery || "video compression")}>
              Compare
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
                      <span className="tb-ready">
                        <PixelIcon name="check" size={14} /> Installed
                      </span>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => installTool(tool)}>
                        Install
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="tb-none">No match in the catalog yet. Try different words, like “convert” or “scan”.</p>
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
                  <strong>{money(price(tool.id))}</strong>
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
                  notify("Default agent", agent.name);
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
          <span className="spacer" />
          <TextField value={query} onChange={setQuery} placeholder="Search tools" icon="search" className="tb-search" />
        </div>
        {tools.length ? (
          <div className="tb-grid">
            {tools.map((tool) => (
              <article className={cx("tile tb-tool", tool.installed && "is-installed")} key={tool.id}>
                <div className="tb-tool-top">
                  <span className="tb-mark" style={markStyle(tool.id)}>
                    {tool.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="row-copy">
                    <strong className="tb-tool-name">{tool.name}</strong>
                    <em>Instead of {tool.replaces}</em>
                  </span>
                  {tool.installed ? (
                    <span className="tb-ready">
                      <PixelIcon name="check" size={14} /> Installed
                    </span>
                  ) : null}
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
            ))}
          </div>
        ) : (
          <div className="tile tb-empty">
            <strong>No tools match “{query}”</strong>
            <span>Try the job instead of the app name, like “pdf” or “video”.</span>
          </div>
        )}
      </section>

      <section className="tile">
        <header className="tile-head">
          <h2>Connectors</h2>
          <span className="tile-count">{state.connectors.filter((connector) => connector.enabled).length}</span>
        </header>
        <div className="pref-list tb-connectors">
          {state.connectors.map((connector) => (
            <div className="pref-row" key={connector.id}>
              <span className={cx("kind-icon small", !connector.enabled && "is-off")}>
                <PixelIcon name={CONNECTOR_ICON[connector.id] ?? (connector.kind === "apple" ? "apple" : "link")} size={14} />
              </span>
              <span className="pref-copy">
                <strong>{connector.name}</strong>
                <em>
                  {connector.blurb}
                  {connector.kind === "apple" ? " Uses Apple Events." : ""}
                </em>
              </span>
              <Switch
                label={connector.name}
                checked={connector.enabled}
                onChange={(value) => {
                  if (connector.kind === "apple") {
                    invoke(value ? "connectApple" : "disconnectApple", { id: connector.id });
                    notify(value ? "Connecting" : "Disconnected", connector.name, "info");
                  } else {
                    notify("Connector updated", connector.name, "info");
                  }
                }}
              />
            </div>
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
                onClick={() => {
                  copyText(docs.docs);
                  notify("Copied", `${docs.name} docs`);
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

function price(id: string): number {
  const map: Record<string, number> = { mole: 39.95, ffmpeg: 79, pandoc: 49, ocrmypdf: 239.88, imagemagick: 69, ollama: 240, rclone: 59, handbrake: 79 };
  return map[id] ?? 0;
}
