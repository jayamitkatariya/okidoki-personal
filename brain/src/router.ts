import type { Decision, ThinkRequest } from "./types";
import { clipboardFor } from "./llm";

const weekdays: Record<string, number> = {
  sunday: 1,
  monday: 2,
  tuesday: 3,
  wednesday: 4,
  thursday: 5,
  friday: 6,
  saturday: 7,
};

function shortTitle(text: string): string {
  return text.trim().slice(0, 54);
}

export function parseClockHour(text: string): number | undefined {
  const lower = text.toLowerCase();
  const matches = [...lower.matchAll(/(?:^|\s|at\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)];
  if (!matches.length) return undefined;
  const match = matches[matches.length - 1];
  let hour = Number(match[1]);
  if (hour > 23) return undefined;
  const meridiem = match[3];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
  return hour;
}

export function parseRoutine(text: string): {
  name: string;
  action: string;
  weekday: number;
  hour: number;
  minute: number;
  schedule: string;
} | undefined {
  const lower = text.toLowerCase();
  if (!lower.startsWith("every")) return undefined;
  const weekday = Object.keys(weekdays).find((name) => lower.includes(name));
  const hour = parseClockHour(lower) ?? 17;
  const comma = text.indexOf(",");
  const action = comma >= 0 ? text.slice(comma + 1).trim() : text.replace(/^every\s+\w+\s+at\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s*/i, "").trim();
  const name = (action || "routine").slice(0, 40);
  const weekdayNum = weekday ? weekdays[weekday] : 6;
  const dayName = weekday ?? "friday";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return { name, action: action || "run my routine", weekday: weekdayNum, hour, minute: 0, schedule: `every ${dayName} at ${displayHour}${hour < 12 ? "am" : "pm"}` };
}

/** A question about how something works or how to do it. Answered, never acted on. */
function isQuestion(t: string): boolean {
  return t.includes("teach me") || t.startsWith("how do i") || t.startsWith("how to") || t.includes("walk me through") || t.includes("show me how") || t.startsWith("explain ") || t.startsWith("what is ") || t.startsWith("what's a ");
}

const WEB_SITES = /\b(google|youtube|wikipedia|amazon|ebay|reddit|linkedin|github|airbnb|expedia|zillow|yelp|gmail|instagram|facebook|tiktok)\b/;
const WEB_CUES = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|dev|co|edu|gov)\b|\bon the (web|internet)\b|\bonline\b|\bwebsite\b|\bweb ?page\b|\bin (the|my) browser\b|\bsearch the web\b|\blook (it |this |that )?up\b/;
const DESKTOP_APPS = /\b(finder|keynote|numbers|xcode|blender|freecad|autocad|terminal|system settings|photos|music|desktop|downloads folder)\b/;

/** Web-only goals (search, look something up on a site, fill a web form, book, download from the web) go to the browser. */
export function isWebGoal(text: string): boolean {
  const t = text.toLowerCase();
  if (DESKTOP_APPS.test(t)) return false;
  return WEB_CUES.test(t) || WEB_SITES.test(t);
}

export function summarize(text: string, name: string): string {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text
    .replace(/\n/g, " ")
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
  const lead = sentences.slice(0, 3).join(". ");
  return `${name || "this"} — ${words} words.\n\n${lead ? lead + "." : "not much prose in here; it looks like a scan or a table. i can OCR it if you want the text."}\n\nwant the long version, or should i pull out the actions?`;
}

export function explainError(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("command not found")) return "that's a path problem, not a code problem. the shell can't find the command. run `which <tool>`; if it's empty, install it or add its folder to PATH.";
  if (lower.includes("eacces") || lower.includes("permission denied")) return "the app is trying to touch something macOS is protecting. check the exact path — if it's in desktop, documents or downloads, grant file access; otherwise fix the permissions on that file.";
  if (lower.includes("module not found") || lower.includes("cannot find module")) return "a dependency is missing or you're in the wrong folder. run `pwd` and `ls node_modules`; then `npm install` in the folder with package.json.";
  if (lower.includes("eaddrinuse")) return "something else is already on that port. `lsof -i :3000` shows the process; stop it or pick another port.";
  return "i can see the error text, but i don't want to guess. the useful bits are the first line and the path in the stack. paste the full text and i'll explain it line by line.";
}

