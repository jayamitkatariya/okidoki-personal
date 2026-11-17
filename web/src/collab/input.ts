import type { InputPayload } from "./protocol";

/**
 * Take-the-wheel mapping: browser events → the session's input packets. Pure functions over plain
 * shapes, so the keyboard and coordinate rules are provable without a DOM or a host.
 */

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/** A point in the screen image → normalized guest-display coordinates. */
export function normPoint(clientX: number, clientY: number, rect: Rect): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
}

/** Whether a press-and-release travelled far enough to be a drag, not a click (normalized distance). */
export const DRAG_THRESHOLD = 0.012;
export function isDrag(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD;
}

const SPECIAL: Record<string, string> = {
  Enter: "return",
  Backspace: "delete",
  Delete: "forwarddelete",
  Tab: "tab",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/** Printable text this keypress types, or null when it's a shortcut or a named key. */
export function typedText(event: KeyLike): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return event.key.length === 1 ? event.key : null;
}

/** The okidoki key combo for a shortcut or named key ("cmd+l", "return", "shift+tab"), or null. */
export function keyCombo(event: KeyLike): string | null {
  const special = SPECIAL[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key.toLowerCase() : null);
  const base = special ?? (event.key.length === 1 ? event.key.toLowerCase() : null);
  if (!base) return null;
  const mods = [event.ctrlKey && "ctrl", event.altKey && "opt", event.shiftKey && "shift", event.metaKey && "cmd"].filter(Boolean) as string[];
  if (!mods.length) return special ? base : null;
  return [...mods, base].join("+");
}

/** The packet for a keydown: typed text first, then a combo. Escape is the caller's (it releases). */
export function keyInput(event: KeyLike): InputPayload | null {
  const text = typedText(event);
  if (text !== null) return { kind: "type", text };
  const combo = keyCombo(event);
  return combo ? { kind: "key", key: combo } : null;
}

/** Scroll deltas arrive in pixels; clamp so one flick can't fling the guest. */
export const MAX_SCROLL = 2000;
export function scrollInput(x: number, y: number, deltaX: number, deltaY: number): InputPayload | null {
  const dx = Math.min(Math.max(deltaX, -MAX_SCROLL), MAX_SCROLL);
  const dy = Math.min(Math.max(deltaY, -MAX_SCROLL), MAX_SCROLL);
  if (dx === 0 && dy === 0) return null;
  return { kind: "scroll", x, y, dx, dy };
}
