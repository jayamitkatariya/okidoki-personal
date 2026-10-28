import { useState } from "react";
import { useDashboard } from "../store";
import { copyText, cx, relativeTime } from "../lib";
import type { CodingAgentID, Run } from "../types";
import { jumpToSettingsSection } from "../nav";
import { Button, Chip, Empty, IconButton, PageTitle, PixelIcon, RiskBadge, StatusBadge, TextField } from "../components/ui";

const EXAMPLES = [
  "check free disk space",
  "compress this video for Discord",
  "install ffmpeg",
  "update everything",
  "clean up my mac",
  "show git status in ~/code/okidoki",
];

/** Terminal work in plain English: ask for it, see every command before it runs, run it again later. */
export function TerminalPage({ go }: { go: (page: "settings") => void }) {
  const { state, settings, updateSettings, invoke, notify } = useDashboard();
  const [text, setText] = useState("");
  const [openID, setOpenID] = useState<string | null>(null);
  const runs = (state.runs ?? []).filter((run) => run.kind === "terminal" || run.kind === "coding").slice(0, 40);
  const agents = state.agents ?? [];

  const ask = (request: string) => {
    const value = request.trim();
    if (!value) return;
    invoke("ask", { text: value });
    notify("On it", "You'll see the commands before anything runs", "info");
    setText("");
  };

  return (
    <div className="memory-page terminal-page">
      <PageTitle title="Terminal" subtitle="Say what you want done. okidoki plans the commands, shows them to you first, installs what's missing, and fixes what fails." />

      <section className="tile memory-compose reveal">
        <header className="tile-head">
          <h2>Ask the terminal</h2>
        </header>
        <TextField value={text} onChange={setText} icon="terminal" placeholder="Make this PDF searchable, zip my Downloads, install python…" onEnter={() => ask(text)} />
        <div className="terminal-examples">
          {EXAMPLES.map((example) => (
            <button key={example} className="memory-example" onClick={() => setText(example)}>
              <PixelIcon name="plus" size={12} />
              {example}
            </button>
          ))}
        </div>
      </section>

      {agents.length ? (
        <section className="tile memory-list-tile reveal reveal-2">
          <header className="tile-head">
            <h2>Coding agents</h2>
            <span className="tile-count">{agents.filter((agent) => agent.installed).length}</span>
            <button
              className="tile-link"
              onClick={() => {
                go("settings");
                jumpToSettingsSection("agents");
              }}
            >
              Agent settings <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          <div className="terminal-agents">
            {agents.map((agent) => (
              <div className="memory-setting" key={agent.id}>
                <span className="kind-icon small">
                  <PixelIcon name="code" size={14} />
                </span>
                <span className="row-copy">
                  <strong>{agent.name}</strong>
                  <em>{agent.installed ? (agent.signedIn ? "ready" : `installed · run ${agent.loginHint}`) : "not installed"}</em>
                </span>
                {agent.installed && settings.selectedAgent === agent.id ? (
                  <Chip tone="green">default</Chip>
                ) : agent.installed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      updateSettings({ selectedAgent: agent.id as CodingAgentID });
                      notify("Default agent", agent.name);
                    }}
                  >
                    Make default
                  </Button>
                ) : null}
                {agent.installed ? (
                  <Button variant="secondary" size="sm" onClick={() => ask(`open ${agent.name} in my project`)}>
                    Open
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" icon="download" onClick={() => ask(`install ${agent.name}`)}>
                    Install
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="tile memory-list-tile reveal reveal-3">
        <header className="tile-head">
          <h2>History</h2>
          {runs.length ? <span className="tile-count">{runs.length}</span> : null}
        </header>
        {runs.length ? (
          <div className="memory-list">
            {runs.map((run) => (
              <TerminalRun key={run.id} run={run} open={openID === run.id} onToggle={() => setOpenID(openID === run.id ? null : run.id)} onAgain={() => ask(run.prompt)} onCopy={(value) => void copyText(value).then(() => notify("Copied", "", "info"))} />
            ))}
          </div>
        ) : (
          <Empty icon="terminal" title="Nothing run yet">
            Terminal jobs you ask for show up here with their commands and output, ready to run again.
          </Empty>
        )}
      </section>
    </div>
  );
}

function TerminalRun({ run, open, onToggle, onAgain, onCopy }: { run: Run; open: boolean; onToggle: () => void; onAgain: () => void; onCopy: (value: string) => void }) {
  const commands = run.preview?.commands ?? [];
  return (
    <div className={cx("memory-item", "terminal-run", open && "is-open")}>
      <span className="kind-icon small">
        <PixelIcon name={run.kind === "coding" ? "code" : "terminal"} size={14} />
      </span>
      <div className="terminal-run-body">
        <button className="memory-copy" onClick={onToggle} aria-expanded={open}>
          <span className="memory-text">{run.title || run.prompt}</span>
          <span className="memory-meta">
            {relativeTime(run.createdAt)}
            {commands.length ? ` · ${commands.length} command${commands.length === 1 ? "" : "s"}` : ""}
          </span>
        </button>
        {open ? (
          <div className="terminal-run-detail">
            {commands.length ? <pre className="terminal">{commands.map((command) => `$ ${command}`).join("\n")}</pre> : null}
            {run.output.trim() ? <pre className="terminal">{run.output.trim().split("\n").slice(-40).join("\n")}</pre> : null}
          </div>
        ) : null}
      </div>
      <StatusBadge status={run.status} />
      {run.preview?.risk && run.preview.risk !== "low" ? <RiskBadge risk={run.preview.risk} /> : null}
      <div className="memory-actions">
        {commands.length ? <IconButton icon="copy" label="Copy commands" size={14} onClick={() => onCopy(commands.join("\n"))} /> : null}
        <IconButton icon="refresh" label="Run again" size={14} onClick={onAgain} />
      </div>
      {run.kind === "coding" ? <Chip tone="blue">agent</Chip> : null}
    </div>
  );
}