const FLOW_SIM = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%}body{font-family:ui-monospace,Menlo,monospace}.card{position:fixed;inset:0;background:rgba(11,11,12,.92);border:1px solid rgba(255,255,255,.1);border-radius:18px;overflow:hidden}.cap{position:absolute;top:10px;left:14px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#1FB57A}canvas{width:100%;height:100%;display:block}</style></head><body><div class="card"><canvas id="c"></canvas><div class="cap">flow field · 900 particles</div></div><script>const c=document.getElementById('c');const x=c.getContext('2d');let W,H;function fit(){W=c.width=c.clientWidth*2;H=c.height=c.clientHeight*2;}fit();const P=[];for(let i=0;i<900;i++)P.push({x:Math.random()*W,y:Math.random()*H});function field(px,py,t){const s=0.0016;const a=Math.sin(px*s+t)*Math.cos(py*s*0.9-t*0.7);return[Math.PI+a*Math.PI*0.8,1.7];}let t=0;function step(){t+=0.008;x.fillStyle='rgba(11,11,12,0.16)';x.fillRect(0,0,W,H);for(const p of P){const f=field(p.x,p.y,t);p.x+=Math.cos(f[0])*f[1]*2;p.y+=Math.sin(f[0])*f[1]*2;if(p.x<0||p.x>W||p.y<0||p.y>H){p.x=Math.random()*W;p.y=Math.random()*H;continue;}const b=0.25+0.6*Math.abs(Math.sin(p.y*0.01+t));x.fillStyle='rgba(31,181,122,'+b.toFixed(2)+')';x.fillRect(p.x,p.y,2.4,2.4);}requestAnimationFrame(step);}step();</script></body></html>`;

const WAVE_SIM = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%}body{font-family:ui-monospace,Menlo,monospace}.card{position:fixed;inset:0;background:rgba(11,11,12,.92);border:1px solid rgba(255,255,255,.1);border-radius:18px;overflow:hidden}.cap{position:absolute;top:10px;left:14px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#1FB57A}canvas{width:100%;height:100%;display:block}</style></head><body><div class="card"><canvas id="c"></canvas><div class="cap">two-source interference</div></div><script>const c=document.getElementById('c');const x=c.getContext('2d');const W=c.width=c.clientWidth*2,H=c.height=c.clientHeight*2;const low=document.createElement('canvas');const LW=220,LH=Math.round(LW*H/W);low.width=LW;low.height=LH;const lx=low.getContext('2d');let t=0;function step(){const img=lx.createImageData(LW,LH);const d=img.data;const s1={x:LW*(0.32+0.05*Math.sin(t*0.5)),y:LH*0.5};const s2={x:LW*(0.68-0.05*Math.sin(t*0.5)),y:LH*0.5};for(let py=0;py<LH;py++){for(let px=0;px<LW;px++){const d1=Math.hypot(px-s1.x,py-s1.y);const d2=Math.hypot(px-s2.x,py-s2.y);const v=Math.sin(d1*0.55-t*4)+Math.sin(d2*0.55-t*4);const b=Math.max(0,(v+2)/4);const i=(py*LW+px)*4;const g=Math.round(60+150*b);d[i]=Math.round(g*0.25);d[i+1]=g;d[i+2]=Math.round(g*0.55);d[i+3]=Math.round(80+150*b);}}lx.putImageData(img,0,0);x.imageSmoothingEnabled=true;x.clearRect(0,0,W,H);x.drawImage(low,0,0,W,H);t+=0.02;requestAnimationFrame(step);}step();</script></body></html>`;

function overlayDecision(html: string, title: string, answer: string): Decision {
  return {
    kind: "overlay",
    title,
    answer,
    speak: answer.split(".")[0],
    overlayHTML: html,
    overlayTitle: title,
    overlayWidth: 560,
    overlayHeight: 380,
  };
}

const MESSENGER_APPS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  imessage: "Messages",
  messages: "Messages",
};

