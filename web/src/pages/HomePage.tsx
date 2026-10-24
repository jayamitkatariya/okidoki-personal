import { useMemo } from "react";
import { useDashboard } from "../store";
import { cx, futureTime, relativeTime, scheduleLabel, timeOfDay, todayLabel, toolPrice } from "../lib";
import type { Run, RunKind, Settings } from "../types";
import { Button, CountUp, KeyHint, PixelIcon, Progress, RiskBadge, StatusBadge } from "../components/ui";
import type { Page } from "../components/Layout";
import { PixelWordmark } from "../components/PixelWordmark";

function openAsk(prompt = "") {
  (window as unknown as { okidokiOpenAsk?: (prompt?: string) => void }).okidokiOpenAsk?.(prompt);
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
  connector: "link",
};

const KIND_LABEL: Record<RunKind, string> = {
  answer: "answers",
  quickAction: "quick actions",
  computer_use: "screen work",
  terminal: "terminal work",
  coding: "coding",
  background: "background jobs",
  teach: "lessons",
  watch: "watching",
  borrow: "screen access",
  routine: "routines",
  connector: "connected services",
};

type ToggleKey = "okidokiEnabled" | "backgroundMode" | "screenBorrowing" | "voiceEnabled" | "captions" | "quietMode";

const CONTROLS: { key: ToggleKey; icon: string; title: string; on: string; off: string }[] = [
  { key: "okidokiEnabled", icon: "spark", title: "Assistant", on: "Ready to help", off: "Paused" },
  { key: "quietMode", icon: "moon", title: "Quiet mode", on: "Silent", off: "Off" },
  { key: "voiceEnabled", icon: "mic", title: "Voice", on: "Spoken replies", off: "Off" },
  { key: "backgroundMode", icon: "runs", title: "Background", on: "Batch work", off: "Off" },
  { key: "screenBorrowing", icon: "hand", title: "Screen access", on: "Asks first", off: "Off" },
  { key: "captions", icon: "eye", title: "Captions", on: "On", off: "Off" },
];

