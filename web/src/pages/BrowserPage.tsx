import { useEffect, useRef } from "react";
import { invoke, isNative } from "../bridge";
import { Empty } from "../components/ui";

/**
 * okidoki's own browser, inside the dashboard. The page is native (a WebKit view the Mac app owns, so
 * the agent and replays can drive it); this page only holds its place and tells the Mac where that is,
 * every time the layout moves. Leaving the page hides the browser without closing it, so a run or a
 * replay keeps going.
 */
const OVERLAYS = ".palette, .modal, .account-pop";

export function BrowserPage() {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    let last = "";
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The browser is a native view drawn above this page: while the ⌘K palette, a dialog or the
        // account menu is open, step aside so it isn't hidden underneath and its clicks don't land in the page.
        if (document.querySelector(OVERLAYS)) {
          if (last === "hidden") return;
          last = "hidden";
          invoke("browserFrame", { hidden: true });
          return;
        }
        const r = element.getBoundingClientRect();
        const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        const key = JSON.stringify(rect);
        if (key === last) return;
        last = key;
        invoke("browserFrame", rect);
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    observer.observe(document.body);
    // Overlays come and go without resizing anything: watch for them directly.
    const overlays = new MutationObserver(report);
    overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", report);
    // The sidebar collapsing or a banner appearing moves the slot without resizing it.
    const timer = window.setInterval(report, 400);
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", report);
      window.clearInterval(timer);
      invoke("browserFrame", { hidden: true });
    };
  }, []);

  return (
    <div className="browser-page">
      <div className="browser-slot" ref={slot}>
        {isNative() ? null : (
          <Empty icon="globe" title="okidoki's browser">
            In the Mac app, the browser opens right here: the agent works in it, Record turns what you do into a skill, and
            replays run in it without touching your mouse.
          </Empty>
        )}
      </div>
    </div>
  );
}
