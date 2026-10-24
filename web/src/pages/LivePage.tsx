import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { LiveStep } from "../types";
import { Button, Empty, PixelIcon } from "../components/ui";

const kindIcon: Record<LiveStep["kind"], string> = {
  script: "terminal",
  pointer: "cursor",
  keys: "pencil",
  app: "screen",
  look: "eye",
  "": "spark",
};

const kindName: Record<LiveStep["kind"], string> = {
  script: "Script",
  pointer: "Pointer",
  keys: "Keys",
  app: "App",
  look: "Looking",
  "": "Thinking",
};

/** The screenshot the model saw, with where it aimed. */
function Frame({ step, large }: { step: LiveStep; large?: boolean }) {
  if (!step.frame) {
    return (
      <div className={cx("live-frame", "live-frame-blank", large && "live-frame-large")}>
        <PixelIcon name={kindIcon[step.kind]} size={large ? 28 : 16} />
        {large ? <span>{step.kind === "script" ? "No screenshot — this step ran a script." : "No screenshot for this step."}</span> : null}
      </div>
    );
  }
  const aimed = typeof step.aimX === "number" && typeof step.aimY === "number";
  return (
    <div className={cx("live-frame", large && "live-frame-large")}>
      <img src={step.frame} alt="" draggable={false} />
      {aimed ? (
        <span className="live-aim" style={{ left: `${(step.aimX as number) * 100}%`, top: `${(step.aimY as number) * 100}%` }} />
      ) : null}
    </div>
  );
}

export function LivePage() {
  const { state, invoke } = useDashboard();
  const live = state.live ?? null;
  const steps = useMemo(() => live?.steps ?? [], [live?.steps]);
  const [selected, setSelected] = useState<number | null>(null);
  const follow = selected === null;
  const listRef = useRef<HTMLDivElement>(null);

  // Follow the newest step until the user picks one; a new run resets the pick.
  useEffect(() => {
    setSelected(null);
  }, [live?.runID]);
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [follow, steps.length]);

  const current = useMemo(() => {
    if (!steps.length) return null;
    if (selected !== null) return steps.find((step) => step.index === selected) ?? steps[steps.length - 1];
    return steps[steps.length - 1];
  }, [steps, selected]);

  const run = live?.runID ? state.runs.find((item) => item.id === live.runID) : undefined;

  if (!live || !steps.length) {
    return (
      <div className="live live-empty">
        <Empty icon="eye" title={live?.active ? "Looking at the screen…" : "Nothing is being driven right now"}>
          {live?.active
            ? "The first step shows up here as soon as the model decides what to do."
            : "Ask okidoki to do something in an app — “send mom a message on WhatsApp”, “export this as PDF” — and every step it takes shows up here with what it saw."}
        </Empty>
      </div>
    );
  }

  return (
    <div className="live">
      <header className="live-head">
        <div className="live-head-text">
          <div className="live-status">
            <span className={cx("live-dot", live.active && "live-dot-on")} />
            <span>{live.active ? `Driving ${live.target} · step ${live.stepIndex + 1}` : run ? `Finished · ${run.status}` : "Finished"}</span>
          </div>
          <h2 className="live-goal">{live.goal}</h2>
          {run?.summary ? <p className="live-summary">{run.summary}</p> : null}
        </div>
        <div className="live-head-actions">
          {live.active && live.runID ? (
            <Button variant="danger" icon="hand" onClick={() => invoke("stopRun", { id: live.runID })}>
              Stop
            </Button>
          ) : null}
          {!follow ? (
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Follow live
            </Button>
          ) : null}
        </div>
      </header>

      <div className="live-body">
        <section className="live-stage">
          {current ? (
            <>
              <Frame step={current} large />
              <div className="live-stage-caption">
                <PixelIcon name={kindIcon[current.kind]} size={14} />
                <strong>{current.say}</strong>
                {current.detail ? <span className={cx("live-detail", current.kind === "script" && "mono")}>{current.detail}</span> : null}
              </div>
              {current.zoomFrame ? (
                <div className="live-zoom">
                  <div className="live-zoom-label">Zoomed in</div>
                  <img src={current.zoomFrame} alt="" draggable={false} />
                </div>
              ) : null}
              {current.script ? (
                <pre className="live-script">{current.script}</pre>
              ) : null}
              {current.result ? <p className="live-result">{current.result}</p> : null}
            </>
          ) : null}
        </section>

        <aside className="live-steps" ref={listRef}>
          {steps.map((step) => {
            const active = current?.index === step.index;
            return (
              <button
                key={step.index}
                type="button"
                className={cx("live-step", active && "live-step-active", step.status === "acting" && "live-step-acting")}
                onClick={() => setSelected(step.index === steps[steps.length - 1]?.index && live.active ? null : step.index)}
              >
                <Frame step={step} />
                <div className="live-step-text">
                  <div className="live-step-top">
                    <span className="live-step-index">{step.index + 1}</span>
                    <span className="live-step-kind">
                      <PixelIcon name={kindIcon[step.kind]} size={11} /> {kindName[step.kind]}
                    </span>
                    <span className="live-step-time">{relativeTime(step.at)}</span>
                  </div>
                  <div className="live-step-say">{step.say}</div>
                  {step.detail ? <div className={cx("live-step-detail", step.kind === "script" && "mono")}>{step.detail}</div> : null}
                  {step.result ? <div className="live-step-result">{step.result}</div> : step.status === "acting" ? <div className="live-step-result muted">working…</div> : null}
                </div>
              </button>
            );
          })}
        </aside>
      </div>
    </div>
  );
}
