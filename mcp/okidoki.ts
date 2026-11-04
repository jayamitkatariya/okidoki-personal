#!/usr/bin/env bun
/**
 * `okidoki` — the okidoki app on this Mac, from a terminal or from another agent (Claude Code, Codex,
 * a script). Web tasks, Mac tasks, skill replays, the browser, memory and the vault.
 *
 *   okidoki do "find the cheapest flight from SFO to JFK next Friday"      # auto: replay if a skill fits
 *   okidoki browse "check my Amazon order status" --wait 300
 *   okidoki computer "make a new note in Notes titled Groceries"
 *   okidoki replay "file a return" --item name=Asha pan=ABCDE1234F --item name=Ravi pan=…
 *   okidoki open https://example.com && okidoki page && okidoki click 4
 *   okidoki mcp                                                            # serve MCP over stdio
 *
 * Exit codes, for scripts: 0 done · 1 failed or stopped · 2 needs the person · 3 still running · 4 error.
 * Every command takes --json for the raw answer.
 */
import { writeFileSync } from "node:fs";
import { api, type Json } from "./client";

const HELP = `okidoki — hand tasks to okidoki on this Mac

tasks
  okidoki do <task…>            okidoki picks: a saved skill if one fits, else the agent
  okidoki browse <task…>        in okidoki's browser (the person's logins are there)
  okidoki computer <task…>      drives this Mac's apps
  okidoki chat <question…>      an answer only, nothing done
      --wait <s>     seconds to wait for the result (default 180; 0 = return at once)
      --thread <id>  continue that conversation

runs
  okidoki status                what's running now
  okidoki runs [--limit n]      recent runs
  okidoki run <id> [--log]      one run
  okidoki wait <id> [--timeout s]
  okidoki stop|pause|resume|takeback <id>
  okidoki reply <id> <answer…>  answer the question a run asked
  okidoki save <id> [name…]     keep a finished web run as a skill (replays with new data)

skills
  okidoki skills                saved skills and their inputs
  okidoki library               ready-made templates
  okidoki replay <skill> [--item k=v k=v …]… [--set k=v …] [--items file.json] [--times n] [--wait s]

browser (tabs you open are yours to drive)
  okidoki open <url>            → tab number
  okidoki tabs
  okidoki page [--tab n]        text and numbered elements
  okidoki click <ref|selector> [--tab n]
  okidoki type <ref|selector> <text…> [--submit] [--tab n]
  okidoki select <ref|selector> <value…> [--tab n]
  okidoki press <key> [--tab n]
  okidoki scroll up|down [--tab n]
  okidoki goto <url> [--tab n]
  okidoki screenshot [--tab n] [-o file.png]
  okidoki close <tab>

memory and vault
  okidoki memory                what okidoki remembers about the person
  okidoki remember <fact…>
  okidoki vault <query…>

  okidoki mcp                   MCP server over stdio (claude mcp add okidoki -- okidoki mcp)

Anything risky waits for the person's okay in the notch, and captchas are theirs: a run that needs them
says so (exit code 2). Add --json to any command for the raw answer.`;

type Flags = { [key: string]: string | boolean | string[] };

function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o") {
      flags.out = argv[++i] ?? "";
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (["json", "log", "submit", "front", "help"].includes(key)) {
        flags[key] = true;
      } else if (key === "item" || key === "set") {
        // Every k=v that follows, up to the next flag.
        const pairs: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--") && argv[i + 1].includes("=")) pairs.push(argv[++i]);
        const list = (flags[key] as string[] | undefined) ?? [];
        list.push(JSON.stringify(Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]))));
        flags[key] = list;
      } else {
        flags[key] = argv[++i] ?? "";
      }
    } else {
      words.push(arg);
    }
  }
  return { words, flags };
}

const asJson = (flags: Flags) => Boolean(flags.json);
const number = (v: unknown, fallback: number) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v));

function exitFor(run: Json): number {
  if (run.needs) return 2;
  if (run.done === false) return 3;
  return run.status === "done" ? 0 : run.status === undefined ? 0 : 1;
}

