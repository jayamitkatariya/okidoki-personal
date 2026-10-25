/**
 * Live check of the v2 driving request against the real API: two turns of one conversation with a
 * real screenshot, nothing executed on the Mac. Prints what came back, the timings and the cache use.
 *
 *   bun scripts/smoke-v2.ts path/to/screenshot.jpg [model] [effort]
 */
import { readFileSync } from "node:fs";
import { driveStep, resetSessions, sessionFor } from "../src/computer2";
import { anthropicKey } from "../src/keys";

const [file, model = "claude-haiku-5-5", effort = "low"] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun scripts/smoke-v2.ts screenshot.jpg [model] [effort]");
  process.exit(1);
}
const key = anthropicKey(null);
if (!key) {
  console.error("no ANTHROPIC_API_KEY");
  process.exit(1);
}
const shot = readFileSync(file).toString("base64");
const mediaType = file.endsWith(".png") ? "image/png" : "image/jpeg";
const observation = {
  app: "Calculator",
  windowTitle: "Calculator",
  imageWidth: 1600,
  imageHeight: 1039,
  screenshotBase64: shot,
  mediaType,
  controls: [{ id: 1, role: "button", label: "All Clear", x: 700, y: 400 }],
};

resetSessions();
const goal = "open calculator and work out 7 times 6";
for (let step = 0; step < 3; step++) {
  const pending = sessionFor("smoke")?.pending ?? [];
  const results = pending.map((use) => ({ id: use.id, result: use.name === "finish" ? "ok" : "OK (screen changed)" }));
  const started = Date.now();
  const out = await driveStep({ runID: "smoke", goal, step, observation, results, effort: effort as "low", settings: { claudeModel: model } }, key);
  console.log(`\nstep ${step} · ${Date.now() - started} ms · ${out.meta?.stopReason} · usage ${JSON.stringify(out.meta?.usage)}`);
  if (out.error) console.log("  error:", out.error);
  for (const action of out.actions) console.log("  ", JSON.stringify(action));
  if (out.error || out.actions.some((a) => a.type === "done" || a.type === "fail")) break;
}
