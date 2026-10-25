import type { ConceptBeat, ConceptFollowRequest, ConceptFollowUp, ConceptLesson, ConceptRequest } from "./types";
import { callAnthropic } from "./teach";

/** The stage's vocabulary, kept in one place so the prompt and the validator agree. */
export const PART_TYPES = [
  "group", "box", "sphere", "cylinder", "cone", "torus", "tube", "gear", "spring", "arrow", "label", "plane",
  "surface", "plot", "axes", "grid", "molecule", "particles", "text", "ring", "lattice",
] as const;

export const ACTION_TYPES = [
  "show", "hide", "move", "rotate", "spin", "oscillate", "pulse", "highlight", "camera", "orbit", "explode",
  "cutaway", "xray", "flow", "color", "label", "point", "wait",
] as const;

const SPEC_REFERENCE = `
Scene spec (JSON):
  mode: "3d" or "2d" (2d = flat diagram looking down the z axis; use for plots, flows, timelines)
  camera: { position: [x,y,z], target: [x,y,z] }   (3d default position [6,4,8] looking at the origin; keep the whole model within about 6 units of the origin)
  parts: each { id, type, name, description, color?, position?, rotation? (radians), scale?, opacity?, visible?, parent? } plus by type:
    group {}  box {size:[w,h,d]}  sphere {radius}  cylinder {radius,height,radiusTop?,radiusBottom?}  cone {radius,height}  torus {radius,tube}
    tube {path:[[x,y,z]...], radius}  gear {radius,teeth,thickness}  spring {radius,height,coils,tube}
    arrow {from:[x,y,z], to:[x,y,z], width?}  label {text, anchor?: partId, offset?: [x,y,z]}  plane {size:[w,h]}
    surface {expr:"sin(x)*cos(y)", xRange:[a,b], yRange:[a,b], colorBy:"height"}   (z = f(x,y); expr uses x,y and sin cos tan exp log sqrt abs pow min max pi e)
    plot {expr:"x^2/8", xRange:[a,b]}   (y = f(x), 2d)   axes {size, labels:[x,y,z]}   grid {size, divisions}
    molecule {atoms:[{el:"C",pos:[x,y,z]}], bonds:[[i,j,order]], style:"ball-stick"}   (or set molecule_name and the real structure is fetched)
    particles {path:[[x,y,z]...], count, speed, size}   text {text,size}   ring {radius, tube}   lattice {nx,ny,nz,spacing,radius}
  Every part the learner should be able to click needs a name and a one-sentence description.
  Parts that appear during a beat start with visible:false and are revealed with a show action.

Beats: each { say, caption?, duration?, actions: [...] , points?: [[fx,fy]] }
  say is what's spoken (one or two sentences). caption is a shorter on-screen line (optional; defaults to say).
  points are 0–1 fractions of the learner's display to circle on the real screen while this beat plays (only when the lesson refers to something visible there).
  actions (run together; seconds default ~1.2):
    {type:"show", ids:[...], effect:"grow"|"fade"|"drop"}  {type:"hide", ids}  {type:"move", id, to:[x,y,z], seconds}
    {type:"rotate", id, by:[rx,ry,rz], seconds}  {type:"spin", id, axis:"x"|"y"|"z", rpm, on}  {type:"oscillate", id, axis, amplitude, period, on}
    {type:"pulse", ids}  {type:"highlight", ids, on}  {type:"camera", position, target, seconds}  {type:"orbit", on, rpm}
    {type:"explode", factor}  {type:"cutaway", axis, at, on}  {type:"xray", ids?, on}  {type:"flow", id, on}
    {type:"color", id, color}  {type:"label", id, text}  {type:"wait", seconds}
`;

