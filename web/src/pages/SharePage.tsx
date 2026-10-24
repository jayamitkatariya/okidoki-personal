import { useEffect, useState } from "react";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { Run } from "../types";
import { PixelIcon, Logo, RiskBadge, StatusBadge } from "../components/ui";
import { clockLabel, dayLabel, formatBytes, relativeTime } from "../lib";

interface SharedRun {
  run: Run;
  accountName?: string;
  createdAt?: string;
}

const KIND_LABEL: Record<string, string> = {
  answer: "Answer",
  quickAction: "Quick action",
  terminal: "Terminal",
  coding: "Coding",
  background: "Background",
  teach: "Teach",
  watch: "Watch",
  borrow: "Borrowed screen",
  routine: "Routine",
  computer_use: "Computer use",
  connector: "Connector",
};

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<SharedRun | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // Dev-only preview: #/share/demo renders a sample run so the page can be designed without Convex.
    if (import.meta.env.DEV && token === "demo") {
      let alive = true;
      void import("../demo").then(({ demoState }) => {
        const runs = demoState.runs ?? [];
        const run = runs.find((item) => item.preview && item.steps.length) ?? runs[0];
        if (!alive) return;
        if (run) setData({ run, accountName: "Jay" });
        else setError("This link is private, expired, or hasn't synced yet.");
      });
      return () => {
        alive = false;
      };
    }
    const url = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim();
    if (!url) {
      setError("This link needs sync. Ask the sender to turn it on in okidoki.");
      return;
    }
    const client = new ConvexClient(url);
    const unsubscribe = client.onUpdate(
      anyApi.share.get,
      { token },
      (value: unknown) => {
        const payload = value as { run?: Run; accountName?: string } | null;
        if (payload?.run) {
          // a link opened before the run synced recovers when it arrives
          setError("");
          setData({ run: payload.run, accountName: payload.accountName });
        } else setError("This link is private, expired, or hasn't synced yet.");
      },
      () => setError("Couldn't connect. Check your connection and try again."),
    );
    return () => unsubscribe();
  }, [token]);

  if (error) {
    return (
      <div className="share-page">
        <div className="share-state">
          <div className="share-state-card">
            <Logo size={44} glow />
            <h1>Nothing to see yet</h1>
            <p>{error}</p>
          </div>
          <span className="share-state-foot">okidoki · Shared run</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="share-page">
        <div className="share-state">
          <span className="share-spinner" aria-hidden="true" />
          <p className="share-loading">Opening the run…</p>
        </div>
      </div>
    );
  }

  const run = data.run;
  const done = run.steps.filter((step) => step.status === "done").length;
  const finished = run.status === "done" || run.status === "failed" || run.status === "cancelled";
  return (
    <div className="share-page">
      <header className="share-head">
        <div className="share-head-inner">
          <Logo size={26} glow />
          <strong className="share-brand">okidoki</strong>
          <span className="share-badge">
            <PixelIcon name="eye" size={12} />
            Read-only
          </span>
          <span className="spacer" />
          <span className="share-date">
            {dayLabel(run.createdAt)} · {clockLabel(run.createdAt)}
          </span>
        </div>
      </header>

      <main className="share-main">
        <section className="share-hero">
          <span className="share-kind">
            <PixelIcon name="runs" size={13} />
            {KIND_LABEL[run.kind] ?? run.kind}
          </span>
          <h1>{run.title}</h1>
          {run.prompt ? <p className="share-prompt">{run.prompt}</p> : null}
          <div className="share-meta">
            <StatusBadge status={run.status} />
            <span>Started {relativeTime(run.createdAt)}</span>
            {data.accountName ? <span>Shared by {data.accountName}</span> : null}
          </div>
        </section>

        {finished || run.summary || run.freedBytes ? (
          <section className={`share-tile share-result is-${run.status}`}>
            <span className="share-result-icon">
              <PixelIcon name={run.status === "failed" ? "x" : run.status === "done" ? "check" : "runs"} size={16} />
            </span>
            <div>
              <span className="share-label">Result</span>
              <h2>{run.summary || run.status}</h2>
            </div>
            {run.freedBytes ? (
              <div className="share-stat">
                <strong>{formatBytes(run.freedBytes)}</strong>
                <span>Freed</span>
              </div>
            ) : null}
          </section>
        ) : null}

        {run.preview ? (
          <section className="share-tile">
            <header className="share-tile-head">
              <h2>Plan</h2>
              <RiskBadge risk={run.preview.risk} />
            </header>
            <p className="share-summary">{run.preview.summary}</p>
            <ol className="share-plan">
              {run.preview.steps.map((step, index) => (
                <li key={step.id}>
                  <em>{index + 1}</em>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="share-tile">
          <header className="share-tile-head">
            <h2>Steps</h2>
            {run.steps.length ? (
              <span className="share-count">
                {done} of {run.steps.length} done
              </span>
            ) : null}
          </header>
          {run.steps.length ? (
            <ol className="share-steps">
              {run.steps.map((step) => (
                <li key={step.id} className={`is-${step.status}`}>
                  <i className="share-dot" />
                  <span>{step.title}</span>
                  <em>{step.status}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p className="share-summary">This run has no steps.</p>
          )}
        </section>

        {run.output ? (
          <section className="share-tile">
            <header className="share-tile-head">
              <h2>Output</h2>
            </header>
            <pre className="share-output">{run.output.slice(-12000)}</pre>
          </section>
        ) : null}

        <footer className="share-foot">
          <PixelIcon name="lock" size={13} />
          <span>Read-only view. Screenshots are never stored.</span>
        </footer>
      </main>
    </div>
  );
}
