import { useEffect, useMemo, useState } from "react";
import { ChatMenu } from "../shell/ChatMenu";
import { useDashboard } from "../store";
import { cx, clockLabel, dayLabel, formatBytes, relativeTime } from "../lib";
import type { Run, Thread } from "../types";
import { Button, Empty, Logo, Markdown, Modal, PageTitle, PixelIcon, Segmented, StatusBadge, TextField, isComposing } from "../components/ui";
import type { Page } from "../nav";

type Tab = "requests" | "threads";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "requests", label: "Requests" },
  { value: "threads", label: "Threads" },
];

/** `onOpenThread`: opens a conversation as its own chat in the shell instead of the overlay here. */
export function HistoryPage({ go, onOpenThread }: { go: (page: Page) => void; onOpenThread?: (id: string) => void }) {
  const { state } = useDashboard();
  const [tab, setTab] = useState<Tab>("requests");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openThreadHere, setOpenThreadHere] = useState<string | null>(null);
  const openThread = openThreadHere;
  const setOpenThread = (id: string | null) => {
    if (id && onOpenThread) onOpenThread(id);
    else setOpenThreadHere(id);
  };
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    // a one-shot hand-off from Runs: take it, then clear it so the next visit doesn't reopen it
    const pending = window as unknown as { __okidokiOpenThread?: string };
    if (pending.__okidokiOpenThread) setOpenThread(pending.__okidokiOpenThread);
    delete pending.__okidokiOpenThread;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setOpenThread(detail);
      delete pending.__okidokiOpenThread;
    };
    window.addEventListener("okidoki-open-thread", handler);
    return () => window.removeEventListener("okidoki-open-thread", handler);
  }, []);

  const runs = useMemo(
    () =>
      [...state.runs]
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
        .filter((run) => !query || run.title.toLowerCase().includes(query.toLowerCase()) || run.prompt.toLowerCase().includes(query.toLowerCase())),
    [state.runs, query],
  );

  const threads = useMemo(
    () =>
      [...state.threads]
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .filter((thread) => (showArchived || !thread.archived) && (!query || thread.title.toLowerCase().includes(query.toLowerCase()) || thread.messages.some((message) => message.text.toLowerCase().includes(query.toLowerCase())))),
    [state.threads, query, showArchived],
  );

  // Group requests by day for scanning ("Today", "Yesterday", "Oct 20").
  const groups = useMemo(() => {
    const out: Array<{ label: string; runs: Run[] }> = [];
    for (const run of runs) {
      const label = dayHeading(run.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.runs.push(run);
      else out.push({ label, runs: [run] });
    }
    return out;
  }, [runs]);

  const archivedCount = state.threads.filter((item) => item.archived).length;
  const thread = state.threads.find((item) => item.id === openThread) ?? null;

  return (
    <div className="history">
      <PageTitle
        title="History"
        subtitle="Every request with its plan and result. Threads pick up where you left off."
        trailing={<Segmented options={TABS} value={tab} onChange={setTab} />}
      />

      <div className="history-tools">
        <TextField
          value={query}
          onChange={setQuery}
          placeholder={tab === "requests" ? "Search requests" : "Search threads"}
          icon="search"
          className="history-search"
        />
        {tab === "threads" && archivedCount ? (
          <button className={cx("history-toggle", showArchived && "is-on")} onClick={() => setShowArchived((value) => !value)} aria-pressed={showArchived}>
            <PixelIcon name="folder" size={14} />
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        ) : null}
        <span className="spacer" />
        <span className="history-count">
          {tab === "requests"
            ? `${runs.length} ${runs.length === 1 ? "request" : "requests"}`
            : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`}
        </span>
      </div>

      {tab === "requests" ? (
        runs.length ? (
          <div className="history-days">
            {groups.map((group) => (
              <section className="history-day" key={`${group.label}-${group.runs[0].id}`}>
                <h2 className="history-day-label">{group.label}</h2>
                <div className="tile request-list">
                  {group.runs.map((run) => (
                    <RequestRow
                      key={run.id}
                      run={run}
                      expanded={expanded === run.id}
                      onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                      onOpenRun={() => {
                        (window as unknown as { __okidokiFocusRun?: string }).__okidokiFocusRun = run.id;
                        window.dispatchEvent(new CustomEvent("okidoki-focus-run", { detail: run.id }));
                        go("runs");
                      }}
                      onOpenThread={(id) => setOpenThread(id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : query ? (
          <Empty icon="search" title="No matches">
            Nothing you’ve asked mentions “{query}”.
          </Empty>
        ) : (
          <Empty
            icon="clock"
            title="Nothing here yet"
            action={
              <Button size="sm" variant="secondary" icon="spark" onClick={() => go("home")}>
                Ask something
              </Button>
            }
          >
            Every request lands here with its plan and what happened.
          </Empty>
        )
      ) : threads.length ? (
        <div className="thread-grid">
          {threads.map((item) => (
            <ThreadCard key={item.id} thread={item} onOpen={() => setOpenThread(item.id)} />
          ))}
        </div>
      ) : query ? (
        <Empty icon="search" title="No matches">
          No thread mentions “{query}”.
        </Empty>
      ) : (
        <Empty
          icon="memory"
          title="No threads yet"
          action={
            <Button size="sm" variant="secondary" icon="compose" onClick={() => go("home")}>
              Start a chat
            </Button>
          }
        >
          Every conversation becomes a thread. Come back later and okidoki picks it up instead of starting over.
        </Empty>
      )}

      <Modal
        open={Boolean(thread)}
        onClose={() => setOpenThread(null)}
        title={thread?.title ?? ""}
        subtitle={thread ? `${thread.app || "Mac"} · ${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}` : undefined}
        width={680}
      >
        {thread ? <ThreadBody thread={thread} onClose={() => setOpenThread(null)} /> : null}
      </Modal>
    </div>
  );
}

function RequestRow({
  run,
  expanded,
  onToggle,
  onOpenRun,
  onOpenThread,
}: {
  run: Run;
  expanded: boolean;
  onToggle: () => void;
  onOpenRun: () => void;
  onOpenThread: (id: string) => void;
}) {
  return (
    <div className={cx("request", expanded && "is-open")}>
      <button className="request-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="kind-icon small">
          <PixelIcon name={kindGlyph(run.kind)} size={14} />
        </span>
        <span className="request-copy">
          <strong>{run.title}</strong>
          <em>{run.summary || run.prompt}</em>
        </span>
        <span className="request-time">{clockLabel(run.createdAt)}</span>
        <StatusBadge status={run.status} />
        <PixelIcon name="chevron" size={14} className={cx("request-chevron", expanded && "is-open")} />
      </button>
      {expanded ? (
        <div className="request-body">
          {run.summary && run.prompt ? <p className="request-prompt">{run.prompt}</p> : null}
          <div className="request-cols">
            <div className="request-col">
              <h3>Plan</h3>
              {run.preview?.steps?.length ? (
                <ol className="request-steps">
                  {run.preview.steps.map((step, index) => (
                    <li key={step.id}>
                      <span className="request-num">{index + 1}</span>
                      <span>{step.text}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="request-note">A direct answer, no actions.</p>
              )}
            </div>
            <div className="request-col">
              <h3>What happened</h3>
              {run.steps.length ? (
                <ul className="request-actual">
                  {run.steps.map((step) => (
                    <li key={step.id}>
                      <i className={cx("request-dot", `request-dot-${step.status}`)} />
                      <span>{step.title}</span>
                      <em className={`request-state-${step.status}`}>{step.status}</em>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="request-note">{run.summary || run.status}</p>
              )}
            </div>
          </div>
          <div className="request-actions">
            <Button variant="secondary" size="sm" onClick={onOpenRun}>
              Open run
            </Button>
            {run.threadID ? (
              <Button variant="ghost" size="sm" icon="link" onClick={() => onOpenThread(run.threadID!)}>
                Open thread
              </Button>
            ) : null}
            <span className="spacer" />
            {run.freedBytes ? <span className="freed-inline">{formatBytes(run.freedBytes)} freed</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThreadCard({ thread, onOpen }: { thread: Thread; onOpen: () => void }) {
  const last = thread.messages[thread.messages.length - 1];
  const count = thread.messages.length;
  return (
    <div className="thread-card-wrap">
    <button className={cx("tile thread-card", thread.archived && "is-archived")} onClick={onOpen}>
      <span className="thread-top">
        <span className="thread-app">
          <PixelIcon name="memory" size={13} />
          <span>{thread.app || "Mac"}</span>
        </span>
        {thread.archived ? <span className="chip">Archived</span> : null}
        <span className="spacer" />
        <time>{relativeTime(thread.updatedAt)}</time>
      </span>
      <strong className="thread-title">{thread.title}</strong>
      <span className="thread-last">{last?.text ?? "No messages yet"}</span>
      <span className="thread-foot">
        <span>
          {count} {count === 1 ? "message" : "messages"}
        </span>
        <span className="spacer" />
        <span className="thread-continue">
          Continue <PixelIcon name="arrow" size={13} />
        </span>
      </span>
    </button>
    {/* Beside the card, not inside it: a button can't hold another button. */}
    <ChatMenu thread={thread} className="thread-card-menu" />
    </div>
  );
}

function ThreadBody({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const { invoke, notify } = useDashboard();
  const [text, setText] = useState("");

  const send = () => {
    if (!text.trim()) return;
    invoke("continueThread", { id: thread.id, text: text.trim() });
    notify("Continuing thread", thread.title);
    onClose();
  };

  return (
    <div className="thread-body">
      <div className="thread-messages">
        {thread.messages.length ? (
          thread.messages.map((message) => (
            <div className={cx("thread-message", message.role === "user" && "is-user")} key={message.id}>
              {message.role !== "user" ? (
                <span className="thread-avatar">
                  <Logo size={22} />
                </span>
              ) : null}
              <div className="bubble">
                {message.role === "assistant" ? <Markdown text={message.text} /> : <p>{message.text}</p>}
                <time>{clockLabel(message.createdAt)}</time>
              </div>
            </div>
          ))
        ) : (
          <p className="thread-none">No messages yet. Say something to start.</p>
        )}
      </div>
      <div className="thread-composer">
        <input
          value={text}
          autoFocus
          placeholder="Continue this thread…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposing(event) && text.trim()) send();
          }}
        />
        <button className="thread-send" onClick={send} disabled={!text.trim()} aria-label="Send" title="Send">
          <PixelIcon name="arrow" size={15} />
        </button>
      </div>
    </div>
  );
}

function dayHeading(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - that) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  return dayLabel(value);
}

function kindGlyph(kind: Run["kind"]): string {
  return (
    {
      answer: "spark",
      quick_action: "bolt",
      background: "runs",
      watch: "eye",
      borrow: "hand",
      computer_use: "hand",
      browser: "globe",
      routine: "clock",
      connector: "link",
      coding_agent: "code",
    } as const
  )[kind] ?? "spark";
}
