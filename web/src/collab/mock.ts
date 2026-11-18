import type { Host } from "./api";
import type { ChatMessage, CollabEvent, JoinResponse, Participant, RunSnapshot, SessionSnapshot, SkillCard } from "./protocol";
import { PARTICIPANT_MAX } from "./protocol";

const COLORS = ["44E45E", "7A8CFF", "FFB454", "FF6B8A", "4CC9F0", "B388FF"];
const uid = () => Math.random().toString(16).slice(2, 10);
const now = () => new Date().toISOString();

const SKILLS: SkillCard[] = [
  { id: "weather-forecast", name: "weather check", summary: "Search the weather for a city", intent: "look up the weather", inputs: [{ name: "city", description: "The city to check" }] },
  { id: "wikipedia-lookup", name: "wikipedia lookup", summary: "Find a topic on Wikipedia", intent: "look up a topic", inputs: [{ name: "topic", description: "What to look up" }] },
  { id: "currency-convert", name: "currency convert", summary: "Convert an amount between currencies", intent: "convert currency", inputs: [{ name: "amount", description: "How much" }, { name: "to", description: "Target currency" }] },
];

/** A stand-in for the VM screen: a little desktop with a window and a ticking clock, as an SVG data URL. */
function fakeFrame(): string {
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1280' height='800'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='#2b3a67'/><stop offset='1' stop-color='#1f2540'/></linearGradient></defs>
    <rect width='1280' height='800' fill='url(#g)'/>
    <rect x='0' y='0' width='1280' height='28' fill='#00000055'/>
    <text x='16' y='19' fill='#ffffffcc' font-family='monospace' font-size='13'>okidoki's private Mac</text>
    <text x='1180' y='19' fill='#ffffffcc' font-family='monospace' font-size='13'>${t}</text>
    <rect x='240' y='120' width='800' height='560' rx='12' fill='#f4f0e8'/>
    <rect x='240' y='120' width='800' height='40' rx='12' fill='#e7e1d5'/>
    <circle cx='266' cy='140' r='6' fill='#ff5f57'/><circle cx='288' cy='140' r='6' fill='#febc2e'/><circle cx='310' cy='140' r='6' fill='#28c840'/>
    <text x='600' y='145' fill='#6e685e' font-family='sans-serif' font-size='14' text-anchor='middle'>Safari</text>
    <rect x='280' y='190' width='720' height='36' rx='8' fill='#ffffff'/>
    <text x='300' y='213' fill='#948d81' font-family='sans-serif' font-size='14'>Search or enter website name</text>
    <text x='640' y='420' fill='#141311' font-family='sans-serif' font-size='30' text-anchor='middle'>Watching okidoki work</text>
    <text x='640' y='456' fill='#6e685e' font-family='sans-serif' font-size='15' text-anchor='middle'>This is a mock screen for the preview.</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * An in-browser host: a session with a couple of people already in it, a shared skill list, and a
 * scripted run that steps forward when someone asks. Enough to prove the whole page without a Mac.
 */
export class MockHost implements Host {
  private listeners = new Set<(e: CollabEvent) => void>();
  private statusListeners = new Set<(c: boolean) => void>();
  private participants: Participant[] = [
    { id: "host", name: "Jay (host)", colorHex: "44E45E", joinedAt: now(), isHost: true },
    { id: "p-asha", name: "Asha", colorHex: "7A8CFF", joinedAt: now() },
  ];
  private messages: ChatMessage[] = [
    { id: uid(), authorID: "host", authorName: "Jay (host)", colorHex: "44E45E", text: "started a session — ask okidoki anything", kind: "system", at: now() },
    { id: uid(), authorID: "p-asha", authorName: "Asha", colorHex: "7A8CFF", text: "hey! can it check the weather in Lisbon?", kind: "chat", at: now() },
  ];
  private run: RunSnapshot | null = null;
  private wheelHolder: string | null = null;
  private tokens = new Map<string, Participant>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  private emit(e: CollabEvent) {
    for (const l of this.listeners) l(e);
  }

  private snapshot(): SessionSnapshot {
    return {
      hostName: "Jay's MacBook Pro",
      startedAt: now(),
      participants: [...this.participants],
      wheelHolder: this.wheelHolder,
      wheelHolderName: this.participants.find((p) => p.id === this.wheelHolder)?.name ?? null,
      vm: { phase: "running", running: true },
      run: this.run,
      skills: SKILLS,
      chat: [...this.messages],
    };
  }

  private say(authorID: string, text: string, kind: ChatMessage["kind"]) {
    const p = this.participants.find((x) => x.id === authorID);
    const msg: ChatMessage = { id: uid(), authorID, authorName: p?.name ?? "okidoki", colorHex: p?.colorHex ?? "1FB57A", text, kind, at: now() };
    this.messages.push(msg);
    this.emit({ type: "chat", message: msg });
  }

  async join(name: string, code: string): Promise<JoinResponse> {
    await delay(120);
    if (code.trim().toUpperCase() !== "OKIDOKI") throw new Error("that code didn't match — check it on the host's screen");
    if (this.participants.length >= PARTICIPANT_MAX) throw new Error("this session is full");
    const you: Participant = { id: `p-${uid()}`, name: name.trim() || "Guest", colorHex: COLORS[this.participants.length % COLORS.length], joinedAt: now() };
    this.participants.push(you);
    const token = `tok-${uid()}`;
    this.tokens.set(token, you);
    this.emit({ type: "presence", participants: [...this.participants] });
    this.say(you.id, "joined", "system");
    return { token, you, session: this.snapshot() };
  }

  async state(token: string) {
    const you = this.tokens.get(token);
    if (!you) throw new Error("session unavailable");
    return { you, session: this.snapshot() };
  }

  subscribe(token: string, onEvent: (e: CollabEvent) => void, onStatus?: (c: boolean) => void) {
    const you = this.tokens.get(token);
    this.listeners.add(onEvent);
    if (onStatus) {
      this.statusListeners.add(onStatus);
      onStatus(true);
    }
    queueMicrotask(() => onEvent({ type: "hello", you: you ?? this.participants[0], session: this.snapshot() }));
    return () => {
      this.listeners.delete(onEvent);
      if (onStatus) this.statusListeners.delete(onStatus);
    };
  }

  frameURL(_token: string) {
    return fakeFrame();
  }

  async chat(token: string, text: string, ask: boolean) {
    const you = this.tokens.get(token);
    if (!you) throw new Error("not in the session");
    const trimmed = text.trim();
    if (!trimmed) return;
    this.say(you.id, trimmed, ask ? "ask" : "chat");
    if (ask) {
      if (this.wheelHolder) {
        const holder = this.participants.find((p) => p.id === this.wheelHolder);
        this.say("okidoki", `${holder?.name ?? "someone"} has the wheel right now — ask them to release it, then try again.`, "okidoki");
        return;
      }
      this.startRun(trimmed.replace(/^\s*okidoki[,:]?\s*/i, ""), you.id);
    }
  }

  async runSkill(token: string, id: string, values?: Record<string, string>) {
    const you = this.tokens.get(token);
    if (!you) throw new Error("not in the session");
    if (this.wheelHolder) {
      const holder = this.participants.find((p) => p.id === this.wheelHolder);
      this.say("okidoki", `${holder?.name ?? "someone"} has the wheel right now — ask them to release it, then try again.`, "okidoki");
      return {};
    }
    const skill = SKILLS.find((s) => s.id === id);
    const detail = values ? Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const runID = this.startRun(`${skill?.name ?? id}${detail ? ` (${detail})` : ""}`, you.id);
    return { runID };
  }

  private startRun(goal: string, requestedBy: string): string {
    const id = `run-${uid()}`;
    // The agent always wins the wheel back once it starts driving.
    if (this.wheelHolder) {
      this.wheelHolder = null;
      this.emit({ type: "wheel", holder: null, holderName: null });
    }
    const steps = [
      { say: "looking at the screen", kind: "look", detail: "", result: "" },
      { say: "open Safari", kind: "app", detail: "Safari", result: "opened Safari" },
      { say: "click the address bar", kind: "pointer", detail: "", result: "clicked" },
      { say: `type “${goal}”`, kind: "keys", detail: goal, result: "typed" },
      { say: "press Return", kind: "keys", detail: "return", result: "pressed return" },
      { say: "reading the result", kind: "look", detail: "", result: "done" },
    ];
    this.run = { id, title: goal, status: "running", goal, requestedBy, needs: null, steps: [] };
    this.emit({ type: "run", run: this.run });
    steps.forEach((s, i) => {
      this.timers.push(setTimeout(() => {
        if (!this.run || this.run.id !== id) return;
        this.run = { ...this.run, steps: [...this.run.steps, { index: i, status: "done", ...s }] };
        this.emit({ type: "run", run: this.run });
        if (i === steps.length - 1) {
          this.timers.push(setTimeout(() => {
            if (!this.run || this.run.id !== id) return;
            this.run = null;
            this.emit({ type: "run", run: null });
            this.say("okidoki", `done — ${goal}. it's on the screen.`, "okidoki");
          }, 500));
        }
      }, 450 * (i + 1)));
    });
    return id;
  }

  async stopRun(token: string, id: string) {
    if (this.run?.id === id) {
      this.run = null;
      this.emit({ type: "run", run: null });
      this.say("okidoki", "stopped.", "okidoki");
    }
  }

  async wheel(token: string, action: "request" | "release") {
    const you = this.tokens.get(token);
    if (action === "request") {
      if (this.run) throw new Error("okidoki is working — stop the run to take the wheel");
      if (this.wheelHolder && this.wheelHolder !== you?.id) throw new Error("someone already has the wheel");
      this.wheelHolder = you?.id ?? null;
    } else if (this.wheelHolder === you?.id) {
      this.wheelHolder = null;
    }
    const holderName = this.participants.find((p) => p.id === this.wheelHolder)?.name ?? null;
    this.emit({ type: "wheel", holder: this.wheelHolder, holderName });
    return { holder: this.wheelHolder };
  }

  async input(token: string, payload: Record<string, unknown>) {
    const you = this.tokens.get(token);
    if (!you || this.wheelHolder !== you.id) return;
    // The mock screen doesn't move, but the pointer overlay everyone else sees is real.
    const kind = String(payload.kind ?? "");
    if (kind === "move" || kind === "click" || kind === "drag") {
      this.emit({
        type: "pointer",
        x: Number(payload.x ?? 0),
        y: Number(payload.y ?? 0),
        by: you.id,
        color: you.colorHex,
        click: kind === "click" || kind === "drag",
      });
    }
  }

  dispose() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.listeners.clear();
    this.statusListeners.clear();
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
