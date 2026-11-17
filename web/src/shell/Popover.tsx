import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "../lib";
import { PixelIcon } from "../components/ui";
import { useCover } from "./media";

/**
 * A menu that grows out of the control that opened it. Portaled so the content card's clipping can't
 * cut it off, and registered as a cover so the native page steps aside under it.
 */
export function Popover({
  open,
  onClose,
  anchor,
  align = "start",
  side = "bottom",
  role = "menu",
  width,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  align?: "start" | "end";
  side?: "bottom" | "top";
  /** "dialog" for a popover of controls (switches) rather than a list of choices. */
  role?: "menu" | "dialog";
  width?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; origin: string } | null>(null);
  useCover(`popover-${id}`, open);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const measure = () => {
      const r = anchor.current!.getBoundingClientRect();
      const w = width ?? 240;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, align === "end" ? r.right - w : r.left));
      const top = side === "bottom" ? r.bottom + 6 : r.top - 6;
      setPlace({ left, top, origin: `${align === "end" ? "right" : "left"} ${side === "bottom" ? "top" : "bottom"}` });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, anchor, align, side, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  return createPortal(
    <AnimatePresence>
      {open && place ? (
        <motion.div
          ref={panel}
          role={role}
          className={cx("pop", className)}
          style={{
            left: place.left,
            top: side === "bottom" ? place.top : undefined,
            bottom: side === "top" ? window.innerHeight - place.top : undefined,
            width,
            transformOrigin: place.origin,
          }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.4, 0, 0.6, 1] } }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** A row in a popover menu. */
export function MenuItem({
  icon,
  label,
  detail,
  checked,
  onSelect,
  trailing,
  active,
  danger,
  onHover,
  id,
  role,
}: {
  id?: string;
  /** "option" inside a listbox (the address suggestions); a menu item otherwise. */
  role?: "option";
  icon?: React.ReactNode;
  label: string;
  detail?: string;
  checked?: boolean;
  onSelect: () => void;
  trailing?: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  onHover?: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role={role ?? (checked === undefined ? "menuitem" : "menuitemradio")}
      aria-checked={role ? undefined : checked}
      aria-selected={role === "option" ? Boolean(active) : undefined}
      tabIndex={role === "option" ? -1 : undefined}
      className={cx("pop-item", active && "is-active", danger && "is-danger")}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {typeof icon === "string" ? <PixelIcon name={icon} size={15} /> : icon}
      <span className="pop-item-text">
        <span>{label}</span>
        {detail ? <em>{detail}</em> : null}
      </span>
      {trailing}
      {checked ? <PixelIcon name="check" size={14} className="pop-check" /> : null}
    </button>
  );
}
