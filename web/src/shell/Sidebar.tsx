import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { Avatar, PixelIcon } from "../components/ui";
import type { Bookmark, BrowserTab, Pin } from "../types";
import { Favicon } from "./media";
import { Tip } from "./Tip";
import { ChatMenu } from "./ChatMenu";
import { Kbd } from "@/components/ui/kbd";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { bookmarkFor, canSave, MAX_PINS, pinFor, siteOf, useSiteActions, type Site } from "./siteActions";
import { ACTIVE, hostOf, LIBRARY, showsPrivateMac, siteLabel, splitTabs, threadInfo, type View } from "./model";

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

/**
 * What's being dragged in the sidebar. Tabs, pins and bookmarks move between the pins grid, Bookmarks
 * and Tabs: a tab onto the pins pins it, onto Bookmarks bookmarks it; a pin onto Tabs unpins it.
 */
type Drag = { kind: "tab"; tab: BrowserTab } | { kind: "pin"; pin: Pin } | { kind: "bookmark"; bookmark: Bookmark };

function dragSite(drag: Drag): Site {
  if (drag.kind === "tab") return siteOf(drag.tab);
  const item = drag.kind === "pin" ? drag.pin : drag.bookmark;
  return { url: item.url, title: item.title };
}

/** Starts a sidebar drag: the page's link rides along, so it can also be dropped into other apps. */
function startDrag(event: React.DragEvent, url: string, title: string) {
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData("text/uri-list", url);
  event.dataTransfer.setData("text/plain", url);
  event.dataTransfer.setData("application/x-okidoki-site", JSON.stringify({ url, title }));
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
  const [scrolled, setScrolled] = useState(false);
  const toggle = (key: string) => {
    const next = { ...open, [key]: !(open[key] ?? true) };
    setOpen(next);
    saveOpen(next);
  };
  const isOpen = (key: string, fallback = true) => open[key] ?? fallback;

  const tabs = state.browser?.tabs ?? [];
  const { mine, agent } = useMemo(() => splitTabs(tabs), [tabs]);
  const vmShown = showsPrivateMac(state);
  const vmPhase = state.privateMac?.phase;
  const vmWorking = vmShown && state.runs.some((run) => run.kind === "computer_use" && ACTIVE.has(run.status));
  const agentCount = agent.length + (vmShown ? 1 : 0);
  const chats = useMemo(() => threadInfo(state), [state]);
  const pins = state.pins ?? [];
  const bookmarks = state.bookmarks ?? [];
  const viewingTab = view.kind === "tab" ? tabs.find((tab) => tab.id === (view.id === "@active" ? activeTabID : view.id)) : null;
  const actions = useSiteActions();
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = drag ? dragSite(drag) : null;

  /** A pin goes back to its site's tab if one is open; a bookmark only to that exact page. */
  const openSite = (url: string, exact = false) => {
    const host = hostOf(url);
    const same = (address: string) => address.replace(/\/$/, "") === url.replace(/\/$/, "");
    const existing = tabs.find((tab) => !tab.ownerRunID && !tab.status && (exact ? same(tab.address) : tab.host === host));
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
    <aside className={cx("side", scrolled && "is-scrolled")} aria-label="okidoki">
      <div className="side-top">
        <span className="side-lights" aria-hidden="true" />
        <Tip label="Hide sidebar ⌘B">
          <button type="button" className="side-icon" aria-label="Hide sidebar (⌘B)" onClick={onHide}>
            <PixelIcon name="panel" size={16} />
          </button>
        </Tip>
        <Tip label="New tab ⌘T">
          <button type="button" className="side-icon" aria-label="New tab (⌘T)" onClick={onNewTab}>
            <PixelIcon name="plus" size={16} />
          </button>
        </Tip>
      </div>

      <div className="side-scroll" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}>
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
          drag={drag}
          onDrag={setDrag}
        />

        <Section
          title="Bookmarks"
          open={isOpen("bookmarks")}
          onToggle={() => toggle("bookmarks")}
          drop={
            drag && drag.kind !== "bookmark" && dragging && canSave(dragging.url)
              ? {
                  hint: bookmarkFor(state, dragging.url) ? "Already bookmarked" : "Drop to bookmark",
                  onDrop: () => actions.bookmark(dragging),
                }
              : null
          }
        >
          {bookmarks.map((bookmark) => (
            <SiteMenu
              key={bookmark.id}
              site={bookmark}
              onOpen={() => openSite(bookmark.url, true)}
              onOpenNew={() => {
                invoke("browserOpen", { url: bookmark.url, newTab: true });
                onNavigate({ kind: "tab", id: "@active" });
              }}
              onRemove={{ label: "Remove bookmark", run: () => actions.removeBookmark(bookmark) }}
            >
              <Row
                icon={<Favicon url={bookmark.url} size={16} />}
                label={siteLabel(bookmark.title, bookmark.url)}
                title={bookmark.url}
                active={Boolean(viewingTab && viewingTab.address === bookmark.url)}
                onClick={() => openSite(bookmark.url, true)}
                onClose={() => actions.removeBookmark(bookmark)}
                closeLabel="Remove bookmark"
                dragging={drag?.kind === "bookmark" && drag.bookmark.id === bookmark.id}
                onDragStart={(event) => {
                  startDrag(event, bookmark.url, bookmark.title);
                  setDrag({ kind: "bookmark", bookmark });
                }}
                onDragEnd={() => setDrag(null)}
              />
            </SiteMenu>
          ))}
          {!bookmarks.length ? (
            <p className="side-empty">
              Drag a tab here, or press <kbd>⌘D</kbd>
            </p>
          ) : null}
        </Section>

        <Section title="Chats" open={isOpen("chats")} onToggle={() => toggle("chats")}>
          <Row icon={<PixelIcon name="compose" size={16} />} label="New chat" title="New chat (⌘N)" muted onClick={onNewChat} />
          {chats.slice(0, CHATS_SHOWN).map((info) => (
            <Row
              key={info.thread.id}
              label={info.thread.title || "New chat"}
              title={info.thread.title || undefined}
              active={view.kind === "chat" && view.id === info.thread.id}
              onClick={() => onNavigate({ kind: "chat", id: info.thread.id })}
              menu={<ChatMenu thread={info.thread} className="srow-close" onGone={() => view.kind === "chat" && view.id === info.thread.id && onNavigate({ kind: "home" })} />}
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
          {chats.length > CHATS_SHOWN ? (
            <Row label="Show all" muted onClick={() => onNavigate({ kind: "page", page: "history" })} active={view.kind === "page" && view.page === "history"} />
          ) : null}
        </Section>

        <Section
          title="Tabs"
          open={isOpen("tabs")}
          onToggle={() => toggle("tabs")}
          drop={
            drag?.kind === "pin"
              ? { hint: "Drop to unpin", effect: "move", onDrop: () => actions.unpin(drag.pin) }
              : drag?.kind === "bookmark"
                ? {
                    hint: "Drop to open in a new tab",
                    onDrop: () => {
                      invoke("browserOpen", { url: drag.bookmark.url, newTab: true });
                      onNavigate({ kind: "tab", id: "@active" });
                    },
                  }
                : null
          }
        >
          <Row icon={<PixelIcon name="plus" size={16} />} label="New tab" title="New tab (⌘T)" muted onClick={onNewTab} active={view.kind === "home"} />
          {mine.map((tab) => (
            <TabRow key={tab.id} tab={tab} active={view.kind === "tab" && viewingTab?.id === tab.id} onOpen={() => onOpenTab(tab.id)} drag={drag} onDrag={setDrag} />
          ))}
          {agentCount ? (
            <div className="agent-group">
              <button type="button" className="srow srow-group" aria-expanded={isOpen("agentTabs", true)} onClick={() => toggle("agentTabs")}>
                <span className="srow-icon">
                  <PixelIcon name="tabs" size={16} />
                </span>
                <span className="srow-label">Agent tabs</span>
                <span className="srow-count tnum">{agentCount}</span>
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
                    {vmShown ? (
                      <Row
                        icon={
                          <span className={cx("tab-icon", "vm-icon", vmWorking && "is-agent")}>
                            <PixelIcon name="screen" size={15} />
                            {vmWorking ? <span className="tab-glow" aria-hidden="true" /> : null}
                            {vmPhase === "running" && !vmWorking ? <span className="vm-dot" aria-hidden="true" /> : null}
                          </span>
                        }
                        label="Private Mac"
                        title={state.privateMac?.status}
                        active={view.kind === "vm"}
                        onClick={() => onNavigate({ kind: "vm" })}
                      />
                    ) : null}
                    {agent.map((tab) => (
                      <TabRow key={tab.id} tab={tab} agent active={view.kind === "tab" && viewingTab?.id === tab.id} onOpen={() => onOpenTab(tab.id)} drag={drag} onDrag={setDrag} />
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
              <Tip key={item.page} label={`${item.title} · ${item.hint}`} side="top">
                <button
                  type="button"
                  className={cx("lib-btn", active && "is-active")}
                  aria-label={badge ? `${item.title}, ${badge} running` : item.title}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onNavigate({ kind: "page", page: item.page })}
                >
                  <PixelIcon name={item.icon} size={17} />
                  {badge ? <span className="lib-badge" aria-hidden="true" /> : null}
                </button>
              </Tip>
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

/** A section a drag can drop onto: it shows what the drop will do while something's being dragged. */
interface SectionDrop {
  hint: string;
  onDrop: () => void;
  /** The cursor's badge: copy (+) for adding, move for taking a pin out. */
  effect?: "copy" | "move";
}

function Section({
  title,
  open,
  onToggle,
  children,
  drop,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  drop?: SectionDrop | null;
}) {
  const [over, setOver] = useState(false);
  // dragenter/leave fire for every child crossed; count them so the highlight doesn't flicker.
  const depth = useRef(0);
  useEffect(() => {
    if (drop) return;
    depth.current = 0;
    setOver(false);
  }, [drop]);
  const dropProps: React.HTMLAttributes<HTMLElement> = drop
    ? {
        onDragEnter: (event) => {
          event.preventDefault();
          depth.current += 1;
          setOver(true);
        },
        onDragOver: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = drop.effect ?? "copy";
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        },
        onDrop: (event) => {
          event.preventDefault();
          depth.current = 0;
          setOver(false);
          drop.onDrop();
        },
      }
    : {};
  return (
    <section className={cx("side-section", drop && "is-drop-ready", over && "is-drop-over")} {...dropProps}>
      <button type="button" className="side-label" aria-expanded={open} onClick={onToggle}>
        <span>{title}</span>
        <PixelIcon name="chevron-down" size={12} className={cx("side-caret", !open && "is-closed")} />
      </button>
      {drop ? (
        <div className="side-drop" role="status">
          {drop.hint}
        </div>
      ) : null}
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
  menu,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  /** A trailing control revealed on hover (a chat's ⋯ menu); takes the close button's place. */
  menu?: React.ReactNode;
  icon?: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  muted?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  /** Draggable rows (tabs, bookmarks) dim while they're being dragged. */
  dragging?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      className={cx("srow", active && "is-active", muted && "is-muted", Boolean(onClose || menu) && "has-close", dragging && "is-dragging")}
      title={title}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
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
      {menu}
    </div>
  );
}

function Shortcut({ keys }: { keys: string }) {
  return (
    <ContextMenuShortcut>
      <Kbd>{keys}</Kbd>
    </ContextMenuShortcut>
  );
}

/** Right-click on a bookmark: open it, pin its site, copy its link, or remove it. */
function SiteMenu({
  site,
  onOpen,
  onOpenNew,
  onRemove,
  children,
}: {
  site: Site;
  onOpen: () => void;
  onOpenNew: () => void;
  onRemove: { label: string; run: () => void };
  children: React.ReactNode;
}) {
  const { state } = useDashboard();
  const actions = useSiteActions();
  const pinned = pinFor(state, site.url);
  return (
    <ContextMenu>
      <ContextMenuTrigger className="srow-ctx">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <PixelIcon name="arrow" size={15} />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={onOpenNew}>
          <PixelIcon name="external" size={15} />
          Open in a new tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => (pinned ? actions.unpin(pinned) : actions.pin(site))}>
          <PixelIcon name="pin" size={15} />
          {pinned ? `Unpin ${hostOf(site.url)}` : `Pin ${hostOf(site.url)}`}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.copyLink(site.url)}>
          <PixelIcon name="link" size={15} />
          Copy link
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onRemove.run}>
          <PixelIcon name="x" size={15} />
          {onRemove.label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TabRow({
  tab,
  active,
  agent,
  onOpen,
  drag,
  onDrag,
}: {
  tab: BrowserTab;
  active: boolean;
  agent?: boolean;
  onOpen: () => void;
  drag: Drag | null;
  onDrag: (drag: Drag | null) => void;
}) {
  const { state, invoke } = useDashboard();
  const actions = useSiteActions();
  const site = siteOf(tab);
  // Blank tabs and error pages have nothing to keep; agent tabs do (what the agent found).
  const saveable = !tab.blank && canSave(tab.address);
  const pinned = saveable ? pinFor(state, tab.address) : undefined;
  const bookmarked = saveable ? bookmarkFor(state, tab.address) : undefined;
  const label = tab.blank ? "Opening…" : siteLabel(tab.title, tab.address);
  return (
    <ContextMenu>
      <ContextMenuTrigger className="srow-ctx">
        <Row
          icon={
            <span className={cx("tab-icon", agent && "is-agent", tab.loading && "is-loading")}>
              <Favicon host={tab.host} size={16} />
              {agent ? <span className="tab-glow" aria-hidden="true" /> : null}
            </span>
          }
          label={label}
          title={agent && tab.status ? `${label} · ${tab.status}` : tab.address}
          active={active}
          onClick={onOpen}
          onClose={() => invoke("browserClose", { tabID: tab.id })}
          closeLabel={agent ? "Stop and close this tab" : "Close tab"}
          dragging={drag?.kind === "tab" && drag.tab.id === tab.id}
          onDragStart={
            saveable
              ? (event) => {
                  startDrag(event, tab.address, tab.title);
                  onDrag({ kind: "tab", tab });
                }
              : undefined
          }
          onDragEnd={() => onDrag(null)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!saveable} onClick={() => (pinned ? actions.unpin(pinned) : actions.pin(site))}>
          <PixelIcon name="pin" size={15} />
          {pinned ? "Unpin site" : "Pin site"}
          {active ? <Shortcut keys="⇧⌘D" /> : null}
        </ContextMenuItem>
        <ContextMenuItem disabled={!saveable} onClick={() => (bookmarked ? actions.removeBookmark(bookmarked) : actions.bookmark(site))}>
          <PixelIcon name="bookmark" size={15} />
          {bookmarked ? "Remove bookmark" : "Bookmark"}
          {active ? <Shortcut keys="⌘D" /> : null}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!saveable} onClick={() => actions.duplicate(tab.address)}>
          <PixelIcon name="copy" size={15} />
          Duplicate tab
        </ContextMenuItem>
        <ContextMenuItem disabled={!saveable} onClick={() => actions.copyLink(tab.address)}>
          <PixelIcon name="link" size={15} />
          Copy link
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => invoke("browserClose", { tabID: tab.id })}>
          <PixelIcon name="x" size={15} />
          {agent ? "Stop and close tab" : "Close tab"}
          {active ? <Shortcut keys="⌘W" /> : null}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Where a tab or bookmark dragged over the pins would land: before pin `index`, or onto a pin to replace it. */
type PinTarget = { index: number } | { replace: Pin };

function PinGrid({
  pins,
  tabs,
  viewingHost,
  viewingTab,
  onOpen,
  onOpenNew,
  drag,
  onDrag,
}: {
  pins: Pin[];
  tabs: BrowserTab[];
  viewingHost: string | null;
  viewingTab: BrowserTab | null;
  onOpen: (url: string) => void;
  onOpenNew: (url: string) => void;
  drag: Drag | null;
  onDrag: (drag: Drag | null) => void;
}) {
  const { state, invoke } = useDashboard();
  const actions = useSiteActions();
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [target, setTarget] = useState<PinTarget | null>(null);
  // The pin a right-click landed on; the menu only opens for a pin.
  const [menu, setMenu] = useState<Pin | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const clicked = useRef<Pin | null>(null);
  const shown = order ? order.map((id) => pins.find((pin) => pin.id === id)).filter((pin): pin is Pin => Boolean(pin)) : pins;
  const full = pins.length >= MAX_PINS;
  const canPin = Boolean(viewingTab && !viewingTab.blank && canSave(viewingTab.address) && !pins.some((pin) => hostOf(pin.url) === viewingTab.host) && !full);
  const openHosts = new Set(tabs.map((tab) => tab.host));
  // A tab or bookmark on its way in.
  const incoming = drag && drag.kind !== "pin" ? dragSite(drag) : null;
  const accepting = Boolean(incoming && canSave(incoming.url));
  const incomingPinned = incoming ? pins.find((pin) => hostOf(pin.url) === hostOf(incoming.url)) : undefined;

  useEffect(() => {
    if (!accepting) setTarget(null);
  }, [accepting]);

  if (!pins.length && !canPin && !accepting) return null;

  const aim = (event: React.DragEvent) => {
    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-pin-at]");
    const at = tile ? Number(tile.dataset.pinAt) : -1;
    if (at < 0 || !shown[at]) {
      setTarget(full ? null : { index: shown.length });
      return;
    }
    if (full && !incomingPinned) {
      setTarget({ replace: shown[at] });
      return;
    }
    const rect = tile!.getBoundingClientRect();
    setTarget({ index: event.clientX < rect.left + rect.width / 2 ? at : at + 1 });
  };

  return (
    <ContextMenu
      open={menuOpen}
      onOpenChange={(open) => {
        if (open && !clicked.current) return;
        if (open) setMenu(clicked.current);
        setMenuOpen(open);
      }}
    >
      <ContextMenuTrigger
        className={cx("pins", accepting && "is-drop-ready", accepting && target && "is-drop-over")}
        role="group"
        aria-label="Pinned sites"
        onContextMenuCapture={() => {
          clicked.current = null;
        }}
        onDragOver={(event: React.DragEvent) => {
          if (!accepting) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          aim(event);
        }}
        onDragLeave={(event: React.DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
        }}
        onDrop={(event: React.DragEvent) => {
          if (!accepting || !incoming) return;
          event.preventDefault();
          if (target && "replace" in target) actions.pin(incoming, { replace: target.replace });
          else actions.pin(incoming, { index: target?.index });
          setTarget(null);
          onDrag(null);
        }}
      >
        {shown.map((pin, at) => {
          const host = hostOf(pin.url);
          const before = target && "index" in target && target.index === at;
          const after = target && "index" in target && target.index === shown.length && at === shown.length - 1;
          const replacing = target && "replace" in target && target.replace.id === pin.id;
          return (
            <Tip key={pin.id} label={replacing ? `Replace ${pin.title || host}` : pin.title || host}>
              <button
                type="button"
                data-pin-at={at}
                data-insert={before ? "before" : after ? "after" : undefined}
                className={cx(
                  "pin",
                  viewingHost === host && "is-active",
                  openHosts.has(host) && "is-open",
                  dragging === pin.id && "is-dragging",
                  replacing && "is-replace",
                  incomingPinned?.id === pin.id && "is-same",
                )}
                aria-label={pin.title || host}
                draggable
                onClick={() => onOpen(pin.url)}
                onContextMenu={() => {
                  clicked.current = pin;
                }}
                onDragStart={(event) => {
                  startDrag(event, pin.url, pin.title);
                  setDragging(pin.id);
                  setOrder(pins.map((item) => item.id));
                  onDrag({ kind: "pin", pin });
                }}
                onDragEnter={() => {
                  if (!dragging || dragging === pin.id || !order) return;
                  const next = order.filter((id) => id !== dragging);
                  next.splice(next.indexOf(pin.id) + (order.indexOf(dragging) < order.indexOf(pin.id) ? 1 : 0), 0, dragging);
                  setOrder(next);
                }}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  if (dragging) event.preventDefault();
                }}
                onDragEnd={(event) => {
                  // Escape, or dropped outside the pins: nothing moves. Dropped on Tabs or Bookmarks:
                  // that section unpins or bookmarks it; the order here is unchanged.
                  if (order && event.dataTransfer.dropEffect !== "none") invoke("reorderPins", { ids: order });
                  setDragging(null);
                  onDrag(null);
                  window.setTimeout(() => setOrder(null), 400);
                }}
              >
                <Favicon url={pin.url} size={20} />
                {replacing ? (
                  <span className="pin-swap" aria-hidden="true">
                    <PixelIcon name="refresh" size={12} />
                  </span>
                ) : null}
              </button>
            </Tip>
          );
        })}
        {accepting && !pins.length ? (
          <div className="pin pin-drop" data-insert={target ? "on" : undefined}>
            Drop to pin
          </div>
        ) : canPin && !accepting ? (
          <Tip label={`Pin ${viewingTab!.host} (⇧⌘D) · or drag a tab here`}>
            <button type="button" className="pin pin-add" aria-label="Pin this site" onClick={() => actions.pin(siteOf(viewingTab!))}>
              <PixelIcon name="plus" size={16} />
            </button>
          </Tip>
        ) : null}
        {accepting && (full || incomingPinned) ? (
          <p className="pins-note" role="status">
            {incomingPinned ? `${hostOf(incomingPinned.url)} is pinned · drop to move it` : `Pins are full · drop on one to replace it`}
          </p>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menu ? (
          <>
            <ContextMenuItem onClick={() => onOpen(menu.url)}>
              <PixelIcon name="arrow" size={15} />
              Open
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onOpenNew(menu.url)}>
              <PixelIcon name="external" size={15} />
              Open in a new tab
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                const saved = bookmarkFor(state, menu.url);
                if (saved) actions.removeBookmark(saved);
                else actions.bookmark(menu);
              }}
            >
              <PixelIcon name="bookmark" size={15} />
              {bookmarkFor(state, menu.url) ? "Remove bookmark" : "Bookmark"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => actions.copyLink(menu.url)}>
              <PixelIcon name="link" size={15} />
              Copy link
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => actions.unpin(menu)}>
              <PixelIcon name="x" size={15} />
              Unpin
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
