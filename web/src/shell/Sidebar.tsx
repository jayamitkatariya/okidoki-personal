import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { Avatar, PixelIcon } from "../components/ui";
import type { BrowserTab, Pin } from "../types";
import { Favicon } from "./media";
import { MenuItem, Popover } from "./Popover";
import { hostOf, LIBRARY, siteLabel, splitTabs, threadInfo, type View } from "./model";

const OPEN_KEY = "okidoki.shell.sections";
const CHATS_SHOWN = 6;

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveOpen(value: Record<string, boolean>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(value));
  } catch {
    // Private windows: the sections just start open next time.
  }
}

/** A spinner the size of a line of text, for a chat that's working. */
export function RowSpinner() {
  return <span className="srow-spin" aria-label="Working" role="img" />;
}

export function Sidebar({
  view,
  activeTabID,
  onNavigate,
  onOpenTab,
  onNewTab,
  onNewChat,
  onHide,
}: {
  view: View;
  activeTabID: string | null;
  onNavigate: (view: View) => void;
  onOpenTab: (tabID: string) => void;
  onNewTab: () => void;
  onNewChat: () => void;
  onHide: () => void;
}) {
  const { state, settings, account, invoke } = useDashboard();
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const toggle = (key: string) => {
    const next = { ...open, [key]: !(open[key] ?? true) };
    setOpen(next);
    saveOpen(next);
  };
  const isOpen = (key: string, fallback = true) => open[key] ?? fallback;

  const tabs = state.browser?.tabs ?? [];
  const { mine, agent } = useMemo(() => splitTabs(tabs), [tabs]);
  const chats = useMemo(() => threadInfo(state), [state]);
  const pins = state.pins ?? [];
  const bookmarks = state.bookmarks ?? [];
  const viewingTab = view.kind === "tab" ? tabs.find((tab) => tab.id === (view.id === "@active" ? activeTabID : view.id)) : null;

  const openSite = (url: string) => {
    const host = hostOf(url);
    const existing = tabs.find((tab) => !tab.ownerRunID && !tab.status && tab.host === host);
    if (existing) {
      onOpenTab(existing.id);
      return;
    }
    invoke("browserOpen", { url, newTab: true });
    onNavigate({ kind: "tab", id: "@active" });
  };

  const waiting = state.runs.filter((run) => run.status === "waiting" || run.status === "previewing" || run.status === "asked").length;
  const working = state.runs.filter((run) => run.status === "running").length;
  const status = !settings.okidokiEnabled
    ? "Paused"
    : settings.quietMode
      ? "Quiet mode"
      : waiting
        ? `${waiting} waiting for you`
        : working
          ? `${working} working`
          : "Ready";

  return (
    <aside className="side" aria-label="okidoki">
      <div className="side-top">
        <span className="side-lights" aria-hidden="true" />
        <button type="button" className="side-icon" aria-label="Hide sidebar (⌘B)" data-tip="Hide sidebar ⌘B" onClick={onHide}>
          <PixelIcon name="panel" size={16} />
        </button>
        <button type="button" className="side-icon" aria-label="New tab (⌘T)" data-tip="New tab ⌘T" onClick={onNewTab}>
          <PixelIcon name="plus" size={16} />
        </button>
      </div>

      <div className="side-scroll">
        <PinGrid
          pins={pins}
          tabs={tabs}
          viewingHost={viewingTab?.host ?? null}
          viewingTab={viewingTab ?? null}
          onOpen={openSite}
          onOpenNew={(url) => {
            invoke("browserOpen", { url, newTab: true });
            onNavigate({ kind: "tab", id: "@active" });
          }}
        />

        {bookmarks.length ? (
          <Section title="Bookmarks" open={isOpen("bookmarks")} onToggle={() => toggle("bookmarks")}>
            {bookmarks.map((bookmark) => (
              <Row
                key={bookmark.id}
                icon={<Favicon url={bookmark.url} size={16} />}
                label={siteLabel(bookmark.title, bookmark.url)}
                title={bookmark.url}
                active={Boolean(viewingTab && viewingTab.address === bookmark.url)}
                onClick={() => openSite(bookmark.url)}
                onClose={() => invoke("removeBookmark", { id: bookmark.id })}
                closeLabel="Remove bookmark"
              />
            ))}
          </Section>
        ) : null}

        <Section title="Chats" open={isOpen("chats")} onToggle={() => toggle("chats")}>
          <Row icon={<PixelIcon name="compose" size={16} />} label="New chat" muted onClick={onNewChat} />
          {chats.slice(0, CHATS_SHOWN).map((info) => (
            <Row
              key={info.thread.id}
              label={info.thread.title || "New chat"}
              active={view.kind === "chat" && view.id === info.thread.id}
              onClick={() => onNavigate({ kind: "chat", id: info.thread.id })}
              trailing={
                info.needsYou ? (
                  <span className="srow-badge" aria-label="Needs you">
                    !
                  </span>
                ) : info.active ? (
                  <RowSpinner />
                ) : info.unread ? (
                  <span className="unread-dot" aria-label="Unread" role="img" />
                ) : null
              }
            />
          ))}
          {chats.length > CHATS_SHOWN || chats.length > 0 ? (
            <Row label="Show all" muted onClick={() => onNavigate({ kind: "page", page: "history" })} active={view.kind === "page" && view.page === "history"} />
          ) : null}
        </Section>

        <Section title="Tabs" open={isOpen("tabs")} onToggle={() => toggle("tabs")}>
          <Row icon={<PixelIcon name="plus" size={16} />} label="New tab" muted onClick={onNewTab} active={view.kind === "home"} />
          {mine.map((tab) => (
            <TabRow key={tab.id} tab={tab} active={view.kind === "tab" && viewingTab?.id === tab.id} onOpen={() => onOpenTab(tab.id)} />
          ))}
          {agent.length ? (
            <div className="agent-group">
              <button type="button" className="srow srow-group" aria-expanded={isOpen("agentTabs", true)} onClick={() => toggle("agentTabs")}>
                <span className="srow-icon">
                  <PixelIcon name="tabs" size={16} />
                </span>
                <span className="srow-label">Agent tabs</span>
                <span className="srow-count tnum">{agent.length}</span>
                <PixelIcon name="chevron-down" size={13} className={cx("srow-caret", !isOpen("agentTabs", true) && "is-closed")} />
              </button>
              <AnimatePresence initial={false}>
                {isOpen("agentTabs", true) ? (
                  <motion.div
                    className="agent-tabs"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
                    exit={{ height: 0, opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 0.6, 1] } }}
                  >
                    {agent.map((tab) => (
                      <TabRow key={tab.id} tab={tab} agent active={view.kind === "tab" && viewingTab?.id === tab.id} onOpen={() => onOpenTab(tab.id)} />
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          ) : null}
        </Section>
      </div>

      <div className="side-foot">
        <nav className="library" aria-label="Library">
          {LIBRARY.map((item) => {
            const active = view.kind === "page" && view.page === item.page;
            const badge = item.page === "runs" ? state.runs.filter((run) => (run.kind === "computer_use" || run.kind === "borrow") && run.status === "running").length : 0;
            return (
              <button
                key={item.page}
                type="button"
                className={cx("lib-btn", active && "is-active")}
                aria-label={item.title}
                aria-current={active ? "page" : undefined}
                data-tip={`${item.title} · ${item.hint}`}
                onClick={() => onNavigate({ kind: "page", page: item.page })}
              >
                <PixelIcon name={item.icon} size={17} />
                {badge ? <span className="lib-badge" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </nav>
        <button type="button" className="side-account" onClick={() => onNavigate({ kind: "page", page: "settings" })} aria-label={`${account.name}, ${status}. Open settings`}>
          <Avatar account={account} size={26} />
          <span className="side-account-text">
            <strong>{account.name}</strong>
            <em className={cx(waiting > 0 && "is-wait", !settings.okidokiEnabled && "is-off")}>{status}</em>
          </span>
        </button>
      </div>
    </aside>
  );
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="side-section">
      <button type="button" className="side-label" aria-expanded={open} onClick={onToggle}>
        <span>{title}</span>
        <PixelIcon name="chevron-down" size={12} className={cx("side-caret", !open && "is-closed")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="side-rows"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 0.6, 1] } }}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function Row({
  icon,
  label,
  title,
  active,
  muted,
  onClick,
  trailing,
  onClose,
  closeLabel,
}: {
  icon?: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  muted?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className={cx("srow", active && "is-active", muted && "is-muted", onClose && "has-close")} title={title}>
      <button type="button" className="srow-main" onClick={onClick} aria-current={active ? "page" : undefined}>
        {icon ? <span className="srow-icon">{icon}</span> : null}
        <span className="srow-label">{label}</span>
        {trailing ? <span className="srow-trailing">{trailing}</span> : null}
      </button>
      {onClose ? (
        <button
          type="button"
          className="srow-close"
          aria-label={closeLabel ?? `Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <PixelIcon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}

function TabRow({ tab, active, agent, onOpen }: { tab: BrowserTab; active: boolean; agent?: boolean; onOpen: () => void }) {
  const { invoke } = useDashboard();
  return (
    <Row
      icon={
        <span className={cx("tab-icon", agent && "is-agent", tab.loading && "is-loading")}>
          <Favicon host={tab.host} size={16} />
          {agent ? <span className="tab-glow" aria-hidden="true" /> : null}
        </span>
      }
      label={tab.blank ? "Opening…" : siteLabel(tab.title, tab.address)}
      title={agent && tab.status ? `${siteLabel(tab.title, tab.address)} · ${tab.status}` : tab.address}
      active={active}
      onClick={onOpen}
      onClose={() => invoke("browserClose", { tabID: tab.id })}
      closeLabel={agent ? "Stop and close this tab" : "Close tab"}
    />
  );
}

function PinGrid({
  pins,
  tabs,
  viewingHost,
  viewingTab,
  onOpen,
  onOpenNew,
}: {
  pins: Pin[];
  tabs: BrowserTab[];
  viewingHost: string | null;
  viewingTab: BrowserTab | null;
  onOpen: (url: string) => void;
  onOpenNew: (url: string) => void;
}) {
  const { invoke } = useDashboard();
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<Pin | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const shown = order ? order.map((id) => pins.find((pin) => pin.id === id)).filter((pin): pin is Pin => Boolean(pin)) : pins;
  const canPin = viewingTab && !viewingTab.blank && !viewingTab.ownerRunID && !viewingTab.status && !pins.some((pin) => hostOf(pin.url) === viewingTab.host) && pins.length < 12;
  const openHosts = new Set(tabs.map((tab) => tab.host));

  if (!pins.length && !canPin) return null;

  return (
    <div className="pins" role="list" aria-label="Pinned sites">
      {shown.map((pin) => {
        const host = hostOf(pin.url);
        return (
          <button
            key={pin.id}
            type="button"
            role="listitem"
            className={cx("pin", viewingHost === host && "is-active", openHosts.has(host) && "is-open", dragging === pin.id && "is-dragging")}
            aria-label={pin.title || host}
            data-tip={pin.title || host}
            draggable
            onClick={() => onOpen(pin.url)}
            onContextMenu={(event) => {
              event.preventDefault();
              menuAnchor.current = event.currentTarget;
              setMenu(pin);
            }}
            onDragStart={(event) => {
              setDragging(pin.id);
              setOrder(pins.map((item) => item.id));
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnter={() => {
              if (!dragging || dragging === pin.id || !order) return;
              const next = order.filter((id) => id !== dragging);
              next.splice(next.indexOf(pin.id) + (order.indexOf(dragging) < order.indexOf(pin.id) ? 1 : 0), 0, dragging);
              setOrder(next);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragEnd={() => {
              if (order) invoke("reorderPins", { ids: order });
              setDragging(null);
              window.setTimeout(() => setOrder(null), 400);
            }}
          >
            <Favicon url={pin.url} size={20} />
          </button>
        );
      })}
      {canPin ? (
        <button type="button" className="pin pin-add" aria-label="Pin this site" data-tip={`Pin ${viewingTab!.host}`} onClick={() => invoke("pinTab", { tabID: viewingTab!.id })}>
          <PixelIcon name="plus" size={16} />
        </button>
      ) : null}
      <Popover open={Boolean(menu)} onClose={() => setMenu(null)} anchor={menuAnchor} width={200}>
        {menu ? (
          <>
            <MenuItem
              icon="external"
              label="Open in a new tab"
              onSelect={() => {
                onOpenNew(menu.url);
                setMenu(null);
              }}
            />
            <MenuItem
              icon="x"
              label="Unpin"
              danger
              onSelect={() => {
                invoke("unpin", { id: menu.id });
                setMenu(null);
              }}
            />
          </>
        ) : null}
      </Popover>
    </div>
  );
}
