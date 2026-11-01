import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { groupOf, jumpToSettingsSection, navFor, ON_DEMAND, pageAvailable, resolveRoute, SECTION_META, SETTINGS_ITEM, type NavGroup, type NavItem, type Page } from "../nav";
import type { AccountKind } from "../types";
import { useDialog } from "./useDialog";
import {
  Avatar,
  Button,
  isComposing,
  KeyHint,
  Logo,
  PixelIcon,
  Segmented,
  TextField,
  ThemeToggle,
  ToastStack,
} from "./ui";

export type { Page };

const SIDEBAR_KEY = "okidoki.sidebar";
const NARROW_QUERY = "(max-width: 760px)";

export function AppShell({
  page,
  setPage,
  askOpen,
  setAskOpen,
  children,
}: {
  page: Page;
  setPage: (page: Page) => void;
  askOpen: boolean;
  setAskOpen: (value: boolean) => void;
  children: React.ReactNode;
}) {
  const { state, settings, account, invoke, updateSettings, toasts, dismissToast, native } = useDashboard();
  const nav = useMemo(() => navFor(account.kind), [account.kind]);
  // the palette can jump anywhere, including the pinned Settings row
  const paletteNav = useMemo(() => [...nav, { label: "setup", items: [SETTINGS_ITEM] }], [nav]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteAsk, setPaletteAsk] = useState(false);
  const [palettePrompt, setPalettePrompt] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // the rail starts closed; opening it is remembered, and narrow windows force it closed
  const [expanded, setExpanded] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "open");
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const collapsed = !expanded || narrow;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, expanded ? "open" : "closed");
  }, [expanded]);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // each page starts at the top, not wherever the last one was scrolled to
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // the current page stays in view on a rail too short to show every item
  useEffect(() => {
    navRef.current?.querySelector(".nav-active")?.scrollIntoView({ block: "nearest" });
  }, [page, collapsed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteAsk(false);
        setPalettePrompt("");
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setExpanded((value) => !value);
      }
      if (event.key === "Escape") setAccountOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [accountOpen]);

  useEffect(() => {
    if (askOpen) {
      setPalettePrompt("");
      setPaletteAsk(true);
      setPaletteOpen(true);
      setAskOpen(false);
    }
  }, [askOpen, setAskOpen]);

  useEffect(() => {
    const bridge = window as unknown as { okidokiOpenAsk?: (prompt?: string) => void; okidokiNavigate?: (page: string) => void };
    bridge.okidokiOpenAsk = (prompt = "") => {
      setPalettePrompt(prompt);
      setPaletteAsk(true);
      setPaletteOpen(true);
    };
    bridge.okidokiNavigate = (next: string) => {
      const route = resolveRoute(next);
      if (pageAvailable(route.page as Page, account.kind)) setPage(route.page as Page);
      if (route.section) jumpToSettingsSection(route.section);
    };
    return () => {
      delete bridge.okidokiOpenAsk;
      delete bridge.okidokiNavigate;
    };
  }, [setPage, account.kind]);

  // A page that isn't in the sidebar (an old deep link) lands on Home, never on a blank page.
  useEffect(() => {
    if (!pageAvailable(page, account.kind)) setPage("home");
  }, [page, account.kind, setPage]);

  const waiting = state.runs.filter((run) => run.status === "waiting" || run.status === "previewing" || run.status === "asked").length;
  const live = state.runs.filter((run) => run.status === "running" || run.status === "paused").length;
  const [status, tone] = state.inCall
    ? ["Quiet during your call", "is-quiet"]
    : settings.quietMode
      ? ["Quiet mode", "is-quiet"]
      : !settings.okidokiEnabled
        ? ["Paused", "is-off"]
        : waiting
          ? [`${waiting} waiting for you`, "is-waiting"]
          : live
            ? [`${live} working`, ""]
            : ["Ready when you are", ""];

  const runBadge = (id: Page): number => {
    if (id === "home") return waiting;
    if (id === "runs") return live;
    return 0;
  };
  // Live is empty unless okidoki is driving, so its row only shows up then (or while you're on it)
  const showItem = (id: Page) => !ON_DEMAND.has(id) || id === page || Boolean(state.live?.active || state.live?.steps?.length);
  const crumbRoot = groupOf(page).replace(/^./, (letter) => letter.toUpperCase());
  const navButton = (item: NavItem) => {
    const badge = runBadge(item.id);
    return (
      <button
        key={item.id}
        className={cx("nav-item", page === item.id && "nav-active")}
        onClick={() => setPage(item.id)}
        aria-current={page === item.id ? "page" : undefined}
        aria-label={badge ? `${item.title}, ${badge}` : item.title}
        data-tip={badge ? `${item.title} · ${badge}` : item.title}
      >
        <PixelIcon name={item.icon} size={17} />
        <span>{item.title}</span>
        {item.id === "live" && state.live?.active ? <em className="nav-badge nav-badge-hot">live</em> : null}
        {badge > 0 ? <em className={cx("nav-badge", item.id === "home" && "nav-badge-hot")}>{badge}</em> : null}
      </button>
    );
  };

  const openAsk = () => {
    setPalettePrompt("");
    setPaletteAsk(true);
    setPaletteOpen(true);
  };

  return (
    <div className={cx("app", collapsed && "is-collapsed")}>
      <aside id="sidebar" ref={railRef} className={cx("sidebar", collapsed && "is-collapsed")} aria-label="Workspace navigation">
        <div className="brand">
          <button
            className={cx("brand-mark", tone)}
            onClick={() => setPage("home")}
            aria-label={`okidoki — ${status}`}
            data-tip={status}
          >
            <Logo size={30} />
            <i aria-hidden="true" />
          </button>
          <div className="brand-text">
            <span className="brand-name">okidoki</span>
            <span className={cx("brand-status", tone)} title={status}>
              <i />
              <span>{status}</span>
            </span>
          </div>
          <ThemeToggle onToggle={(next) => updateSettings({ appearance: next })} />
        </div>

        <div className="account-wrap workspace-switcher" ref={accountRef}>
          <button
            className={cx("account", accountOpen && "is-open")}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            aria-label="Profile"
            data-tip={account.name}
            onClick={() => setAccountOpen((value) => !value)}
          >
            <Avatar account={account} size={28} />
            <span className="account-text">
              <strong>{account.name}</strong>
              <em>Local</em>
            </span>
            <PixelIcon name="chevron" size={15} className="account-chevron" />
          </button>
          <AnimatePresence>
            {accountOpen ? (
              <motion.div
                className="account-pop"
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 460, damping: 34 }}
              >
                <div className="pop-label">{account.email || account.name}</div>
                <button
                  className="pop-action"
                  onClick={() => {
                    setPage("settings");
                    jumpToSettingsSection("account");
                    setAccountOpen(false);
                  }}
                >
                  <PixelIcon name="user" size={15} /> Edit profile
                </button>
                <div className="pop-sep" />
                <button
                  className="pop-action"
                  onClick={() => {
                    setAccountOpen(false);
                    invoke("openOnboarding");
                  }}
                >
                  <PixelIcon name="spark" size={15} /> Replay onboarding
                </button>
                <button
                  className="pop-action"
                  onClick={() => {
                    setPage("settings");
                    jumpToSettingsSection("keys");
                    setAccountOpen(false);
                  }}
                >
                  <PixelIcon name="key" size={15} /> API keys
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <button className="side-ask" aria-label="Search or ask okidoki" data-tip="Search or ask · ⌘K" onClick={openAsk}>
          <PixelIcon name="search" size={15} />
          <span>Search or ask</span>
          <KeyHint>⌘K</KeyHint>
        </button>

        <nav className="nav" ref={navRef} aria-label="Main navigation">
          {nav.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.filter((item) => showItem(item.id)).map(navButton)}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          {navButton(SETTINGS_ITEM)}
          <div
            className={cx("sidebar-foot", native ? "is-local" : "")}
            data-tip={`${native ? "Saved on this Mac" : "Browser preview"}${state.version ? ` · v${state.version}` : ""}`}
          >
            <i />
            <span>{native ? "Saved on this Mac" : "Browser preview"}</span>
            <span className="spacer" />
            {state.version ? <span>v{state.version}</span> : null}
          </div>
        </div>
      </aside>
      <RailTip rail={railRef} enabled={collapsed} />

      <main className="main">
        <header className="workspace-bar">
          <div className="workspace-lead">
            <button
              className="bar-toggle"
              onClick={() => setExpanded((value) => !value)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="sidebar"
              title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
              disabled={narrow}
            >
              <PixelIcon name="panel" size={15} />
            </button>
            <span className="workspace-breadcrumb">
              {crumbRoot} <PixelIcon name="chevron" size={12} /> <strong>{SECTION_META[page].title}</strong>
            </span>
          </div>
          <div className="workspace-actions">
            <span className="workspace-local">
              <PixelIcon name="lock" size={12} />
              {native ? "On your Mac" : "Preview"}
            </span>
            <button className="bar-ask" onClick={openAsk} aria-label="Ask okidoki">
              <PixelIcon name="spark" size={14} />
              <span>Ask</span>
            </button>
            <button
              className={cx("bar-bell", waiting > 0 && "is-hot")}
              onClick={() => setPage("runs")}
              aria-label={waiting > 0 ? `${waiting} waiting for you` : "No notifications"}
              title={waiting > 0 ? `${waiting} waiting for you` : "Nothing waiting"}
            >
              <PixelIcon name="bell" size={15} />
            </button>
          </div>
        </header>
        <div className="content" ref={contentRef}>
          {/* the next page fades straight in: no exit wait, so navigation never lags a beat */}
          <motion.div
            key={page}
            className="page"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          >
            {children}
          </motion.div>
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        nav={paletteNav}
        askFirst={paletteAsk}
        initialQuery={palettePrompt}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(next) => {
          setPage(next);
          setPaletteOpen(false);
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/** The collapsed rail's labels. One tip floats above the page, so the scrolling icon column can't clip it. */
function RailTip({ rail, enabled }: { rail: React.RefObject<HTMLElement | null>; enabled: boolean }) {
  const [tip, setTip] = useState({ text: "", x: 0, y: 0, on: false });

  useEffect(() => {
    const root = rail.current;
    if (!root || !enabled) return;
    let shown: HTMLElement | null = null;
    // a click puts the tip away until the pointer moves on to another item
    let dismissed: HTMLElement | null = null;
    const hideTip = () => setTip((current) => (current.on ? { ...current, on: false } : current));
    const show = (target: HTMLElement | null) => {
      if (target === shown) return;
      shown = target;
      // an open menu speaks for itself, and a tip must not float over it
      if (!target || target.getAttribute("aria-expanded") === "true" || root.querySelector('[aria-expanded="true"]')) return hideTip();
      const rect = target.getBoundingClientRect();
      setTip({ text: target.dataset.tip ?? "", x: rect.right + 12, y: rect.top + rect.height / 2, on: true });
    };
    const tipOf = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null);
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tipOf(event.target);
      if (target && target === dismissed) return;
      dismissed = null;
      show(target);
    };
    const onDown = (event: PointerEvent) => {
      dismissed = tipOf(event.target);
      show(null);
    };
    const onFocus = (event: FocusEvent) => {
      const target = tipOf(event.target);
      if (target?.matches(":focus-visible")) show(target);
    };
    const hide = () => show(null);
    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerleave", hide);
    root.addEventListener("focusin", onFocus);
    root.addEventListener("focusout", hide);
    root.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerleave", hide);
      root.removeEventListener("focusin", onFocus);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      hideTip();
    };
  }, [rail, enabled]);

  if (!enabled) return null;
  return createPortal(
    <div className={cx("rail-tip", tip.on && "is-on")} style={{ left: tip.x, top: tip.y }} aria-hidden="true">
      {tip.text}
    </div>,
    document.body,
  );
}

