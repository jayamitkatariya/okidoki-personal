import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { invoke } from "../src/bridge";
import type { NativeState } from "../src/types";
import { browserDetail, importSummary } from "../src/vaultImport";

const originalWindow = globalThis.window;
let snapshots: NativeState[];

beforeEach(() => {
  snapshots = [];
  const previewWindow = new EventTarget() as unknown as Window & typeof globalThis;
  globalThis.window = previewWindow;
  previewWindow.addEventListener("okidoki-native", ((event: CustomEvent<NativeState>) => {
    snapshots.push(event.detail);
  }) as EventListener);
});
afterEach(() => {
  globalThis.window = originalWindow;
});

const report = (patch: Partial<Parameters<typeof importSummary>[0]> = {}) => ({
  source: "Arc",
  imported: 0,
  updated: 0,
  skipped: 0,
  errors: [] as string[],
  finishedAt: "2026-11-01T00:00:00Z",
  ...patch,
});

describe("password import", () => {
  test("summaries count what happened and lead with the first problem when nothing did", () => {
    expect(importSummary(report({ imported: 12, updated: 3, skipped: 40 }))).toBe("12 added, 3 updated, 40 skipped");
    expect(importSummary(report({ imported: 1, errors: ["Arc · Work: blocked"] }))).toBe("1 added · Arc · Work: blocked");
    expect(importSummary(report({ errors: ["Keychain access was declined"] }))).toBe("Keychain access was declined");
    expect(importSummary(report())).toBe("Nothing to import");
  });

  test("a browser line shows its count, profiles, or why it can't be read", () => {
    expect(browserDetail({ id: "arc", name: "Arc", profiles: ["Default"], logins: 1 })).toBe("1 saved password");
    expect(browserDetail({ id: "chrome", name: "Chrome", profiles: ["Default", "Work"], logins: 148 })).toBe("148 saved passwords · 2 profiles");
    expect(browserDetail({ id: "chrome", name: "Chrome", profiles: [], error: "macOS blocked it" })).toBe("macOS blocked it");
    expect(browserDetail({ id: "dia", name: "Dia", profiles: ["Default"], logins: null })).toBe("Saved passwords");
  });

  test("the browser preview reports a stand-in import and offers to trash an imported CSV", () => {
    invoke("vaultImportBrowser", { browser: "arc", passphrase: "x" });
    expect(snapshots.at(-1)?.vaultImport?.last?.source).toBe("Arc");
    expect(snapshots.at(-1)?.vaultImport?.last?.imported).toBe(37);
    invoke("vaultImportCSV", { passphrase: "x" });
    expect(snapshots.at(-1)?.vaultImport?.csvToTrash).toBe("Passwords.csv");
    invoke("vaultImportTrashCSV", { trash: true });
    expect(snapshots.at(-1)?.vaultImport?.csvToTrash).toBeNull();
  });
});

describe("sign-ins", () => {
  test("summarise what came over, or why nothing did", () => {
    const { cookieSummary } = require("../src/vaultImport");
    expect(cookieSummary({ source: "Dia", cookies: 300, sites: 1, skipped: 0, errors: [], finishedAt: "" })).toBe("Signed in to 1 site in okidoki's browser");
    expect(cookieSummary({ source: "Dia", cookies: 0, sites: 0, skipped: 0, errors: ["Keychain access to Dia's key was declined"], finishedAt: "" }))
      .toBe("Keychain access to Dia's key was declined");
  });
});
