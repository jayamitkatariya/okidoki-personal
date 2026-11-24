import { useMemo, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Run, Thread } from "../types";
import { Button, PageTitle, PixelIcon, TextField } from "../components/ui";
import { LivePage } from "./LivePage";
import { NEEDS_YOU, threadInfo, type ThreadInfo } from "../shell/model";

const KIND_ICON: Record<Run["kind"], string> = {
  answer: "spark",
  quick_action: "bolt",
  computer_use: "screen",
  browser: "globe",
  watch: "eye",
  borrow: "hand",
  routine: "clock",
  connector: "link",
  coding_agent: "code",
};

const KIND_NAME: Record<Run["kind"], string> = {
  answer: "Answer",
  quick_action: "Quick action",
  computer_use: "On your Mac",
  browser: "In the browser",
  watch: "Watching",
  borrow: "Replay",
  routine: "Automation",
  connector: "Connected service",
  coding_agent: "Coding agent",
};

interface Item {
  info: ThreadInfo;
  run: Run | null;
  needs: Run | null;
  title: string;
  summary: string;
}

function lastText(thread: Thread): string {
  const message = [...thread.messages].reverse().find((item) => item.text?.trim());
  return message?.text.trim() ?? "";
}

function toItem(info: ThreadInfo): Item {
  const needs = info.runs.find((run) => NEEDS_YOU.has(run.status)) ?? null;
  const run = needs ?? info.runs[0] ?? null;
  const summary = needs
    ? needs.status === "asked"
      ? needs.summary || "okidoki has a question"
      : needs.preview?.summary || needs.prompt
    : run
      ? run.summary || run.prompt
      : lastText(info.thread);
  return {
    info,
    run,
    needs,
    title: info.thread.title || "New chat",
    summary: summary || "No messages yet",
  };
}

/** Work is the inbox: conversations, what they are doing, and what needs you. */
export function WorkPage({ onOpenThread, onNewChat }: { onOpenThread: (threadID: string) => void; onNewChat: () => void }) {
  const { state, invoke, notify } = useDashboard();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showLive, setShowLive] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = threadInfo(state)
      .map(toItem)
      .filter((item) => !q || item.title.toLowerCase().includes(q) || item.summary.toLowerCase().includes(q));
    return {
      needs: items.filter((item) => item.needs),
      working: items.filter((item) => !item.needs && item.info.active),
      settled: items.filter((item) => !item.needs && !item.info.active),
    };
  }, [state, query]);

  const live = Boolean(state.live?.active);
  const hasLive = live || Boolean(state.live?.steps?.length);
  if (showLive && hasLive) {
    return (
      <div className="work-page">
        <PageTitle
          title="Work"
          subtitle="okidoki is driving this Mac right now."
          trailing={
            <Button variant="secondary" icon="panel" onClick={() => setShowLive(false)}>
              Back to inbox
            </Button>
          }
        />
        <div className="work-live">
          <LivePage />
        </div>
      </div>
    );
  }

  const total = groups.needs.length + groups.working.length + groups.settled.length;
  const settledShown = showAll ? groups.settled : groups.settled.slice(0, 10);

  return (
    <div className="work-page">
      <PageTitle
        title="Work"
        subtitle="Everything okidoki is doing, and what needs you. Open a conversation to see the steps."
        trailing={
          hasLive ? (
            <Button variant="secondary" icon="hand" onClick={() => setShowLive(true)}>
              {live ? "Watch live" : "View last run"}
            </Button>
          ) : undefined
        }
      />

      <div className="work-tools">
        <TextField value={query} onChange={setQuery} placeholder="Search work" icon="search" className="work-search" />
      </div>

      {total === 0 ? (
        <section className="work-empty">
          <span className="work-empty-icon">
            <PixelIcon name="hand" size={22} />
          </span>
          <h2>{query ? "No matches" : "Nothing needs you"}</h2>
          <p>
            {query
              ? `Nothing in your work mentions “${query}”.`
              : "Ask okidoki for something. Conversations and the work inside them land here, grouped by what they need."}
          </p>
          {!query ? (
            <Button variant="secondary" icon="compose" onClick={onNewChat}>
              Ask okidoki
            </Button>
          ) : null}
        </section>
      ) : (
        <>
          <Group title="Needs you" items={groups.needs} onOpenThread={onOpenThread} />
          <Group title="Working" items={groups.working} onOpenThread={onOpenThread} />
          <Group title="Recent" items={settledShown} onOpenThread={onOpenThread} />
          {groups.settled.length > settledShown.length ? (
            <button type="button" className="work-more" onClick={() => setShowAll(true)}>
              Show {groups.settled.length - settledShown.length} older
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function Group({ title, items, onOpenThread }: { title: string; items: Item[]; onOpenThread: (threadID: string) => void }) {
  if (!items.length) return null;
  return (
    <section className="work-group" aria-label={title}>
      <header className="work-group-head">
        <span>{title}</span>
        <span className="tnum">{items.length}</span>
      </header>
      <div className="work-list">
        {items.map((item) => (
          <InboxRow key={item.info.thread.id} item={item} onOpen={() => onOpenThread(item.info.thread.id)} />
        ))}
      </div>
    </section>
  );
}

function InboxRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const { invoke, notify } = useDashboard();
  const needs = item.needs;
  const working = Boolean(item.info.active) && !needs;
  const icon = item.run ? (KIND_ICON[item.run.kind] ?? "chat") : "chat";

  const decline = () => {
    if (!needs) return;
    if (needs.status === "asked") invoke("declineQuestion", { id: needs.id });
    else invoke("denyRun", { id: needs.id });
    notify("Declined", item.title);
  };

  const approve = () => {
    if (!needs) return;
    invoke("approveRun", { id: needs.id });
    notify("Doing it", item.title);
  };

  return (
    <div className={cx("work-row", item.info.unread && "is-unread")}>
      <button type="button" className="work-main" onClick={onOpen}>
        <span className={cx("work-icon", needs && "is-needs", working && "is-live")}>
          <PixelIcon name={icon} size={16} />
        </span>
        <span className="work-copy">
          <span className="work-top">
            <strong>{item.title}</strong>
            <time>{relativeTime(item.info.thread.updatedAt)}</time>
          </span>
          <span className="work-sub">{item.summary}</span>
          <span className="work-tags">
            {needs ? <em className="work-tag is-needs">{needs.status === "asked" ? "Needs your answer" : "Needs your OK"}</em> : null}
            {working ? <em className="work-tag is-live">Working</em> : null}
            {item.run ? <em className="work-tag">{KIND_NAME[item.run.kind] ?? "Task"}</em> : null}
            {item.info.unread ? <em className="work-tag is-unread">Unread</em> : null}
          </span>
        </span>
      </button>
      {needs ? (
        <div className="work-actions">
          <Button size="sm" variant="ghost" onClick={decline}>
            Decline
          </Button>
          {needs.status === "asked" ? (
            <Button size="sm" variant="secondary" onClick={onOpen}>
              Answer
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={approve}>
              Do it
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
