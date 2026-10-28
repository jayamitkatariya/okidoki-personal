import { describe, expect, test } from "bun:test";
import { isPage, NAV, navFor, pageAvailable, SECTION_META } from "../src/nav";

describe("sidebar navigation", () => {
  test("every account sees the same local pages, with no enterprise group", () => {
    const personal = navFor("personal").flatMap((group) => group.items.map((item) => item.id));
    const work = navFor("work").flatMap((group) => group.items.map((item) => item.id));
    expect(work).toEqual(personal);
    expect(personal).toContain("vault");
    expect(personal).not.toContain("spaces" as never);
    expect(personal).not.toContain("team" as never);
  });

  test("the vault is reachable from any account", () => {
    expect(pageAvailable("vault", "personal")).toBe(true);
    expect(pageAvailable("settings", "personal")).toBe(true);
  });

  test("every nav item has a title for the breadcrumb and palette", () => {
    for (const item of NAV.flatMap((group) => group.items)) {
      expect(isPage(item.id)).toBe(true);
      expect(SECTION_META[item.id].title.length).toBeGreaterThan(0);
    }
    expect(isPage("keys")).toBe(false);
    expect(isPage("spaces")).toBe(false);
  });
});
