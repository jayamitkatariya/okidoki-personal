import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { isComposing, KeyHint, PixelIcon } from "../components/ui";
import { useDialog } from "../components/useDialog";
import { Favicon, useCover } from "./media";
import { hostOf, LIBRARY, looksLikeAddress, siteLabel, threadInfo, type View } from "./model";
import { askAndOpen } from "./ask";

interface Result {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** ⌘K: jump to any tab, chat, bookmark or page, or hand what you typed to okidoki. */
export function Palette({
  open,
  onClose,
  onNavigate,
  onOpenTab,
  onOpenURL,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
  onOpenTab: (id: string) => void;
  onOpenURL: (url: string) => void;
}) {
  const { state, invoke } = useDashboard();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const dialog = useDialog(open, onClose);
  useCover("palette", open);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    input.current?.focus();
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const has = (...values: Array<string | undefined>) => !q || values.some((value) => value?.toLowerCase().includes(q));
    const close = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const list: Result[] = [];
    if (q) {
      list.push({
        id: "ask",
        group: "okidoki",
        label: `Ask okidoki “${query.trim()}”`,
        detail: "Answer or do it",
        icon: <PixelIcon name="spark" size={16} />,
        run: close(() => askAndOpen(invoke, { text: query.trim(), mode: "auto" }, (thread) => onNavigate({ kind: "chat", id: thread }))),
      });
      list.push({
        id: "search",
        group: "okidoki",
        label: looksLikeAddress(query.trim()) ? `Open ${query.trim()}` : `Search Google for “${query.trim()}”`,
        icon: looksLikeAddress(query.trim()) ? <Favicon host={hostOf(query.trim())} size={16} /> : <PixelIcon name="search" size={16} />,
        run: close(() => {
          invoke("browserGo", { text: query.trim(), choice: looksLikeAddress(query.trim()) ? "open" : "search", newTab: true });
          onNavigate({ kind: "tab", id: "@active" });
        }),
      });
    }
    for (const tab of state.browser?.tabs ?? []) {
      if (tab.blank) continue;
      const label = siteLabel(tab.title, tab.address);
      if (has(label, tab.address)) list.push({ id: `tab-${tab.id}`, group: "Tabs", label, detail: tab.status ?? tab.host, icon: <Favicon host={tab.host} size={16} />, run: close(() => onOpenTab(tab.id)) });
    }
    for (const info of threadInfo(state).slice(0, 30)) {
      if (has(info.thread.title, info.thread.topic)) {
        list.push({ id: `chat-${info.thread.id}`, group: "Chats", label: info.thread.title || "New chat", icon: <PixelIcon name="chat" size={16} />, run: close(() => onNavigate({ kind: "chat", id: info.thread.id })) });
      }
    }
    for (const item of [...(state.pins ?? []), ...(state.bookmarks ?? [])]) {
      if (has(item.title, item.url)) {
        // Like the sidebar: back to that site's tab if one's open, else a new one.
        const open = (state.browser?.tabs ?? []).find((tab) => !tab.ownerRunID && !tab.status && tab.host === hostOf(item.url));
        list.push({ id: `site-${item.id}`, group: "Sites", label: siteLabel(item.title, item.url), detail: hostOf(item.url), icon: <Favicon url={item.url} size={16} />, run: close(() => (open ? onOpenTab(open.id) : onOpenURL(item.url))) });
      }
    }
    for (const page of LIBRARY) {
      if (has(page.title, page.hint)) list.push({ id: `page-${page.page}`, group: "Go to", label: page.title, detail: page.hint, icon: <PixelIcon name={page.icon} size={16} />, run: close(() => onNavigate({ kind: "page", page: page.page })) });
    }
    for (const skill of state.skills ?? []) {
      if (q && has(skill.name, skill.summary)) {
        list.push({ id: `skill-${skill.id}`, group: "Replay", label: `Replay “${skill.name}”`, detail: skill.summary, icon: <PixelIcon name="repeat" size={16} />, run: close(() => invoke("replaySkill", { id: skill.id })) });
      }
    }
    return list.slice(0, 40);
  }, [query, state, invoke, onClose, onNavigate, onOpenTab, onOpenURL]);

  // Results shrink as you type: keep the selection on something that exists.
  const at = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="palette2-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.16 } }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={dialog}
            className="palette2"
            role="dialog"
            aria-modal="true"
            aria-label="Go anywhere or ask okidoki"
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.4, 0, 0.6, 1] } }}
          >
            <div className="palette2-input">
              <PixelIcon name="search" size={17} />
              <input
                ref={input}
                value={query}
                placeholder="Go to a tab, chat or page, or ask okidoki…"
                aria-label="Search"
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls="palette-results"
                aria-activedescendant={results[at] ? `palette-${results[at].id}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
                onKeyDown={(event) => {
                  if (isComposing(event)) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setIndex((value) => Math.min(results.length - 1, value + 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setIndex((value) => Math.max(0, value - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    results[at]?.run();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    onClose();
                  }
                }}
              />
            </div>
            <div className="palette2-body" id="palette-results" role="listbox" aria-label="Results">
              {results.map((result, place) => (
                <div key={result.id} role="presentation">
                  {place === 0 || results[place - 1].group !== result.group ? <div className="pop-group" role="presentation">{result.group}</div> : null}
                  <button
                    ref={place === at ? selected : undefined}
                    id={`palette-${result.id}`}
                    type="button"
                    role="option"
                    aria-selected={place === at}
                    tabIndex={-1}
                    className={cx("pop-item", place === at && "is-active")}
                    onMouseEnter={() => setIndex(place)}
                    onClick={result.run}
                  >
                    {result.icon}
                    <span className="pop-item-text">
                      <span>{result.label}</span>
                      {result.detail ? <em>{result.detail}</em> : null}
                    </span>
                    {place === at ? <span className="pop-enter">↵</span> : null}
                  </button>
                </div>
              ))}
              {!results.length ? <p className="pop-empty">Type to find a tab, chat or page, or to ask okidoki.</p> : null}
            </div>
            <footer className="palette2-foot">
              <span>
                <KeyHint>↑↓</KeyHint> move
              </span>
              <span>
                <KeyHint>↵</KeyHint> open
              </span>
              <span>
                <KeyHint>esc</KeyHint> close
              </span>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
