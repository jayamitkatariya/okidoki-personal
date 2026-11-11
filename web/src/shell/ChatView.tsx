import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import { Button, Markdown, PixelIcon, RiskBadge } from "../components/ui";
import { AskedReply } from "../pages/RunsPage";
import type { Message, Run, Thread } from "../types";
import { Composer } from "./Composer";
import { ACTIVE, actionLines, runUnread, threadUnread, workingFor } from "./model";
import { thumbURL, useNow } from "./media";

const KIND_ICON: Record<Run["kind"], string> = {
  answer: "spark",
  quick_action: "bolt",
  computer_use: "screen",
  browser: "globe",
  watch: "eye",
  borrow: "hand",
  routine: "clock",
  connector: "link",
};

const KIND_NAME: Record<Run["kind"], string> = {
  answer: "Answer",
  quick_action: "Quick action",
  computer_use: "On your Mac",
  browser: "In the browser",
  watch: "Watching",
  borrow: "Replay",
  routine: "Routine",
  connector: "Connected service",
};

type Item = { at: number; message?: Message; run?: Run };

/** A conversation: what was said, and every task okidoki ran for it, live. */
export function ChatView({
  thread,
  runs,
  onOpenTab,
  onAsked,
}: {
  thread: Thread;
  runs: Run[];
  onOpenTab: (tabID: string) => void;
  onAsked: (threadID: string) => void;
}) {
  const { state, invoke } = useDashboard();
  const scroller = useRef<HTMLDivElement>(null);
  const live = runs.some((run) => run.status === "running");
  const now = useNow(live);
  const tabs = state.browser?.tabs ?? [];
  const threadTab = tabs.find((tab) => tab.threadID === thread.id);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = thread.messages.map((message) => ({ at: Date.parse(message.createdAt), message }));
    // Answers are already their message; every other task gets a card where it started.
    for (const run of runs) if (run.kind !== "answer") list.push({ at: Date.parse(run.createdAt) + 1, run });
    return list.sort((a, b) => a.at - b.at);
  }, [thread.messages, runs]);

  // Opening a conversation reads it.
  const unreadRuns = runs.filter(runUnread).map((run) => run.id).join(",");
  const unread = threadUnread(thread);
  useEffect(() => {
    if (unread) invoke("markSeen", { threadID: thread.id });
    for (const id of unreadRuns ? unreadRuns.split(",") : []) invoke("markSeen", { runID: id });
  }, [thread.id, unread, unreadRuns, invoke]);

  // Start at the newest, and follow new messages while already at the bottom.
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, thread.id, runs.map((run) => run.output.length).join()]);
  useEffect(() => {
    stick.current = true;
  }, [thread.id]);

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="chat-column">
          <header className="chat-head">
            <h1>{thread.title || "New chat"}</h1>
            <p>
              <span>Started {relativeTime(thread.createdAt)}</span>
              {thread.app && thread.app !== "mac" && thread.app !== "okidoki" ? <span> · {thread.app}</span> : null}
            </p>
            {threadTab ? (
              <Button size="sm" variant="secondary" icon="globe" onClick={() => onOpenTab(threadTab.id)}>
                Open its tab
              </Button>
            ) : null}
          </header>
          {items.map((item) =>
            item.message ? (
              <MessageBubble key={item.message.id} message={item.message} />
            ) : item.run ? (
              <RunCard key={item.run.id} run={item.run} now={now} thumbVersion={state.thumbs?.[item.run.id]} tabID={tabs.find((tab) => tab.ownerRunID === item.run!.id)?.id} onOpenTab={onOpenTab} />
            ) : null,
          )}
          {items.length === 0 ? <p className="chat-empty">Ask anything below. okidoki answers here, and anything it does shows up as it happens.</p> : null}
        </div>
      </div>
      <div className="chat-dock">
        <Composer variant="dock" threadID={thread.id} autoFocus onAsked={onAsked} />
      </div>
    </div>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === "system") return <p className="msg-system">{message.text}</p>;
  const mine = message.role === "user";
  // What a mention attached rides along in brackets: show the request, keep the context quiet.
  const [body, context] = mine ? message.text.split(/\n\n\(context: /) : [message.text];
  return (
    <div className={cx("msg", mine ? "msg-user" : "msg-okidoki")}>
      {mine ? (
        <div className="msg-bubble">
          <p>{body}</p>
          {context ? <em className="msg-context">with {context.replace(/\)$/, "")}</em> : null}
        </div>
      ) : (
        <div className="msg-answer">
          <span className="msg-mark" aria-hidden="true" />
          <Markdown text={message.text} />
        </div>
      )}
    </div>
  );
}

