import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isNative } from "../bridge";
import { cx } from "../lib";
import { hostOf } from "./model";

const SCHEME = "okidoki-live://";

/** One clock for every ticking label on screen, so ten "Working for…" lines cost one timer. */
export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [active, every]);
  return now;
}

export function faviconURL(host: string): string {
  if (!host) return "";
  // In the Mac app the icon comes from okidoki's own cache; in the browser preview, from the site.
  return isNative() ? `${SCHEME}favicon/${encodeURIComponent(host)}` : `https://${host}/favicon.ico`;
}

/** A soft, readable tint per site for the letter tile shown when a site has no icon. */
function tint(host: string): string {
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 42% 46%)`;
}

/** A site's icon, or its first letter on a tinted tile while there isn't one. */
export function Favicon({ url, host, size = 16, className }: { url?: string; host?: string; size?: number; className?: string }) {
  const site = host || (url ? hostOf(url) : "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [site]);
  if (!site || failed) {
    return (
      <span className={cx("fav fav-letter", className)} style={{ width: size, height: size, fontSize: size * 0.62, background: tint(site) }} aria-hidden="true">
        {(site.replace(/^(mail|app|calendar|docs)\./, "")[0] ?? "·").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className={cx("fav", className)}
      src={faviconURL(site)}
      width={size}
      height={size}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** A run's screenshot for its card. `version` changes when the Mac takes a newer one. */
export function thumbURL(runID: string, version: number | undefined, title = ""): string | null {
  if (version == null) return null;
  if (isNative()) return `${SCHEME}thumb/${encodeURIComponent(runID)}?v=${version}`;
  return demoThumb(runID, title);
}

/** Browser preview only: a drawn stand-in for a page, so cards have something page-shaped to show. */
function demoThumb(seed: string, title: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const dark = hash % 3 === 0;
  const bg = dark ? `hsl(${hue} 30% 16%)` : `hsl(${hue} 60% 94%)`;
  const ink = dark ? "rgba(255,255,255,.85)" : `hsl(${hue} 40% 22%)`;
  const block = dark ? "rgba(255,255,255,.12)" : `hsl(${hue} 50% 84%)`;
  const accent = `hsl(${(hue + 40) % 360} 75% 55%)`;
  const label = title.replace(/[<&>"]/g, "").slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
<rect width="640" height="400" fill="${bg}"/>
<rect x="0" y="0" width="640" height="44" fill="${block}"/>
<circle cx="28" cy="22" r="8" fill="${accent}"/>
<rect x="48" y="16" width="120" height="12" rx="6" fill="${ink}" opacity=".5"/>
<rect x="480" y="14" width="130" height="16" rx="8" fill="${ink}" opacity=".25"/>
<text x="40" y="118" font-family="-apple-system,Helvetica" font-size="34" font-weight="700" fill="${ink}">${label}</text>
<rect x="40" y="140" width="320" height="12" rx="6" fill="${ink}" opacity=".35"/>
<rect x="40" y="162" width="260" height="12" rx="6" fill="${ink}" opacity=".25"/>
<rect x="40" y="196" width="128" height="36" rx="10" fill="${accent}"/>
<rect x="400" y="96" width="200" height="200" rx="16" fill="${block}"/>
<rect x="40" y="262" width="170" height="110" rx="12" fill="${block}"/>
<rect x="226" y="262" width="170" height="110" rx="12" fill="${block}"/>
<rect x="412" y="312" width="188" height="60" rx="12" fill="${block}"/>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// MARK: - Covering the native page

/**
 * The browser page is a native view drawn above the web content. Anything the shell floats over it
 * (the palette, a menu, the address suggestions) registers here; while any is open the page steps
 * aside and a still of it stands in, so it never blinks out.
 */
interface CoverContext {
  covered: boolean;
  setCover: (id: string, on: boolean) => void;
}

const Cover = createContext<CoverContext>({ covered: false, setCover: () => {} });

export function CoverProvider({ children }: { children: React.ReactNode }) {
  const [covers, setCovers] = useState<ReadonlySet<string>>(new Set());
  const setCover = useCallback((id: string, on: boolean) => {
    setCovers((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ covered: covers.size > 0, setCover }), [covers, setCover]);
  return <Cover.Provider value={value}>{children}</Cover.Provider>;
}

export function useCovered(): boolean {
  return useContext(Cover).covered;
}

/** Marks the page covered while `open` is true. */
export function useCover(id: string, open: boolean) {
  const { setCover } = useContext(Cover);
  useEffect(() => {
    setCover(id, open);
    return () => setCover(id, false);
  }, [id, open, setCover]);
}