/** "42m" or "2h 14m" — the time okidoki spent working, not the time you spent waiting. */
function spentLabel(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

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
  const skills = state.skills ?? [];
  const memories = state.memories ?? [];
  const installedTools = (state.tools ?? []).filter((tool) => tool.installed);
  const savings = state.savings || installedTools.reduce((sum, tool) => sum + toolPrice(tool.id), 0);
  const firstWord = account.name.split(" ")[0] || "there";
  const firstName = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);

  const week = useMemo(() => weekSummary(runs), [runs]);

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
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="hero-date">{todayLabel()}</span>
          <h1>
            Good {timeOfDay()}, {firstName}
            <span className="greeting-dot">.</span>
          </h1>
          <p className="hero-lede">
            {waiting.length
              ? `${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} your attention. Let's make room for the rest.`
              : live.length
                ? "A few things are moving. You've got room to focus."
                : "A little less busywork. A little more headspace."}
          </p>
          <button className="hero-ask" onClick={() => openAsk()}>
            <PixelIcon name="spark" size={19} />
            <span>What can I take off your plate?</span>
            <KeyHint>⌘K</KeyHint>
            <span className="ask-arrow">
              <PixelIcon name="arrow" size={16} />
            </span>
          </button>
          <div className="home-suggestions" aria-label="Suggested requests">
            {[
              { icon: "folder", label: "Tidy my Downloads", prompt: "Help me tidy my Downloads folder" },
              { icon: "note", label: "Summarize a document", prompt: "Summarize a document" },
              { icon: "wand", label: "Teach me something", prompt: "Teach me something new" },
            ].map((suggestion) => (
              <button key={suggestion.label} onClick={() => openAsk(suggestion.prompt)}>
                <PixelIcon name={suggestion.icon} size={13} />
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>

        <article className="halo-card">
          <span className="halo-tag">
            <PixelIcon name="spark" size={13} />
            Key insight
          </span>
          <h2 className="halo-headline">{week.headline}</h2>
          <p className="halo-detail">{week.detail}</p>
          <div className="halo-stats">
            <span>
              <strong>{week.done}</strong>
              {week.done === 1 ? "task finished" : "tasks finished"}
            </span>
            <span>
              <strong>{week.spent}</strong>
              reclaimed
            </span>
          </div>
          <button className="halo-cta" onClick={() => go("history")}>
            Explore activity
            <PixelIcon name="arrow" size={15} />
          </button>
        </article>
      </section>

      <section className="home-stats" aria-label="Workspace overview">
        <StatCard
          tone="rose"
          icon="hand"
          label="Needs review"
          value={waiting.length}
          note={waiting.length ? "Your approval comes first" : "You're all caught up"}
          onClick={() => go("runs")}
        />
        <StatCard
          tone="mint"
          icon="runs"
          label="In progress"
          value={live.length}
          note={live.length ? "Working in the background" : "Ready for your next idea"}
          onClick={() => go("runs")}
        />
        <StatCard
          tone="lilac"
          icon="clock"
          label="Finished this week"
          value={week.done}
          note={week.done ? `${week.spent} reclaimed for you` : "Nothing wrapped up yet"}
          onClick={() => go("history")}
        />
        <StatCard
          tone="peach"
          icon="grid"
          label="Annual savings"
          value={Math.round(savings)}
          prefix="$"
          note={installedTools.length ? `With ${installedTools.length} free ${installedTools.length === 1 ? "tool" : "tools"} in your toolbox` : "Discover free tools in your toolbox"}
          onClick={() => go("toolbox")}
        />
      </section>

      <div className="bento">
        <section className="tile span-7 reveal reveal-2">
          <header className="tile-head">
            <span className="tile-icon tone-rose">
              <PixelIcon name="hand" size={15} />
            </span>
            <h2>Needs your attention</h2>
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

        <section className="tile span-5 reveal reveal-2">
          <header className="tile-head">
            <span className="tile-icon tone-mint">
              <PixelIcon name="runs" size={15} />
            </span>
            <h2>In progress</h2>
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
              <span className="tile-empty-icon">
                <PixelIcon name="runs" size={16} />
              </span>
              <strong>Nothing running</strong>
              Background work and agents show progress here.
            </div>
          )}
        </section>

        <section className="tile span-4 reveal reveal-3">
          <header className="tile-head">
            <span className="tile-icon tone-lilac">
              <PixelIcon name="calendar" size={15} />
            </span>
            <h2>This week</h2>
            <button className="tile-link" onClick={() => go("history")}>
              History <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          <WeekChart runs={runs} />
        </section>

        <section className="tile span-8 reveal reveal-3">
          <header className="tile-head">
            <span className="tile-icon tone-sky">
              <PixelIcon name="clock" size={15} />
            </span>
            <h2>Recent activity</h2>
            <button className="tile-link" onClick={() => go("history")}>
              See all <PixelIcon name="chevron" size={14} />
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
              <span className="tile-empty-icon">
                <PixelIcon name="clock" size={16} />
              </span>
              <strong>No history yet</strong>
              Finished requests land here.
            </div>
          )}
        </section>

        <section className="tile span-12 reveal reveal-3">
          <header className="tile-head">
            <span className="tile-icon tone-amber">
              <PixelIcon name="gear" size={15} />
            </span>
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
                  aria-label={control.title}
                  aria-checked={on}
                  onClick={() => toggle(control.key, control.title)}
                >
                  <span className="control-top">
                    <span className="control-icon">
                      <PixelIcon name={control.icon} size={16} />
                    </span>
                    <i className="control-switch" aria-hidden="true" />
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

        <section className="tile span-4 reveal reveal-4">
          <header className="tile-head">
            <span className="tile-icon tone-peach">
              <PixelIcon name="grid" size={15} />
            </span>
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
              <span className="tile-empty-icon">
                <PixelIcon name="grid" size={16} />
              </span>
              <strong>No tools installed</strong>
              Mole, ffmpeg and Pandoc are one click away.
            </div>
          )}
        </section>

        <section className="tile span-4 reveal reveal-4">
          <header className="tile-head">
            <span className="tile-icon tone-rose">
              <PixelIcon name="record" size={15} />
            </span>
            <h2>Skills</h2>
            <button className="tile-link" onClick={() => go("skills")}>
              {skills.length ? "Manage" : "Record one"} <PixelIcon name="chevron" size={14} />
            </button>
          </header>
          {skills.length ? (
            <div className="rows">
              {skills.slice(0, 3).map((skill) => (
                <div className="row" key={skill.id}>
                  <span className="kind-icon small">
                    <PixelIcon name="record" size={14} />
                  </span>
                  <span className="row-copy">
                    <strong className="sentence">{skill.name}</strong>
                    <em>
                      {skill.steps.length} {skill.steps.length === 1 ? "step" : "steps"} · {skill.runCount}{" "}
                      {skill.runCount === 1 ? "replay" : "replays"}
                    </em>
                  </span>
                  <button
                    className="icon-btn"
                    aria-label={`Replay ${skill.name}`}
                    title="Replay"
                    onClick={() => {
                      invoke("replaySkill", { id: skill.id, times: 1 });
                      notify("Ready to replay", "Approve the preview to run it");
                    }}
                  >
                    <PixelIcon name="play" size={14} />
                  </button>
                </div>
              ))}
              {routines.length ? (
                <div className="row">
                  <span className="kind-icon small">
                    <PixelIcon name="clock" size={14} />
                  </span>
                  <span className="row-copy">
                    <strong className="sentence">{routines[0].name}</strong>
                    <em>
                      {scheduleLabel(routines[0])}
                      {routines[0].nextRunAt ? ` · ${futureTime(routines[0].nextRunAt)}` : ""}
                      {routines.length > 1 ? ` · +${routines.length - 1} more` : ""}
                    </em>
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tile-empty">
              <span className="tile-empty-icon">
                <PixelIcon name="record" size={16} />
              </span>
              <strong>Nothing learned yet</strong>
              Record yourself doing a task once; okidoki replays it on demand.
            </div>
          )}
        </section>

        <section className="tile span-4 reveal reveal-4">
          <header className="tile-head">
            <span className="tile-icon tone-lilac">
              <PixelIcon name="memory" size={15} />
            </span>
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
              <span className="tile-empty-icon">
                <PixelIcon name="memory" size={16} />
              </span>
              <strong>Nothing remembered yet</strong>
              Tell okidoki about yourself once. Edit it anytime.
            </div>
          )}
        </section>
      </div>

      <footer className="home-footer">
        <div className="wordmark-band">
          <PixelWordmark />
        </div>
        <p className="home-footer-note">
          <PixelIcon name="lock" size={13} />
          A little peace of mind. Your keys stay in your Mac's Keychain.
        </p>
      </footer>
    </div>
  );
}

