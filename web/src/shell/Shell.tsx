import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { isNative } from "../bridge";
import { cx } from "../lib";
import { Empty, PixelIcon, ToastStack } from "../components/ui";
import { jumpToSettingsSection, type Page } from "../nav";
import { RunsPage } from "../pages/RunsPage";
import { LivePage } from "../pages/LivePage";
import { HistoryPage } from "../pages/HistoryPage";
import { MemoryPage } from "../pages/MemoryPage";
import { SkillsPage } from "../pages/SkillsPage";
import { SettingsPage } from "../pages/SettingsPage";
import { VaultPage } from "../pages/VaultPage";
import type { Run } from "../types";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { Home } from "./Home";
import { ChatView } from "./ChatView";
import { AssistantPanel } from "./AssistantPanel";
import { PageSlot } from "./PageSlot";
import { Palette } from "./Palette";
import { CoverProvider } from "./media";
import { hostOf, LIBRARY, parseView, viewKey, type LibraryPage, type View } from "./model";
import "../styles/shell.css";
// Inlined: a CSS mask is a CORS load, which a page opened from the app's files can't make.
import brandMark from "../../public/brand.png?inline";

const SIDEBAR_KEY = "okidoki.shell.sidebar";

export function Shell() {
  // The look is scoped to this class, so the original dashboard never sees any of it.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("shell2-on");
    root.style.setProperty("--mark", `url("${brandMark}")`);
    if (isNative()) root.classList.add("is-native");
    return () => root.classList.remove("shell2-on", "is-native");
  }, []);
  return (
    <CoverProvider>
      <ShellBody />
    </CoverProvider>
  );
}

function initialView(): View {
  const parsed = parseView(window.location.hash);
  if (!parsed) return { kind: "home" };
  if (parsed === "browser") return { kind: "tab", id: "@active" };
  if ("settingsSection" in parsed) return { kind: "page", page: "settings" };
  return parsed;
}