function CommandPalette({
  open,
  nav,
  askFirst,
  initialQuery,
  onClose,
  onNavigate,
}: {
  open: boolean;
  nav: NavGroup[];
  askFirst: boolean;
  initialQuery: string;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}) {
  const { invoke, notify } = useDashboard();
  const [query, setQuery] = useState("");
  const [askMode, setAskMode] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog(open, onClose);

  const sections = useMemo(
    () =>
      nav.flatMap((group) => group.items).filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query.toLowerCase()) ||
          SECTION_META[item.id].subtitle.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, nav],
  );

  useLayoutEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setAskMode(askFirst);
    setIndex(0);
    inputRef.current?.focus();
  }, [open, askFirst, initialQuery]);

  const examples = [
    "What's on my screen?",
    "Summarize the PDF on my desktop",
    "Find the cheapest flight to Chicago",
    "My Mac is out of space",
    "Clean up my desktop",
  ];

  useEffect(() => {
    if (open && !askMode) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, askMode, index, query]);

  const ask = (text: string) => {
    invoke("ask", { text });
    notify("Asked okidoki", text);
    onClose();
  };

  const submit = () => {
    const trimmed = query.trim();
    if (askMode) {
      if (trimmed) ask(trimmed);
      return;
    }
    const target = sections[index];
    if (target) {
      onNavigate(target.id);
      return;
    }
    if (trimmed) ask(trimmed);
  };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div className="palette-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}>
          <motion.div
            ref={dialogRef}
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label={askMode ? "Ask okidoki" : "Search the workspace"}
            tabIndex={-1}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
          >
            <div className="palette-input">
              <PixelIcon name={askMode ? "spark" : "search"} size={18} />
              <input
                ref={inputRef}
                aria-label={askMode ? "Your request" : "Search pages"}
                autoFocus
                value={query}
                placeholder={askMode ? "Ask, do, or learn anything…" : "Search pages or ask…"}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !isComposing(event)) submit();
                  if (event.key === "Escape" && !isComposing(event)) {
                    // keep a page modal underneath open
                    event.preventDefault();
                    onClose();
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setIndex((value) => Math.max(0, Math.min(sections.length + (query.trim() ? 1 : 0) - 1, value + 1)));
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setIndex((value) => Math.max(0, value - 1));
                  }
                }}
              />
              <span className="mode-chip">{askMode ? "Ask" : "Go to"}</span>
            </div>
            {askMode ? (
              <div className="palette-body">
                <div className="palette-label">
                  <span>Try</span>
                </div>
                {examples.map((example) => (
                  <button
                    key={example}
                    className="palette-row example"
                    onClick={() => ask(example)}
                  >
                    <PixelIcon name="spark" size={15} />
                    <span>{example}</span>
                    <PixelIcon name="arrow" size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="palette-body">
                {sections.map((item, itemIndex) => (
                  <button
                    key={item.id}
                    ref={itemIndex === index ? selectedRef : undefined}
                    className={cx("palette-row", itemIndex === index && "is-selected")}
                    onMouseEnter={() => setIndex(itemIndex)}
                    onClick={() => onNavigate(item.id)}
                  >
                    <PixelIcon name={item.icon} size={17} />
                    <span>
                      <strong>{item.title}</strong>
                      <em>{SECTION_META[item.id].subtitle}</em>
                    </span>
                    {itemIndex === index ? <span className="palette-enter">↵</span> : null}
                  </button>
                ))}
                {query.trim() ? (
                  <button ref={index === sections.length ? selectedRef : undefined} className={cx("palette-row ask", index === sections.length && "is-selected")} onMouseEnter={() => setIndex(sections.length)} onClick={() => ask(query.trim())}>
                    <PixelIcon name="spark" size={17} />
                    <span>
                      <strong>Ask okidoki “{query.trim()}”</strong>
                      <em>Answer or do</em>
                    </span>
                  </button>
                ) : null}
              </div>
            )}
            <footer className="palette-foot">
              <span>
                <KeyHint>↑↓</KeyHint> move
              </span>
              <span>
                <KeyHint>↵</KeyHint> {askMode ? "ask" : "open"}
              </span>
              <span>
                <KeyHint>esc</KeyHint> close
              </span>
              <button onClick={() => setAskMode((value) => !value)}>{askMode ? "Go to a page" : "Ask okidoki"}</button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function AccountFields({
  name,
  setName,
  email,
  setEmail,
  kind,
  setKind,
  autoFocus,
}: {
  name: string;
  setName: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  kind: AccountKind;
  setKind: (value: AccountKind) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="form-stack">
      <label className="form-label">Name</label>
      <TextField value={name} onChange={setName} placeholder="Your name" autoFocus={autoFocus} />
      <label className="form-label">Email</label>
      <TextField value={email} onChange={setEmail} placeholder="you@example.com" type="email" />
      <div className="form-inline">
        <span className="form-label">Type</span>
        <Segmented
          options={[
            { value: "personal", label: "Personal" },
            { value: "work", label: "Work" },
          ]}
          value={kind}
          onChange={(value) => setKind(value as AccountKind)}
        />
      </div>
    </div>
  );
}

export function AuthGate() {
  const { state, invoke, notify } = useDashboard();
  const [mode, setMode] = useState<"signin" | "create">(state.accounts.length ? "signin" : "create");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<AccountKind>("personal");

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={44} glow />
          <h1>{mode === "signin" ? "Welcome back" : "Make it yours"}</h1>
          <p>{mode === "signin" ? "Pick an account to continue." : "One account per context. Work stays at work."}</p>
        </div>
        {mode === "signin" ? (
          <>
            <div className="auth-accounts">
              {state.accounts.map((account) => (
                <button
                  key={account.id}
                  className="auth-account"
                  onClick={() => {
                    invoke("signIn", { id: account.id });
                    notify("Welcome back", account.name);
                  }}
                >
                  <Avatar account={account} size={34} />
                  <span>
                    <strong>{account.name}</strong>
                    <em>{account.email || account.kind}</em>
                  </span>
                  <PixelIcon name="chevron" size={16} />
                </button>
              ))}
            </div>
            <button className="auth-link" onClick={() => setMode("create")}>
              Create a new account
            </button>
          </>
        ) : (
          <>
            <AccountFields name={name} setName={setName} email={email} setEmail={setEmail} kind={kind} setKind={setKind} autoFocus />
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                const finalName = name.trim() || "You";
                invoke("createAccount", { name: finalName, email: email.trim(), kind });
                notify("Account created", finalName);
              }}
            >
              Create account
            </Button>
            {state.accounts.length ? (
              <button className="auth-link" onClick={() => setMode("signin")}>
                Use an existing account
              </button>
            ) : null}
          </>
        )}
        <div className="auth-note">
          <PixelIcon name="lock" size={13} />
          Stays on this Mac. Nothing leaves it unless you ask a model.
        </div>
      </div>
    </div>
  );
}