function StatCard({
  tone,
  icon,
  label,
  value,
  note,
  prefix = "",
  onClick,
}: {
  tone: "rose" | "mint" | "lilac" | "peach";
  icon: string;
  label: string;
  value: number;
  note: string;
  prefix?: string;
  onClick: () => void;
}) {
  return (
    <button className={cx("stat-card", `tone-${tone}`)} onClick={onClick}>
      <span className="stat-top">
        <span className="stat-icon">
          <PixelIcon name={icon} size={14} />
        </span>
        <span className="stat-label">{label}</span>
        <PixelIcon name="chevron" size={14} className="stat-arrow" />
      </span>
      <strong className="stat-value">
        <CountUp end={value} duration={650} prefix={prefix} />
      </strong>
      <span className="stat-note">{note}</span>
    </button>
  );
}

/** Seven days of activity, oldest first, with today picked out. */
function WeekChart({ runs }: { runs: Run[] }) {
  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      const end = new Date(date);
      end.setDate(date.getDate() + 1);
      const count = runs.filter((run) => {
        const at = new Date(run.createdAt).getTime();
        return at >= date.getTime() && at < end.getTime();
      }).length;
      return {
        count,
        label: date.toLocaleDateString("en-US", { weekday: "narrow" }),
        isToday: index === 6,
      };
    });
  }, [runs]);

  const peak = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);

  return (
    <div className="week-chart">
      <div className="week-bars">
        {days.map((day, index) => (
          <div className={cx("week-col", day.isToday && "is-today")} key={index}>
            <span className="week-count">{day.count || ""}</span>
            <span className="week-track">
              <span className="week-bar" style={{ height: `${Math.max(day.count ? 12 : 4, (day.count / peak) * 100)}%` }} />
            </span>
            <span className="week-label">{day.label}</span>
          </div>
        ))}
      </div>
      <p className="week-summary">
        <strong>{total}</strong> {total === 1 ? "request" : "requests"} in the last seven days
      </p>
    </div>
  );
}

/** The seven-day story behind the insight card: what finished, and how long it took. */
function weekSummary(runs: Run[]) {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRuns = runs.filter((run) => new Date(run.createdAt).getTime() >= since);
  const done = weekRuns.filter((run) => run.status === "done");
  const seconds = weekRuns.reduce((sum, run) => {
    if (!run.startedAt) return sum;
    const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
    return sum + Math.max(0, (end - new Date(run.startedAt).getTime()) / 1000);
  }, 0);

  const kinds = new Map<RunKind, number>();
  for (const run of done) kinds.set(run.kind, (kinds.get(run.kind) ?? 0) + 1);
  const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];

  const spent = spentLabel(seconds);
  const headline = done.length
    ? `okidoki put in ${spent} of work for you this week.`
    : "You're all caught up. Nothing needs you right now.";
  const detail = done.length
    ? `${done.length} ${done.length === 1 ? "task" : "tasks"} finished without you${top ? ` — mostly ${KIND_LABEL[top[0]]}` : ""}.`
    : "Ask okidoki to take the next thing off your plate, or just look around.";

  return { done: done.length, spent, headline, detail };
}

function LiveItem({ run, onOpen, onPause, onStop }: { run: Run; onOpen: () => void; onPause: () => void; onStop: () => void }) {
  const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "previewing");
  const done = run.steps.filter((step) => step.status === "done").length;
  const fraction = run.steps.length ? done / run.steps.length : 0;
  return (
    <div className="live-item">
      <div className="live-top">
        <span className="kind-label">
          <PixelIcon name={kindGlyph[run.kind] ?? "spark"} size={13} />{" "}
          {run.kind === "quickAction" ? "Quick action" : run.kind === "computer_use" ? "Computer use" : run.kind}
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
