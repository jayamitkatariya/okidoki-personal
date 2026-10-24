import { computerAct } from "../src/computer";
import { think } from "../src/llm";

// Exercise the actual API without capturing the screen or executing any returned action.
let key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key && process.platform === "darwin") {
  const saved = Bun.spawnSync(["security", "find-generic-password", "-s", "com.jaykatariya.okidoki.keys", "-a", "anthropic", "-w"]);
  if (saved.exitCode === 0) key = saved.stdout.toString().trim();
}
if (!key) {
  console.error("No API key available. Run from a terminal with access to Okidoki's Keychain entry, or set ANTHROPIC_API_KEY.");
  process.exit(1);
}

let failed = false;
for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
  const thought = await think({ text: "What is 2 + 2? Answer briefly.", settings: { claudeModel: model } }, key);
  const answerOK = thought.usedModel && thought.decision.kind === "answer" && thought.decision.answer.includes("4");
  console.log(`${answerOK ? "PASS" : "FAIL"} ${model} answer${thought.error ? `: ${thought.error}` : ""}`);

  const drive = await computerAct({
    goal: "Open Notes. You are currently in Finder. Return the one next open_app action for Notes.",
    step: 0,
    app: "Finder",
    screen: { x: 0, y: 0, width: 800, height: 600 },
    imageWidth: 800,
    imageHeight: 600,
    history: [],
    canSee: false,
    settings: { claudeModel: model },
  }, key);
  const driveOK = drive.usedModel && drive.action.type === "open_app" && drive.action.app?.toLowerCase() === "notes";
  console.log(`${driveOK ? "PASS" : "FAIL"} ${model} computer use${drive.error ? `: ${drive.error}` : ""}`);
  failed ||= !answerOK || !driveOK;
}
process.exitCode = failed ? 1 : 0;
