import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { isComposing, PixelIcon } from "../components/ui";
import type { BrowserTab } from "../types";
import { Favicon, useCover } from "./media";
import { MenuItem } from "./Popover";
import { hostOf, looksLikeAddress, looksLikeTask } from "./model";
import { askAndOpen } from "./ask";
import { Tip } from "./Tip";
import { AnimatePresence, motion } from "motion/react";

type Choice = "open" | "search" | "ask";

/**
 * The toolbar sits right above the native page; a tip hanging below would make the page step aside on
 * every hover. Toolbar tips open beside their button instead: rightward on the left, leftward on the right.
 */
function ToolButton({ icon, label, onClick, disabled, active, className, tip = "right" }: { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean; className?: string; tip?: "left" | "right" }) {
  return (
    <Tip label={label} side={tip}>
      <button type="button" className={cx("tool-btn", active && "is-on", className)} aria-label={label} disabled={disabled} onClick={onClick}>
        <PixelIcon name={icon} size={16} />
      </button>
    </Tip>
  );
}

/**
 * The bar across the top of the content card. On a tab it's the browser's: back, forward, reload, the
 * address (open, search or ask), and the page's own buttons. On Home it's a plain search. Elsewhere it
 * says where you are.
 */
export function Toolbar({
  tab,
  crumb,
  sidebarHidden,
  onShowSidebar,
  onSearched,
  onAsked,
  focusTick,
  assistantOpen,
  onToggleAssistant,
  onAskedHere,
  home = false,
}: {
  /** Home (a new tab): the toolbar stays quiet. */
  home?: boolean;
  /** A task typed into the address bar with no page to do it on: its conversation opens. */
  onAsked: (threadID: string) => void;
  tab: BrowserTab | null;
  /** Shown instead of the address when the view isn't the browser. */
  crumb?: { icon: string; title: string } | null;
  sidebarHidden: boolean;
  onShowSidebar: () => void;
  onSearched: () => void;
  focusTick: number;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  /** A task asked about the page in this tab: the assistant panel opens so its reply is in view. */
  onAskedHere?: () => void;
}) {
  const { invoke, state } = useDashboard();
  const working = Boolean(tab?.status || tab?.ownerRunID);
  const recording = state.browser?.recording ?? false;

  return (
    <div className={cx("toolbar", working && "is-agent")}>
      {sidebarHidden ? <ToolButton icon="panel" label="Show sidebar (⌘B)" onClick={onShowSidebar} className="tool-sidebar" /> : null}
      {tab && !home ? (
      <div className="tool-nav">
        <ToolButton icon="chevron-left" label="Back (⌘[)" disabled={!tab?.canGoBack} onClick={() => invoke("browserNav", { action: "back", tabID: tab?.id })} />
        <ToolButton icon="chevron" label="Forward (⌘])" disabled={!tab?.canGoForward} onClick={() => invoke("browserNav", { action: "forward", tabID: tab?.id })} />
        {tab?.loading ? (
          <ToolButton icon="x" label="Stop loading" onClick={() => invoke("browserNav", { action: "stop", tabID: tab.id })} />
        ) : (
          <ToolButton icon="refresh" label="Reload (⌘R)" disabled={tab.blank} onClick={() => invoke("browserNav", { action: "reload", tabID: tab.id })} />
        )}
      </div>
      ) : null}

      {home ? (
        // Home's own box searches and asks; a second one up here would only compete with it.
        <div className="tool-spacer" />
      ) : crumb ? (
        <div className="tool-crumb">
          <PixelIcon name={crumb.icon} size={15} />
          <span>{crumb.title}</span>
        </div>
      ) : (
        <Address tab={tab} focusTick={focusTick} onSearched={onSearched} onAsked={onAsked} onAskedHere={onAskedHere} />
      )}

      <div className="tool-trailing">
        {tab && working ? <AgentPill tab={tab} /> : null}
        {tab && !tab.blank && !working ? (
          <>
            {tab.hasLogin ? (
              <Tip label="A saved login from your vault fills in here" side="left">
                <span className="tool-key" tabIndex={0} aria-label="A saved login from your vault fills in here">
                  <PixelIcon name="key" size={15} />
                </span>
              </Tip>
            ) : null}
            <ToolButton tip="left" icon="record" label={recording ? `Save recording (${state.browser?.recordedSteps ?? 0} steps)` : "Record a skill"} active={recording} className={cx(recording && "is-recording")} onClick={() => invoke("browserRecord")} />
            <ToolButton tip="left" icon="bookmark" label={tab.bookmarked ? "Remove bookmark" : "Bookmark"} active={tab.bookmarked} onClick={() => invoke("toggleBookmark", { tabID: tab.id })} />
          </>
        ) : null}
        {tab && !tab.blank ? <ToolButton tip="left" icon="chat" label={assistantOpen ? "Hide okidoki (⌘J)" : "Ask okidoki about this page (⌘J)"} active={assistantOpen} onClick={onToggleAssistant} /> : null}
      </div>
      {tab?.loading ? <span className="tool-progress" aria-hidden="true" /> : null}
    </div>
  );
}

