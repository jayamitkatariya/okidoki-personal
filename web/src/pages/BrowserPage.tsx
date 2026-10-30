import { useMemo } from "react";
import { useDashboard } from "../store";
import { relativeTime } from "../lib";
import { Button, Empty, PageTitle, PixelIcon, StatusBadge } from "../components/ui";

// Same hand-off Home uses: the Computer page picks it up whether or not it has mounted yet.
function openRun(id: string) {
  (window as unknown as { __okidokiFocusRun?: string }).__okidokiFocusRun = id;
  window.dispatchEvent(new CustomEvent("okidoki-focus-run", { detail: id }));
  window.location.hash = "#/runs";
}

/** okidoki's own browser. For now: open it, and see what ran in it. */
export function BrowserPage() {
  const { state, invoke, notify } = useDashboard();
  const runs = useMemo(
    () => state.runs.filter((run) => run.kind === "browser").sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [state.runs],
  );

  return (
    <div className="browser-page">
      <PageTitle
        title="Browser"
        subtitle="okidoki's own browser, separate from yours. Agent runs, recordings and the pages you open there."
        trailing={
          <Button
            variant="primary"
            icon="globe"
            onClick={() => {
              invoke("openBrowser");
              notify("Opening the browser", undefined, "info");
            }}
          >
            Open browser
          </Button>
        }
      />

      {runs.length ? (
        <section className="tile">
          <header className="tile-head">
            <h2>Runs</h2>
            <span className="tile-count">{runs.length}</span>
          </header>
          <div className="rows">
            {runs.map((run) => (
              <button className="row" key={run.id} onClick={() => openRun(run.id)}>
                <span className="kind-icon small">
                  <PixelIcon name="globe" size={14} />
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
        </section>
      ) : (
        <Empty icon="globe" title="Nothing has run in the browser yet">
          Ask okidoki to do something on the web, like “find the cheapest flight to Chicago”, and the run shows up here.
        </Empty>
      )}
    </div>
  );
}