const conceptTool = {
  name: "okidoki_concept",
  description: "Build a short narrated 2D/3D lesson for the stage.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "2-5 lowercase words" },
      intro: { type: "string", description: "one warm sentence spoken before the first beat" },
      mode: { type: "string", enum: ["3d", "2d"] },
      camera: { type: "object", properties: { position: { type: "array", items: { type: "number" } }, target: { type: "array", items: { type: "number" } } } },
      parts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: [...PART_TYPES] }, name: { type: "string" }, description: { type: "string" } }, required: ["id", "type"], additionalProperties: true } },
      beats: {
        type: "array",
        items: {
          type: "object",
          properties: {
            say: { type: "string" },
            caption: { type: "string" },
            duration: { type: "number" },
            actions: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: [...ACTION_TYPES] } }, required: ["type"], additionalProperties: true } },
            points: { type: "array", items: { type: "array", items: { type: "number" } } },
          },
          required: ["say", "actions"],
        },
      },
      molecule_name: { type: "string", description: "when the subject is a molecule or compound: its common name, e.g. 'caffeine', so the real 3D structure can be fetched. then include ONE molecule part with id 'mol' and empty atoms; it gets filled in." },
      photo_query: { type: "string", description: "when the subject is a real thing (engine, animal, building, planet, person): a Wikipedia article title for a photo card, e.g. 'Four-stroke engine'" },
    },
    required: ["title", "intro", "mode", "parts", "beats"],
  },
};

function conceptSystem(request: ConceptRequest): string {
  return [
    `You are Okidoki's tutor, explaining "${request.topic}" with a small animated 2D/3D model that floats beside what the learner is looking at.`,
    `First decide the ONE mental model that makes this click, then build only that. Teach it in 4-7 beats. Each beat must change the model visibly (parts appear, something moves or spins, the camera comes closer, a part lights up) while you narrate one idea. The learner can drag to orbit and click any named part to ask about it, so give parts real names and one-sentence descriptions in the words a learner would use.`,
    `Pick the mode deliberately: 3d for physical things (machines, anatomy, molecules, planets, buildings, devices); 2d for ideas and processes (flows, algorithms, data structures, networks, timelines, graphs, finance, physics diagrams). In 2d lay things out left-to-right or top-to-bottom like a clean diagram, with arrows and labels.`,
    `If they pointed at something on screen ("this chart", "this code", "this video", "this diagram"), model THAT thing from the screenshot, with the same names and numbers they can see, and add points so the matching spot on their screen gets circled.`,
    `Style: short, warm, concrete, lowercase labels, no emoji. Narration is spoken aloud: one or two sentences per beat. Fill title and intro first — they are spoken while the model is still being drawn.`,
    `Make it mechanically plausible: an engine has a crank, rods and pistons that oscillate; a cell has a membrane and organelles; a neural net has layers of spheres with tubes between them and particles flowing; the solar system has orbit rings and spinning planets. Prefer assembly beats (parts arriving one by one) over a static model. Use explode, cutaway, xray and camera moves where they explain something.`,
    `Give functional groups distinct colors and anchor labels to parts. No walls of text: at most one text part per beat.`,
    `Keep the whole model within about ±4 units of the origin so the default camera frames it, part count under 24, and reveal parts with show actions.`,
    request.language ? `Write everything in ${request.language}.` : ``,
    SPEC_REFERENCE,
    request.pageTitle || request.pageURL ? `They are looking at: ${request.pageTitle ?? ""} ${request.pageURL ?? ""}`.trim() : ``,
    request.context ? `On screen: ${request.context.slice(0, 1200)}` : ``,
    request.screenshotBase64 ? `A screenshot of their display is attached. If the lesson refers to something visible there, add points (fractions of the display) to that beat so it gets circled.` : ``,
  ].filter(Boolean).join("\n");
}

type JSONObject = Record<string, unknown>;

function num(value: unknown, fallback = 0, limit = 1000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(-limit, Math.min(limit, value));
}

function vec(value: unknown, fallback: number[] = [0, 0, 0]): number[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.slice(0, 3).map((v) => num(v));
  while (out.length < 3) out.push(0);
  return out;
}

