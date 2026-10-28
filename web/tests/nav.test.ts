import { describe, expect, test } from "bun:test";
import { groupOf, isPage, NAV, navFor, ON_DEMAND, pageAvailable, SECTION_META, SETTINGS_ITEM } from "../src/nav";

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

  test("daily tools come first and Settings is pinned rather than in a group", () => {
    expect(NAV[0].items.map((item) => item.id)).toEqual(["home", "skills", "notes", "reminders", "terminal"]);
    expect(NAV.flatMap((group) => group.items).some((item) => item.id === "settings")).toBe(false);
    expect(SETTINGS_ITEM.id).toBe("settings");
    expect(groupOf("settings")).toBe("setup");
    expect(groupOf("vault")).toBe("library");
  });

  test("every page appears once, and only Live waits for something to show", () => {
    const ids = NAV.flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ON_DEMAND]).toEqual(["live"]);
    expect(pageAvailable("live")).toBe(true);
  });
});
