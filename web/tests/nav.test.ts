import { describe, expect, test } from "bun:test";
import { isPage } from "../src/nav";
import { parseView } from "../src/shell/model";

describe("routes", () => {
  test("every place the shell routes to is a page, and nothing else is", () => {
    for (const page of ["home", "browser", "runs", "live", "history", "memory", "skills", "vault", "settings"]) {
      expect(isPage(page)).toBe(true);
    }
    expect(isPage("keys")).toBe(false);
    expect(isPage("spaces")).toBe(false);
  });

  test("old dashboard links still land somewhere sensible in the shell", () => {
    expect(parseView("#/live")).toEqual({ kind: "page", page: "runs" });
    expect(parseView("#/keys")).toEqual({ settingsSection: "keys" });
    expect(parseView("#/browser")).toBe("browser");
  });
});
