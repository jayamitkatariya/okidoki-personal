import { useCallback, useMemo, useRef } from "react";
import { useDashboard } from "../store";
import { copyText } from "../lib";
import { toast } from "@/components/ui/toast";
import type { Bookmark, BrowserTab, NativeState, Pin } from "../types";
import { hostOf, siteLabel } from "./model";

/** Matches OkidokiStore.maxPins. */
export const MAX_PINS = 12;

/** What can be pinned or bookmarked: a real web page, never a blank tab or an error page's about:. */
export function canSave(url: string | null | undefined): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

const sameURL = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");

export function pinFor(state: NativeState, url: string): Pin | undefined {
  const host = hostOf(url);
  return (state.pins ?? []).find((pin) => hostOf(pin.url) === host);
}

export function bookmarkFor(state: NativeState, url: string): Bookmark | undefined {
  return (state.bookmarks ?? []).find((bookmark) => sameURL(bookmark.url, url));
}

/** A site: a tab's page, a pin or a bookmark, reduced to what pinning and bookmarking need. */
export interface Site {
  url: string;
  title: string;
}

export function siteOf(tab: BrowserTab): Site {
  return { url: tab.address, title: tab.title };
}

/**
 * Pin, bookmark, copy, duplicate: one set of actions for the sidebar, its menus, the toolbar, ⌘D/⌘⇧D and
 * the palette, so each says the same thing and offers the same Undo wherever it's done.
 */
export function useSiteActions() {
  const { state, invoke } = useDashboard();
  // Undo runs later: it reads the pins and bookmarks as they are then, not as they were when it was made.
  const latest = useRef(state);
  latest.current = state;

  const unpinURL = useCallback(
    (url: string) => {
      const pin = pinFor(latest.current, url);
      if (pin) invoke("unpin", { id: pin.id });
    },
    [invoke],
  );

  /** Pins a site at `index` (end when missing). A full grid explains itself; `replace` swaps one pin out. */
  const pin = useCallback(
    (site: Site, options: { index?: number; replace?: Pin; quiet?: boolean } = {}) => {
      if (!canSave(site.url)) return;
      const current = latest.current;
      const label = siteLabel(site.title, site.url);
      const existing = pinFor(current, site.url);
      if (existing) {
        // Already there: a drop between two pins moves it instead.
        if (options.index !== undefined) {
          const ids = (current.pins ?? []).map((item) => item.id).filter((id) => id !== existing.id);
          ids.splice(Math.min(options.index, ids.length), 0, existing.id);
          invoke("reorderPins", { ids });
        } else if (!options.quiet) toast({ message: `${hostOf(site.url)} is already pinned`, state: "info" });
        return;
      }
      const pins = current.pins ?? [];
      const replace = options.replace;
      if (!replace && pins.length >= MAX_PINS) {
        toast({
          message: "Your pins are full",
          description: `${MAX_PINS} is the most. Drop onto a pin to replace it, or right-click one to unpin it.`,
          state: "warning",
        });
        return;
      }
      const at = replace ? pins.findIndex((item) => item.id === replace.id) : options.index;
      const place = Math.min(at ?? pins.length, pins.length);
      if (replace) invoke("unpin", { id: replace.id });
      invoke("pinSite", { url: site.url, title: site.title || hostOf(site.url), index: at });
      toast({
        message: replace ? `Pinned ${hostOf(site.url)} in place of ${hostOf(replace.url)}` : `Pinned ${hostOf(site.url)}`,
        description: place < 8 ? `${label} · ⌘${place + 1} opens it` : label,
        state: "success",
        action: {
          label: "Undo",
          run: () => {
            unpinURL(site.url);
            if (replace) invoke("pinSite", { url: replace.url, title: replace.title, index: at });
          },
        },
      });
    },
    [invoke, unpinURL],
  );

  const unpin = useCallback(
    (item: Pin) => {
      const index = (latest.current.pins ?? []).findIndex((p) => p.id === item.id);
      invoke("unpin", { id: item.id });
      toast({
        message: `Unpinned ${hostOf(item.url)}`,
        state: "info",
        action: { label: "Undo", run: () => invoke("pinSite", { url: item.url, title: item.title, index }) },
      });
    },
    [invoke],
  );

  const removeBookmarkByURL = useCallback(
    (url: string) => {
      const found = bookmarkFor(latest.current, url);
      if (found) invoke("removeBookmark", { id: found.id });
    },
    [invoke],
  );

  const bookmark = useCallback(
    (site: Site, options: { quiet?: boolean } = {}) => {
      if (!canSave(site.url)) return;
      if (bookmarkFor(latest.current, site.url)) {
        if (!options.quiet) toast({ message: "Already in your bookmarks", description: siteLabel(site.title, site.url), state: "info" });
        return;
      }
      invoke("addBookmark", { url: site.url, title: site.title || hostOf(site.url) });
      toast({
        message: "Bookmarked",
        description: siteLabel(site.title, site.url),
        state: "success",
        action: { label: "Undo", run: () => removeBookmarkByURL(site.url) },
      });
    },
    [invoke, removeBookmarkByURL],
  );

  const removeBookmark = useCallback(
    (item: Bookmark) => {
      const index = (latest.current.bookmarks ?? []).findIndex((b) => b.id === item.id);
      invoke("removeBookmark", { id: item.id });
      toast({
        message: "Bookmark removed",
        description: siteLabel(item.title, item.url),
        state: "info",
        action: { label: "Undo", run: () => invoke("addBookmark", { url: item.url, title: item.title, index }) },
      });
    },
    [invoke],
  );

  const toggleBookmark = useCallback(
    (site: Site) => {
      const found = bookmarkFor(latest.current, site.url);
      if (found) removeBookmark(found);
      else bookmark(site);
    },
    [bookmark, removeBookmark],
  );

  const togglePin = useCallback(
    (site: Site) => {
      const found = pinFor(latest.current, site.url);
      if (found) unpin(found);
      else pin(site);
    },
    [pin, unpin],
  );

  const copyLink = useCallback((url: string) => {
    void copyText(url).then((ok) =>
      ok ? toast({ message: "Link copied", description: url, state: "success" }) : toast({ message: "Couldn’t copy the link", description: "The clipboard isn’t available", state: "warning" }),
    );
  }, []);

  const duplicate = useCallback((url: string) => invoke("browserOpen", { url, newTab: true }), [invoke]);

  return useMemo(
    () => ({ pin, unpin, togglePin, bookmark, removeBookmark, toggleBookmark, copyLink, duplicate }),
    [pin, unpin, togglePin, bookmark, removeBookmark, toggleBookmark, copyLink, duplicate],
  );
}
