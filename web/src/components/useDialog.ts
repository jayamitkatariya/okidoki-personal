import { useEffect, useRef } from "react";

const layers: symbol[] = [];
let rootWasInert = false;
const focusable = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

/** Keep keyboard focus and Escape in the foremost dialog, then return to its trigger. */
export function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const previouslyOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  if (open && !previouslyOpen.current) opener.current = document.activeElement as HTMLElement | null;
  previouslyOpen.current = open;
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const layer = Symbol("dialog");
    const previous = opener.current;
    const root = document.getElementById("root");
    if (!layers.length) rootWasInert = root?.inert ?? false;
    layers.push(layer);
    if (root) root.inert = true;

    const frame = requestAnimationFrame(() => {
      const dialog = ref.current;
      if (!dialog || layers.at(-1) !== layer) return;
      if (dialog.contains(document.activeElement)) return;
      const target = dialog.querySelector<HTMLElement>("input, textarea, [autofocus]") ?? dialog.querySelector<HTMLElement>(focusable);
      (target ?? dialog).focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(focusable) ?? [])]
        .filter((element) => element.getClientRects().length && !element.closest("[inert]"));
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        ref.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      const index = layers.indexOf(layer);
      const wasTop = index === layers.length - 1;
      if (index !== -1) layers.splice(index, 1);
      if (root && !layers.length) root.inert = rootWasInert;
      if (wasTop && previous?.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, [open]);

  return ref;
}
