/**
 * Live check of the v2 driving request against the real API: a few turns of one conversation with a
 * real screenshot, nothing executed on the Mac. Streams by default, so it also proves a rebuilt
 * streamed turn (thinking signature included) is accepted when it goes back in the next request.
 *
 *   bun scripts/smoke-v2.ts path/to/screenshot.jpg [model] [effort] [--no-stream]
 */
import { readFileSync } from "node:fs";
import { driveStep, resetSessions, sessionFor } from "../src/computer2";
import { anthropicKey } from "../src/keys";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const stream = !process.argv.includes("--no-stream");
const [file, model = "claude-haiku-5-5", effort = "low"] = args;
if (!file) {
  console.error("usage: bun scripts/smoke-v2.ts screenshot.jpg [model] [effort] [--no-stream]");
  process.exit(1);
}
const key = anthropicKey(null);
if (!key) {
  console.error("no ANTHROPIC_API_KEY");
  process.exit(1);
}
const shot = readFileSync(file).toString("base64");
// Shows any rejected request, so a reset conversation explains itself.
const logged = (async (url: string | URL | Request, init?: RequestInit) => {
  const response = await fetch(url, init);
  if (!response.ok) console.log(`  HTTP ${response.status}: ${(await response.clone().text()).slice(0, 400)}`);
  return response;
}) as typeof fetch;
const mediaType = file.endsWith(".png") ? "image/png" : "image/jpeg";
const observation = {
  app: "Notes",
  windowTitle: "Notes",
  imageWidth: 1600,
  imageHeight: 1039,
  screenshotBase64: shot,
  mediaType,
  controls: [{ id: 1, role: "button", label: "New Note", x: 700, y: 60 }, { id: 2, role: "field", label: "Search", x: 300, y: 60 }],
};

resetSessions();
const goal = "in the Notes app, make a new note that says smoke test, then check it is there";
let failures = 0;
for (let step = 0; step < 4; step++) {
  const pending = sessionFor("smoke")?.pending ?? [];
  const results = pending.map((use) => ({ id: use.id, result: "OK (the screen changed)" }));
  const before = sessionFor("smoke")?.messages.length ?? 0;
  const started = Date.now();
  const firsts: number[] = [];
  const out = await driveStep(
    { runID: "smoke", goal, step, observation, results, effort: effort as "low", settings: { claudeModel: model } },
    key, logged, 55_000, stream ? () => firsts.push(Date.now() - started) : undefined,
  );
  const after = sessionFor("smoke")?.messages.length ?? 0;
  const kept = step === 0 || after > before;
  if (!kept) failures++;
  console.log(`\nstep ${step} · ${Date.now() - started} ms · first action ${firsts[0] ?? "-"} ms · ${out.meta?.stopReason} · ` +
    `usage ${JSON.stringify(out.meta?.usage)} · conversation ${kept ? `kept (${after} messages)` : "RESET"}`);
  if (out.error) console.log("  error:", out.error);
  for (const action of out.actions) console.log("  ", JSON.stringify(action).slice(0, 200));
  if (out.error || out.actions.some((a) => a.type === "done" || a.type === "fail")) break;
}
if (failures) {
  console.error(`\n✗ the conversation was reset ${failures} time(s) — a rebuilt turn was rejected`);
  process.exit(1);
}
