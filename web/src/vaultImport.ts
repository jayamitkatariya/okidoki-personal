import type { DetectedBrowser, VaultImportReport } from "./types";

/** "12 added, 3 updated, 40 skipped", plus the first problem. Mirrors VaultImportReport.summary on the Mac. */
export function importSummary(report: VaultImportReport): string {
  const parts: string[] = [];
  if (report.imported) parts.push(`${report.imported} added`);
  if (report.updated) parts.push(`${report.updated} updated`);
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  if (!parts.length) return report.errors[0] ?? "Nothing to import";
  return parts.join(", ") + (report.errors.length ? ` · ${report.errors[0]}` : "");
}

/** One line for a browser: how many it holds, or why it can't be read, or how its import went. */
export function browserDetail(browser: DetectedBrowser, report?: VaultImportReport | null): string {
  if (browser.error) return browser.error;
  if (report) return importSummary(report);
  const count = browser.logins == null ? "Saved passwords" : `${browser.logins} saved ${browser.logins === 1 ? "password" : "passwords"}`;
  return browser.profiles.length > 1 ? `${count} · ${browser.profiles.length} profiles` : count;
}