function printRun(run: Json) {
  const bits = [`${run.status ?? "?"}`, run.by ? `by ${run.by}` : "", run.seconds !== undefined ? `${run.seconds}s` : "",
    run.modelCalls ? `${run.modelCalls} model calls` : ""].filter(Boolean);
  console.log(`run ${run.id ?? "-"} · ${bits.join(" · ")}`);
  if (run.title) console.log(`  ${run.title}`);
  if (run.needs) console.log(`  ⏸ needs ${run.needs}`);
  const said = (run.said as string[] | undefined) ?? [];
  const result = String(run.result ?? "");
  if (result) console.log(`\n${result}`);
  for (const line of said) if (line && !result.includes(line.slice(0, 60))) console.log(`\n${line}`);
  if (run.log) console.log(`\n--- log ---\n${run.log}`);
  if (run.thread) console.log(`\nthread ${run.thread}  (okidoki do --thread ${run.thread} "…" to continue)`);
}

function target(spec: string | undefined): Json {
  if (spec === undefined) throw new Error("which element? a number from `okidoki page`, or a CSS selector");
  return /^\d+$/.test(spec) ? { ref: Number(spec) } : { selector: spec };
}

async function main(argv: string[]): Promise<number> {
  const { words, flags } = parse(argv);
  const [command, ...rest] = words;
  const text = rest.join(" ").trim();
  const show = (value: Json, human: (v: Json) => void) => (asJson(flags) ? console.log(JSON.stringify(value, null, 2)) : human(value));
  const tab = flags.tab as string | undefined;

  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return 0;
    case "mcp": {
      const { serve } = await import("./okidoki-mcp");
      serve();
      return -1; // keeps running
    }
    case "do":
    case "browse":
    case "computer":
    case "chat": {
      if (!text) throw new Error(`what should okidoki do? okidoki ${command} "…"`);
      const mode = { do: "auto", browse: "browser", computer: "computer", chat: "chat" }[command];
      const run = await api.task(text, mode, number(flags.wait, 180), flags.thread as string | undefined);
      show(run, printRun);
      return exitFor(run);
    }
    case "status": {
      const status = await api.status();
      show(status, (s) => {
        console.log(`okidoki · key ${s.key ? "set" : "missing"} · brain ${s.brain ? "up" : "down"} · smart replay ${s.smartReplay ? "on" : "off"}`);
        const running = (s.running as Json[]) ?? [];
        console.log(running.length ? running.map((r) => `  ${r.id}  ${r.status}  ${r.title}${r.needs ? `  (needs ${r.needs})` : ""}`).join("\n") : "  nothing running");
      });
      return 0;
    }
    case "runs": {
      const runs = await api.runs(number(flags.limit, 10));
      show(runs, (r) => {
        for (const run of (r.runs as Json[]) ?? []) console.log(`${run.id}  ${String(run.status).padEnd(9)} ${String(run.kind).padEnd(12)} ${run.title}`);
      });
      return 0;
    }
    case "run": {
      const run = await api.run(rest[0], Boolean(flags.log));
      show(run, printRun);
      return exitFor(run);
    }
    case "wait": {
      const run = await api.wait(rest[0], number(flags.timeout, 300));
      show(run, printRun);
      return exitFor(run);
    }
    case "stop":
    case "pause":
    case "resume":
    case "takeback": {
      const run = await api.control(rest[0], command);
      show(run, printRun);
      return 0;
    }
    case "reply": {
      const run = await api.reply(rest[0], rest.slice(1).join(" "));
      show(run, printRun);
      return 0;
    }
    case "save": {
      const out = await api.save(rest[0], rest.slice(1).join(" ") || undefined);
      show(out, (o) => {
        const skill = o.skill as Json | string;
        if (typeof skill === "string") return console.log(`saved “${skill}”`);
        const inputs = ((skill.inputs as Json[]) ?? []).map((i) => i.name);
        console.log(`saved “${skill.name}”${inputs.length ? ` · inputs: ${inputs.join(", ")}` : ""}`);
      });
      return 0;
    }
    case "skills":
    case "library": {
      const out = command === "skills" ? await api.skills() : await api.library();
      show(out, (o) => {
        for (const s of ((o.skills ?? o.templates) as Json[]) ?? []) {
          const inputs = ((s.inputs as Json[]) ?? []).map((i) => `${i.name}${i.required === false ? "?" : ""}`);
          const params = inputs.length ? inputs : ((s.parameters as string[]) ?? []);
          console.log(`${s.name}${s.learned ? "  (learned)" : ""}${s.installed ? "  (installed)" : ""}`);
          if (s.intent || s.summary) console.log(`    ${s.intent ?? s.summary}`);
          if (params.length) console.log(`    inputs: ${params.join(", ")}`);
        }
      });
      return 0;
    }
    case "replay": {
      const skill = rest[0];
      if (!skill) throw new Error('which skill? okidoki replay "<name>" --item k=v …');
      let items = ((flags.item as string[]) ?? []).map((s) => JSON.parse(s) as Json);
      if (flags.items) items = items.concat(JSON.parse(await Bun.file(String(flags.items)).text()) as Json[]);
      const values = ((flags.set as string[]) ?? []).reduce((all, s) => ({ ...all, ...(JSON.parse(s) as Json) }), {} as Json);
      const run = await api.replay(skill, {
        items: items.length ? items : undefined,
        values: Object.keys(values).length ? values : undefined,
        times: flags.times ? number(flags.times, 1) : undefined,
        wait: number(flags.wait, 300),
      });
      show(run, printRun);
      return exitFor(run);
    }
    case "open": {
      const out = await api.open(text, Boolean(flags.front));
      show(out, (o) => console.log(`tab ${o.tab} · ${o.title || ""} · ${o.url}`));
      return 0;
    }
    case "tabs": {
      const out = await api.tabs();
      show(out, (o) => {
        for (const t of (o.tabs as Json[]) ?? []) console.log(`${String(t.tab).padStart(3)}  ${t.yours ? "yours" : t.readable ? "readable" : "      "}  ${t.title} — ${t.url}`);
      });
      return 0;
    }
    case "page": {
      const out = await api.page(tab);
      show(out, (o) => {
        console.log(`tab ${o.tab} · ${o.title} · ${o.url}`);
        if (o.needsPerson) console.log(`⏸ the page needs a person: ${o.needsPerson}`);
        console.log(`\n${o.text}\n\n--- elements ---\n${o.elements}`);
        if (o.more) console.log(`(+${o.more} more further down: okidoki scroll down)`);
      });
      return 0;
    }
    case "click":
    case "type":
    case "select":
    case "press":
    case "scroll":
    case "goto":
    case "hover": {
      let action: Json;
      if (command === "press") action = { action: "press", key: rest[0] ?? "Enter" };
      else if (command === "scroll") action = { action: "scroll", direction: rest[0] ?? "down" };
      else if (command === "goto") action = { action: "navigate", url: text };
      else if (command === "type") action = { action: "type", ...target(rest[0]), text: rest.slice(1).join(" "), submit: Boolean(flags.submit) };
      else if (command === "select") action = { action: "select", ...target(rest[0]), value: rest.slice(1).join(" ") };
      else action = { action: command, ...target(rest[0]) };
      if (tab !== undefined) action.tab = Number(tab);
      const out = await api.act(action);
      show(out, (o) => console.log(o.ok ? `ok${o.label ? ` · ${o.label}` : ""} · ${o.url}` : `✗ ${o.detail ?? "didn't work"}`));
      return out.ok ? 0 : 1;
    }
    case "screenshot": {
      const out = await api.screenshot(tab);
      const file = String(flags.out || `okidoki-tab-${out.tab}.png`);
      writeFileSync(file, Buffer.from(String(out.png ?? ""), "base64"));
      show({ tab: out.tab, file }, (o) => console.log(o.file));
      return 0;
    }
    case "close": {
      show(await api.close(rest[0]), () => console.log("closed"));
      return 0;
    }
    case "memory": {
      const out = await api.memory();
      show(out, (o) => console.log(((o.memory as string[]) ?? []).join("\n") || "nothing yet"));
      return 0;
    }
    case "remember": {
      const out = await api.remember(text);
      show(out, (o) => console.log(o.note));
      return 0;
    }
    case "vault": {
      const out = await api.vault(text);
      show(out, (o) => {
        for (const f of (o.files as Json[]) ?? []) console.log(f.path);
      });
      return 0;
    }
    default:
      console.error(`no command “${command}”. okidoki help`);
      return 4;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(4);
    },
  );
}

export { main, parse };