/** Keep only well-formed parts and actions so the stage never has to guess. */
export function sanitizeScene(raw: JSONObject): { scene: JSONObject; parts: { id: string; name: string }[]; warnings: string[] } {
  const warnings: string[] = [];
  const parts: JSONObject[] = [];
  const ids = new Set<string>();
  const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
  for (const item of rawParts.slice(0, 60)) {
    if (!item || typeof item !== "object") continue;
    const part = { ...(item as JSONObject) };
    const id = typeof part.id === "string" ? part.id.trim().slice(0, 40) : "";
    const type = typeof part.type === "string" ? part.type : "";
    if (!id || ids.has(id) || !(PART_TYPES as readonly string[]).includes(type)) {
      warnings.push(`dropped part ${id || "?"} (${type || "no type"})`);
      continue;
    }
    ids.add(id);
    part.id = id;
    if (part.position !== undefined) part.position = vec(part.position);
    if (part.rotation !== undefined) part.rotation = vec(part.rotation);
    if (typeof part.scale === "number") part.scale = num(part.scale, 1, 50);
    else if (Array.isArray(part.scale)) part.scale = vec(part.scale, [1, 1, 1]);
    if (part.opacity !== undefined) part.opacity = Math.max(0, Math.min(1, num(part.opacity, 1)));
    if (typeof part.name === "string") part.name = part.name.slice(0, 48);
    if (typeof part.description === "string") part.description = part.description.slice(0, 240);
    if (typeof part.parent !== "string") delete part.parent;
    parts.push(part);
  }
  for (const part of parts) {
    if (typeof part.parent === "string" && !ids.has(part.parent)) delete part.parent;
  }
  const beats: JSONObject[] = [];
  const rawBeats = Array.isArray(raw.beats) ? raw.beats : [];
  for (const item of rawBeats.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const beat = item as JSONObject;
    const say = typeof beat.say === "string" ? beat.say.trim().slice(0, 320) : "";
    if (!say) continue;
    const actions: JSONObject[] = [];
    for (const a of (Array.isArray(beat.actions) ? beat.actions : []).slice(0, 10)) {
      if (!a || typeof a !== "object") continue;
      const action = { ...(a as JSONObject) };
      const type = typeof action.type === "string" ? action.type : "";
      if (!(ACTION_TYPES as readonly string[]).includes(type)) { warnings.push(`dropped action ${type}`); continue; }
      if (Array.isArray(action.ids)) {
        action.ids = action.ids.filter((x): x is string => typeof x === "string" && ids.has(x));
        if ((action.ids as string[]).length === 0 && ["show", "hide", "pulse", "highlight"].includes(type)) continue;
      }
      if (typeof action.id === "string" && !ids.has(action.id) && !["camera", "orbit", "explode", "cutaway", "xray", "wait", "point"].includes(type)) {
        warnings.push(`action ${type} points at unknown part ${action.id}`);
        continue;
      }
      if (action.seconds !== undefined) action.seconds = Math.max(0.2, num(action.seconds, 1.2, 12));
      if (action.to !== undefined) action.to = vec(action.to);
      if (action.by !== undefined) action.by = vec(action.by);
      if (action.position !== undefined) action.position = vec(action.position);
      if (action.target !== undefined) action.target = vec(action.target);
      if (action.factor !== undefined) action.factor = Math.max(0, num(action.factor, 1, 3));
      if (action.rpm !== undefined) action.rpm = num(action.rpm, 10, 600);
      actions.push(action);
    }
    const points: [number, number][] = [];
    for (const p of (Array.isArray(beat.points) ? beat.points : []).slice(0, 3)) {
      if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number"
        && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) {
        points.push([p[0], p[1]]);
      }
    }
    beats.push({
      say,
      caption: typeof beat.caption === "string" ? beat.caption.trim().slice(0, 140) : undefined,
      duration: beat.duration !== undefined ? Math.max(0.8, num(beat.duration, 2, 20)) : undefined,
      actions,
      points,
    });
  }
  const mode = raw.mode === "2d" ? "2d" : "3d";
  const camera = raw.camera && typeof raw.camera === "object"
    ? { position: vec((raw.camera as JSONObject).position, [6, 4, 8]), target: vec((raw.camera as JSONObject).target, [0, 0, 0]) }
    : { position: mode === "2d" ? [0, 0, 10] : [6, 4, 8], target: [0, 0, 0] };
  const scene: JSONObject = { title: typeof raw.title === "string" ? raw.title : "lesson", mode, camera, parts, beats };
  return {
    scene,
    parts: parts.filter((p) => typeof p.name === "string" && p.name).map((p) => ({ id: p.id as string, name: p.name as string })),
    warnings,
  };
}