export function RunCard({ run, now, thumbVersion, tabID, onOpenTab }: { run: Run; now: number; thumbVersion?: number; tabID?: string; onOpenTab: (id: string) => void }) {
  const { invoke, notify } = useDashboard();
  const active = ACTIVE.has(run.status);
  const waiting = run.status === "waiting" || run.status === "previewing";
  const thumb = thumbURL(run.id, thumbVersion, run.title);
  const lines = actionLines(run, active ? 4 : 3);
  const took = run.startedAt ? workingFor(run.startedAt, now, active ? null : run.endedAt) : "";
  const state =
    run.status === "running"
      ? `Working for ${took}`
      : run.status === "paused"
        ? run.waitingFor
          ? `Paused while you handle ${run.waitingFor}`
          : "Paused"
        : waiting
          ? "Waiting for your OK"
          : run.status === "asked"
            ? "Needs your answer"
            : run.status === "done"
              ? `Done${took ? ` in ${took}` : ""}`
              : run.status === "failed"
                ? "Didn't finish"
                : "Stopped";

  return (
    <article className={cx("run-card", `run-${run.status}`)}>
      <header className="run-card-head">
        <span className="run-kind">
          <PixelIcon name={KIND_ICON[run.kind]} size={14} />
          {KIND_NAME[run.kind]}
        </span>
        <span className={cx("run-state", run.status === "running" && "is-live")}>
          {run.status === "running" ? <span className="pulse-dot" aria-hidden="true" /> : null}
          <span className="tnum">{state}</span>
        </span>
      </header>
      <h3>{run.title}</h3>

      {waiting && run.preview ? (
        <div className="run-preview">
          <p>
            {run.preview.summary} <RiskBadge risk={run.preview.risk} />
          </p>
          <ol>
            {run.preview.steps.map((step) => (
              <li key={step.id}>{step.text}</li>
            ))}
          </ol>
          {run.preview.commands.length ? <code className="run-commands">{run.preview.commands.join("\n")}</code> : null}
        </div>
      ) : lines.length ? (
        <ul className="task-lines">
          {lines.map((line, index) => (
            <li key={`${index}-${line.text}`}>
              <PixelIcon name={line.icon} size={14} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {thumb ? (
        <button type="button" className="run-thumb" disabled={!tabID} onClick={() => tabID && onOpenTab(tabID)} aria-label={tabID ? "Watch it in its tab" : "Screenshot"}>
          <img src={thumb} alt="" draggable={false} />
          {tabID && active ? <span className="run-thumb-cta">Watch in its tab</span> : null}
        </button>
      ) : null}

      {run.status === "asked" ? <AskedReply run={run} /> : null}
      {!active && run.summary && run.status !== "asked" ? <p className="run-summary">{run.summary}</p> : null}

      <footer className="run-actions">
        {waiting ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => invoke("denyRun", { id: run.id })}>
              Not now
            </Button>
            <Button size="sm" variant="secondary" onClick={() => invoke("allowAlways", { id: run.id })}>
              Always allow
            </Button>
            <Button size="sm" variant="primary" onClick={() => invoke("approveRun", { id: run.id })}>
              Do it
            </Button>
          </>
        ) : null}
        {run.status === "running" || run.status === "paused" ? (
          <>
            {tabID ? (
              <Button size="sm" variant="ghost" icon="globe" onClick={() => onOpenTab(tabID)}>
                Open tab
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" icon={run.status === "paused" ? "play" : "pause"} onClick={() => invoke("pauseRun", { id: run.id })}>
              {run.status === "paused" ? "Hand back" : "Pause"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="stop"
              onClick={() => {
                invoke("stopRun", { id: run.id });
                notify("Stopped", run.title);
              }}
            >
              Stop
            </Button>
          </>
        ) : null}
      </footer>
    </article>
  );
}
