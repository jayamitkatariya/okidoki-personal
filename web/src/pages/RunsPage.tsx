import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx, clockLabel, copyText, formatBytes, relativeTime } from "../lib";
import type { Run, RunKind, RunStatus } from "../types";
import { Button, Empty, IconButton, Modal, PixelIcon, RiskBadge, Segmented, StatusBadge, TextArea, TextField } from "../components/ui";

const kindGlyph: Record<RunKind, string> = {
  answer: "spark",
  quickAction: "bolt",
  terminal: "terminal",
  coding: "code",
  background: "runs",
  teach: "wand",
  watch: "eye",
  borrow: "hand",
  computer_use: "hand",
  routine: "clock",
};

const kindName: Record<RunKind, string> = {
  answer: "Answer",
  quickAction: "Quick action",
  terminal: "Terminal",
  coding: "Coding",
  background: "Background",
  teach: "Teach",
  watch: "Watch",
  borrow: "Borrow",
  computer_use: "Computer use",
  routine: "Routine",
};

type FilterId = "all" | "waiting" | "running" | "done" | "failed";

const FILTERS: Array<{ value: FilterId; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

/** "45s", "3m 10s", "3h 5m" — readable at a glance. */
function elapsed(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start) return null;
  const finish = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.max(1, Math.round((finish - new Date(start).getTime()) / 1000));
  if (Number.isNaN(seconds)) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function rowState(status: RunStatus): "wait" | "live" | null {
  if (status === "waiting" || status === "previewing") return "wait";
  if (status === "running") return "live";
  return null;
}

export function RunsPage() {
  const { state, invoke, notify } = useDashboard();
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [redirectText, setRedirectText] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);

  const runs = useMemo(() => {
    return [...state.runs]
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .filter((run) => {
        const matchFilter =
          filter === "all"
            ? true
            : filter === "waiting"
              ? run.status === "waiting" || run.status === "previewing"
              : filter === "running"
                ? run.status === "running" || run.status === "paused"
                : filter === "done"
                  ? run.status === "done"
                  : run.status === "failed" || run.status === "cancelled";
        const matchQuery = !query || run.title.toLowerCase().includes(query.toLowerCase()) || run.prompt.toLowerCase().includes(query.toLowerCase());
        return matchFilter && matchQuery;
      });
  }, [state.runs, filter, query]);

  // the selection always comes from the visible list, so the highlighted row and the detail agree
  const current = runs.find((run) => run.id === selected) ?? runs[0] ?? null;

  useEffect(() => {
    const focusRun = (id: string) => {
      setFilter("all");
      setQuery("");
      setSelected(id);
    };
    // a one-shot hand-off from Home or History: take it, then clear it so later visits start fresh
    const pending = window as unknown as { __okidokiFocusRun?: string };
    if (pending.__okidokiFocusRun) focusRun(pending.__okidokiFocusRun);
    delete pending.__okidokiFocusRun;
    const onFocus = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) focusRun(id);
      delete pending.__okidokiFocusRun;
    };
    window.addEventListener("okidoki-focus-run", onFocus);
    return () => window.removeEventListener("okidoki-focus-run", onFocus);
  }, []);

  // Each run opens at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [current?.id]);


  return (
    <div className="runs">
      <aside className="runs-list">
        <div className="runs-list-head">
          <div className="runs-heading">
            <h1 className="page-title-sm">Runs</h1>
            {state.runs.length ? <span className="tile-count">{state.runs.length}</span> : null}
          </div>
          <TextField value={query} onChange={setQuery} placeholder="Search runs" icon="search" className="runs-search" />
          <div className="runs-filters">
            <Segmented options={FILTERS} value={filter} onChange={setFilter} compact />
          </div>
        </div>
        <div className="runs-scroll">
          {runs.length ? (
            runs.map((run) => {
              const flag = rowState(run.status);
              return (
                <button
                  key={run.id}
                  className={cx("run-row", current?.id === run.id && "is-selected")}
                  onClick={() => setSelected(run.id)}
                  aria-current={current?.id === run.id ? "true" : undefined}
                >
                  <span className="kind-icon small">
                    <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={14} />
                  </span>
                  <span className="run-row-copy">
                    <span className="run-row-top">
                      <strong>{run.title}</strong>
                      <time>{relativeTime(run.createdAt)}</time>
                    </span>
                    <span className="run-row-sub">
                      {flag ? <i className={cx("run-flag", `run-flag-${flag}`)} /> : null}
                      <em>{run.summary || run.status}</em>
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="runs-none">
              <strong>{query ? "No matches" : "Nothing here"}</strong>
              <span>{query ? `No runs mention “${query}”.` : "Runs with this status show up here."}</span>
            </div>
          )}
        </div>
      </aside>

      <div className="runs-detail" ref={detailRef}>
        {current ? (
          <RunDetail
            key={current.id}
            run={current}
            onRedirect={() => setRedirectOpen(true)}
            onShare={() => {
              invoke("shareRun", { id: current.id });
              notify("Run copied", "Paste it anywhere to share");
            }}
          />
        ) : (
          <div className="runs-empty">
            <Empty icon="runs" title="No runs yet">
              Shake your mouse and ask for something. You’ll see the plan before anything touches your Mac.
            </Empty>
          </div>
        )}
      </div>

      <Modal
        open={redirectOpen}
        onClose={() => setRedirectOpen(false)}
        title="Redirect this run"
        subtitle="I’ll stop here and follow your note instead. The thread stays together."
      >
        <TextArea value={redirectText} onChange={setRedirectText} placeholder="Actually, do it this way…" rows={4} />
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setRedirectOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (current) {
                invoke("redirectRun", { id: current.id, text: redirectText });
                notify("Redirected", current.title, "info");
              }
              setRedirectOpen(false);
              setRedirectText("");
            }}
          >
            Redirect
          </Button>
        </footer>
      </Modal>
    </div>
  );
}

