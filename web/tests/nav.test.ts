import { describe, expect, test } from "bun:test";
import { isPage, NAV, navFor, pageAvailable, SECTION_META } from "../src/nav";

describe("sidebar navigation by account kind", () => {
  test("a personal account sees exactly the original pages", () => {
    const ids = navFor("personal").flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toEqual(["home", "runs", "live", "history", "memory", "skills", "toolbox", "settings"]);
    expect(navFor("personal").some((group) => group.enterprise)).toBe(false);
  });

  test("a work account gains the enterprise group without losing anything", () => {
    const personal = navFor("personal").flatMap((group) => group.items.map((item) => item.id));
    const work = navFor("work").flatMap((group) => group.items.map((item) => item.id));
    for (const id of personal) expect(work).toContain(id);
    expect(work).toContain("spaces");
    expect(work).toContain("team");
    expect(navFor("work").find((group) => group.enterprise)?.label).toBe("enterprise");
  });

  test("enterprise pages are only reachable from a work account", () => {
    expect(pageAvailable("team", "work")).toBe(true);
    expect(pageAvailable("team", "personal")).toBe(false);
    expect(pageAvailable("settings", "personal")).toBe(true);
  });

  test("every nav item has a title for the breadcrumb and palette", () => {
    for (const item of NAV.flatMap((group) => group.items)) {
      expect(isPage(item.id)).toBe(true);
      expect(SECTION_META[item.id].title.length).toBeGreaterThan(0);
    }
    expect(isPage("keys")).toBe(false);
  });
});
