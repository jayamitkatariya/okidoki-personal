import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useDashboard } from "../store";
import { IconButton, PixelIcon } from "../components/ui";
import type { BrowserTab, Run } from "../types";
import { Composer } from "./Composer";
import { MessageBubble, RunCard } from "./ChatView";
import { Favicon, useNow } from "./media";
import { runUnread, threadUnread } from "./model";

/**
 * okidoki beside the page: the tab's own conversation, its tasks live, and a composer that works in
 * this tab. The page shrinks to make room rather than being covered.
 */
export function AssistantPanel({ tab, onClose, onOpenTab }: { tab: BrowserTab; onClose: () => void; onOpenTab: (id: string) => void }) {
  const { state, invoke } = useDashboard();
  const thread = state.threads.find((item) => item.id === tab.threadID) ?? null;
  const runs = useMemo<Run[]>(() => (thread ? state.runs.filter((run) => run.threadID === thread.id) : []), [state.runs, thread]);

  // Watching the conversation here reads it, the same as opening it as a chat.
  const unreadRuns = runs.filter(runUnread).map((run) => run.id).join(",");
  const unread = thread ? threadUnread(thread) : false;
  useEffect(() => {
    if (thread && unread) invoke("markSeen", { threadID: thread.id });
    for (const id of unreadRuns ? unreadRuns.split(",") : []) invoke("markSeen", { runID: id });
  }, [thread, unread, unreadRuns, invoke]);
  const now = useNow(runs.some((run) => run.status === "running"));
  const scroller = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    if (!thread) return [];
    const list: Array<{ at: number; key: string; node: "m" | "r"; index: number }> = [
      ...thread.messages.map((message, index) => ({ at: Date.parse(message.createdAt), key: message.id, node: "m" as const, index })),
      ...runs.filter((run) => run.kind !== "answer").map((run, index) => ({ at: Date.parse(run.createdAt) + 1, key: run.id, node: "r" as const, index })),
    ];
    return list.sort((a, b) => a.at - b.at);
  }, [thread, runs]);
  const browserRuns = runs.filter((run) => run.kind !== "answer");

  // Follow new output only while you're already at the bottom, so reading back isn't interrupted.
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, runs.map((run) => run.output.length).join()]);

  const suggest = (text: string) => invoke("shellAsk", { text, mode: "tab", tabID: tab.id, threadID: thread?.id });

  return (
    <motion.aside
      className="assistant"
      aria-label="okidoki for this page"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 360, opacity: 1, transition: { duration: 0.24, ease: [0.32, 0.72, 0, 1] } }}
      exit={{ width: 0, opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 0.6, 1] } }}
    >
      <div className="assistant-inner">
        <header className="assistant-head">
          <Favicon host={tab.host} size={16} />
          <span className="assistant-title">{tab.title || tab.host || "This page"}</span>
          <IconButton icon="x" label="Close (⌘J)" onClick={onClose} />
        </header>
        <div
          className="assistant-scroll"
          ref={scroller}
          role="log"
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {items.length === 0 ? (
            <div className="assistant-empty">
              <PixelIcon name="spark" size={20} />
              <p>Ask about this page, or tell okidoki what to do here. It works right in this tab, and you can take over any time with esc.</p>
              <div className="assistant-suggestions">
                {["Summarize this page", "Fill this form with my details", "Find the cancel or unsubscribe option"].map((text) => (
                  <button key={text} type="button" className="starter" onClick={() => suggest(text)}>
                    <PixelIcon name="spark" size={14} />
                    <span>{text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((item) =>
              item.node === "m" ? (
                <MessageBubble key={item.key} message={thread!.messages[item.index]} />
              ) : (
                <RunCard key={item.key} run={browserRuns[item.index]} now={now} thumbVersion={state.thumbs?.[browserRuns[item.index].id]} tabID={undefined} onOpenTab={onOpenTab} />
              ),
            )
          )}
        </div>
        <div className="assistant-dock">
          <Composer variant="panel" tabID={tab.id} threadID={thread?.id} autoFocus />
        </div>
      </div>
    </motion.aside>
  );
}