function ShellBody() {
  const { state, toasts, dismissToast, invoke } = useDashboard();
  const [view, setViewState] = useState<View>(initialView);
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "hidden";
    } catch {
      return false;
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantFor, setAssistantFor] = useState<Record<string, boolean>>({});
  const [focusTick, setFocusTick] = useState(0);
  const [addressTick, setAddressTick] = useState(0);
  const firstHome = useRef(true);

  const tabs = state.browser?.tabs ?? [];
  const activeTabID = state.browser?.activeID ?? null;
  const resolvedTabID = view.kind === "tab" ? (view.id === "@active" ? activeTabID : view.id) : null;
  const tab = resolvedTabID ? (tabs.find((item) => item.id === resolvedTabID) ?? null) : null;

  const setView = useCallback((next: View) => {
    setViewState(next);
  }, []);

  // The hash follows the view, so a reload or a deep link from the Mac lands in the same place.
  useEffect(() => {
    const key = viewKey(view);
    if (window.location.hash !== `#/${key}`) window.history.replaceState(null, "", `#/${key}`);
    if (view.kind === "home") firstHome.current = false;
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarHidden ? "hidden" : "shown");
    } catch {
      // Not remembered in a private window; nothing else depends on it.
    }
  }, [sidebarHidden]);

  // The new shell's pins start from what you already use, once.
  useEffect(() => {
    invoke("seedPins");
  }, [invoke]);

  // Picking a tab here picks it in the browser.
  const openTab = useCallback(
    (id: string) => {
      invoke("browserSelect", { tabID: id });
      setView({ kind: "tab", id });
    },
    [invoke, setView],
  );

  const openURL = useCallback(
    (url: string) => {
      invoke("browserOpen", { url, newTab: true });
      setView({ kind: "tab", id: "@active" });
    },
    [invoke, setView],
  );

  // The browser moved on by itself (a closed tab, a page that opened another, the agent): follow it
  // while a tab is showing.
  const lastActive = useRef(activeTabID);
  useEffect(() => {
    if (lastActive.current === activeTabID) return;
    lastActive.current = activeTabID;
    if (view.kind === "tab" && view.id !== "@active" && activeTabID) setView({ kind: "tab", id: activeTabID });
  }, [activeTabID, view, setView]);

  // A tab that's gone falls back to whatever the browser has in front.
  useEffect(() => {
    if (view.kind === "tab" && view.id !== "@active" && tabs.length && !tabs.some((item) => item.id === view.id)) {
      setView({ kind: "tab", id: "@active" });
    }
  }, [tabs, view, setView]);

  // A chat that's been deleted or archived goes Home.
  useEffect(() => {
    if (view.kind === "chat" && state.threads.length && !state.threads.some((thread) => thread.id === view.id && !thread.archived)) setView({ kind: "home" });
  }, [state.threads, view, setView]);

  const newTab = useCallback(() => {
    setView({ kind: "home" });
    setFocusTick((value) => value + 1);
  }, [setView]);

  const openRun = useCallback(
    (run: Run) => {
      invoke("markSeen", { runID: run.id });
      const agentTab = tabs.find((item) => item.ownerRunID === run.id);
      if (agentTab) openTab(agentTab.id);
      else if (run.threadID && state.threads.some((thread) => thread.id === run.threadID)) setView({ kind: "chat", id: run.threadID });
      else setView({ kind: "page", page: "runs" });
    },
    [invoke, tabs, openTab, state.threads, setView],
  );

  const go = useCallback(
    (page: Page) => {
      if (page === "home") setView({ kind: "home" });
      else if (page === "browser") setView({ kind: "tab", id: "@active" });
      else if (page === "live") setView({ kind: "page", page: "runs" });
      else setView({ kind: "page", page: page as LibraryPage });
    },
    [setView],
  );

  const toggleAssistant = useCallback(() => {
    if (!tab || tab.blank) return;
    setAssistantFor((current) => ({ ...current, [tab.id]: !current[tab.id] }));
  }, [tab]);

  const key = useCallback(
    (k: string) => {
      switch (k) {
        case "t":
        case "n":
          newTab();
          break;
        case "l":
          // Chats and pages have no address bar: ⌘L starts somewhere new, as in a browser.
          if (view.kind === "tab" && tab && !tab.blank) setAddressTick((value) => value + 1);
          else newTab();
          break;
        case "k":
          setPaletteOpen(true);
          break;
        case "b":
          setSidebarHidden((value) => !value);
          break;
        case "j":
          toggleAssistant();
          break;
        case "w":
          if (tab) invoke("browserClose", { tabID: tab.id });
          break;
        default:
          if (/^[1-9]$/.test(k)) {
            const pins = state.pins ?? [];
            const pin = k === "9" ? pins[pins.length - 1] : pins[Number(k) - 1];
            if (!pin) break;
            // Like clicking the pin: back to that site's tab if one's open.
            const open = tabs.find((item) => !item.ownerRunID && !item.status && item.host === hostOf(pin.url));
            if (open) openTab(open.id);
            else openURL(pin.url);
          }
      }
    },
    [newTab, view.kind, toggleAssistant, tab, invoke, state.pins, openURL, openTab, tabs],
  );

  // Shortcuts while the page here has the keyboard, and from the Mac while the browser's page has it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // ⌘ only: ⌃K, ⌃B, ⌃N, ⌃T and ⌃L are text editing keys on the Mac.
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const k = event.key.toLowerCase();
      if (["t", "n", "l", "k", "b", "j", "w"].includes(k)) {
        event.preventDefault();
        key(k);
        return;
      }
      if (/^[1-9]$/.test(k)) {
        event.preventDefault();
        key(k);
      }
    };
    window.addEventListener("keydown", onKey);
    const bridge = window as unknown as { okidokiShellKey?: (k: string) => void };
    bridge.okidokiShellKey = key;
    return () => {
      window.removeEventListener("keydown", onKey);
      delete bridge.okidokiShellKey;
    };
  }, [key]);

  // The Mac points at a run (a notch row, a card's "preview"): its conversation, where its live card is.
  const runsRef = useRef({ runs: state.runs, threads: state.threads, tabs });
  runsRef.current = { runs: state.runs, threads: state.threads, tabs };
  useEffect(() => {
    const bridge = window as unknown as { okidokiOpenRun?: (id: string) => void };
    bridge.okidokiOpenRun = (id: string) => {
      const { runs, threads, tabs: open } = runsRef.current;
      const run = runs.find((item) => item.id === id);
      invoke("markSeen", { runID: id });
      if (run?.threadID && threads.some((thread) => thread.id === run.threadID)) {
        setView({ kind: "chat", id: run.threadID });
        return;
      }
      const agentTab = open.find((item) => item.ownerRunID === id);
      if (agentTab) {
        invoke("browserSelect", { tabID: agentTab.id });
        setView({ kind: "tab", id: agentTab.id });
      } else setView({ kind: "page", page: "runs" });
    };
    return () => {
      delete bridge.okidokiOpenRun;
    };
  }, [invoke, setView]);

  // The Mac asks for a place: Home, the browser (the agent opened a page), a page, or the ask box.
  useEffect(() => {
    const bridge = window as unknown as { okidokiNavigate?: (route: string) => void; okidokiOpenAsk?: (prompt?: string) => void };
    bridge.okidokiNavigate = (route: string) => {
      const parsed = parseView(route);
      if (!parsed) return;
      if (parsed === "browser") setView({ kind: "tab", id: "@active" });
      else if ("settingsSection" in parsed) {
        setView({ kind: "page", page: "settings" });
        jumpToSettingsSection(parsed.settingsSection);
      } else if (parsed.kind === "page" && (parsed.page as string) === "live") setView({ kind: "page", page: "runs" });
      else setView(parsed);
    };
    bridge.okidokiOpenAsk = () => newTab();
    // Back and forward in the page's own history, and hand-typed links.
    const onHash = () => {
      const parsed = parseView(window.location.hash);
      if (parsed && parsed !== "browser" && !("settingsSection" in parsed)) setView(parsed);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      delete bridge.okidokiNavigate;
      delete bridge.okidokiOpenAsk;
    };
  }, [setView, newTab]);

  const thread = view.kind === "chat" ? (state.threads.find((item) => item.id === view.id) ?? null) : null;
  const threadRuns = useMemo(() => (thread ? state.runs.filter((run) => run.threadID === thread.id) : []), [thread, state.runs]);
  const page = view.kind === "page" ? LIBRARY.find((item) => item.page === view.page) : null;
  const showPage = view.kind === "tab" && tab && !tab.blank;
  const assistantOpen = Boolean(tab && assistantFor[tab.id]);

  const crumb =
    view.kind === "chat"
      ? { icon: "chat", title: thread?.title || "Chat" }
      : page
        ? { icon: page.icon, title: page.title }
        : null;

  return (
    <div className={cx("shell2", sidebarHidden && "is-sidebar-hidden")}>
      <AnimatePresence initial={false}>
        {!sidebarHidden ? (
          <motion.div
            className="side-wrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "var(--side-w)", opacity: 1, transition: { duration: 0.24, ease: [0.32, 0.72, 0, 1] } }}
            exit={{ width: 0, opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.6, 1] } }}
          >
            <Sidebar
              view={view}
              activeTabID={activeTabID}
              onNavigate={setView}
              onOpenTab={openTab}
              onNewTab={newTab}
              onNewChat={newTab}
              onHide={() => setSidebarHidden(true)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <main className="card" aria-label="Content">
        <Toolbar
          tab={view.kind === "tab" ? tab : null}
          crumb={crumb}
          sidebarHidden={sidebarHidden}
          onShowSidebar={() => setSidebarHidden(false)}
          onSearched={() => setView({ kind: "tab", id: "@active" })}
          onAsked={(id) => setView({ kind: "chat", id })}
          focusTick={addressTick}
          assistantOpen={assistantOpen}
          onToggleAssistant={toggleAssistant}
        />
        <div className={cx("card-body", `is-${view.kind}`)}>
          {view.kind === "home" || (view.kind === "tab" && (!tab || tab.blank)) ? (
            <div className="card-scroll">
              <Home
                firstOpen={firstHome.current}
                focusTick={focusTick}
                onOpenRun={openRun}
                onAsked={(id) => setView({ kind: "chat", id })}
                onSearched={() => setView({ kind: "tab", id: "@active" })}
                onShowAll={() => setView({ kind: "page", page: "history" })}
              />
            </div>
          ) : null}

          {showPage && tab ? (
            <div className="tab-view">
              <PageSlot>
                <div className="page-preview">
                  <Empty icon="globe" title={tab.title || tab.host}>
                    In the Mac app, {tab.host} shows right here. The agent works in it, Record turns what you do into a skill, and replays run in it without touching your mouse.
                  </Empty>
                </div>
              </PageSlot>
              <AnimatePresence initial={false}>
                {assistantOpen ? <AssistantPanel key={tab.id} tab={tab} onClose={toggleAssistant} onOpenTab={openTab} /> : null}
              </AnimatePresence>
            </div>
          ) : null}

          {view.kind === "chat" ? (
            thread ? (
              <ChatView key={thread.id} thread={thread} runs={threadRuns} onOpenTab={openTab} onAsked={(id) => setView({ kind: "chat", id })} />
            ) : (
              <div className="card-scroll">
                <Empty icon="chat" title="This chat is gone">
                  It was deleted or archived. Find it again in History.
                </Empty>
              </div>
            )
          ) : null}

          {view.kind === "page" ? (
            <div className="card-scroll page-host" key={view.page}>
              <div className="page-inner">
                {view.page === "runs" ? (
                  <ComputerPage />
                ) : view.page === "history" ? (
                  <HistoryPage go={go} onOpenThread={(id) => setView({ kind: "chat", id })} />
                ) : view.page === "memory" ? (
                  <MemoryPage />
                ) : view.page === "skills" ? (
                  <SkillsPage />
                ) : view.page === "settings" ? (
                  <SettingsPage />
                ) : view.page === "vault" ? (
                  <VaultPage go={go} />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={setView} onOpenTab={openTab} onOpenURL={openURL} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/** Computer: the runs on your Mac, and the live view while okidoki is driving. */
function ComputerPage() {
  const { state } = useDashboard();
  const driving = Boolean(state.live?.active);
  const [tab, setTab] = useState<"runs" | "live">(driving ? "live" : "runs");
  useEffect(() => {
    if (driving) setTab("live");
  }, [driving]);
  const hasLive = driving || Boolean(state.live?.steps?.length);
  return (
    <>
      {hasLive ? (
        <div className="page-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "runs"} className={cx(tab === "runs" && "is-on")} onClick={() => setTab("runs")}>
            Runs
          </button>
          <button type="button" role="tab" aria-selected={tab === "live"} className={cx(tab === "live" && "is-on")} onClick={() => setTab("live")}>
            {driving ? <span className="pulse-dot" aria-hidden="true" /> : <PixelIcon name="eye" size={13} />}
            Live
          </button>
        </div>
      ) : null}
      {tab === "live" && hasLive ? <LivePage /> : <RunsPage />}
    </>
  );
}
