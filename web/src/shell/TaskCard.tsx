import { useEffect, useState } from "react";
import { cx, relativeTime } from "../lib";
import { PixelIcon } from "../components/ui";
import { Skeleton } from "@/components/ui/skeleton";
import type { Run } from "../types";
import { actionLines, ACTIVE, NEEDS_YOU, runUnread, workingFor } from "./model";
import { thumbURL } from "./media";

/** The status line on a card: what it's doing right now, in a few words. */
function statusLine(run: Run, now: number): { text: string; tone: "live" | "wait" | "done" | "fail" } {
  if (run.status === "running") return { text: `Working for ${workingFor(run.startedAt ?? run.createdAt, now)}`, tone: "live" };
  if (run.status === "paused") return { text: run.waitingFor ? `Paused for ${run.waitingFor}` : "Paused", tone: "wait" };
  if (run.status === "asked") return { text: "Needs your answer", tone: "wait" };
  if (NEEDS_YOU.has(run.status)) return { text: "Waiting for your OK", tone: "wait" };
  if (run.status === "failed") return { text: `Didn’t finish · ${relativeTime(run.endedAt ?? run.createdAt)}`, tone: "fail" };
  if (run.status === "cancelled") return { text: `Stopped · ${relativeTime(run.endedAt ?? run.createdAt)}`, tone: "fail" };
  return { text: relativeTime(run.endedAt ?? run.createdAt), tone: "done" };
}

/**
 * A thumbnail that keeps the last frame on screen while the next one loads, so a live card doesn't
 * flash. A skeleton shows only for the very first frame, and only if it takes a moment.
 */
function Thumb({ src, title }: { src: string; title: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSlow(false);
    const timer = window.setTimeout(() => live && setSlow(true), 150);
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      setShown(src);
      setFailed(false);
    };
    image.onerror = () => live && setFailed(true);
    image.src = src;
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [src]);
  if (failed && !shown) return null;
  return (
    <div className="task-thumb">
      {shown ? (
        <img src={shown} alt={`What okidoki saw while working on “${title}”`} draggable={false} />
      ) : slow ? (
        <Skeleton className="task-thumb-skeleton" />
      ) : null}
    </div>
  );
}

export function TaskCard({ run, now, thumbVersion, onOpen }: { run: Run; now: number; thumbVersion?: number; onOpen: () => void }) {
  const status = statusLine(run, now);
  const unread = runUnread(run);
  const lines = run.kind === "answer" ? [] : actionLines(run);
  const thumb = run.kind === "answer" ? null : thumbURL(run.id, thumbVersion, run.title);
  const excerpt = run.kind === "answer" || (!thumb && run.summary) ? run.summary : "";
  const active = ACTIVE.has(run.status);

  return (
    // A card, not a button wrapping headings and lists: one stretched button opens it, and the
    // steps stay readable on their own.
    <div className={cx("task-card", active && "is-active")}>
      <button type="button" className="task-card-hit" title={run.title || run.prompt} onClick={onOpen} aria-label={`Open ${run.title || run.prompt}. ${status.text}${unread ? ". Unread" : ""}`} />
      <div className="task-head">
        <span className={cx("task-status", `tone-${status.tone}`)}>
          {status.tone === "live" ? <span className="pulse-dot" aria-hidden="true" /> : null}
          <span className="tnum">{status.text}</span>
        </span>
        {unread ? <span className="unread-dot" aria-hidden="true" /> : null}
      </div>
      <h3 className="task-title">{run.title || run.prompt}</h3>
      {lines.length ? (
        <ul className="task-lines">
          {lines.map((line, index) => (
            <li key={`${index}-${line.text}`}>
              <PixelIcon name={line.icon} size={14} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {excerpt ? <p className="task-excerpt">{excerpt}</p> : null}
      {thumb ? <Thumb src={thumb} title={run.title} /> : null}
    </div>
  );
}
