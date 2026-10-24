import type { Decision, NativeContext, ThinkRequest } from "./types";
import { findTools } from "./catalog";

const weekdays: Record<string, number> = {
  sunday: 1,
  monday: 2,
  tuesday: 3,
  wednesday: 4,
  thursday: 5,
  friday: 6,
  saturday: 7,
};

function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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

export function detectedDate(text: string): string | undefined {
  const lower = text.toLowerCase();
  const hour = parseClockHour(lower);
  const now = new Date();
  let day = new Date(now);
  if (lower.includes("tomorrow")) day.setDate(day.getDate() + 1);
  if (lower.includes("next week")) day.setDate(day.getDate() + 7);
  const weekday = Object.keys(weekdays).find((name) => lower.includes(name));
  if (weekday) {
    const target = weekdays[weekday];
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    day.setDate(day.getDate() + delta);
  }
  if (hour !== undefined) {
    day.setHours(hour, 0, 0, 0);
    return day.toISOString();
  }
  // "friday" with no time: 9am
  if (weekday) {
    day.setHours(9, 0, 0, 0);
    return day.toISOString();
  }
  return undefined;
}

export function reminderTitle(text: string): string {
  let title = text;
  title = title.replace(/^remind me (to|about)\s+/i, "");
  title = title.replace(/^set a reminder (to|for)\s+/i, "");
  title = title.replace(/^reminder (to|for)\s+/i, "");
  title = title.replace(/^remind me\s+/i, "");
  title = title.replace(/\s+(at|on|by)\s+.*$/i, "");
  return sentence(title.trim().replace(/[.,;:]+$/, "") || "reminder");
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

export function teachSteps(topic: string): string[] {
  const t = topic.toLowerCase();
  if (t.includes("auto layout") || (t.includes("figma") && t.includes("layout"))) {
    return [
      "select the two cards you want to arrange, then press shift + a. figma wraps them in an auto layout frame.",
      "in the right panel, set direction to ↓ and gap to 16.",
      "click the padding field and set 24 on all four sides.",
      "resize the frame from its edge — the cards reflow instead of overlapping.",
      "drag a third card into the frame. it joins the stack automatically.",
      "turn on “clip content” only if you want the frame to crop. that's auto layout.",
    ];
  }
  if (t.includes("git")) {
    return [
      "open terminal in a project folder and run `git status` — read what git thinks is going on.",
      "run `git init` once per project, then `git add -A` to stage everything.",
      "run `git commit -m \"first commit\"` — that's your first save point.",
      "make a branch with `git switch -c experiment`, change a file, and commit again.",
      "run `git switch main` to jump back. the files change with you.",
      "run `git merge experiment` — this is how the two lines come back together.",
    ];
  }
  if (t.includes("terminal") || t.includes("shell") || t.includes("bash") || t.includes("zsh")) {
    return [
      "`pwd` prints where you are. try it.",
      "`ls` lists what's here; `ls -la` includes hidden files.",
      "`cd folder` walks in; `cd ..` walks back out. tab completes names.",
      "`mkdir new-folder` makes one; `touch note.txt` makes an empty file.",
      "`cat note.txt` prints a file. `man ls` opens the manual — press q to leave.",
      "that's the loop: look, move, make, read.",
    ];
  }
  return [
    `open ${topic} and find the main canvas or window.`,
    "find the one control that creates something new — a plus, a button, or a menu item.",
    "make the smallest possible version. don't perfect it yet.",
    "change one property and watch what moves. that's the mental model.",
    "undo once. if you can get back, you're safe to explore.",
    "tell me what confused you and we'll go one level deeper.",
  ];
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
  const installed = request.installedTools ?? [];
  const native = request.nativeContext;

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
    return { kind: "answer", title: `hey ${name}`, answer: `hey ${name}. shake anytime. i can answer, do, teach, or hand it to a coding agent.`, speak: `Hey ${name}. What do you need?` };
  }

  if (t.includes("who are you") || t.includes("what are you")) {
    return {
      kind: "answer",
      title: "okidoki",
      answer: "i'm okidoki — a little Mac assistant that lives in your notch. i answer questions, do small jobs, take over the boring parts, and teach when you'd rather learn. you're in charge of what i remember.",
      speak: "I'm Okidoki. I live in your notch and help you get things done.",
    };
  }

  if (t.includes("what can you do") || t === "help") {
    return {
      kind: "answer",
      title: "what i do",
      answer: "a few things, without picking a mode:\n\n- answer: “what's this error?” or “summarize this pdf”\n- quick actions: “remind me to call mom at 6”\n- terminal: “my mac is out of space” → mole, with approval\n- coding: “build me a script…” → your chosen agent\n- teach: “teach me auto layout in figma”\n- watch: “watch me do this once” → a reusable skill\n\nshake again to dismiss.",
      speak: "I can answer, do, teach, or hand it to your coding agent.",
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
    return { kind: "watch", title: "watching you", answer: "go ahead — do it once, slowly. i'll watch app changes and clicks, then repeat it back as plain steps. click stop or shake again when you're done.", speak: "I'm watching. Do it once." };
  }

  const openMatch = raw.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([\w .+]+?)(?:\s+app)?[.!?]*$/i);
  if (openMatch) {
    const appName = openMatch[1].trim();
    return {
      kind: "computer_use",
      title: `open ${appName.toLowerCase()}`,
      answer: `i'll open ${appName} and take it from there. approve once, then i drive — you'll see every move and can stop me anytime.`,
      speak: `Opening ${appName}.`,
      risk: "medium",
      previewSummary: `open ${appName} and do the rest if needed`,
      previewSteps: [`open ${appName}`, "look at the screen", "finish anything else you asked"],
      apps: [appName],
      actions: ["go ahead"],
    };
  }

  for (const [needle, appName] of Object.entries(MESSENGER_APPS)) {
    if (t.includes(needle)) {
      return {
        kind: "computer_use",
        title: `${needle} it`,
        answer: `i can do that end to end — open ${appName}, find the chat, write the message, press send. one approval, then i drive it live and you can stop me anytime.`,
        speak: "I can message them for you. Want me to drive?",
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
      answer: "i'll drive the messaging app end to end — find the person, write it, press send. one approval, then i take over live; move your mouse and i stop.",
      speak: "I can send that for you. Want me to drive?",
      risk: "medium",
      previewSummary: "drive the messaging app end to end",
      previewSteps: ["open the messaging app", "open the right chat", "type the message", "send it"],
      apps: [],
      actions: ["go ahead"],
    };
  }

  if (t.includes("notion") || t.includes("blender") || t.includes("figma") || t.includes("freecad") || t.includes("sketch") || t.includes("autocad")) {
    return {
      kind: "computer_use",
      title: shortTitle(raw),
      answer: "i can drive that app end to end — menus, buttons, typing, the whole flow. approve once, then i take over live; move your mouse and i stop.",
      speak: "I can do that in the app. Want me to drive?",
      risk: "medium",
      previewSummary: shortTitle(raw),
      previewSteps: ["open the app", "look at the screen", "click and type through it", "hand control back"],
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
      answer: "i can render a live simulation right on your screen — physics, flow, anything — but building one needs an Anthropic key. add one in keys and ask again.",
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

  if (t.includes("remind") || t.startsWith("reminder")) {
    const title = reminderTitle(raw);
    const date = detectedDate(raw);
    return {
      kind: "quick_action",
      title: "reminder",
      answer: date ? `done — “${title}” is in reminders. tap the notch to undo or edit.` : `i'll put “${title}” in reminders. when?`,
      speak: "Reminder set.",
      quickAction: { type: "reminder", title, date },
      previewSummary: `add reminder: ${title}`,
      actions: ["undo", "edit"],
    };
  }

  if (t.startsWith("note ") || t === "note this" || t === "note that" || t.includes("make a note")) {
    const body = t === "note this" || t === "note that" || t.includes("clipboard") ? request.clipboardText ?? "" : raw.replace(/^(make a note|note)( that| this)?[ :]*/i, "");
    return {
      kind: "quick_action",
      title: "note saved",
      answer: "saved to notes. tap the notch to undo.",
      speak: "Note saved.",
      quickAction: { type: "note", title: `okidoki · ${new Date().toISOString().slice(0, 10)}`, body: body || raw },
      previewSummary: "new note in Notes",
      actions: ["undo", "open"],
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
      answer: "i'll find it in the frontmost app, move a ghost cursor, click once, and give control right back. moving your mouse cancels instantly.",
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

  if (t.includes("out of space") || t.includes("free space") || t.includes("disk space") || t.includes("clean my mac") || t.includes("storage")) {
    const mole = installed.includes("mole");
    return {
      kind: "terminal",
      title: "free up space",
      answer: mole ? "mole is installed. i can dry-run first, then clean caches, logs and trash. approval before anything moves." : "mole is the free cleaner i'd use. installing it is one homebrew command; i'll ask first.",
      speak: "I can clean this up with Mole, with your approval.",
      risk: "medium",
      previewSummary: mole ? "scan with mole, then clean caches and trash" : "install mole, scan, then clean caches and trash",
      previewSteps: mole ? ["dry-run scan with mole", "clean caches, logs and trash", "show freed space"] : ["install mole with homebrew", "dry-run scan", "clean caches, logs and trash"],
      commands: mole ? ["mo clean --dry-run", "mo clean"] : ["brew install mole", "mo clean --dry-run", "mo clean"],
      apps: ["Terminal"],
      actions: ["review"],
    };
  }

  if (t.includes("downloads folder") || (t.includes("clean") && t.includes("downloads"))) {
    return {
      kind: "terminal",
      title: "clean downloads",
      answer: "i'll move files older than 30 days from Downloads to the Trash — nothing is deleted for good. approval first.",
      risk: "high",
      previewSummary: "move Downloads files older than 30 days to Trash",
      previewSteps: ["list files older than 30 days", "move them to Trash", "leave recent files alone"],
      commands: ['find "$HOME/Downloads" -maxdepth 1 -type f -mtime +30 -print0 | xargs -0 -I{} mv {} "$HOME/.Trash/"'],
      apps: ["Finder"],
      actions: ["review"],
    };
  }

  if (t.includes("compress") || (t.includes("video") && t.includes("discord"))) {
    return {
      kind: "terminal",
      title: "compress video",
      answer: "pick the video. i'll make a smaller H.264 copy at 1280 wide — good for Discord — and leave the original untouched.",
      speak: "Pick a video and I'll compress a copy.",
      risk: "low",
      previewSummary: "compress a video for Discord with ffmpeg",
      previewSteps: ["read the video", "scale to 1280 wide, h.264 crf 28", "write a new file next to it"],
      commands: [`ffmpeg -i {{file}} -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart {{outputDir}}/{{basename}}-discord.mp4`],
      apps: ["Terminal"],
      pickFile: "video",
      actions: ["choose file"],
    };
  }

  if (t.includes("ocr") || t.includes("searchable") || t.includes("scanned")) {
    const has = installed.includes("ocrmypdf");
    return {
      kind: "terminal",
      title: "make scans searchable",
      answer: `pick the PDF. i'll add a searchable text layer without touching the original.${has ? "" : " ocrmypdf needs a one-time install; i'll ask first."}`,
      risk: "medium",
      previewSummary: "OCR a PDF with ocrmypdf",
      previewSteps: ["read the scan", "recognise text", "write a searchable copy"],
      commands: has ? ["ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"] : ["brew install ocrmypdf", "ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"],
      apps: ["Terminal"],
      pickFile: "pdf",
      actions: ["choose file"],
    };
  }

  if (t.includes("convert this to word") || t.includes("convert to word") || t.includes("pandoc")) {
    return {
      kind: "terminal",
      title: "convert document",
      answer: "pick the document. pandoc will make a copy in a format Word can open, right beside it.",
      risk: "low",
      previewSummary: "convert a document with pandoc",
      previewSteps: ["read the source", "convert with pandoc", "write a new file"],
      commands: ["pandoc {{file}} -o {{outputDir}}/{{basename}}.docx"],
      apps: ["Terminal"],
      pickFile: "document",
      actions: ["choose file"],
    };
  }

  if ((t.includes("resize") && (t.includes("image") || t.includes("photo"))) || t.includes("heic")) {
    return {
      kind: "terminal",
      title: "resize images",
      answer: "pick a folder. i'll write resized copies to a sibling folder and leave the originals alone.",
      risk: "low",
      previewSummary: "batch resize images with ImageMagick",
      previewSteps: ["read the folder", "resize to 1600px", "write copies to a new folder"],
      commands: ["mkdir -p {{outputDir}} && magick mogrify -resize '1600x1600>' -path {{outputDir}} {{dir}}/*.{jpg,jpeg,png,heic}"],
      apps: ["Terminal"],
      pickFile: "images",
      actions: ["choose folder"],
    };
  }

  if ((t.includes("keynote") || t.includes("decks")) && t.includes("export")) {
    return {
      kind: "background",
      title: "export keynote decks",
      answer: "pick the folder of decks. i'll export each one to PDF into a new folder, quietly, while you keep working.",
      speak: "Pick the folder and I'll export them in the background.",
      risk: "low",
      previewSummary: "batch-export Keynote decks to PDF",
      previewSteps: ["scan the folder for .key files", "open each deck in Keynote", "export PDFs into one folder"],
      apps: ["Keynote"],
      pickFile: "folder",
      builtin: "export-keynote",
      actions: ["choose folder"],
    };
  }

  if (t.includes("batch") && (t.includes("convert") || t.includes("video"))) {
    return {
      kind: "background",
      title: "batch convert videos",
      answer: "pick a folder. i'll convert every video to a smaller MP4 into a new folder, one at a time, while you keep working.",
      risk: "medium",
      previewSummary: "batch-convert a folder of videos with ffmpeg",
      previewSteps: ["scan the folder", "convert each video", "leave originals alone"],
      commands: [`mkdir -p {{outputDir}}; for f in {{dir}}/*.{mov,mp4,avi,mkv}; do [ -f "$f" ] || continue; ffmpeg -i "$f" -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -c:a aac "{{outputDir}}/$(basename "\${f%.*}")-small.mp4"; done`],
      apps: ["Terminal"],
      pickFile: "folder",
      actions: ["choose folder"],
    };
  }

  if (t.includes("summarize") || t.includes("summarise")) {
    if (request.documentText) {
      return { kind: "answer", title: "summary", answer: summarize(request.documentText, request.documentName ?? ""), speak: "Here's the short version." };
    }
    if (request.clipboardText) return { kind: "answer", title: "summary", answer: summarize(request.clipboardText, "clipboard") };
    return { kind: "answer", title: "summarize", answer: "pick the PDF and ask again — i'll read the whole thing, not just the page you're on.", actions: ["choose pdf"], pickFile: "pdf" };
  }

  if (t.includes("error") || t.includes("not working") || t.includes("broken") || t.includes("what's this")) {
    const clip = request.clipboardText ?? "";
    if (clip) return { kind: "answer", title: "looks like", answer: explainError(clip), actions: ["explain more", "fix it"] };
    if (request.screenshotBase64) {
      return { kind: "answer", title: "what i see", answer: "i have the screen area but no model key to read it. add an Anthropic key in keys, or paste the error. without it i can still walk you through common fixes.", actions: ["add key"] };
    }
    return { kind: "answer", title: "show me", answer: "circle the error — press the pencil when you summon me — or copy it and ask again. i'll read the whole thing.", actions: ["circle it"] };
  }

  if (t.includes("teach me") || t.startsWith("how do i") || t.startsWith("how to") || t.includes("walk me through") || t.includes("show me how") || t.includes("learn ")) {
    let topic = raw.toLowerCase().replace(/^(teach me |how do i |how to |walk me through |show me how to |learn )/, "").replace(/\?/g, "");
    topic = sentence(topic.slice(0, 48));
    return { kind: "teach", title: `teach: ${topic}`, answer: `alright — ${topic}. i'll mark each step on screen and wait for you. take your time; i'll only move when you do.`, speak: `Let's learn ${topic}.`, teachSteps: teachSteps(topic) };
  }

  if (t.includes("build me") || t.includes("write a script") || t.includes("make a script") || t.includes("fix this bug") || t.includes("fix the bug") || t.includes("refactor") || t.includes("set up this repo") || t.includes("set up this github") || t.includes("run it")) {
    const agent = request.settings?.selectedAgent ?? "claude";
    return {
      kind: "coding",
      title: shortTitle(raw),
      answer: `i'll hand this to ${agent}. first you'll see the plan and the files it wants to touch — nothing runs until you say so.`,
      speak: `I'll hand this to ${agent}.`,
      risk: "medium",
      previewSummary: `${agent} works on: ${shortTitle(raw)}`,
      previewSteps: ["read the project", "plan the change", "edit files", "run tests or a check", "summarise in plain english"],
      apps: [agent],
      actions: ["review"],
    };
  }

  if (request.screenshotBase64) {
    return { kind: "answer", title: "what i see", answer: "i have the screen area, but reading it needs an Anthropic key. paste the text here, or add a key in keys and ask again.", actions: ["add key"] };
  }

  return {
    kind: "answer",
    title: "okidoki",
    answer: `i heard “${shortTitle(raw)}”. i can answer it, do the small version now, or teach you how. which one?`,
    speak: "Want me to show you, or do it?",
    clarification: "want me to show you, or do it?",
    actions: ["show me", "do it"],
  };
}

export function findDecision(query: string, request: ThinkRequest): Decision {
  const results = findTools(query);
  if (!results.length) {
    return {
      kind: "answer",
      title: "find a tool",
      answer: `nothing in the open-source catalog matches “${query}”. tell me what the job is and i'll compare a few options by upkeep, popularity and license.`,
    };
  }
  const tool = results[0];
  return {
    kind: "terminal",
    title: `install ${tool.name}`,
    answer: `${tool.name} replaces ${tool.replaces}: ${tool.blurb}\n\nit's ${tool.license}, and one homebrew command away. install it?`,
    risk: "medium",
    previewSummary: `install ${tool.name} with homebrew`,
    previewSteps: [`run ${tool.installCommand}`, `verify ${tool.command} is on your path`],
    commands: [tool.installCommand],
    apps: ["Terminal"],
    builtin: "tool-search",
    actions: ["install"],
  };
}
