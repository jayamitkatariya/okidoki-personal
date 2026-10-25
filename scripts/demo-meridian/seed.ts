#!/usr/bin/env bun
// Sets up the Meridian Trade Services demo: a U.S. customs brokerage filing CBP 7501 entry summaries.
//
//   bun scripts/demo-meridian/seed.ts            everything below
//   bun scripts/demo-meridian/seed.ts --fresh    also clears the workbench's transmitted entries and
//                                                takes CBP 3461 out of the vault, so the demo can add it live
//   --remote-only / --local-only                 just the organization and vault, or just this Mac
//
// 1. records.json (the shipments) into ~/Library/Application Support/Okidoki
// 2. the "file ACE entry" skill into the work account, and the worker switched on (Okidoki is quit
//    first and state.json backed up to App Backups)
// 3. the organization becomes Meridian: colleagues, spaces, chat, the skill shared org-wide
//    (needs backend/convex/seedDemo.ts deployed: `cd backend && npx convex dev --once`)
// 4. the vault: official CBP/CBSA forms from their sites, plus the shipments' paperwork
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..", "..");
const SUPPORT = join(process.env.HOME!, "Library", "Application Support", "Okidoki");
const fresh = process.argv.includes("--fresh");
const remoteOnly = process.argv.includes("--remote-only");
const localOnly = process.argv.includes("--local-only");
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const site = (env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
const secret = env.OKIDOKI_SYNC_SECRET ?? "";

export const SKILL_ID = "MERIDIAN-FILE-ACE-ENTRY";

/** The entry summary, field by field: the first field of each section is clicked, the rest tabbed to. */
export function aceEntrySkill() {
  type Step = Record<string, unknown>;
  let n = 0;
  const id = () => `${SKILL_ID}-${String(++n).padStart(2, "0")}`;
  const steps: Step[] = [
    { id: id(), text: "switch to Safari", app: "Safari", action: "switch", delay: 0.45 },
    { id: id(), text: "in Safari, press ⌘T", app: "Safari", action: "key", input: "cmd+t", delay: 0.35 },
    { id: id(), text: "in Safari, type the Entry Workbench address", app: "Safari", action: "type", input: "{{portal}}/ace/entry", delay: 0.25 },
    { id: id(), text: "in Safari, press ↩", app: "Safari", action: "key", input: "return", delay: 0.2 },
  ];
  const sections: [string, string][][] = [
    [["Broker reference", "ref"], ["Port of entry", "port"], ["Mode of transport", "mode"], ["Import date", "import_date"]],
    [["Importer number", "ior_number"], ["Manufacturer ID", "mid"]],
    [["Carrier SCAC", "carrier"], ["Bill of lading", "bill_of_lading"], ["Country of origin", "origin"]],
    [["HTS number", "hts"], ["Quantity", "quantity"], ["Entered value", "value"], ["SPI", "spi"]],
  ];
  for (const fields of sections) {
    fields.forEach(([label, param], i) => {
      if (i === 0) steps.push({ id: id(), text: `in Safari, click “${label}”`, app: "Safari", action: "click", label, role: "AXTextField", delay: 0.45 });
      else steps.push({ id: id(), text: `in Safari, press tab to “${label}”`, app: "Safari", action: "key", input: "tab", delay: 0.2 });
      steps.push({ id: id(), text: `in Safari, type “{{${param}}}”`, app: "Safari", action: "type", input: `{{${param}}}`, delay: 0.2 });
    });
  }
  steps.push({ id: id(), text: "in Safari, click “Validate”", app: "Safari", action: "click", label: "Validate", role: "AXButton", delay: 0.45 });
  steps.push({ id: id(), text: "in Safari, click “Transmit to ACE”", app: "Safari", action: "click", label: "Transmit to ACE", role: "AXButton", delay: 1.0 });
  return {
    id: SKILL_ID,
    name: "file ACE entry",
    summary: "CBP 7501 entry summary in the ACE Entry Workbench, from a shipment record · 13 fields, validate, transmit",
    steps,
  };
}

const OFFICIAL = [
  ["CBP Form 7501 (Entry Summary).pdf", "https://www.cbp.gov/sites/default/files/2026-02/cbp_form_7501.pdf"],
  ["CBP Form 7512 (Transportation Entry and Manifest of Goods).pdf", "https://www.cbp.gov/sites/default/files/2025-06/cbp_form_7512.pdf"],
  ["CBP Form 5106 (Create-Update Importer Identity).pdf", "https://www.cbp.gov/sites/default/files/2026-06/cbp_form_5106.pdf"],
  ["CBP Form 301 (Customs Bond).pdf", "https://www.cbp.gov/sites/default/files/2024-05/cbp_form_301.pdf"],
  ["CBP Form 28 (Request for Information).pdf", "https://www.cbp.gov/sites/default/files/2025-05/cbp_form_28.pdf"],
  ["CBSA CI1 (Canada Customs Invoice).pdf", "https://www.cbsa-asfc.gc.ca/publications/forms-formulaires/ci1.pdf"],
] as const;
const LIVE_DEMO_FORM = "CBP Form 3461 (Entry-Immediate Delivery).pdf";

function step(title: string) {
  console.log(`\n▸ ${title}`);
}

function okidokiRunning() {
  return spawnSync("pgrep", ["-x", "Okidoki"]).status === 0;
}

async function quitOkidoki() {
  if (!okidokiRunning()) return;
  spawnSync("osascript", ["-e", 'tell application id "com.jaykatariya.okidoki" to quit']);
  for (let i = 0; i < 40 && okidokiRunning(); i++) await Bun.sleep(250);
  if (okidokiRunning()) throw new Error("Okidoki is still running; quit it and run this again");
}

function workAccountId(state: any): string {
  const current = state.accounts?.find((a: any) => a.id === state.currentAccountID && a.kind === "work");
  const work = current ?? state.accounts?.find((a: any) => a.kind === "work");
  if (!work) throw new Error("no work account on this Mac: add one in the account switcher and link it to the organization first");
  return work.id;
}

async function vaultUpload(accountId: string, name: string, bytes: Uint8Array, space: string) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(site + path, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404) throw new Error(`${path} isn't deployed: cd backend && npx convex dev --once`);
    return (await response.json()) as any;
  };
  const ticket = await post("/api/vault/upload-url", { accountId });
  if (!ticket.ok) throw new Error(ticket.reason ?? "no upload url");
  const stored = (await (await fetch(ticket.url, { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes })).json()) as { storageId: string };
  const saved = await post("/api/vault/save", { accountId, storageId: stored.storageId, name, mime: "application/pdf", space });
  if (!saved.ok) throw new Error(saved.reason ?? "not saved");
  console.log(`  ${saved.replaced ? "updated" : "added"} ${name}${space ? ` · #${space}` : ""}`);
}

