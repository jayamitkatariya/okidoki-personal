import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { Account, Risk, RunStatus, Toast } from "../types";
import { cx } from "../lib";
import { useDialog } from "./useDialog";

// 24px line icons, drawn on a 1.75 stroke so they sit with SF Pro text.
const ICONS: Record<string, string[]> = {
  spark: ["M12 3c.5 4.5 2.5 6.5 7 7-4.5.5-6.5 2.5-7 7-.5-4.5-2.5-6.5-7-7 4.5-.5 6.5-2.5 7-7z", "M19 16v4", "M17 18h4"],
  home: ["M3.5 10.5 12 3.5l8.5 7", "M5.5 9v11h13V9", "M10 20v-5.5h4V20"],
  runs: ["M3 12h4l3-8 4 16 3-8h4"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5V12l3 2"],
  memory: ["M12 3.5 3.5 8l8.5 4.5L20.5 8z", "M3.5 12.5 12 17l8.5-4.5", "M3.5 16.5 12 21l8.5-4.5"],
  wand: ["M4 20 14.5 9.5", "M17 3v4", "M15 5h4", "M20 10v3", "M18.5 11.5h3"],
  grid: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
  key: ["M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M11 12l9-9", "M17 6l3 3", "M14.5 8.5l2 2"],
  gear: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M9 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-3.8-3.8"],
  mic: ["M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21"],
  pencil: ["M4 20h4L19 9l-4-4L4 16z", "m13 7 4 4"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "m13 7 4 4"],
  cursor: ["M5 4l5.5 15 2.2-6.3L19 10.5z"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  play: ["M7.5 5v14l11-7z"],
  pause: ["M9 5.5v13", "M15 5.5v13"],
  stop: ["M7 7h10v10H7z"],
  arrow: ["M5 12h14", "m13 6 6 6-6 6"],
  chevron: ["m9 6 6 6-6 6"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  eye: ["M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  bolt: ["M13 3 5 13.5h6.5L10.5 21 19 10.5h-6.5z"],
  folder: ["M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  terminal: ["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "m7 9 3 3-3 3", "M13 15h4"],
  code: ["m8 7-5 5 5 5", "m16 7 5 5-5 5"],
  hand: ["M8 13V5.5a1.5 1.5 0 0 1 3 0V12", "M11 11V4.5a1.5 1.5 0 0 1 3 0V12", "M14 11.5v-5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L3.6 15.4a1.5 1.5 0 0 1 2.5-1.7L8 15.5"],
  lock: ["M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z", "M8 11V7.5a4 4 0 0 1 8 0V11"],
  moon: ["M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 2.5v2", "M12 19.5v2", "M2.5 12h2", "M19.5 12h2", "m5.3 5.3 1.4 1.4", "m17.3 17.3 1.4 1.4", "m5.3 18.7 1.4-1.4", "m17.3 6.7 1.4-1.4"],
  bell: ["M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9z", "M10 20.5a2 2 0 0 0 4 0"],
  note: ["M5 4h14v10l-6 6H5z", "M13 20v-6h6"],
  calendar: ["M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3 10h18", "M8 3v4", "M16 3v4"],
  share: ["M12 3v12", "m8 7 4-4 4 4", "M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"],
  clip: ["m16 7-7.5 7.5a2.1 2.1 0 0 0 3 3L19 10a4.2 4.2 0 0 0-6-6L5.5 11.5a6.4 6.4 0 0 0 9 9L20 15"],
  refresh: ["M20 11a8 8 0 0 0-14.9-3.5", "M4 4v4h4", "M4 13a8 8 0 0 0 14.9 3.5", "M20 20v-4h-4"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "m6 7 1 13h10l1-13", "M9 7V4h6v3"],
  copy: ["M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"],
  external: ["M14 4h6v6", "m20 4-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
  filter: ["M4 5h16l-6 8v6l-4-2v-4z"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  apple: ["M12 7.5c-.4-2.4 1-4.2 3-4.5.3 2.3-1.1 4.2-3 4.5z", "M16.5 8.2c-1.6 0-2.6.9-4.5.9s-2.9-.9-4.5-.9C5.4 8.2 4 10.2 4 13c0 4 2.4 8 4.4 8 1.3 0 1.9-.7 3.6-.7s2.3.7 3.6.7c2 0 4.4-4 4.4-8 0-2.8-1.4-4.8-3.5-4.8z"],
  download: ["M12 4v11", "m7 10 5 5 5-5", "M5 20h14"],
  dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  wave: ["M3 12h1.5", "M7 8.5v7", "M11 5v14", "M15 8.5v7", "M19 10.5v3"],
  user: ["M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  screen: ["M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M8.5 20h7", "M12 16v4"],
  sticker: ["M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7l-7 7H6a2 2 0 0 1-2-2z", "M13 20v-5a2 2 0 0 1 2-2h5"],
  spinner: ["M12 3a9 9 0 1 0 9 9"],
  inbox: ["M3 13h5l1.5 3h5l1.5-3h5", "M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"],
  logout: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "m10 8-4 4 4 4", "M6 12h10"],
  keyboard: ["M4 6h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 18H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 6z", "M7 10h.01", "M11 10h.01", "M15 10h.01", "M7 13.5h.01", "M8.5 15h7"],
  scroll: ["M12 3v18", "m8 7 4-4 4 4", "m8 17 4 4 4-4"],
  record: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  repeat: ["M4 10a7 7 0 0 1 12-4.9", "M16 2.5v3h-3", "M20 14a7 7 0 0 1-12 4.9", "M8 21.5v-3h3"],
  switch: ["M4 7h12", "m12 3 4 4-4 4", "M20 17H8", "m12 13-4 4 4 4"],
  panel: ["M4 5h16a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 5z", "M9.5 5v14"],
  people: ["M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z", "M2.5 20a6.5 6.5 0 0 1 13 0", "M16 5a3 3 0 0 1 0 6", "M17.5 14.5a5.5 5.5 0 0 1 4 5.5"],
  chat: ["M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M8 10h8", "M8 13h5"],
  building: ["M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17", "M15 9h3a1 1 0 0 1 1 1v11", "M3 21h18", "M8.5 7h2", "M8.5 11h2", "M8.5 15h2", "M10 21v-3"],
  ticket: ["M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z", "M10 6v12"],
};

export function PixelIcon({
  name,
  size = 14,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const paths = ICONS[name] ?? ICONS.spark;
  const heavy = name === "dots";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx("icon", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={heavy ? 3 : 1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function Logo({ size = 28, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <span className={cx("logo", glow && "logo-glow")} style={{ width: size, height: size }}>
      <img src="brand.png" width={size} height={size} alt="Okidoki" draggable={false} />
    </span>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "dark";
  size?: "sm" | "md" | "lg";
  icon?: string;
};

export function Button({ variant = "secondary", size = "md", icon, className, children, ...props }: ButtonProps) {
  return (
    <button className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} {...props}>
      {icon ? <PixelIcon name={icon} size={size === "sm" ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

/** Eases a number up from zero once, the first time it scrolls into view. Later changes
 *  glide from the shown value to the new one instead of restarting at zero. */
export function CountUp({ end, duration = 1100, prefix = "", suffix = "" }: { end: number; duration?: number; prefix?: string; suffix?: string }) {
  const [value, setValue] = useState(0);
  const shown = useRef(0);
  const seen = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const animate = (from: number, length: number) => {
      if (reduced || from === end) {
        shown.current = end;
        setValue(end);
        return;
      }
      let started = -1;
      const tick = (now: number) => {
        if (started < 0) started = now;
        const progress = Math.min((now - started) / length, 1);
        const next = progress < 1 ? from + (1 - Math.pow(1 - progress, 4)) * (end - from) : end;
        shown.current = next;
        setValue(next);
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    if (seen.current) {
      animate(shown.current, Math.min(duration, 500));
      return () => cancelAnimationFrame(frame);
    }
    // first showing: hold at zero until visible, then count up
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        seen.current = true;
        animate(0, duration);
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [end, duration]);
  return (
    <span ref={ref} className="count-up">
      {prefix}
      {Math.round(value).toLocaleString("en-US")}
      {suffix}
    </span>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  className,
  size = 13,
}: {
  icon: string;
  label: string;
  onClick?: (event: React.MouseEvent) => void;
  className?: string;
  size?: number;
}) {
  return (
    <button className={cx("icon-btn", className)} onClick={onClick} aria-label={label} title={label}>
      <PixelIcon name={icon} size={size} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  tint = "var(--accent)",
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  tint?: string;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("switch", checked && "switch-on")}
      style={{ ["--switch-tint" as string]: tint }}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function Chip({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: "default" | "coral" | "green" | "blue" | "lavender" | "amber";
  className?: string;
}) {
  return <span className={cx("chip", `chip-${tone}`, className)}>{children}</span>;
}

export function RiskBadge({ risk }: { risk: Risk | undefined }) {
  const value = risk ?? "low";
  return (
    <span className={cx("risk", `risk-${value}`)}>
      <i />
      {value}
    </span>
  );
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const label: Record<RunStatus, string> = {
    previewing: "previewing",
    waiting: "waiting",
    running: "running",
    paused: "paused",
    done: "done",
    failed: "failed",
    cancelled: "cancelled",
  };
  return (
    <span className={cx("status", `status-${status}`)}>
      <i />
      {label[status]}
    </span>
  );
}

export function Avatar({ account, size = 30 }: { account: Account; size?: number }) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `#${account.colorHex}`,
        fontSize: size * 0.34,
      }}
    >
      {account.name
        .split(" ")
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase()}
    </span>
  );
}

export function PageTitle({
  icon,
  title,
  subtitle,
  trailing,
  children,
}: {
  icon?: string;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {children}
        <div className="page-title-row">
          {icon ? <PixelIcon name={icon} size={22} className="page-icon" /> : null}
          <h1 className="page-title">{title}</h1>
        </div>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {trailing ? <div className="page-trailing">{trailing}</div> : null}
    </header>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={cx("markdown", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") return <h3 key={index}>{inline(block.text)}</h3>;
        if (block.kind === "bullet") {
          return (
            <div className="md-bullet" key={index}>
              <i />
              <p>{inline(block.text)}</p>
            </div>
          );
        }
        if (block.kind === "code") {
          return (
            <pre key={index} className="md-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={index} className="md-quote">
              {inline(block.text)}
            </blockquote>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

type Block = { kind: "heading" | "paragraph" | "bullet" | "code" | "quote"; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let inCode = false;
  let code = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (inCode) {
        blocks.push({ kind: "code", text: code.trimEnd() });
        code = "";
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code += `${line}\n`;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("### ") || trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      blocks.push({ kind: "heading", text: trimmed.replace(/^#+\s/, "") });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("· ")) {
      blocks.push({ kind: "bullet", text: trimmed.slice(2) });
    } else if (/^\d+\.\s/.test(trimmed)) {
      blocks.push({ kind: "bullet", text: trimmed.replace(/^\d+\.\s/, "") });
    } else if (trimmed.startsWith("> ")) {
      blocks.push({ kind: "quote", text: trimmed.slice(2) });
    } else {
      blocks.push({ kind: "paragraph", text: trimmed });
    }
  }
  if (code) blocks.push({ kind: "code", text: code });
  return blocks;
}

function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

/** True while an input method (Japanese, Chinese…) is composing; WebKit reports keyCode 229 for the committing key. */
export function isComposing(event: React.KeyboardEvent | KeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}

export function TextField({
  value,
  onChange,
  placeholder,
  icon,
  type = "text",
  autoFocus = false,
  onEnter,
  onBlur,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: string;
  type?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  onBlur?: () => void;
  className?: string;
}) {
  return (
    <label className={cx("field", className)}>
      {icon ? <PixelIcon name={icon} size={15} /> : null}
      <input
        value={value}
        type={type}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder || "Text field"}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter && !isComposing(event)) onEnter();
        }}
      />
    </label>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 5,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea className="textarea" aria-label={placeholder || "Text"} value={value} rows={rows} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  compact,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={cx("segmented", compact && "segmented-compact")}>
      {options.map((option) => (
        <button
          key={option.value}
          className={cx("segment", value === option.value && "segment-active")}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: number;
}) {
  const dialogRef = useDialog(open, onClose);
  const titleId = useId();
  const descriptionId = useId();

  // portal to <body> so the scrim covers the whole window, not just the panel the page lives in
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="modal-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={dialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={subtitle ? descriptionId : undefined}
            tabIndex={-1}
            style={{ width }}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
          >
            <header className="modal-head">
              <div>
                <h2 id={titleId}>{title}</h2>
                {subtitle ? <p id={descriptionId}>{subtitle}</p> : null}
              </div>
              <IconButton icon="x" label="close" onClick={onClose} />
            </header>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** A small yes/no for destructive actions. Open while `request` is set; confirm runs it, then closes. */
export interface ConfirmRequest {
  title: string;
  detail?: string;
  action: string;
  onConfirm: () => void;
}

export function ConfirmModal({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  return (
    <Modal open={Boolean(request)} onClose={onClose} title={request?.title ?? ""} subtitle={request?.detail} width={420}>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          autoFocus
          onClick={() => {
            request?.onConfirm();
            onClose();
          }}
        >
          {request?.action ?? "Delete"}
        </Button>
      </footer>
    </Modal>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-stack">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            className={cx("toast", `toast-${toast.kind ?? "success"}`)}
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={() => onDismiss(toast.id)}
          >
            <span className="toast-icon">
              <PixelIcon name={toast.kind === "warning" ? "bolt" : toast.kind === "approval" ? "hand" : "check"} size={14} />
            </span>
            <span>
              <strong>{toast.title}</strong>
              {toast.detail ? <em>{toast.detail}</em> : null}
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <PixelIcon name={icon} size={24} />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Progress({ value, tint }: { value: number; tint?: string }) {
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label="Task progress" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${percent}%`, background: tint }} />
    </div>
  );
}

export function KeyHint({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Follow native, system and local theme changes, including reduced-motion toggles. */
export function ThemeToggle({ onToggle }: { onToggle: (next: "light" | "dark") => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const root = document.documentElement;
  const dark = useSyncExternalStore(subscribeTheme, () => root.dataset.theme === "dark", () => false);
  const next = dark ? "light" : "dark";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const handle = () => {
    const rect = ref.current?.getBoundingClientRect();
    root.style.setProperty("--toggle-x", `${rect ? rect.left + rect.width / 2 : 0}px`);
    root.style.setProperty("--toggle-y", `${rect ? rect.top + rect.height / 2 : 0}px`);
    if (!("startViewTransition" in document) || document.hidden || reduced) {
      onToggle(next);
      return;
    }
    const transition = (document as Document & { startViewTransition: (cb: () => void) => { ready: Promise<void> } }).startViewTransition(() => {
      // set the attribute now too, so the "after" snapshot is the new theme before effects run
      root.dataset.theme = next;
      flushSync(() => onToggle(next));
    });
    transition.ready.catch(() => {});
  };

  return (
    <button ref={ref} className="theme-toggle" onClick={handle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light" : "Dark"}>
      <PixelIcon name={dark ? "sun" : "moon"} size={14} />
    </button>
  );
}
