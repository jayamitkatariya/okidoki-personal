import { useEffect, useRef, useState } from "react";
import { invoke, isNative } from "../bridge";
import { useCovered } from "./media";

/**
 * Where the native page sits. Reports its rect to the Mac whenever the layout moves. While something
 * covers it, the Mac sends a still of the page first, the still goes in here, and only then does the
 * native view step aside, so the page never flashes empty.
 */
export function PageSlot({ children }: { children?: React.ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const covered = useCovered();
  const [still, setStill] = useState<string | null>(null);
  // Every overlay in the shell registers a cover (Kobra ones through OverlayCover), so this is all.
  const hidden = covered;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const last = useRef("");

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
    // With the assistant panel beside it, the page's bottom-right corner meets the panel: square it.
    const squareRight = Boolean(element.closest(".tab-view")?.querySelector(".assistant"));
    const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), squareRight };
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
    // The sidebar or the assistant panel sliding changes the slot's size (and so fires here) as it moves.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.body);
    const card = element.closest(".card");
    if (card) observer.observe(card);
    window.addEventListener("resize", schedule);
    // A slide that ends with the same width but a new position: one late check after layout settles.
    const settle = () => window.setTimeout(schedule, 260);
    document.addEventListener("transitionend", settle);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", settle);
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