function AgentPill({ tab }: { tab: BrowserTab }) {
  const { invoke } = useDashboard();
  return (
    <div className="agent-pill" role="status">
      <span className="agent-glow" aria-hidden="true" />
      <span className="agent-line">{tab.status ?? "okidoki is working here"}</span>
      <Tip label="Hand the page back to you" side="left">
        <button type="button" onClick={() => invoke("browserNav", { action: "takeOver", tabID: tab.id })}>
          Take over <kbd>esc</kbd>
        </button>
      </Tip>
    </div>
  );
}

function Address({
  tab,
  focusTick,
  onSearched,
  onAsked,
  onAskedHere,
}: {
  tab: BrowserTab | null;
  focusTick: number;
  onSearched: () => void;
  onAsked: (threadID: string) => void;
  onAskedHere?: () => void;
}) {
  const { invoke } = useDashboard();
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const address = tab && !tab.blank ? tab.address : "";

  useEffect(() => {
    if (!focused) setText(address);
  }, [address, focused]);

  // Only a fresh ⌘L focuses: coming back to a tab later must not grab the keyboard again.
  const seenTick = useRef(focusTick);
  useEffect(() => {
    if (focusTick === seenTick.current) return;
    seenTick.current = focusTick;
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);

  const typed = text.trim();
  const editing = focused && typed !== "" && typed !== address;
  const choices = useMemo<Array<{ choice: Choice; label: string; icon: React.ReactNode }>>(() => {
    if (!editing) return [];
    const list: Array<{ choice: Choice; label: string; icon: React.ReactNode }> = [];
    const site = looksLikeAddress(typed);
    const task = looksLikeTask(typed);
    const open = { choice: "open" as const, label: `Open ${typed}`, icon: <Favicon host={hostOf(typed)} size={15} /> };
    const search = { choice: "search" as const, label: `Search Google for “${typed}”`, icon: <PixelIcon name="search" size={15} /> };
    const ask = { choice: "ask" as const, label: tab && !tab.blank ? `Ask okidoki to do this here` : `Ask okidoki to do this`, icon: <PixelIcon name="spark" size={15} /> };
    if (site) list.push(open, search, ask);
    else if (task) list.push(ask, search);
    else list.push(search, ask);
    return list;
  }, [editing, typed, tab]);

  useCover("address", choices.length > 0);

  const go = (choice: Choice) => {
    if (!typed) return;
    const inTab = tab && !tab.blank && !tab.status ? tab.id : undefined;
    input.current?.blur();
    if (choice === "ask" && !inTab) {
      // No page to work on: an ordinary request, in a conversation of its own, which opens.
      askAndOpen(invoke, { text: typed, mode: "auto" }, onAsked);
      return;
    }
    if (choice === "ask") {
      invoke("shellAsk", { text: typed, mode: "tab", tabID: inTab });
      onAskedHere?.();
      return;
    }
    invoke("browserGo", { text: typed, choice, tabID: inTab, newTab: !inTab });
    onSearched();
  };

  return (
    <div className={cx("address", focused && "is-focused")}>
      {tab && !tab.blank && !focused ? <Favicon host={tab.host} size={15} /> : <PixelIcon name="search" size={15} />}
      <input
        ref={input}
        value={focused ? text : address ? prettyAddress(address) : ""}
        placeholder="Search Google or type a URL"
        aria-label="Address"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={choices.length > 0}
        aria-controls={choices.length ? "address-choices" : undefined}
        aria-activedescendant={choices.length ? `address-choice-${index}` : undefined}
        spellCheck={false}
        onFocus={(event) => {
          setFocused(true);
          setText(address);
          setIndex(0);
          requestAnimationFrame(() => event.target.select());
        }}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onChange={(event) => {
          setText(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.key === "ArrowDown" && choices.length) {
            event.preventDefault();
            setIndex((value) => (value + 1) % choices.length);
          } else if (event.key === "ArrowUp" && choices.length) {
            event.preventDefault();
            setIndex((value) => (value - 1 + choices.length) % choices.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (choices.length) go(choices[index].choice);
            else if (typed) go(looksLikeAddress(typed) ? "open" : "search");
          } else if (event.key === "Escape") {
            setText(address);
            input.current?.blur();
          }
        }}
      />
      <AnimatePresence>
        {choices.length ? (
          <motion.div
            className="address-pop"
            id="address-choices"
            role="listbox"
            aria-label="Where to go"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          >
            {choices.map((item, at) => (
              <MenuItem key={item.choice} id={`address-choice-${at}`} role="option" icon={item.icon} label={item.label} active={at === index} onHover={() => setIndex(at)} onSelect={() => go(item.choice)} />
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** "github.com/jay/okidoki" rather than "https://www.github.com/jay/okidoki". */
function prettyAddress(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}
