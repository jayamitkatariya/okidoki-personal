import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import type { AccountKind } from "../types";
import {
  Avatar,
  Button,
  isComposing,
  KeyHint,
  Logo,
  Modal,
  PixelIcon,
  Segmented,
  TextField,
  ThemeToggle,
  ToastStack,
} from "./ui";

export type Page =
  | "home"
  | "runs"
  | "history"
  | "memory"
  | "skills"
  | "toolbox"
  | "keys"
  | "settings";

const NAV: { label: string; items: { id: Page; title: string; icon: string }[] }[] = [
  {
    label: "workspace",
    items: [
      { id: "home", title: "Home", icon: "home" },
      { id: "runs", title: "Runs", icon: "runs" },
      { id: "history", title: "History", icon: "clock" },
      { id: "memory", title: "Memory", icon: "memory" },
      { id: "skills", title: "Skills & routines", icon: "wand" },
    ],
  },
  {
    label: "configure",
    items: [
      { id: "toolbox", title: "Toolbox", icon: "grid" },
      { id: "keys", title: "Keys", icon: "key" },
      { id: "settings", title: "Settings", icon: "gear" },
    ],
  },
];

const SECTION_META: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Home", subtitle: "What needs you, and what's moving" },
  runs: { title: "Runs", subtitle: "Live work and action previews" },
  history: { title: "History", subtitle: "Threads and past requests" },
  memory: { title: "Memory", subtitle: "What okidoki knows about you" },
  skills: { title: "Skills & routines", subtitle: "Learned skills and repeating tasks" },
  toolbox: { title: "Toolbox", subtitle: "Free tools, agents and Apple apps" },
  keys: { title: "Keys", subtitle: "Your API keys, kept in the Keychain" },
  settings: { title: "Settings", subtitle: "Input, voice, permissions, look" },
};

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
  const { state, settings, account, invoke, updateSettings, toasts, dismissToast, convexConnected, native } = useDashboard();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteAsk, setPaletteAsk] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [addAccount, setAddAccount] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // each page starts at the top, not wherever the last one was scrolled to
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteAsk(false);
        setPaletteOpen(true);
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
      setPaletteAsk(true);
      setPaletteOpen(true);
      setAskOpen(false);
    }
  }, [askOpen, setAskOpen]);

  useEffect(() => {
    (window as unknown as { okidokiOpenAsk?: () => void }).okidokiOpenAsk = () => {
      setPaletteAsk(true);
      setPaletteOpen(true);
    };
    (window as unknown as { okidokiNavigate?: (page: string) => void }).okidokiNavigate = (next: string) => {
      setPage(next as Page);
    };
  }, [setPage]);

  const waiting = state.runs.filter((run) => run.status === "waiting" || run.status === "previewing").length;
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
            : ["Ready · shake to summon", ""];

  const runBadge = (id: Page): number => {
    if (id === "home") return waiting;
    if (id === "runs") return live;
    return 0;
  };

  const openAsk = () => {
    setPaletteAsk(true);
    setPaletteOpen(true);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={30} glow />
          <div className="brand-text">
            <span className="brand-name">okidoki</span>
            <span className={cx("brand-status", tone)}>
              <i />
              {status}
            </span>
          </div>
          <ThemeToggle onToggle={(next) => updateSettings({ appearance: next })} />
        </div>

        <button className="side-ask" onClick={openAsk}>
          <PixelIcon name="search" size={15} />
          <span>Ask okidoki</span>
          <KeyHint>⌘K</KeyHint>
        </button>

        <nav className="nav">
          {NAV.map((group) => (
            <div className="nav-group" key={group.label}>
              {group.items.map((item) => {
                const badge = runBadge(item.id);
                return (
                  <button
                    key={item.id}
                    className={cx("nav-item", page === item.id && "nav-active")}
                    onClick={() => setPage(item.id)}
                    aria-current={page === item.id ? "page" : undefined}
                  >
                    <PixelIcon name={item.icon} size={17} />
                    <span>{item.title}</span>
                    {badge > 0 ? <em className={cx("nav-badge", item.id === "home" && "nav-badge-hot")}>{badge}</em> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="account-wrap" ref={accountRef}>
            <button className={cx("account", accountOpen && "is-open")} onClick={() => setAccountOpen((value) => !value)}>
              <Avatar account={account} size={30} />
              <span className="account-text">
                <strong>{account.name}</strong>
                <em>{account.kind}</em>
              </span>
              <PixelIcon name="dots" size={16} />
            </button>
            <AnimatePresence>
              {accountOpen ? (
                <motion.div
                  className="account-pop"
                  initial={{ opacity: 0, y: 6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 460, damping: 34 }}
                >
                  <div className="pop-label">Accounts</div>
                  {state.accounts.map((item) => (
                    <button
                      key={item.id}
                      className={cx("pop-account", item.id === state.currentAccountID && "is-current")}
                      onClick={() => {
                        invoke("switchAccount", { id: item.id });
                        setAccountOpen(false);
                      }}
                    >
                      <Avatar account={item} size={26} />
                      <span>
                        <strong>{item.name}</strong>
                        <em>{item.email || item.kind}</em>
                      </span>
                      {item.id === state.currentAccountID ? <PixelIcon name="check" size={15} /> : null}
                    </button>
                  ))}
                  <button
                    className="pop-action"
                    onClick={() => {
                      setAccountOpen(false);
                      setAddAccount(true);
                    }}
                  >
                    <PixelIcon name="plus" size={15} /> Add account
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
                      setAccountOpen(false);
                    }}
                  >
                    <PixelIcon name="gear" size={15} /> Settings
                  </button>
                  <button
                    className="pop-action pop-danger"
                    onClick={() => {
                      invoke("signOut");
                      setAccountOpen(false);
                    }}
                  >
                    <PixelIcon name="logout" size={15} /> Sign out
                  </button>
                  <div className="pop-sep" />
                  <div className={cx("pop-sync", convexConnected ? "is-live" : native ? "is-local" : "")}>
                    <i />
                    {convexConnected ? "Synced with Convex" : native ? "Saved on this Mac" : "Browser preview"}
                    <span className="spacer" />v{state.version}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </aside>

      <main className="main">
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
        askFirst={paletteAsk}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(next) => {
          setPage(next);
          setPaletteOpen(false);
        }}
      />

      <AddAccountModal open={addAccount} onClose={() => setAddAccount(false)} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function CommandPalette({
  open,
  askFirst,
  onClose,
  onNavigate,
}: {
  open: boolean;
  askFirst: boolean;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}) {
  const { state, invoke, notify } = useDashboard();
  const [query, setQuery] = useState("");
  const [askMode, setAskMode] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sections = useMemo(
    () =>
      NAV.flatMap((group) => group.items).filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query.toLowerCase()) ||
          SECTION_META[item.id].subtitle.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );

  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setAskMode(askFirst);
    setIndex(0);
    inputRef.current?.focus();
  }, [open, askFirst]);

  const examples = [
    "What's on my screen?",
    "Summarize the PDF on my desktop",
    "Teach me auto layout in Figma",
    "My Mac is out of space",
    "Remind me to call Mom at 6",
  ];

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
    const target = sections[index] ?? sections[0];
    if (target) {
      onNavigate(target.id);
      return;
    }
    if (trimmed) ask(trimmed);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="palette-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="palette"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
          >
            <div className="palette-input">
              <PixelIcon name={askMode ? "spark" : "search"} size={18} />
              <input
                ref={inputRef}
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
                    setIndex((value) => Math.min(sections.length - 1, value + 1));
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
                {query ? (
                  <button className="palette-row ask" onClick={() => ask(query.trim())}>
                    <PixelIcon name="spark" size={17} />
                    <span>
                      <strong>Ask okidoki “{query.trim()}”</strong>
                      <em>Answer, do, or teach</em>
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
    </AnimatePresence>
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

function AddAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { invoke, notify } = useDashboard();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<AccountKind>("personal");

  useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setKind("personal");
    }
  }, [open]);

  const create = () => {
    const finalName = name.trim() || "You";
    invoke("createAccount", { name: finalName, email: email.trim(), kind });
    notify("Account added", finalName);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add an account" subtitle="Each account keeps its own threads and memory." width={420}>
      <AccountFields name={name} setName={setName} email={email} setEmail={setEmail} kind={kind} setKind={setKind} autoFocus />
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={create}>
          Add account
        </Button>
      </footer>
    </Modal>
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
          Stays on this Mac. Turn on sync anytime in Keys.
        </div>
      </div>
    </div>
  );
}
