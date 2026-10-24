import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { Account, Risk, RunStatus, Toast } from "../types";
import { cx } from "../lib";

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
      {variant === "primary" ? <PixelFill /> : null}
      {icon ? <PixelIcon name={icon} size={size === "sm" ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

/** Squares that step in on hover, filling a primary button pixel by pixel. */
export function PixelFill({ cols = 10, rows = 3 }: { cols?: number; rows?: number }) {
  const delays = useMemo(
    () => Array.from({ length: cols * rows }, (_, i) => (i % cols) * 9 + Math.random() * 120),
    [cols, rows],
  );
  return (
    <span
      aria-hidden="true"
      className="pixel-fill"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {delays.map((delay, i) => (
        <span key={i} style={{ transitionDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

/** Eases a number up from zero the first time it scrolls into view. Honours reduced motion. */
export function CountUp({ end, duration = 1100, prefix = "", suffix = "" }: { end: number; duration?: number; prefix?: string; suffix?: string }) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(end);
      return;
    }
    let frame = 0;
    let started = -1;
    const tick = (now: number) => {
      if (started < 0) started = now;
      const progress = Math.min((now - started) / duration, 1);
      setValue(progress < 1 ? (1 - Math.pow(1 - progress, 4)) * end : end);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        frame = requestAnimationFrame(tick);
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
    <span ref={ref}>
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

export function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="section-label" style={color ? { color } : undefined}>
      <i />
      {children}
    </span>
  );
}

export function Scramble({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = useState(text);
  const frame = useRef(0);
  useEffect(() => {
    const glyphs = "abcdefghijklmnopqrstuvwxyz#%&*+";
    frame.current = 0;
    const timer = window.setInterval(() => {
      frame.current += 1;
      if (frame.current > 8) {
        setDisplay(text);
        window.clearInterval(timer);
        return;
      }
      setDisplay(
        [...text]
          .map((char, index) => {
            if (char === " ") return " ";
            const threshold = (index / Math.max(1, text.length)) * 5;
            return frame.current > threshold + 2 ? char : glyphs[(index * 7 + frame.current * 5) % glyphs.length];
          })
          .join(""),
      );
    }, 28);
    return () => window.clearInterval(timer);
  }, [text]);
  return <span className={cx("scramble", className)}>{display}</span>;
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

export function TextField({
  value,
  onChange,
  placeholder,
  icon,
  type = "text",
  autoFocus = false,
  onEnter,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: string;
  type?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
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
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) onEnter();
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
    <textarea className="textarea" value={value} rows={rows} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
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
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
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
            className="modal"
            style={{ width }}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
          >
            <header className="modal-head">
              <div>
                <h2>{title}</h2>
                {subtitle ? <p>{subtitle}</p> : null}
              </div>
              <IconButton icon="x" label="close" onClick={onClose} />
            </header>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
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
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: tint }} />
    </div>
  );
}

export function KeyHint({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Sun/moon toggle. The new theme opens as a circle from the button, as on the portfolio. */
export function ThemeToggle({ onToggle }: { onToggle: (next: "light" | "dark") => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const root = document.documentElement;
  const dark = root.dataset.theme === "dark";
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

/** Route change: tiles pop in to cover the page, then pop out to reveal the next. */
const WIPE_TILE = 56;
export function PixelWipe({ trigger }: { trigger: string }) {
  const previous = useRef(trigger);
  const [phase, setPhase] = useState<"idle" | "cover" | "reveal">("idle");
  const [run, setRun] = useState(0);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    // compare values, not a first-run flag, so StrictMode's double effect doesn't wipe on load
    if (previous.current === trigger) return;
    previous.current = trigger;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setRun((value) => value + 1);
    setPhase("cover");
    const reveal = window.setTimeout(() => setPhase("reveal"), 260);
    const done = window.setTimeout(() => setPhase("idle"), 260 + 320 + 100);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(done);
    };
  }, [trigger]);

  const tiles = useMemo(() => {
    const cols = Math.ceil(window.innerWidth / WIPE_TILE);
    const rows = Math.ceil(window.innerHeight / WIPE_TILE);
    const count = cols * rows;
    return {
      cols,
      cover: Array.from({ length: count }, () => Math.random() * 220),
      reveal: Array.from({ length: count }, () => Math.random() * 320),
    };
  }, [run]);

  useEffect(() => {
    if (phase === "idle") {
      setArmed(false);
      return;
    }
    if (phase !== "cover") return;
    // two steps so the cover starts from opacity 0
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  if (phase === "idle") return null;

  return (
    <div aria-hidden="true" className="pixel-wipe" style={{ gridTemplateColumns: `repeat(${tiles.cols}, ${WIPE_TILE}px)`, gridAutoRows: `${WIPE_TILE}px` }}>
      {tiles.cover.map((delay, i) => {
        const on = phase === "cover" && armed;
        return (
          <span
            key={i}
            style={{
              opacity: on ? 1 : 0,
              transition: `opacity 60ms steps(1) ${phase === "cover" ? delay : tiles.reveal[i]}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

export function useCopyToast(notify: (title: string, detail?: string) => void) {
  return (text: string, title = "copied") => {
    void navigator.clipboard?.writeText(text);
    notify(title, "on your clipboard");
  };
}