// MARK: real data

const CPK: Record<string, string> = { H: "#f2f2f2", C: "#8a8f98", N: "#3f6cff", O: "#ff4d4d", S: "#ffd84d", P: "#ff9a3c", F: "#6ddf6d", Cl: "#2fd36f", Br: "#a3542d", I: "#8a2be2" };
const ELEMENTS = ["", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe"];

/** Real 3D coordinates from PubChem (free, no key). Returns a molecule part body or null. */
export async function fetchMolecule(name: string): Promise<JSONObject | null> {
  try {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/JSON?record_type=3d`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const json = await response.json() as { PC_Compounds?: { atoms?: { aid: number[]; element: number[] }; bonds?: { aid1: number[]; aid2: number[]; order: number[] }; coords?: { conformers?: { x: number[]; y: number[]; z: number[] }[] }[] }[] };
    const compound = json.PC_Compounds?.[0];
    const conformer = compound?.coords?.[0]?.conformers?.[0];
    if (!compound?.atoms || !conformer) return null;
    const atoms = compound.atoms.element.map((z, i) => ({
      el: ELEMENTS[z] ?? "C",
      pos: [conformer.x[i] ?? 0, conformer.y[i] ?? 0, conformer.z[i] ?? 0],
    }));
    const index = new Map(compound.atoms.aid.map((aid, i) => [aid, i]));
    const bonds = (compound.bonds?.aid1 ?? []).map((a, i) => [index.get(a) ?? 0, index.get(compound.bonds!.aid2[i]) ?? 0, compound.bonds!.order[i] ?? 1]);
    // Centre the molecule on the origin.
    const cx = atoms.reduce((s, a) => s + a.pos[0], 0) / atoms.length;
    const cy = atoms.reduce((s, a) => s + a.pos[1], 0) / atoms.length;
    const cz = atoms.reduce((s, a) => s + a.pos[2], 0) / atoms.length;
    for (const a of atoms) a.pos = [a.pos[0] - cx, a.pos[1] - cy, a.pos[2] - cz];
    return { atoms, bonds, style: "ball-stick", colors: CPK };
  } catch {
    return null;
  }
}

/** A photo card from Wikipedia (summary thumbnail), fetched here because the stage has no network. */
export async function fetchPhoto(query: string): Promise<{ title: string; caption: string; dataURL: string; credit: string } | null> {
  try {
    const summary = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, "_"))}`, {
      headers: { accept: "application/json", "user-agent": "okidoki/1.0 (teaching assistant)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!summary.ok) return null;
    const json = await summary.json() as { title?: string; extract?: string; thumbnail?: { source: string }; originalimage?: { source: string } };
    const source = json.thumbnail?.source ?? json.originalimage?.source;
    if (!source) return null;
    const bigger = source.replace(/\/(\d+)px-/, "/640px-");
    const image = await fetch(bigger, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "okidoki/1.0 (teaching assistant)" } });
    if (!image.ok) return null;
    const type = image.headers.get("content-type") ?? "image/jpeg";
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.byteLength > 3_000_000) return null;
    return {
      title: json.title ?? query,
      caption: (json.extract ?? "").split(". ")[0]?.slice(0, 160) ?? "",
      dataURL: `data:${type};base64,${bytes.toString("base64")}`,
      credit: "wikipedia / wikimedia commons",
    };
  } catch {
    return null;
  }
}

