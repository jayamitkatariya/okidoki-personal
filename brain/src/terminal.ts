import type { Decision } from "./types";
import { tools } from "./catalog";
import { agentCommand, shellQuote } from "./executor";
import type { CodingAgent } from "./types";

/** Keep an explicitly named agent and the complete task together, including question phrasing. */
export function agentTaskDecision(text: string): Decision | undefined {
  const raw = text.trim();
  if (!/^(?:(?:please|can you|could you|would you)\s+)*(?:use|run|open|start|launch|ask|have|get|install|set up|find|locate|search|write|build|fix|summarize|summarise|analyze|analyse|create|check)\b/i.test(raw)) return;
  const aliases: [RegExp, CodingAgent, string][] = [
    [/\b(?:hermes(?:[ -]agent)?)\b/i, "hermes", "Hermes Agent"],
    [/\bclaude[ -]?code\b/i, "claude", "Claude Code"],
    [/\bopen[ -]?code\b/i, "opencode", "OpenCode"],
    [/\bomp\b/i, "omp", "omp"],
    [/\bcodex(?: cli)?\b/i, "codex", "Codex"],
    [/\bgemini(?:[ -]cli)?\b/i, "gemini", "Gemini CLI"],
    [/\bcursor[ -](?:agent|cli)\b/i, "cursor", "Cursor Agent"],
  ];
  const named = aliases.find(([pattern]) => pattern.test(raw));
  const match = raw.match(/\b(?:to|and|then)\s+(?:find|locate|search|write|build|fix|summarize|summarise|analyze|analyse|create|check|list|read|convert|download|make|do|tell|help)\b[\s\S]+|^(?:find|locate|search|write|build|fix|summarize|summarise|analyze|analyse|create|check)\b[\s\S]+\b(?:using|with|via)\b[\s\S]+/i);
  if (!named || !match) return;
  const [, agent, name] = named;
  const task = match[0].replace(/^(?:to|and|then)\s+/i, "");
  const command = agentCommand({ runId: "plan", kind: "coding", agent, prompt: raw }).map(arg => arg === raw ? shellQuote(arg) : arg).join(" ");
  const summary = `Use ${name} to ${task}. Return its result here.`;
  return { kind: "terminal", title: task.slice(0, 70), answer: summary, previewSummary: summary,
    previewSteps: [`give ${name} your full request and wait for its result`], commands: [command], risk: "medium" };
}

export function terminalDecision(text: string): Decision | undefined {
  const raw = text.trim(), t = raw.toLowerCase();
  const delegated = agentTaskDecision(raw);
  if (delegated) return delegated;
  if (requiresCustomPlan(raw)) return;
  if (/^(teach|how |what )/.test(t)) return;
  const plan = (title: string, answer: string, commands: string[], pickFile?: Decision["pickFile"], risk: Decision["risk"] = "low"): Decision =>
    ({ kind: "terminal", title, previewSteps: commands.map(c => c.startsWith("test ") ? "check that the output doesn't already exist" : c.startsWith("mkdir ") ? "make a folder for the copies" : c.startsWith("command -v ") ? "check the installation" : title), answer: `${answer} I'll show the result here.`, previewSummary: answer, commands, pickFile, risk });
  if (/^(please )?(install|set up|get) /.test(t)) {
    const tool = tools.find(tool => [tool.id, tool.name, tool.command].some(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)));
    if (tool) return plan(`install ${tool.name}`, `Install ${tool.name} and check it's ready.`, [tool.installCommand, `command -v ${shellQuote(tool.command)}`], undefined, "medium");
  }
  if (/(compress|smaller)/.test(t) && /(video|movie)/.test(t)) return plan("make video smaller", "Choose a video. I'll save a smaller MP4 beside it and keep the original.",
    ["test ! -e {{outputDir}}/{{basename}}-small.mp4", `ffmpeg -nostdin -n -i {{file}} -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart {{outputDir}}/{{basename}}-small.mp4`], "video");
  if (/ocr|searchable|scanned pdf/.test(t)) return plan("make PDF searchable", "Choose a PDF. I'll save a searchable copy beside the original.", ["ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"], "pdf");
  if (/convert/.test(t) && /word/.test(t)) return plan("convert to Word", "Choose a document. I'll make a Word copy beside it.", ["test ! -e {{outputDir}}/{{basename}}.docx", "pandoc {{file}} -o {{outputDir}}/{{basename}}.docx"], "document");
  if (/resize/.test(t) && /image|photo|picture/.test(t)) return plan("resize photos", "Choose a folder. I'll save copies at up to 1600 pixels in a new folder.", ["test ! -e {{outputDir}}", "mkdir -p {{outputDir}}", "magick mogrify -resize '1600x1600>' -path {{outputDir}} {{dir}}/*.(jpg|jpeg|png|heic|JPG|JPEG|PNG|HEIC)(N)"], "images");
  if (/zip/.test(t) && !/unzip/.test(t) && /folder|compress/.test(t)) return plan("zip a folder", "Choose a folder. I'll make a ZIP beside it.", ["test ! -e {{dir}}.zip", "ditto -c -k --sequesterRsrc --keepParent {{dir}} {{dir}}.zip"], "folder");
  if (/disk|storage|space/.test(t) && /check|show|how much|available|left|free space/.test(t)) return plan("check storage", "Check how much storage is available on your Mac.", ['df -h "$HOME"']);
  if (/system info|mac version/.test(t)) return plan("about this Mac", "Check your macOS version and processor.", ["sw_vers", "uname -m"]);
  if (/git status|uncommitted/.test(t)) return plan("check project changes", "Choose a project. I'll show its changed files.", ["git status --short --branch"], "folder");
  const repo = raw.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  if (repo && /clone|download|get this repo/.test(t)) return plan("download repository", "Choose where to save the project. I'll download it with Git.", [`git clone -- ${shellQuote(repo[0].replace(/\.$/, ""))}`], "folder", "medium");
}

/** A fixed single-job recipe must never swallow extra actions or parameters. */
export function requiresCustomPlan(text: string): boolean {
  return /\b(?:and|then|also|afterwards|before|after|but|without|except|instead|only|don't|do not|using|with|to|keep|ensure)\b|\d/i.test(text);
}
