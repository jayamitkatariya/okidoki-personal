import { useMemo } from "react";
import { useDashboard } from "../store";
import { cx, futureTime, money, relativeTime, scheduleLabel, timeOfDay, todayLabel, toolPrice } from "../lib";
import type { Run, RunKind, Settings } from "../types";
import { Button, CountUp, KeyHint, PixelIcon, Progress, RiskBadge, StatusBadge } from "../components/ui";
import type { Page } from "../components/Layout";
import { PixelMark } from "../components/PixelMark";

function openAsk() {
  (window as unknown as { okidokiOpenAsk?: () => void }).okidokiOpenAsk?.();
}

function focusRun(id: string) {
  (window as unknown as { __okidokiFocusRun?: string }).__okidokiFocusRun = id;
  window.dispatchEvent(new CustomEvent("okidoki-focus-run", { detail: id }));
}

export const kindGlyph: Record<RunKind, string> = {
  answer: "spark",
  quickAction: "bolt",
  computer_use: "hand",
  terminal: "terminal",
  coding: "code",
  background: "runs",
  teach: "wand",
  watch: "eye",
  borrow: "hand",
  routine: "clock",
};

type ToggleKey = "okidokiEnabled" | "backgroundMode" | "screenBorrowing" | "voiceEnabled" | "captions" | "quietMode";

const CONTROLS: { key: ToggleKey; icon: string; title: string; on: string; off: string }[] = [
  { key: "okidokiEnabled", icon: "spark", title: "okidoki", on: "Listening", off: "Paused" },
  { key: "quietMode", icon: "moon", title: "Quiet", on: "Silent", off: "Off" },
  { key: "voiceEnabled", icon: "mic", title: "Voice", on: "Spoken replies", off: "Off" },
  { key: "backgroundMode", icon: "runs", title: "Background", on: "Batch work", off: "Off" },
  { key: "screenBorrowing", icon: "hand", title: "Borrowing", on: "Asks first", off: "Off" },
  { key: "captions", icon: "eye", title: "Captions", on: "On", off: "Off" },
];