export function localRouter(request: ThinkRequest): Decision {
  const raw = request.text.trim();
  const t = raw.toLowerCase();
  const native = request.nativeContext;
  // Only when the request names the clipboard; same rule as the model path.
  const clipboard = clipboardFor(request);

  if (!raw) {
    return {
      kind: "answer",
      title: "what i see",
      answer: "i can see the area you circled. tell me what you want to know about it — “what's wrong here?” or “make this better.”",
      speak: "I can see what you circled. What do you want to know?",
      actions: ["add key"],
    };
  }

  if (["hi", "hey", "hello", "yo", "okidoki"].includes(t)) {
    const name = request.account?.name?.split(" ")[0] ?? "you";
    return { kind: "answer", title: `hey ${name}`, answer: `hey ${name}. shake anytime. i can answer, do it on your mac, or do it on the web.`, speak: `Hey ${name}. What do you need?` };
  }

  if (t.includes("who are you") || t.includes("what are you")) {
    return {
      kind: "answer",
      title: "okidoki",
      answer: "i'm okidoki — a little Mac assistant that lives in your notch. i answer questions, do small jobs and take over the boring parts, on your mac or on the web. you're in charge of what i remember.",
      speak: "I'm Okidoki. I live in your notch and help you get things done.",
    };
  }

  if (t.includes("what can you do") || t === "help") {
    return {
      kind: "answer",
      title: "what i do",
      answer: "a few things, without picking a mode:\n\n- answer: “what's this error?” or “summarize this pdf”\n- do it on your mac: “message mom on whatsapp”\n- do it on the web: “find flights to tokyo on google flights”\n- watch: “watch me do this once” → a reusable skill\n\nshake again to dismiss.",
      speak: "I can answer, or do it for you on your Mac or the web.",
    };
  }

  if (t.includes("remember")) {
    let fact = raw.replace(/^remember (that )?/i, "").replace(/^keep in mind (that )?/i, "");
    return { kind: "memory", title: "noted", answer: `noted. i'll remember: ${fact}`, speak: "Noted.", previewSummary: fact, memory: [fact] };
  }

  if (t.includes("what do you remember") || t.includes("what do you know about me")) {
    const items = request.memory ?? [];
    return {
      kind: "answer",
      title: "what i remember",
      answer: items.length ? items.map((m) => `· ${m}`).join("\n") + "\n\nyou can edit or delete all of this in memory." : "nothing yet. tell me something and it stays yours.",
    };
  }

  if (t.startsWith("watch me") || t.includes("record what i do")) {
    return { kind: "watch", title: "watching you", answer: "go ahead — do it once, slowly. i'll watch app changes and clicks, then repeat it back as plain steps. click stop in the notch when you're done.", speak: "I'm watching. Do it once." };
  }

  const openMatch = raw.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([\w .+]+?)(?:\s+app)?[.!?]*$/i);
  if (openMatch) {
    const appName = openMatch[1].trim();
    return {
      kind: "computer_use",
      title: `open ${appName.toLowerCase()}`,
      answer: `opening ${appName}.`,
      speak: `Opening ${appName}.`,
      risk: "medium",
      previewSummary: `open ${appName} and do the rest if needed`,
      previewSteps: [`open ${appName}`, "look at the screen", "finish anything else you asked"],
      apps: [appName],
      actions: ["go ahead"],
    };
  }

  for (const [needle, appName] of Object.entries(MESSENGER_APPS)) {
    if (t.includes(needle) && !/compress|convert|resize|install/.test(t)) {
      return {
        kind: "computer_use",
        title: `${needle} it`,
        answer: `opening ${appName} and sending it.`,
        speak: "Sending it.",
        risk: "medium",
        previewSummary: `drive ${appName} end to end`,
        previewSteps: ["open " + appName, "open the right chat", "type the message", "send it"],
        apps: [appName],
        actions: ["go ahead"],
      };
    }
  }

  if (/^(message|text|whats?app)\b/.test(t) || t.startsWith("send ") || t.includes(" message ")) {
    return {
      kind: "computer_use",
      title: "send the message",
      answer: "sending it.",
      speak: "Sending it.",
      risk: "medium",
      previewSummary: "drive the messaging app end to end",
      previewSteps: ["open the messaging app", "open the right chat", "type the message", "send it"],
      apps: [],
      actions: ["go ahead"],
    };
  }

  if (!isQuestion(t) && (t.includes("notion") || t.includes("blender") || t.includes("figma") || t.includes("freecad") || t.includes("sketch") || t.includes("autocad"))) {
    return {
      kind: "computer_use",
      title: shortTitle(raw),
      answer: "doing it in the app.",
      speak: "On it.",
      risk: "medium",
      previewSummary: shortTitle(raw),
      previewSteps: ["open the app", "look at the screen", "click and type through it", "hand control back"],
      apps: [],
      actions: ["go ahead"],
    };
  }

  if (!isQuestion(t) && isWebGoal(raw)) {
    return {
      kind: "browser",
      title: shortTitle(raw),
      answer: "doing it in the browser.",
      speak: "On it.",
      risk: "medium",
      previewSummary: shortTitle(raw),
      previewSteps: ["open the browser", "find the right page", "click and type through it", "hand control back"],
      apps: [],
      actions: ["go ahead"],
    };
  }

  if (/simulat|visualis|visualiz/.test(t)) {
    if (t.includes("fluid") || t.includes("flow") || t.includes("particle") || t.includes("aerodynam") || t.includes("streamline") || t.includes("turbulen")) {
      return overlayDecision(FLOW_SIM, "flow", "here's the flow — a vector field steering particles, like smoke in a wind tunnel. this is roughly how fluid moves around a shape: it follows the field, speeds up where lines crowd.");
    }
    if (t.includes("wave") || t.includes("interference") || t.includes("sound") || t.includes("ripple") || t.includes("double slit") || t.includes("double-slit")) {
      return overlayDecision(WAVE_SIM, "wave", "two ripples crossing — where crests meet crests you get bright bands, where crest meets trough they cancel. that's interference.");
    }
    return {
      kind: "answer",
      title: "simulation",
      answer: "i can render a live simulation right on your screen — physics, flow, anything — but building one needs an Anthropic key. ask again in a moment.",
      actions: ["add key"],
    };
  }

  const routine = parseRoutine(raw);
  if (routine) {
    return {
      kind: "routine",
      title: `routine: ${routine.name}`,
      answer: `got it — ${routine.schedule}. “${routine.action}”. i'll run it and leave the result in the notch. you can change or pause it anytime.`,
      speak: "Routine saved.",
      previewSummary: routine.action,
      commands: [routine.action],
      routineName: routine.name,
      routineCadence: "weekly",
      routineWeekday: routine.weekday,
      routineHour: routine.hour,
      routineMinute: routine.minute,
      actions: ["run now"],
    };
  }

  if ((t.includes("move") || t.includes("reschedule")) && (t.includes("pm") || t.includes("am"))) {
    const hour = parseClockHour(t) ?? 15;
    const weekday = Object.keys(weekdays).find((name) => t.includes(name));
    const day = weekday ?? "friday";
    return {
      kind: "quick_action",
      title: "move event",
      answer: `i'll move your ${hour}:00 event to ${day}. approval in the notch?`,
      speak: `I can move that to ${day}.`,
      risk: "medium",
      quickAction: { type: "move_event", title: `move ${hour}:00 event`, hour, weekday: weekday ? weekdays[weekday] : 6 },
      previewSummary: `move today's ${hour}:00 event to ${day}`,
      actions: ["do it"],
    };
  }

  if (t.startsWith("click ") || t.includes("click the")) {
    const target = raw.replace(/^click (the )?/i, "").replace(/[.?!]+$/, "");
    return {
      kind: "borrow",
      title: `click ${target}`,
      answer: "i'll find it in the frontmost app, move a ghost cursor, click once, and give control right back. esc cancels.",
      speak: "Can I take over for ten seconds?",
      risk: "medium",
      previewSummary: `click “${target}” with a ghost cursor`,
      previewSteps: [`find “${target}”`, "move a ghost cursor there", "click once", "hand control back"],
      quickAction: { type: "click", title: target },
      actions: ["allow once"],
    };
  }

  if (t.includes("calendar") || t.includes("meeting") || t.includes("schedule") || t.includes("what's next")) {
    const events = native?.events ?? [];
    if (events.length) {
      return { kind: "answer", title: "today", answer: "here's today:\n\n" + events.slice(0, 6).map((e) => `· ${new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — ${e.title}`).join("\n") };
    }
    return { kind: "answer", title: "calendar", answer: "nothing on the calendar today. a clear deck." };
  }

  if ((t.includes("keynote") || t.includes("decks")) && t.includes("export")) {
    // The Mac drives Keynote itself, deck by deck.
    return {
      kind: "computer_use",
      title: "export keynote decks",
      answer: "exporting each deck to PDF in Keynote.",
      risk: "medium",
      previewSummary: "export Keynote decks to PDF",
      previewSteps: ["open each deck in Keynote", "export it as PDF", "hand control back"],
      apps: ["Keynote"],
    };
  }

  if (t.includes("summarize") || t.includes("summarise")) {
    if (request.documentText) {
      return { kind: "answer", title: "summary", answer: summarize(request.documentText, request.documentName ?? ""), speak: "Here's the short version." };
    }
    if (clipboard) return { kind: "answer", title: "summary", answer: summarize(clipboard, "clipboard") };
    return { kind: "answer", title: "summarize", answer: "pick the PDF and ask again — i'll read the whole thing, not just the page you're on.", actions: ["choose pdf"], pickFile: "pdf" };
  }

  if (t.includes("error") || t.includes("not working") || t.includes("broken") || t.includes("what's this")) {
    const clip = clipboard;
    if (clip) return { kind: "answer", title: "looks like", answer: explainError(clip), actions: ["explain more", "fix it"] };
    if (request.screenshotBase64) {
      return { kind: "answer", title: "what i see", answer: "i have the screen area but no model key to read it. paste the error and i can still walk you through common fixes.", actions: [] };
    }
    return { kind: "answer", title: "show me", answer: "circle the error — press the pencil when you summon me — or copy it and ask again. i'll read the whole thing.", actions: ["circle it"] };
  }

  if (isQuestion(t)) {
    return { kind: "answer", title: shortTitle(raw), answer: "i can walk you through that once the model is back. ask again in a moment.", actions: [] };
  }

  if (request.screenshotBase64) {
    return { kind: "answer", title: "what i see", answer: "i have the screen area, but reading it needs an Anthropic key. paste the text here and ask again.", actions: [] };
  }

  const app = request.appName ?? "";
  const title = shortTitle(raw);
  return {
    kind: "computer_use",
    title,
    answer: "doing it.",
    risk: "medium",
    previewSummary: title,
    previewSteps: ["open the app", "look at the screen", "click and type through it", "hand control back"],
    apps: app ? [app] : [],
  };
}