function toBeats(scene: JSONObject): ConceptBeat[] {
  return (scene.beats as JSONObject[]).map((b) => ({
    say: b.say as string,
    caption: b.caption as string | undefined,
    duration: b.duration as number | undefined,
    points: (b.points as [number, number][]) ?? [],
  }));
}

/** Pull a top-level string field out of a partially streamed JSON object, once its closing quote has arrived. */
export function partialField(partial: string, field: string): string | undefined {
  const match = partial.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return undefined;
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return undefined; }
}

/**
 * Streams one tool call and resolves with the final tool input. `onPartial` sees the accumulated
 * JSON text as it grows, so callers can act on early fields (title, intro) while the rest streams.
 */
export async function callAnthropicStreaming(
  body: Record<string, unknown>,
  apiKey: string,
  timeout: number,
  onPartial: (partial: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 160);
    throw new Error(`model ${response.status}: ${detail}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolIndex: number | null = null;
  let partial = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      let event: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; partial_json?: string }; error?: unknown };
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
      // An overload or rate limit arrives as an event on the stream, not as a status code.
      if (event.type === "error") throw new Error(`model stream error: ${JSON.stringify(event.error ?? event).slice(0, 300)}`);
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && toolIndex === null) {
        toolIndex = event.index ?? 0;
      } else if (event.type === "content_block_delta" && event.index === toolIndex && event.delta?.type === "input_json_delta") {
        partial += event.delta.partial_json ?? "";
        onPartial(partial);
      } else if (event.type === "content_block_stop" && event.index === toolIndex) {
        done = true;
      } else if (event.type === "message_stop") {
        done = true;
      }
    }
  }
  // The lesson is whole once its tool block closes; don't hold the connection open for the rest.
  await reader.cancel().catch(() => {});
  if (toolIndex === null || !partial.trim()) return null;
  try { return JSON.parse(partial) as Record<string, unknown>; } catch { return null; }
}

export interface ConceptProgress {
  /** Fired once, as soon as the title and intro have streamed in. */
  intro?: (title: string, intro: string) => void;
}

export async function conceptLesson(
  request: ConceptRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  progress: ConceptProgress = {},
): Promise<{ lesson: ConceptLesson | null; usedModel: boolean; error?: string; warnings?: string[] }> {
  if (!apiKey) return { lesson: null, usedModel: false, error: "anthropic key required" };
  const model = request.model || "claude-haiku-5-5";
  const content: unknown[] = [];
  if (request.screenshotBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: request.screenshotBase64 } });
  }
  content.push({ type: "text", text: `Teach: ${request.topic}` });
  try {
    let introSent = false;
    const input = await callAnthropicStreaming({
      model,
      max_tokens: 5000,
      system: conceptSystem(request),
      messages: [{ role: "user", content }],
      tools: [conceptTool],
      tool_choice: { type: "auto" },
    }, apiKey, 110_000, (partial) => {
      if (introSent || !progress.intro) return;
      const title = partialField(partial, "title");
      const intro = partialField(partial, "intro");
      if (title !== undefined && intro !== undefined) {
        introSent = true;
        progress.intro(title.slice(0, 60), intro.slice(0, 240));
      }
    }, fetchImpl);
    if (!input) return { lesson: null, usedModel: false, error: "empty model response" };
    const { scene, parts, warnings } = sanitizeScene(input);
    if ((scene.parts as unknown[]).length === 0 || (scene.beats as unknown[]).length === 0) {
      return { lesson: null, usedModel: true, error: "the lesson came back empty", warnings };
    }
    const [molecule, photo] = await Promise.all([
      typeof input.molecule_name === "string" && input.molecule_name ? fetchMolecule(input.molecule_name) : Promise.resolve(null),
      typeof input.photo_query === "string" && input.photo_query ? fetchPhoto(input.photo_query) : Promise.resolve(null),
    ]);
    if (molecule) {
      const list = scene.parts as JSONObject[];
      const existing = list.find((p) => p.type === "molecule");
      if (existing) Object.assign(existing, molecule);
      else list.unshift({ id: "mol", type: "molecule", name: String(input.molecule_name), description: `the ${input.molecule_name} molecule`, ...molecule });
    }
    const lesson: ConceptLesson = {
      title: String(input.title ?? request.topic).slice(0, 60),
      intro: String(input.intro ?? "").slice(0, 240),
      mode: scene.mode as "3d" | "2d",
      sceneJSON: JSON.stringify(scene),
      beats: toBeats(scene),
      photo: photo ?? undefined,
      parts: parts.map((p) => `${p.id}: ${p.name}`),
    };
    return { lesson, usedModel: true, warnings };
  } catch (error) {
    return { lesson: null, usedModel: false, error: error instanceof Error ? error.message : "model unavailable" };
  }
}

const followTool = {
  name: "okidoki_concept_more",
  description: "Answer a question about the model with a short answer and 1-3 new beats, adding parts if needed.",
  input_schema: {
    type: "object",
    properties: {
      answer: { type: "string", description: "one or two spoken sentences" },
      parts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: [...PART_TYPES] } }, required: ["id", "type"], additionalProperties: true } },
      beats: { type: "array", items: { type: "object", properties: { say: { type: "string" }, caption: { type: "string" }, actions: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["say", "actions"] } },
    },
    required: ["answer", "beats"],
  },
};

export async function conceptFollowUp(
  request: ConceptFollowRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ follow: ConceptFollowUp | null; usedModel: boolean; error?: string }> {
  if (!apiKey) return { follow: null, usedModel: false, error: "anthropic key required" };
  const model = request.model || "claude-haiku-5-5";
  const system = [
    `You are Okidoki's tutor, mid-lesson on "${request.topic}" with a 3D/2D model on the stage. The learner asked a question${request.partName ? ` about the part “${request.partName}” (id ${request.partId})` : ""}.`,
    `Answer in one or two spoken sentences, then add 1-3 beats that show the answer on the existing model: highlight or pulse the part, move the camera to it, xray the rest, or add a small new part (a label, an arrow) if that helps. Reference existing part ids exactly.`,
    request.language ? `Write in ${request.language}.` : ``,
    SPEC_REFERENCE,
    `Current scene:\n${request.sceneSummary.slice(0, 3000)}`,
  ].filter(Boolean).join("\n");
  try {
    const input = await callAnthropic({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: request.question }],
      tools: [followTool],
      tool_choice: { type: "auto" },
    }, apiKey, 60_000, fetchImpl);
    if (!input) return { follow: null, usedModel: false, error: "empty model response" };
    // Reuse the scene sanitizer; unknown-id checks are relaxed since existing parts aren't listed here.
    const sanitized = sanitizeScene({ parts: input.parts ?? [], beats: input.beats ?? [], mode: "3d" });
    const beats = (sanitized.scene.beats as JSONObject[]);
    // sanitizeScene drops actions pointing at ids it hasn't seen; re-run leniently for follow-ups.
    const lenientBeats = (Array.isArray(input.beats) ? input.beats : []).slice(0, 4).map((b) => {
      const beat = b as JSONObject;
      const actions = (Array.isArray(beat.actions) ? beat.actions : []).filter((a) => a && typeof a === "object" && (ACTION_TYPES as readonly string[]).includes(String((a as JSONObject).type))).slice(0, 8);
      return { say: String(beat.say ?? "").slice(0, 320), caption: typeof beat.caption === "string" ? beat.caption.slice(0, 140) : undefined, actions, points: [] };
    }).filter((b) => b.say);
    const chosen = lenientBeats.length ? lenientBeats : beats;
    const follow: ConceptFollowUp = {
      answer: String(input.answer ?? "").slice(0, 400),
      appendJSON: JSON.stringify({ parts: sanitized.scene.parts, beats: chosen }),
      beats: chosen.map((b) => ({ say: b.say as string, caption: b.caption as string | undefined, points: [] })),
    };
    return { follow, usedModel: true };
  } catch (error) {
    return { follow: null, usedModel: false, error: error instanceof Error ? error.message : "model unavailable" };
  }
}