export function HomePage({ go }: { go: (page: Page) => void }) {
  const { state, settings, account, invoke, updateSettings, notify } = useDashboard();
  const runs = state.runs ?? [];
  const waiting = runs.filter((run) => run.status === "waiting" || run.status === "previewing");
  const live = runs.filter((run) => run.status === "running" || run.status === "paused");
  const recent = useMemo(
    () =>
      runs
        .filter((run) => run.status === "done" || run.status === "failed" || run.status === "cancelled")
        .sort((a, b) => +new Date(b.endedAt ?? b.createdAt) - +new Date(a.endedAt ?? a.createdAt)),
    [runs],
  );
  const routines = (state.routines ?? []).filter((routine) => routine.enabled);
  const memories = state.memories ?? [];
  const installedTools = (state.tools ?? []).filter((tool) => tool.installed);
  const savings = state.savings || installedTools.reduce((sum, tool) => sum + toolPrice(tool.id), 0);
  const firstWord = account.name.split(" ")[0] || "there";
  const firstName = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);

  const openRun = (id: string) => {
    focusRun(id);
    go("runs");
  };

  const toggle = (key: ToggleKey, title: string) => {
    const next = !settings[key];
    updateSettings({ [key]: next } as Partial<Settings>);
    notify(`${title} ${next ? "on" : "off"}`, undefined, "info");
  };

  return (
    <div className="home">
      <div className="bento">
        <section className="tile hero span-8 reveal">
          <div className="hero-copy">
            <span className="hero-date">{todayLabel()}</span>
            <h1>
              Good {timeOfDay()}, {firstName}
            </h1>
            <p>
              {waiting.length ? (
                <>
                  <strong>
                    {waiting.length} {waiting.length === 1 ? "thing needs" : "things need"} your yes.
                  </strong>{" "}
                  {live.length ? `${live.length} more in progress.` : null}
                </>
              ) : live.length ? (
                `${live.length} ${live.length === 1 ? "run is" : "runs are"} in progress. Nothing needs you.`
              ) : (
                "All clear. Shake your mouse anywhere to summon okidoki."
              )}
            </p>
          </div>
          <button className="hero-ask" onClick={openAsk}>
            <PixelIcon name="search" size={18} />
            <span>Ask, do, or learn anything</span>
            <em className="hero-mode">
              <PixelIcon name={settings.defaultInput === "voice" ? "mic" : "pencil"} size={13} />
              {settings.defaultInput === "voice" ? "Voice" : "Typing"}
            </em>
            <KeyHint>⌘K</KeyHint>
          </button>
        </section>

        <section className="tile mat span-4 reveal reveal-2">
          <div>
            <span className="mat-label">Saved on subscriptions</span>
            <div className="mat-value">
              <CountUp end={Math.round(savings)} prefix="$" />
            </div>
            <p className="mat-sub">
              {installedTools.length
                ? `${installedTools.length} free ${installedTools.length === 1 ? "tool replaces a" : "tools replace"} paid apps`
                : "Install free tools to replace paid apps"}
            </p>
          </div>
          <div className="mat-stats">
            <button onClick={() => go("runs")}>
              <strong>
                <CountUp end={waiting.length} />
              </strong>
              <span>Waiting</span>
            </button>
            <button onClick={() => go("runs")}>
              <strong>
                <CountUp end={live.length} />
              </strong>
              <span>Running</span>
            </button>
            <button onClick={() => go("memory")}>
              <strong>
                <CountUp end={memories.length} />
              </strong>
              <span>Memories</span>
            </button>
          </div>
        </section>

        <section className="tile span-8 reveal reveal-2">
          <header className="tile-head">
            <h2>Needs you</h2>
            {waiting.length ? <span className="tile-count is-hot">{waiting.length}</span> : null}
            <button className="tile-link" onClick={() => go("runs")}>
              All runs <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {waiting.length ? (
            <div className="needs-list">
              {waiting.slice(0, 3).map((run) => (
                <div className="needs-row" key={run.id}>
                  <span className="kind-icon">
                    <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={17} />
                  </span>
                  <div className="needs-copy">
                    <div className="needs-title">
                      <strong>{run.title}</strong>
                      <RiskBadge risk={run.preview?.risk} />
                    </div>
                    <p>{run.preview?.summary || run.prompt}</p>
                  </div>
                  <div className="needs-actions">
                    <Button variant="ghost" size="sm" onClick={() => openRun(run.id)}>
                      Review
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        invoke("approveRun", { id: run.id });
                        notify("Approved", run.title);
                      }}
                    >
                      {run.kind === "borrow" ? "Allow once" : "Approve"}
                    </Button>
                  </div>
                </div>
              ))}
              {waiting.length > 3 ? (
                <button className="row is-clickable more-row" onClick={() => go("runs")}>
                  <span className="row-copy">
                    <em>+{waiting.length - 3} more waiting</em>
                  </span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="caught-up">
              <span className="caught-up-icon">
                <PixelIcon name="check" size={20} />
              </span>
              <div>
                <strong>You're all caught up</strong>
                <span>Anything that touches your Mac shows up here first.</span>
              </div>
            </div>
          )}
        </section>

        <section className="tile span-4 reveal reveal-2">
          <header className="tile-head">
            <h2>Live</h2>
            {live.length ? <span className="tile-count">{live.length}</span> : null}
            <button className="tile-link" onClick={() => go("runs")}>
              Runs <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {live.length ? (
            <div>
              {live.slice(0, 2).map((run) => (
                <LiveItem
                  key={run.id}
                  run={run}
                  onOpen={() => openRun(run.id)}
                  onPause={() => invoke("pauseRun", { id: run.id })}
                  onStop={() => invoke("stopRun", { id: run.id })}
                />
              ))}
            </div>
          ) : (
            <div className="tile-empty">
              <strong>Nothing running</strong>
              Background work and agents show progress here.
            </div>
          )}
        </section>

        <section className="tile span-12 reveal reveal-3">
          <header className="tile-head">
            <h2>Controls</h2>
            <button className="tile-link" onClick={() => go("settings")}>
              Settings <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          <div className="controls">
            {CONTROLS.map((control) => {
              const on = Boolean(settings[control.key]);
              return (
                <button
                  key={control.key}
                  className={cx("control", on && "is-on")}
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggle(control.key, control.title)}
                >
                  <span className="control-icon">
                    <PixelIcon name={control.icon} size={15} />
                  </span>
                  <span>
                    <strong>{control.title}</strong>
                    <em>{on ? control.on : control.off}</em>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="tile span-8 reveal reveal-3">
          <header className="tile-head">
            <h2>Recent</h2>
            <button className="tile-link" onClick={() => go("history")}>
              History <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {recent.length ? (
            <div className="rows">
              {recent.slice(0, 4).map((run) => (
                <button className="row" key={run.id} onClick={() => openRun(run.id)}>
                  <span className="kind-icon small">
                    <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={14} />
                  </span>
                  <span className="row-copy">
                    <strong className="sentence">{run.title}</strong>
                    <em className="sentence">{run.summary || run.prompt}</em>
                  </span>
                  <span className="row-meta">{relativeTime(run.endedAt ?? run.createdAt)}</span>
                  <StatusBadge status={run.status} />
                </button>
              ))}
            </div>
          ) : (
            <div className="tile-empty">
              <strong>No history yet</strong>
              Finished requests land here.
            </div>
          )}
        </section>

        <section className="tile span-4 reveal reveal-3">
          <header className="tile-head">
            <h2>Toolbox</h2>
            <button className="tile-link" onClick={() => go("toolbox")}>
              Browse <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {installedTools.length ? (
            <div className="rows">
              {installedTools.slice(0, 4).map((tool) => (
                <div className="row" key={tool.id}>
                  <span className="kind-icon small">
                    <PixelIcon name="terminal" size={14} />
                  </span>
                  <span className="row-copy">
                    <strong>{tool.name}</strong>
                    <em>Instead of {tool.replaces}</em>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="tile-empty">
              <strong>No tools installed</strong>
              Mole, ffmpeg and Pandoc are one click away.
            </div>
          )}
        </section>
        <section className="tile span-6 reveal reveal-4">
          <header className="tile-head">
            <h2>Routines</h2>
            <button className="tile-link" onClick={() => go("skills")}>
              Manage <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {routines.length ? (
            <div className="rows">
              {routines.slice(0, 3).map((routine) => (
                <div className="row" key={routine.id}>
                  <span className="kind-icon small">
                    <PixelIcon name="clock" size={14} />
                  </span>
                  <span className="row-copy">
                    <strong className="sentence">{routine.name}</strong>
                    <em>
                      {scheduleLabel(routine)}
                      {routine.nextRunAt ? ` · ${futureTime(routine.nextRunAt)}` : ""}
                    </em>
                  </span>
                  <button
                    className="icon-btn"
                    aria-label={`Run ${routine.name} now`}
                    title="Run now"
                    onClick={() => {
                      invoke("runRoutine", { id: routine.id });
                      notify("Routine started", routine.name);
                    }}
                  >
                    <PixelIcon name="play" size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="tile-empty">
              <strong>No routines yet</strong>
              Try “every Friday at 5, clean my Downloads.”
            </div>
          )}
        </section>

        <section className="tile span-6 reveal reveal-4">
          <header className="tile-head">
            <h2>Memory</h2>
            <button className="tile-link" onClick={() => go("memory")}>
              Edit <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {memories.length ? (
            <div className="rows">
              {memories.slice(0, 3).map((memory) => (
                <div className="row" key={memory.id}>
                  <span className="row-dot" />
                  <span className="row-copy">
                    <strong className="wrap sentence">{memory.text}</strong>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="tile-empty">
              <strong>Nothing remembered yet</strong>
              Tell okidoki about yourself once. Edit it anytime.
            </div>
          )}
        </section>

      </div>

      <footer className="home-footer">
        <PixelIcon name="lock" size={13} />
        Private by design. Keys stay in your Keychain, screenshots are never stored.
      </footer>
      <PixelMark className="home-mark" />
    </div>
  );
}

function LiveItem({ run, onOpen, onPause, onStop }: { run: Run; onOpen: () => void; onPause: () => void; onStop: () => void }) {
  const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "previewing");
  const done = run.steps.filter((step) => step.status === "done").length;
  const fraction = run.steps.length ? done / run.steps.length : 0;
  return (
    <div className="live-item">
      <div className="live-top">
        <span className="kind-label">
          <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={13} /> {run.kind === "quickAction" ? "Quick action" : run.kind === "computer_use" ? "Computer use" : run.kind}
        </span>
        <span className="spacer" />
        <StatusBadge status={run.status} />
      </div>
      <button className="live-title" onClick={onOpen}>
        {run.title}
      </button>
      <p className="live-step">{active?.title ?? (run.status === "paused" ? "Paused" : "Working…")}</p>
      <Progress value={fraction} />
      <div className="live-foot">
        <span>
          {run.steps.length ? `${done} of ${run.steps.length} steps` : "Starting"}
          {run.startedAt ? ` · ${relativeTime(run.startedAt)}` : ""}
        </span>
        <span className="spacer" />
        <button className="icon-btn" aria-label={run.status === "paused" ? "Resume" : "Pause"} title={run.status === "paused" ? "Resume" : "Pause"} onClick={onPause}>
          <PixelIcon name={run.status === "paused" ? "play" : "pause"} size={14} />
        </button>
        <button className="icon-btn" aria-label="Stop" title="Stop" onClick={onStop}>
          <PixelIcon name="stop" size={14} />
        </button>
      </div>
    </div>
  );
}
