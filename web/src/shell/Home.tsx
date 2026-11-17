import { useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { Button, PixelIcon } from "../components/ui";
import type { Run } from "../types";
import { Composer } from "./Composer";
import { TaskCard } from "./TaskCard";
import { ACTIVE, FINISHED, NEEDS_YOU } from "./model";
import { useNow } from "./media";
import { askAndOpen } from "./ask";

const STARTERS = [
  { text: "Find the cheapest nonstop to Chicago next Thursday", icon: "globe" },
  { text: "Summarize the PDF in my vault folder", icon: "note" },
  { text: "My Mac is out of space", icon: "screen" },
];

/** Home is the new tab: ask or search, what needs you, what's moving, and what you can replay. */
export function Home({
  onOpenRun,
  onAsked,
  onSearched,
  onShowAll,
  focusTick,
  firstOpen,
}: {
  onOpenRun: (run: Run) => void;
  onAsked: (threadID: string) => void;
  onSearched: () => void;
  onShowAll: () => void;
  focusTick: number;
  /** The cascade plays once per launch, never when coming back to Home. */
  firstOpen: boolean;
}) {
  const { state, invoke, notify } = useDashboard();
  const runs = state.runs ?? [];
  const working = runs.some((run) => run.status === "running");
  const now = useNow(working);
  const needs = runs.filter((run) => NEEDS_YOU.has(run.status));
  const recent = useMemo(() => {
    const live = runs.filter((run) => ACTIVE.has(run.status) && !NEEDS_YOU.has(run.status));
    const done = runs
      .filter((run) => FINISHED.has(run.status) && run.kind !== "watch")
      .sort((a, b) => Date.parse(b.endedAt ?? b.createdAt) - Date.parse(a.endedAt ?? a.createdAt));
    return [...live, ...done].slice(0, 6);
  }, [runs]);
  const skills = useMemo(() => [...(state.skills ?? [])].sort((a, b) => (b.runCount ?? 0) - (a.runCount ?? 0)).slice(0, 4), [state.skills]);
  const templates = (state.library ?? []).filter((entry) => !entry.added).slice(0, Math.max(0, 4 - skills.length));
  const empty = runs.length === 0;
  // Said up front, not after the first request bounces: nothing answers until a key is saved.
  const anthropic = state.keyProviders?.find((provider) => provider.id === "anthropic");
  const needsKey = anthropic ? !anthropic.set && !anthropic.builtin : state.keys?.anthropic === false;
  const fresh = useRef(firstOpen).current;

  const rise = (order: number) =>
    fresh
      ? {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.4, ease: [0.23, 1, 0.32, 1] as const, delay: Math.min(order * 0.06, 0.6) },
        }
      : {};

  return (
    <div className="nt">
      <div className="nt-hero">
        <motion.div className={cx("nt-mark", working && "is-working")} aria-hidden="true" {...rise(0)} />
        <motion.div className="nt-composer" {...rise(1)}>
          <Composer variant="home" autoFocus focusTick={focusTick} onAsked={onAsked} onSearched={onSearched} />
        </motion.div>
        {needsKey ? (
          <p className="nt-needs-key" role="status">
            <PixelIcon name="key" size={14} />
            <span>okidoki needs an Anthropic key before it can answer or do anything.</span>
            <button type="button" className="link-btn" onClick={() => (window.location.hash = "#/keys")}>
              Add a key
            </button>
          </p>
        ) : null}
        {empty ? (
          <motion.div className="nt-starters" {...rise(2)}>
            <p>Ask okidoki to do something. It works in a tab or on your Mac, and anything it learns you can replay forever.</p>
            <div>
              {STARTERS.map((starter) => (
                <button key={starter.text} type="button" className="starter" onClick={() => askAndOpen(invoke, { text: starter.text, mode: "auto" }, onAsked)}>
                  <PixelIcon name={starter.icon} size={15} />
                  <span>{starter.text}</span>
                </button>
              ))}
            </div>
          </motion.div>
        ) : null}
      </div>

      {needs.length ? (
        <motion.section className="nt-section" aria-labelledby="needs-title" {...rise(2)}>
          <header className="nt-head">
            <h2 id="needs-title">Needs you</h2>
          </header>
          <div className="need-list">
            {needs.slice(0, 4).map((run) => (
              <div key={run.id} className="need-row">
                <span className="need-icon">
                  <PixelIcon name={run.status === "asked" ? "chat" : "hand"} size={16} />
                </span>
                <button type="button" className="need-copy" title={run.title} onClick={() => onOpenRun(run)}>
                  <strong>{run.title}</strong>
                  <span>{run.status === "asked" ? run.summary || "okidoki has a question" : run.preview?.summary || run.prompt}</span>
                </button>
                {run.status === "asked" ? (
                  <Button size="sm" variant="secondary" onClick={() => onOpenRun(run)}>
                    Answer
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        invoke("denyRun", { id: run.id });
                        notify("Skipped", run.title);
                      }}
                    >
                      Not now
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => invoke("approveRun", { id: run.id })}>
                      Do it
                    </Button>
                  </>
                )}
              </div>
            ))}
            {needs.length > 4 ? (
              <button type="button" className="need-more" onClick={onShowAll}>
                +{needs.length - 4} more waiting
              </button>
            ) : null}
          </div>
        </motion.section>
      ) : null}

      {recent.length ? (
        <motion.section className="nt-section" aria-labelledby="recent-title" {...rise(3)}>
          <header className="nt-head">
            <h2 id="recent-title">Recent tasks</h2>
            <button type="button" className="link-btn" onClick={onShowAll}>
              Show all
            </button>
          </header>
          <div className="task-grid">
            {recent.map((run) => (
              <TaskCard key={run.id} run={run} now={now} thumbVersion={state.thumbs?.[run.id]} onOpen={() => onOpenRun(run)} />
            ))}
          </div>
        </motion.section>
      ) : null}

      {skills.length || templates.length ? (
        <motion.section className="nt-section" aria-labelledby="replay-title" {...rise(4)}>
          <header className="nt-head">
            <h2 id="replay-title">Replay it again</h2>
          </header>
          <div className="replay-row">
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="replay-chip"
                onClick={() => {
                  invoke("replaySkill", { id: skill.id });
                  notify("Replaying", skill.name);
                }}
              >
                <span className="replay-play">
                  <PixelIcon name="play" size={12} />
                </span>
                <span className="replay-text">
                  <strong>{skill.name}</strong>
                  <em>{skill.runCount ? `${skill.runCount} ${skill.runCount === 1 ? "run" : "runs"}` : "Never run"}</em>
                </span>
              </button>
            ))}
            {templates.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="replay-chip is-template"
                onClick={() => {
                  invoke("installTemplate", { id: entry.id });
                  notify("Added to your skills", entry.name);
                }}
              >
                <span className="replay-play">
                  <PixelIcon name="plus" size={12} />
                </span>
                <span className="replay-text">
                  <strong>{entry.name}</strong>
                  <em>From the library</em>
                </span>
              </button>
            ))}
          </div>
        </motion.section>
      ) : null}
    </div>
  );
}