function RunDetail({ run, onRedirect, onShare }: { run: Run; onRedirect: () => void; onShare: () => void }) {
  const { state, invoke, notify } = useDashboard();
  const [showCommands, setShowCommands] = useState(true);
  const [allOutput, setAllOutput] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const thread = state.threads.find((item) => item.id === run.threadID);
  const live = run.status === "running" || run.status === "waiting" || run.status === "paused";
  const waiting = run.status === "waiting" || run.status === "previewing";
  const finished = run.status === "done" || run.status === "failed" || run.status === "cancelled";
  const took = run.startedAt ? elapsed(run.startedAt, run.endedAt) : null;
  const doneSteps = run.steps.filter((step) => step.status === "done").length;

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [run.output]);

  const output = allOutput ? run.output : run.output.slice(-14000);

  return (
    <div className="run-detail">
      <header className="run-head">
        <div className="run-head-bar">
          <span className="kind-label">
            <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={14} />
            {kindName[run.kind] ?? run.kind}
          </span>
          <StatusBadge status={run.status} />
          <span className="spacer" />
          <div className="run-tools">
            {live ? (
              <Button variant="ghost" size="sm" onClick={onRedirect}>
                Redirect
              </Button>
            ) : null}
            <IconButton icon="share" label="Share run" onClick={onShare} size={15} />
            {run.status === "running" || run.status === "paused" ? (
              <Button
                variant="secondary"
                size="sm"
                icon={run.status === "paused" ? "play" : "pause"}
                onClick={() => {
                  invoke("pauseRun", { id: run.id });
                  notify(run.status === "paused" ? "Resumed" : "Paused", run.title, "info");
                }}
              >
                {run.status === "paused" ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {live ? (
              <Button
                variant="secondary"
                size="sm"
                icon="stop"
                className="run-stop"
                onClick={() => {
                  invoke("stopRun", { id: run.id });
                  notify("Stopped", "You’re in charge", "info");
                }}
              >
                Stop
              </Button>
            ) : null}
          </div>
        </div>
        <h1 className="run-title">{run.title}</h1>
        {run.prompt ? <p className="run-prompt">{run.prompt}</p> : null}
        <div className="run-meta">
          <span>Started {clockLabel(run.createdAt)}</span>
          {took ? <span>{took}</span> : null}
          {run.agent ? <span className="run-agent">{run.agent}</span> : null}
          {thread ? (
            <button
              className="run-thread"
              title="Open thread"
              onClick={() => {
                (window as unknown as { __okidokiOpenThread?: string }).__okidokiOpenThread = thread.id;
                (window as unknown as { okidokiNavigate?: (page: string) => void }).okidokiNavigate?.("history");
              }}
            >
              <PixelIcon name="link" size={13} />
              <span>{thread.title}</span>
            </button>
          ) : null}
        </div>
      </header>

      {waiting ? (
        <section className="run-approve">
          <span className="run-approve-icon">
            <PixelIcon name="hand" size={17} />
          </span>
          <div className="run-approve-copy">
            <strong>Waiting for your okay</strong>
            <span>Nothing runs until you say so. Review the plan below.</span>
          </div>
          <div className="run-approve-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                invoke("denyRun", { id: run.id });
                notify("Not now", "Nothing changed", "info");
              }}
            >
              Not now
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                invoke("allowAlways", { id: run.id });
                notify("Always allowed", "I won’t ask for this one again", "info");
              }}
            >
              Always allow
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                invoke("approveRun", { id: run.id });
                notify("okidoki!", run.title);
              }}
            >
              Allow once
            </Button>
          </div>
        </section>
      ) : null}

      {run.preview ? (
        <section className="tile run-tile">
          <header className="tile-head">
            <h2>Action preview</h2>
            <RiskBadge risk={run.preview.risk} />
            {run.preview.commands.length ? (
              <button className="tile-link" onClick={() => setShowCommands((value) => !value)}>
                {showCommands ? "Hide commands" : "Show commands"}
              </button>
            ) : null}
          </header>
          {run.preview.summary ? <p className="preview-summary">{run.preview.summary}</p> : null}
          <div className={cx("preview-grid", !(run.preview.apps.length || run.preview.files.length) && "is-single")}>
            {run.preview.steps.length ? (
              <ol className="preview-steps">
                {run.preview.steps.map((step, index) => (
                  <li key={step.id}>
                    <span className="preview-num">{index + 1}</span>
                    <span className="preview-text">{step.text}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {run.preview.apps.length || run.preview.files.length ? (
              <div className="preview-side">
                {run.preview.apps.length ? (
                  <div className="preview-group">
                    <span className="preview-label">Apps</span>
                    <div className="preview-chips">
                      {run.preview.apps.map((app) => (
                        <span key={app} className="chip">
                          {app}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {run.preview.files.length ? (
                  <div className="preview-group">
                    <span className="preview-label">Files</span>
                    {run.preview.files.slice(0, 4).map((file) => (
                      <code key={file} className="preview-file" title={file}>
                        {file.replace(/^\/Users\/[^/]+/, "~")}
                      </code>
                    ))}
                    {run.preview.files.length > 4 ? <span className="preview-more">+{run.preview.files.length - 4} more</span> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {showCommands && run.preview.commands.length ? (
            <div className="command-box">
              <div className="command-head">
                <span>Commands</span>
                <button
                  className="code-action"
                  onClick={() => {
                    copyText(run.preview!.commands.join("\n"));
                    notify("Copied", "Commands are on your clipboard");
                  }}
                >
                  <PixelIcon name="copy" size={13} />
                  Copy
                </button>
              </div>
              {run.preview.commands.map((command, index) => (
                <code key={index}>
                  <em>$</em>
                  <span>{command}</span>
                </code>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {run.steps.length ? (
        <section className="tile run-tile">
          <header className="tile-head">
            <h2>Plan vs actual</h2>
            {run.steps.length ? (
              <span className="run-tile-note">
                {doneSteps} of {run.steps.length} done
              </span>
            ) : null}
          </header>
          {run.steps.length ? (
            <ol className="plan-list">
              {run.steps.map((step, index) => (
                <li className="plan-row" key={step.id}>
                  <span className={cx("plan-dot", `plan-${step.status}`)}>
                    {step.status === "done" ? (
                      <PixelIcon name="check" size={13} />
                    ) : step.status === "failed" ? (
                      <PixelIcon name="x" size={13} />
                    ) : step.status === "running" ? (
                      <i className="spinner-dot" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="plan-copy">
                    <strong>{step.title}</strong>
                    {step.detail ? <em>{step.detail}</em> : null}
                  </span>
                  <span className={cx("plan-status", `plan-status-${step.status}`)}>{step.status}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      {run.output ? (
        <section className="tile run-tile">
          <header className="tile-head">
            <h2>Output</h2>
            {run.status === "running" ? (
              <span className="live-tag">
                <i /> Live
              </span>
            ) : null}
            <button className="tile-link" onClick={() => setAllOutput((value) => !value)}>
              {allOutput ? "Show recent" : "Show all"}
            </button>
            <IconButton
              icon="copy"
              label="Copy output"
              size={15}
              onClick={() => {
                copyText(run.output);
                notify("Copied", "Run output is on your clipboard");
              }}
            />
          </header>
          <pre ref={outputRef} className="terminal">
            {output || "Waiting for output…"}
          </pre>
        </section>
      ) : null}

      {finished ? (
        <section className={cx("run-result", run.status === "done" ? "is-done" : "is-failed")}>
          <span className="run-result-icon">
            <PixelIcon name={run.status === "done" ? "check" : "x"} size={18} />
          </span>
          <div className="run-result-copy">
            <strong>{run.status === "done" ? "Done" : run.status === "cancelled" ? "Stopped" : "Didn’t finish"}</strong>
            <span>{run.summary || run.status}</span>
          </div>
          <div className="run-result-side">
            {run.freedBytes ? (
              <span className="freed">
                <strong>{formatBytes(run.freedBytes)}</strong>
                <em>freed</em>
              </span>
            ) : null}
            {run.kind === "teach" ? (
              <Button variant="secondary" size="sm" icon="play" onClick={() => invoke("startSkill", { id: run.id })}>
                Walk through again
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                onClick={() => {
                  invoke("ask", { text: run.prompt });
                  notify("Running it again", run.prompt);
                }}
              >
                Run again
              </Button>
            )}
          </div>
        </section>
      ) : null}

      <footer className="run-footer">
        <PixelIcon name="lock" size={13} />
        <span>Ran on this Mac. Nothing leaves it without your okay.</span>
        <button className="text-link" onClick={() => invoke("openDataFolder")}>
          Open data folder
        </button>
      </footer>
    </div>
  );
}