async function main() {
  if (!site || !secret) throw new Error(".env needs CONVEX_SITE_URL and OKIDOKI_SYNC_SECRET");
  mkdirSync(SUPPORT, { recursive: true });
  const skill = aceEntrySkill();

  const statePath = join(SUPPORT, "state.json");
  const accountId = workAccountId(JSON.parse(readFileSync(statePath, "utf8")));

  if (!remoteOnly) await seedThisMac(skill, statePath, accountId);
  if (!localOnly) await seedOrganization(skill, accountId);

  step("done");
  console.log(`  start Okidoki: scripts/launch-app.sh${existsSync("/Applications/Okidoki.app") ? "" : " (after make install)"}`);
}

async function seedThisMac(skill: ReturnType<typeof aceEntrySkill>, statePath: string, accountId: string) {
  step("records.json (shipments MTS-4471, MTS-4472, MTS-4473)");
  copyFileSync(join(import.meta.dir, "records.json"), join(SUPPORT, "records.json"));
  if (fresh) {
    rmSync(join(SUPPORT, "ace-entries.json"), { force: true });
    console.log("  cleared the workbench's transmitted entries");
  }

  step("the skill and the worker, on this Mac");
  await quitOkidoki();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  mkdirSync(join(SUPPORT, "App Backups"), { recursive: true });
  const backup = join(SUPPORT, "App Backups", `state.before-meridian.${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  copyFileSync(statePath, backup);
  console.log(`  backed up state.json → ${basename(backup)}`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const existing = (state.skills ?? []).find((s: any) => s.id === SKILL_ID);
  const local = { ...skill, accountID: accountId, source: "taught", createdAt: existing?.createdAt ?? now, runCount: existing?.runCount ?? 0 };
  state.skills = [local, ...(state.skills ?? []).filter((s: any) => s.id !== SKILL_ID && !(s.source?.startsWith("shared:") && s.name === skill.name))];
  state.settings = { ...state.settings, syncEnabled: true, workerEnabled: true };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`  “${skill.name}” (${skill.steps.length} steps) on work account ${accountId}; worker on`);
}

async function seedOrganization(skill: ReturnType<typeof aceEntrySkill>, accountId: string) {
  step("the organization: Meridian Trade Services");
  const args = JSON.stringify({ accountId, skill, ...(fresh ? { forget: [LIVE_DEMO_FORM] } : {}) });
  const run = spawnSync("npx", ["convex", "run", "seedDemo:meridian", args], { cwd: join(ROOT, "backend"), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`convex run failed (is seedDemo deployed? cd backend && npx convex dev --once)\n${run.stderr}`);
  console.log("  " + run.stdout.trim().split("\n").join("\n  "));

  step("the vault: official forms");
  for (const [name, url] of OFFICIAL) {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" }, signal: AbortSignal.timeout(30_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error(`${url} didn't give a PDF`);
    await vaultUpload(accountId, name, bytes, "");
  }

  step("the vault: the shipments' paperwork");
  const out = join(ROOT, "build", "meridian-docs");
  const made = spawnSync("python3", [join(import.meta.dir, "make_docs.py"), out], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`make_docs.py failed: ${made.stderr}`);
  for (const doc of JSON.parse(made.stdout) as { space: string; path: string }[]) {
    await vaultUpload(accountId, basename(doc.path), new Uint8Array(readFileSync(doc.path)), doc.space);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
