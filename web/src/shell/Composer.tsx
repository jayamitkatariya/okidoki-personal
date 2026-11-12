import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { isComposing, PixelIcon, Switch } from "../components/ui";
import { hasNativeBridge } from "../bridge";
import type { Settings } from "../types";
import { MenuItem, Popover } from "./Popover";
import { followAsk, nextAskRef } from "./ask";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover as KPopover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Favicon } from "./media";
import { looksLikeAddress, looksLikeTask, siteLabel } from "./model";

export type ComposerMode = "search" | "ask";
type Where = NonNullable<Settings["summonMode"]>;

export const WHERE: Array<{ value: Where; label: string; icon: string; detail: string }> = [
  { value: "auto", label: "Auto", icon: "spark", detail: "okidoki picks: answer, browser or your Mac" },
  { value: "browser", label: "Browser", icon: "globe", detail: "Works in a tab of okidoki's browser" },
  { value: "act", label: "Mac", icon: "screen", detail: "Drives apps on your Mac" },
  { value: "chat", label: "Chat", icon: "chat", detail: "Just answers, never acts" },
];

export const MODELS = [
  { value: "claude-haiku-5-5", label: "Haiku 5.5", detail: "Fastest" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", detail: "Balanced" },
  { value: "claude-opus-5-5", label: "Opus 5.5", detail: "Most capable" },
];

export const PACE = [
  { value: "fast", label: "Fast", detail: "The pointer moves quickly" },
  { value: "calm", label: "Careful", detail: "Glides, so you can follow along" },
] as const;

interface Mention {
  id: string;
  kind: "tab" | "skill" | "memory" | "file";
  label: string;
  /** What rides along with the request. */
  context: string;
  icon: React.ReactNode;
}



/**
 * The one place to ask okidoki anything. Home has the full composer (Search or Ask, and the chips),
 * a chat has it docked under the conversation, and a tab's assistant panel asks in that tab.
 */
export function Composer({
  variant,
  threadID,
  tabID,
  autoFocus,
  focusTick,
  onAsked,
  onSearched,
  placeholder,
}: {
  variant: "home" | "dock" | "panel";
  threadID?: string;
  tabID?: string;
  autoFocus?: boolean;
  /** Bumped by the shell (⌘L on Home) to put the cursor here. */
  focusTick?: number;
  onAsked?: (threadID: string) => void;
  onSearched?: () => void;
  placeholder?: string;
}) {
  const { state, settings, updateSettings, invoke, notify } = useDashboard();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("ask");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [pending, setPending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    if (focusTick) input.current?.focus();
  }, [focusTick]);

  // Grow with the text, up to six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, 6 * line + 4)}px`;
  }, [text]);

  // Stop following a request's reply when this box goes away; a late reply then offers itself in a toast.
  const stopFollowing = useRef<(() => void) | null>(null);
  const onAskedRef = useRef(onAsked);
  onAskedRef.current = onAsked;

  const tabs = state.browser?.tabs ?? [];
  const candidates = useMemo<Mention[]>(() => {
    const list: Mention[] = [
      ...tabs
        .filter((tab) => !tab.blank)
        .map((tab) => ({
          id: `tab-${tab.id}`,
          kind: "tab" as const,
          label: siteLabel(tab.title, tab.address),
          context: `the tab “${siteLabel(tab.title, tab.address)}” (${tab.address})`,
          icon: <Favicon host={tab.host} size={15} />,
        })),
      ...(state.skills ?? []).map((skill) => ({
        id: `skill-${skill.id}`,
        kind: "skill" as const,
        label: skill.name,
        context: `my skill “${skill.name}”`,
        icon: <PixelIcon name="repeat" size={15} />,
      })),
      ...(state.vault?.files ?? []).slice(0, 40).map((file) => ({
        id: `file-${file.id}`,
        kind: "file" as const,
        label: file.name,
        context: `the vault document “${file.id}”`,
        icon: <PixelIcon name="note" size={15} />,
      })),
      ...(state.memories ?? []).map((memory) => ({
        id: `mem-${memory.id}`,
        kind: "memory" as const,
        label: memory.text,
        context: `what I told you: “${memory.text}”`,
        icon: <PixelIcon name="memory" size={15} />,
      })),
    ];
    return list.filter((item) => !mentions.some((chosen) => chosen.id === item.id));
  }, [tabs, state.skills, state.vault?.files, state.memories, mentions]);

  const matches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return candidates.filter((item) => !q || item.label.toLowerCase().includes(q)).slice(0, 8);
  }, [candidates, mentionQuery]);

  const updateText = (value: string) => {
    setText(value);
    const caret = input.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const at = before.match(/(?:^|\s)@([^\s@]{0,30})$/);
    setMentionQuery(at ? at[1] : null);
    setMentionIndex(0);
  };

  const pick = (item: Mention) => {
    const caret = input.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, "");
    setText(before + text.slice(caret));
    setMentions((current) => [...current, item]);
    setMentionQuery(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const trimmed = text.trim();
  // Only Home's box doubles as an address bar. In a chat or a tab's panel, "jay@example.com" or
  // "README.md" is a reply, never a page to load over the one in front.
  const opensSite = variant === "home" && trimmed !== "" && looksLikeAddress(trimmed);
  const effective: ComposerMode = variant === "home" ? mode : "ask";

  const submit = () => {
    if (!trimmed || pending) return;
    // A site typed into Ask is still a site: open it rather than send the agent to it.
    if (effective === "search" || (opensSite && mentions.length === 0)) {
      invoke("browserGo", { text: trimmed, choice: opensSite ? "open" : "search", newTab: variant === "home", tabID: variant === "panel" ? tabID : undefined });
      setText("");
      onSearched?.();
      return;
    }
    const context = mentions.length ? `\n\n(context: ${mentions.map((item) => item.context).join("; ")})` : "";
    const ref = nextAskRef();
    const where = variant === "panel" ? "tab" : settings.summonMode ?? "auto";
    invoke("shellAsk", { text: trimmed + context, mode: where, threadID, tabID, ref });
    setText("");
    setMentions([]);
    if (!hasNativeBridge()) {
      notify("Asked okidoki", trimmed);
      return;
    }
    pendingRef.current = ref;
    setPending(true);
    stopFollowing.current?.();
    stopFollowing.current = followAsk(
      ref,
      (thread) => onAskedRef.current?.(thread),
      () => {
        if (pendingRef.current === ref) {
          pendingRef.current = null;
          setPending(false);
        }
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return;
    if (mentionQuery !== null && matches.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(matches[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    // Tab flips Search/Ask only while there's something typed; an empty box lets focus move on.
    if (event.key === "Tab" && variant === "home" && !event.shiftKey && text.trim() !== "") {
      event.preventDefault();
      setMode((value) => (value === "ask" ? "search" : "ask"));
      return;
    }
    if (event.key === "Backspace" && !text && mentions.length) {
      setMentions((current) => current.slice(0, -1));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const hint = !trimmed
    ? null
    : effective === "search"
      ? opensSite
        ? "Open site"
        : "Search"
      : opensSite && !mentions.length
        ? "Open site"
        : variant === "panel"
          ? "Do it in this tab"
          : looksLikeTask(trimmed) && (settings.summonMode ?? "auto") === "chat"
            ? "Answer only"
            : "Ask";

  const defaultPlaceholder =
    variant === "panel"
      ? "Ask or do something on this page"
      : variant === "dock"
        ? "Reply, or ask something new"
        : effective === "search"
          ? "Search the web or type a URL"
          : "Ask okidoki a task, @ for context";

  return (
    <div className={cx("composer", `composer-${variant}`, pending && "is-pending")}>
      <div className="composer-box" ref={box}>
        {mentions.length ? (
          <div className="composer-mentions">
            {mentions.map((item) => (
              <span key={item.id} className="mention-chip">
                {item.icon}
                <span>{item.label}</span>
                <button type="button" aria-label={`Remove ${item.label}`} onClick={() => setMentions((current) => current.filter((m) => m.id !== item.id))}>
                  <PixelIcon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          {variant !== "home" ? <AttachButton onPick={(item) => setMentions((current) => [...current, item])} candidates={candidates} compact /> : null}
          <textarea
            ref={input}
            rows={1}
            value={text}
            aria-label={placeholder ?? defaultPlaceholder}
            placeholder={placeholder ?? defaultPlaceholder}
            onChange={(event) => updateText(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={effective === "ask"}
          />
          {hint && variant === "home" ? <span className="composer-hint">{hint} <kbd>↵</kbd></span> : null}
          {variant === "home" ? (
            <div
              className="mode-switch"
              role="radiogroup"
              aria-label="Search or ask"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const next = mode === "search" ? "ask" : "search";
                setMode(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
              }}
            >
              {(["search", "ask"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  data-mode={value}
                  aria-checked={mode === value}
                  tabIndex={mode === value ? 0 : -1}
                  className={cx(mode === value && "is-on")}
                  onClick={() => {
                    setMode(value);
                    input.current?.focus();
                  }}
                >
                  {value === "search" ? "Search" : "Ask"}
                  {mode === value ? <motion.span layoutId="mode-thumb" className="mode-thumb" transition={{ type: "spring", duration: 0.3, bounce: 0 }} /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {(
            <button
              type="button"
              className="send"
              aria-label={effective === "search" || opensSite ? "Go" : "Send"}
              aria-busy={pending}
              onClick={submit}
              disabled={!trimmed && !pending}
              data-ready={trimmed ? "" : undefined}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {pending ? (
                  <motion.span key="spin" className="send-glyph" initial={{ rotateX: -90, opacity: 0 }} animate={{ rotateX: 0, opacity: 1 }} exit={{ rotateX: 90, opacity: 0 }} transition={{ type: "spring", duration: 0.3, bounce: 0 }}>
                    <span className="spin" />
                  </motion.span>
                ) : (
                  <motion.span key="arrow" className="send-glyph" initial={{ rotateX: -90, opacity: 0 }} animate={{ rotateX: 0, opacity: 1 }} exit={{ rotateX: 90, opacity: 0 }} transition={{ type: "spring", duration: 0.3, bounce: 0 }}>
                    <PixelIcon name="arrow" size={15} />
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          )}
        </div>
        <MentionList anchor={box} open={mentionQuery !== null && matches.length > 0} items={matches} index={mentionIndex} onPick={pick} onHover={setMentionIndex} onClose={() => setMentionQuery(null)} side={variant === "home" ? "bottom" : "top"} />
      </div>
      {variant === "home" ? (
        <div className="composer-chips">
          <AttachButton onPick={(item) => setMentions((current) => [...current, item])} candidates={candidates} />
          <WhereChip value={settings.summonMode ?? "auto"} target={settings.computerTarget} onChange={(value) => updateSettings({ summonMode: value })} />
          <GuardChip settings={settings} onChange={updateSettings} />
          <span className="chips-gap" />
          <ModelChip value={settings.claudeModel} onChange={(value) => updateSettings({ claudeModel: value })} />
          <PaceChip value={settings.drivePace ?? "fast"} onChange={(value) => updateSettings({ drivePace: value })} />
        </div>
      ) : null}
    </div>
  );
}

function MentionList({
  anchor,
  open,
  items,
  index,
  onPick,
  onHover,
  onClose,
  side,
}: {
  side: "bottom" | "top";
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  items: Mention[];
  index: number;
  onPick: (item: Mention) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const groups: Record<Mention["kind"], string> = { tab: "Tabs", skill: "Skills", file: "Vault", memory: "Memory" };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={360} side={side} className="mention-pop">
      {items.map((item, at) => (
        <div key={item.id}>
          {at === 0 || items[at - 1].kind !== item.kind ? <div className="pop-group">{groups[item.kind]}</div> : null}
          <MenuItem icon={item.icon} label={item.label} active={at === index} onSelect={() => onPick(item)} onHover={() => onHover(at)} />
        </div>
      ))}
    </Popover>
  );
}

function AttachButton({ candidates, onPick, compact }: { candidates: Mention[]; onPick: (item: Mention) => void; compact?: boolean }) {
  const tabs = candidates.filter((item) => item.kind === "tab").slice(0, 5);
  const files = candidates.filter((item) => item.kind === "file").slice(0, 4);
  const skills = candidates.filter((item) => item.kind === "skill").slice(0, 4);
  const group = (title: string, items: Mention[]) =>
    items.length ? (
      <DropdownMenuGroup>
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => onPick(item)}>
            {typeof item.icon === "string" ? <PixelIcon name={item.icon} size={15} /> : item.icon}
            <span className="menu-copy">{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    ) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className={cx("chip-btn", compact && "chip-icon")} aria-label="Add context" />}>
        <PixelIcon name="plus" size={compact ? 15 : 16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent width="menu" side={compact ? "top" : "bottom"}>
        {group("Open tabs", tabs)}
        {group("From the vault", files)}
        {group("Skills", skills)}
        {!tabs.length && !files.length && !skills.length ? <p className="pop-empty">Open a tab or add files to the vault, then attach them here. Type @ to search everything.</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A chip that picks one of a few options, each with a line of detail. */
function PickChip<T extends string>({
  title,
  icon,
  label,
  value,
  options,
  onChange,
  align = "start",
}: {
  title: string;
  icon?: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string; detail?: string; icon?: string }>;
  onChange: (value: T) => void;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="chip-btn" />}>
        {icon ? <PixelIcon name={icon} size={15} /> : null}
        <span>{label}</span>
        <PixelIcon name="chevron" size={11} className="chip-caret" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width="menu" align={align}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
            {options.map((item) => (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                {item.icon ? <PixelIcon name={item.icon} size={15} /> : null}
                <span className="menu-copy">
                  <span>{item.label}</span>
                  {item.detail ? <em>{item.detail}</em> : null}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WhereChip({ value, target, onChange }: { value: Where; target: Settings["computerTarget"]; onChange: (value: Where) => void }) {
  const current = WHERE.find((item) => item.value === value) ?? WHERE[0];
  const name = (item: (typeof WHERE)[number]) => (item.value === "act" && target === "vm" ? "Private Mac" : item.label);
  return (
    <PickChip
      title="Where okidoki works"
      icon={current.icon}
      label={name(current)}
      value={value}
      options={WHERE.map((item) => ({ value: item.value, label: name(item), detail: item.detail, icon: item.icon }))}
      onChange={onChange}
    />
  );
}

function GuardChip({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  return (
    <KPopover>
      <PopoverTrigger render={<button type="button" className="chip-btn" />}>
        <PixelIcon name="lock" size={15} />
        <span>Guard</span>
        <PixelIcon name="chevron" size={11} className="chip-caret" />
      </PopoverTrigger>
      <PopoverContent align="start" className="guard-pop">
        <p className="pop-note">okidoki always asks before it sends, buys, deletes, installs or runs anything risky.</p>
        <label className="pop-toggle">
          <span>
            <strong>Background mode</strong>
            <em>Long jobs run without touching your cursor</em>
          </span>
          <Switch label="Background mode" checked={settings.backgroundMode} onChange={(value) => onChange({ backgroundMode: value })} />
        </label>
        <label className="pop-toggle">
          <span>
            <strong>Screen borrowing</strong>
            <em>A ghost cursor, ten seconds at a time</em>
          </span>
          <Switch label="Screen borrowing" checked={settings.screenBorrowing} onChange={(value) => onChange({ screenBorrowing: value })} />
        </label>
        <label className="pop-toggle">
          <span>
            <strong>See the screen</strong>
            <em>Send the front window with each request</em>
          </span>
          <Switch label="See the screen" checked={settings.screenContext ?? true} onChange={(value) => onChange({ screenContext: value })} />
        </label>
        {/* Not a control here: it's set in Settings › Safety, so it reads as a fact, not a field. */}
        <p className="pop-note">
          Spending limit ${settings.spendingLimit} per task. Change it in Settings › Safety.
        </p>
      </PopoverContent>
    </KPopover>
  );
}

function ModelChip({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = MODELS.find((item) => item.value === value);
  return (
    <PickChip
      title="Model for doing things"
      icon="spark"
      label={current?.label ?? value.replace(/^claude-/, "")}
      value={value}
      options={MODELS.map((item) => ({ value: item.value, label: item.label, detail: item.detail }))}
      onChange={onChange}
      align="end"
    />
  );
}

function PaceChip({ value, onChange }: { value: "calm" | "fast"; onChange: (value: "calm" | "fast") => void }) {
  const current = PACE.find((item) => item.value === value) ?? PACE[0];
  return (
    <PickChip
      title="Pace on your Mac"
      label={current.label}
      value={value}
      options={PACE.map((item) => ({ value: item.value, label: item.label, detail: item.detail }))}
      onChange={onChange}
      align="end"
    />
  );
}
