import { useLayoutEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useDashboard } from "../store";
import { IconButton, PixelIcon } from "../components/ui";
import type { BrowserTab, Run } from "../types";
import { Composer } from "./Composer";
import { MessageBubble, RunCard } from "./ChatView";
import { Favicon, useNow } from "./media";

/**
 * okidoki beside the page: the tab's own conversation, its tasks live, and a composer that works in
 * this tab. The page shrinks to make room rather than being covered.
 */
export function AssistantPanel({ tab, onClose, onOpenTab }: { tab: BrowserTab; onClose: () => void; onOpenTab: (id: string) => void }) {
  const { state } = useDashboard();
  const thread = state.threads.find((item) => item.id === tab.threadID) ?? null;
  const runs = useMemo<Run[]>(() => (thread ? state.runs.filter((run) => run.threadID === thread.id) : []), [state.runs, thread]);
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

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, runs.map((run) => run.output.length).join()]);

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
        <div className="assistant-scroll" ref={scroller}>
          {items.length === 0 ? (
            <div className="assistant-empty">
              <PixelIcon name="spark" size={20} />
              <p>Ask about this page, or tell okidoki what to do here. It works right in this tab, and you can take over any time with esc.</p>
              <ul>
                <li>Summarize this page</li>
                <li>Fill this form with my details</li>
                <li>Find the cancel or unsubscribe option</li>
              </ul>
            </div>
          ) : (
            items.map((item) =>
              item.node === "m" ? (
                <MessageBubble key={item.key} message={thread!.messages[item.index]} />
              ) : (
                <RunCard key={item.key} run={browserRuns[item.index]} now={now} thumbVersion={undefined} tabID={undefined} onOpenTab={onOpenTab} />
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
