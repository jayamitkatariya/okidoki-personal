import { useEffect, useRef, useState } from "react";
import { invoke, isNative } from "../bridge";
import { useCovered } from "./media";

/** Old-style overlays that pages inside the card still use (dialogs). */
const LEGACY_OVERLAYS = ".modal, .palette, .account-pop";

/**
 * Where the native page sits. Reports its rect to the Mac whenever the layout moves. While something
 * covers it, the Mac sends a still of the page first, the still goes in here, and only then does the
 * native view step aside, so the page never flashes empty.
 */
export function PageSlot({ children }: { children?: React.ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const covered = useCovered();
  const [legacyCovered, setLegacyCovered] = useState(false);
  const [still, setStill] = useState<string | null>(null);
  const hidden = covered || legacyCovered;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const last = useRef("");

  // Dialogs from pages that don't know about covers.
  useEffect(() => {
    const check = () => setLegacyCovered(Boolean(document.querySelector(LEGACY_OVERLAYS)));
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }, []);

  // Freeze, then hide; show, then thaw.
  useEffect(() => {
    if (!isNative()) return;
    if (hidden) {
      let settled = false;
      const hide = () => {
        if (settled) return;
        settled = true;
        last.current = "hidden";
        invoke("browserFrame", { hidden: true });
      };
      const onFreeze = (event: Event) => {
        const url = (event as CustomEvent<string>).detail;
        if (url) setStill(url);
        // One frame for the still to paint under the native view before it goes.
        requestAnimationFrame(() => requestAnimationFrame(hide));
      };
      window.addEventListener("okidoki-freeze", onFreeze, { once: true });
      invoke("browserFreeze");
      // A page that can't be captured (still loading, blank) shouldn't hold the overlay back.
      const timer = window.setTimeout(hide, 220);
      return () => {
        window.removeEventListener("okidoki-freeze", onFreeze);
        window.clearTimeout(timer);
      };
    }
    last.current = "";
    report();
    const timer = window.setTimeout(() => setStill(null), 120);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  const report = () => {
    const element = slot.current;
    if (!element || !isNative() || hiddenRef.current) return;
    const r = element.getBoundingClientRect();
    const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const key = JSON.stringify(rect);
    if (key === last.current) return;
    last.current = key;
    invoke("browserFrame", rect);
  };

  useEffect(() => {
    const element = slot.current;
    if (!element || !isNative()) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.body);
    window.addEventListener("resize", schedule);
    // The sidebar or the assistant panel sliding moves the slot without resizing the body.
    const timer = window.setInterval(schedule, 300);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.clearInterval(timer);
      last.current = "";
      invoke("browserFrame", { hidden: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page-slot" ref={slot}>
      {still ? <img className="page-still" src={still} alt="" draggable={false} /> : null}
      {isNative() ? null : children}
    </div>
  );
}
