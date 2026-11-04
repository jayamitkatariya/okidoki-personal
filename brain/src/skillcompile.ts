// The three places smart replay asks the model, each once and up front, never per step:
//
//   compile — when a run is saved as a skill: which typed values are inputs, which steps only apply
//             sometimes, what repeats, what's irreversible, and what to read off the last page.
//   resolve — before a replay: one person's (invoice's, row's) values, found in their documents.
//   route   — for an everyday request: which skill (or template) does it, for whom, or none.
//
// Each answer comes back through a forced tool call, so it's always the shape the Mac expects.

type Fetch = typeof fetch;

const API = "https://api.anthropic.com/v1/messages";
/** Once per saved skill, in the background: the most capable model, since every replay inherits its reading. */
export const COMPILE_MODEL = "claude-opus-5-5";
export const RESOLVE_MODEL = "claude-sonnet-5-5";
export const ROUTE_MODEL = "claude-sonnet-5-5";

/** Every object closed (`additionalProperties: false`), as structured outputs requires. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] = key === "properties" && value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strictSchema(v)]))
      : strictSchema(value);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** One model call whose answer is JSON matching `tool.input_schema` (structured outputs). */
async function forcedTool<T>(opts: {
  key: string | undefined; model: string; system: string; user: unknown[] | string;
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  maxTokens?: number; timeoutMs?: number; fetchImpl?: Fetch; effort?: "low" | "medium" | "high";
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  if (!opts.key) return { ok: false, error: "no Anthropic key" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(API, {
      method: "POST",
      headers: { "x-api-key": opts.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 16000,
        system: `${opts.system}\n\nAnswer with ${opts.tool.description}`,
        output_config: {
          format: { type: "json_schema", schema: strictSchema(opts.tool.input_schema) },
          ...(opts.effort ? { effort: opts.effort } : {}),
        },
        messages: [{ role: "user", content: opts.user }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "the model took too long" : "couldn't reach the model" };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `the model said ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}` };
  }
  const data = (await response.json()) as { stop_reason?: string; content?: { type: string; text?: string; input?: unknown }[] };
  if (data.stop_reason === "refusal") return { ok: false, error: "the model declined" };
  if (data.stop_reason === "max_tokens") return { ok: false, error: "the answer was cut off" };
  // Tests (and any older path) may still answer with a tool call; take that too.
  const call = (data.content ?? []).find((b) => b.type === "tool_use" && b.input && typeof b.input === "object");
  if (call) return { ok: true, value: call.input as T };
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return { ok: true, value: value as T };
  } catch {}
  return { ok: false, error: "the model didn't answer in the expected shape" };
}

// MARK: - compile

export interface CompileStep {
  i: number;
  action: string;
  text: string;
  label?: string;
  role?: string;
  /** What was typed or chosen; secrets arrive as {{vault:…}} and stay that way. */
  input?: string;
  url?: string;
  /** Headings or labels on the page right after the step. */
  after?: string[];
}

export interface CompileRequest {
  goal: string;
  /** The agent's closing line ("Filed. Reference REF-448990."), where a captured value usually shows. */
  summary?: string;
  surface: "browser" | "mac";
  steps: CompileStep[];
  /** Each page or window the run went through, with some of its text: what the run didn't use is here. */
  pages?: { url?: string; title?: string; text?: string }[];
  /** Files the run read (vault documents), for the inputs' hints. */
  documents?: string[];
}

export interface CompiledInput {
  name: string; description: string; kind: string; fields?: string[]; format?: string; pattern?: string;
  choices?: string[]; source?: string; hint?: string; sensitive?: boolean; required?: boolean; example?: string;
}

export interface CompileResult {
  name?: string;
  intent: string;
  itemNoun?: string;
  inputs: CompiledInput[];
  /** Step i's input (or URL) rewritten with {{placeholders}}. */
  substitutions: { step: number; input: string }[];
  conditions: { step: number; when: string }[];
  loops: { start: number; length: number; over: string }[];
  /** Steps to add for parts of the goal this run never exercised: done by the model on the passes
   *  that need them, until a replay learns them as plain steps. Inserted before step `before`. */
  thinkSteps: { before: number; goal: string; when?: string }[];
  irreversible: number[];
  capture?: { name: string; example: string; description?: string } | null;
  /** Detours that weren't part of the job (a wrong click undone, a stray scroll). */
  drop: number[];
  alwaysConfirm?: boolean;
}

const compileTool = {
  name: "skill",
  description: "the generalized skill, as JSON.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the skill, 2-5 words, lowercase (e.g. 'file acme return')." },
      intent: { type: "string", description: "One line: what the skill achieves, for any item, without this run's specifics." },
      itemNoun: { type: "string", description: "What one pass is for: person, invoice, order, row, customer…" },
      inputs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "snake_case placeholder name" },
            description: { type: "string" },
            kind: { type: "string", enum: ["text", "number", "money", "date", "choice", "list", "file"] },
            fields: { type: "array", items: { type: "string" }, description: "For kind list: the fields of one entry." },
            format: { type: "string", description: "money: plain | grouped | indian; date: a pattern like dd/MM/yyyy; text: upper | lower" },
            pattern: { type: "string", description: "A regex the value must match, only when the format is strict (an id, a PAN, a postcode)." },
            choices: { type: "array", items: { type: "string" }, description: "For kind choice: the exact option texts on the page." },
            source: { type: "string", enum: ["document", "request", "record", "page", "builtin"] },
            hint: { type: "string", description: "Where to find it, e.g. 'Form 16 Part B, gross salary'." },
            sensitive: { type: "boolean" },
            required: { type: "boolean" },
            example: { type: "string", description: "This run's value (omit for sensitive inputs)." },
          },
          required: ["name", "description", "kind"],
        },
      },
      substitutions: {
        type: "array",
        items: { type: "object", properties: { step: { type: "integer" }, input: { type: "string" } }, required: ["step", "input"] },
      },
      conditions: {
        type: "array",
        items: { type: "object", properties: { step: { type: "integer" }, when: { type: "string" } }, required: ["step", "when"] },
      },
      loops: {
        type: "array",
        items: { type: "object", properties: { start: { type: "integer" }, length: { type: "integer" }, over: { type: "string" } }, required: ["start", "length", "over"] },
      },
      thinkSteps: {
        type: "array",
        items: { type: "object", properties: { before: { type: "integer" }, goal: { type: "string" }, when: { type: "string" } }, required: ["before", "goal"] },
      },
      irreversible: { type: "array", items: { type: "integer" } },
      capture: {
        type: "object",
        properties: { name: { type: "string" }, example: { type: "string" }, description: { type: "string" } },
        required: ["name", "example"],
      },
      drop: { type: "array", items: { type: "integer" } },
      alwaysConfirm: { type: "boolean", description: "True when the skill spends money or deletes something." },
    },
    required: ["intent", "inputs", "substitutions", "conditions", "loops", "thinkSteps", "irreversible", "drop"],
  },
};

const COMPILE_SYSTEM = `You turn one recorded run of a task into a reusable skill that a replay engine repeats for other people, invoices or rows, fast and without a model.

The replay engine fills {{placeholders}} from per-item values, skips steps whose "when" is false, repeats loops once per entry of a list input (with {{item.field}} inside), and runs a "think" step (a short sub-goal done by a model) only where no recorded step exists. Everything else is replayed exactly.

Rules:
- Every typed or chosen value that would differ for another item becomes an input with a substitution. Values that are the same for everyone (a site's fixed option, a login username used for the account, a search term that's part of the job itself) stay literal. Never turn {{vault:…}} text into an input; leave those steps alone.
- A substitution's input is the step's new text with each placeholder written in double braces, e.g. "{{pan}}" or "{{first_name}} {{last_name}}", never a bare name.
- A "when" is "{{name}}" (true when that input has a value that isn't empty, 0 or none), "!{{name}}", or "{{name}} == exact value"; never compare an amount to yes/no.
- For a "select" step, the substitution is the placeholder alone and the input is kind choice with the page's exact option texts as choices.
- Give money and numbers kind money/number and the format the field shows when typed (plain unless the run typed it grouped). Add a pattern only for strict identifiers.
- The goal and the pages show parts of the job this run didn't use (an optional section, a list that was empty this time). For each, add an input (a list for repeated rows, with fields) and a thinkStep placed where that part belongs (before the step that leaves that page), with a "when" so it only runs when needed, e.g. when "{{deductions}}". Describe the think goal concretely in terms of the page: which control to use and which input values to enter, e.g. "For each entry in {{deductions}}, click 'Add deduction', then choose its section in the new row's section dropdown and type its amount in the new row's amount field." Use {{placeholders}} in the goal.
- If steps in this run repeat a pattern once per entry, make them a loop over a list input.
- A step that applies only to some items (a checkbox for capital gains) gets a "when".
- Mark steps that submit, file, pay, send, post or delete as irreversible. alwaysConfirm only when money is spent or something is deleted.
- If the last page showed a value worth keeping (a reference, an order number, a confirmation id), give capture with its example from the run.
- If the task's point is to find something out (a price, a rating, a definition, a list of results), give capture: a short snake_case name, a description of exactly what to read as the task asked it ("the top five video results: title, channel, length, views"), and the run's answer as example. Never make a thinkStep that only reads or reports: reading the page is what capture does, in one look.
- Custom widgets: steps that worked a calendar (clicking a month/year dropdown inside it, then one specific day), an autocomplete (typing, then clicking or pressing Enter on one suggestion) or a slider pick this run's value by where it sat, so for another item they'd pick the wrong thing. Drop all of that widget's steps and put one thinkStep where they were, naming the field and the value, e.g. "Set 'Date of birth' to {{dob}} with its date picker (open it, choose the month and year, click the day), then check the field shows it." Recorded steps that type a value straight into an ordinary text field are not widgets; keep those.
- drop only true detours (a wrong click that was undone, a failed attempt) and widget steps replaced as above. Never drop signing in or typing into ordinary fields.
- An optional amount (capital gains, a bonus) is a money input that's empty when absent, used in "when": "{{capital_gains}}", and the think step types the amount; not a yes/no choice.
- Step numbers are the "i" values given. Keep names short, snake_case.`;

export async function compileSkill(request: CompileRequest, key: string | undefined, fetchImpl: Fetch = fetch, model = COMPILE_MODEL):
  Promise<{ ok: true; skill: CompileResult } | { ok: false; error: string }> {
  if (!request.steps?.length) return { ok: false, error: "no steps" };
  const pages = (request.pages ?? []).slice(0, 12).map((p) => ({ url: p.url, title: p.title, text: (p.text ?? "").slice(0, 1800) }));
  const user = [
    `Task as asked: ${request.goal}`,
    request.summary ? `How the run ended: ${request.summary}` : "",
    `Surface: ${request.surface}`,
    request.documents?.length ? `Documents the run read: ${request.documents.join(", ")}` : "",
    `Recorded steps:\n${JSON.stringify(request.steps, null, 1)}`,
    pages.length ? `Pages it went through:\n${JSON.stringify(pages, null, 1)}` : "",
  ].filter(Boolean).join("\n\n");
  const result = await forcedTool<CompileResult>({ key, model, system: COMPILE_SYSTEM, user, tool: compileTool, maxTokens: 32000, timeoutMs: 170_000, fetchImpl, effort: "high" });
  if (!result.ok) return result;
  return { ok: true, skill: normalizeCompile(result.value, request.steps.map((s) => s.i)) };
}

/** Drops anything that points at steps that don't exist, so the Mac never trips on a bad index. */
export function normalizeCompile(raw: Partial<CompileResult>, stepIDs: number[]): CompileResult {
  const valid = new Set(stepIDs);
  const max = stepIDs.length ? Math.max(...stepIDs) : 0;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const inputs = arr<CompiledInput>(raw.inputs).filter((i) => i && typeof i.name === "string" && i.name.trim())
    .map((i) => ({ ...i, name: i.name.trim(), kind: i.kind || "text", description: i.description || i.name.trim() }));
  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    intent: typeof raw.intent === "string" ? raw.intent : "",
    itemNoun: typeof raw.itemNoun === "string" ? raw.itemNoun : undefined,
    inputs,
    substitutions: arr<{ step: number; input: string }>(raw.substitutions).filter((s) => valid.has(s.step) && typeof s.input === "string"),
    conditions: arr<{ step: number; when: string }>(raw.conditions).filter((c) => valid.has(c.step) && typeof c.when === "string"),
    loops: arr<{ start: number; length: number; over: string }>(raw.loops)
      .filter((l) => valid.has(l.start) && l.length >= 1 && typeof l.over === "string"),
    thinkSteps: arr<{ before: number; goal: string; when?: string }>(raw.thinkSteps)
      .filter((t) => typeof t.goal === "string" && t.goal.trim() && Number.isInteger(t.before) && t.before >= 0 && t.before <= max + 1),
    irreversible: arr<number>(raw.irreversible).filter((i) => valid.has(i)),
    capture: raw.capture && typeof raw.capture.name === "string" && typeof raw.capture.example === "string" ? raw.capture : null,
    drop: arr<number>(raw.drop).filter((i) => valid.has(i)),
    alwaysConfirm: raw.alwaysConfirm === true,
  };
}

// MARK: - resolve

export interface ResolveRequest {
  /** The item: a person's name, an invoice number, a row's key. */
  item: string;
  inputs: CompiledInput[];
  documents: { name: string; text: string }[];
  /** What the request said, which may hold values too ("…with income 9 lakh"). */
  request?: string;
}

export interface ResolvedValue { value: unknown; confidence: number; source?: string }

const RESOLVE_SYSTEM = `You fill in a form's values for one item from that item's documents, exactly as written there.

Rules:
- Use only the documents and the request. Never guess or invent a value; if it isn't there, give value "" and confidence 0.
- Only what's about this item counts. Some documents may be about someone or something else (another person, another
  invoice): ignore them entirely, and a value from one of them is never this item's. The request may name several items;
  use only the part about this one.
- Copy identifiers exactly (case, digits). Give money and numbers as plain digits (no commas or currency), dates as yyyy-MM-dd.
- For a list input, give an array of objects with exactly the listed fields; an empty array when the documents show none.
- For a choice input, give one of its choices verbatim.
- An optional input that the documents show is absent (no capital gains, no deductions) is "" or [] with high confidence.
- confidence: 0.95+ when read plainly from a document, ~0.7 when inferred (e.g. a total you added up), below 0.5 when unsure.
- source: the document name and where in it ("Form16.pdf, Part B").`;

export async function resolveValues(request: ResolveRequest, key: string | undefined, fetchImpl: Fetch = fetch, model = RESOLVE_MODEL):
  Promise<{ ok: true; values: Record<string, ResolvedValue> } | { ok: false; error: string }> {
  if (!request.inputs?.length) return { ok: true, values: {} };
  const properties: Record<string, unknown> = {};
  for (const input of request.inputs) {
    const valueSchema = input.kind === "list"
      ? { type: "array", items: { type: "object", properties: Object.fromEntries((input.fields ?? ["value"]).map((f) => [f, { type: "string" }])) } }
      : { type: "string" };
    properties[input.name] = {
      type: "object",
      properties: { value: valueSchema, confidence: { type: "number" }, source: { type: "string" } },
      required: ["value", "confidence"],
    };
  }
  const tool = {
    name: "values",
    description: `the values for ${request.item}, as JSON.`,
    input_schema: { type: "object", properties, required: request.inputs.map((i) => i.name) },
  };
  const docs = request.documents.slice(0, 12).map((d) => `<document name="${d.name}">\n${d.text.slice(0, 20_000)}\n</document>`).join("\n\n");
  const user = [
    `Item: ${request.item}`,
    request.request ? `The request: ${request.request}` : "",
    `Inputs to fill:\n${JSON.stringify(request.inputs.map((i) => ({ name: i.name, description: i.description, kind: i.kind, fields: i.fields, choices: i.choices, hint: i.hint, required: i.required ?? true })), null, 1)}`,
    docs ? `Documents:\n${docs}` : "No documents were found for this item.",
  ].filter(Boolean).join("\n\n");
  const result = await forcedTool<Record<string, ResolvedValue>>({ key, model, system: RESOLVE_SYSTEM, user, tool, maxTokens: 16000, timeoutMs: 90_000, fetchImpl, effort: "low" });
  if (!result.ok) return result;
  const values: Record<string, ResolvedValue> = {};
  for (const input of request.inputs) {
    const got = result.value[input.name];
    if (!got || typeof got !== "object") { values[input.name] = { value: "", confidence: 0 }; continue; }
    const confidence = typeof got.confidence === "number" ? Math.max(0, Math.min(1, got.confidence)) : 0;
    values[input.name] = { value: got.value ?? "", confidence, ...(typeof got.source === "string" ? { source: got.source } : {}) };
  }
  return { ok: true, values };
}

// MARK: - route

export interface RouteSkill { id: string; name: string; intent?: string; itemNoun?: string; inputs?: string[]; surface?: string; template?: boolean }
export interface RouteRequest { request: string; skills: RouteSkill[]; records?: string[] }
export interface RouteResult {
  kind: "skill" | "template" | "agent";
  id?: string;
  /** Who or what each pass is for, as named in the request. Empty means one pass. */
  items: string[];
  /** Values the request states outright ("to Goa", "qty 2"), by input name. */
  overrides: Record<string, string>;
  confidence: number;
  why?: string;
}

const ROUTE_SYSTEM = `You decide whether a saved skill can do what the user asked, so it runs instantly instead of an AI agent working it out from scratch.

Pick a skill only when it does the same job the request asks for (same site or app and same kind of action), only for different data. If the request asks for something the skill doesn't do, or is a question, or is ambiguous, answer kind "agent". Templates (template: true) are starting points: pick one when it fits and no learned skill does.

When several skills do the same job, pick the one whose inputs cover what changes between items. A skill with no inputs repeats exactly what was recorded, so it only fits a request for that same data once.

items: every person, invoice, order or row the request wants it done for, in order, as named ("for Jay, Jia and Neha" → ["Jay", "Jia", "Neha"]; "for invoices 4471 and 4472" → ["4471", "4472"]). Empty for a single unnamed pass. "everyone in X.csv" → ["every row in X.csv"].
overrides: only values the request states outright, keyed by the skill's input names.
confidence: how sure you are this skill is right for this request, 0-1:
- 0.9-1: the skill's intent is the job the request asks for, on the same site or app; only the data differs (other people, other values, other documents). Different data is the point of a skill, never a reason for doubt.
- 0.6-0.8: same site, but the request asks for a noticeably different action or an extra step the skill doesn't cover.
- below 0.5: a different job, or you can't tell which skill.
Missing values are not your concern: they're found later in the person's documents or asked for.`;

const routeTool = {
  name: "route",
  description: "which skill does it and for which items, as JSON.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["skill", "template", "agent"] },
      id: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      overrides: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] },
      },
      confidence: { type: "number" },
      why: { type: "string" },
    },
    required: ["kind", "items", "overrides", "confidence"],
  },
};

export async function routeRequest(request: RouteRequest, key: string | undefined, fetchImpl: Fetch = fetch, model = ROUTE_MODEL):
  Promise<{ ok: true; route: RouteResult } | { ok: false; error: string }> {
  const text = (request.request ?? "").trim();
  if (!text) return { ok: false, error: "empty request" };
  if (!request.skills?.length) return { ok: true, route: { kind: "agent", items: [], overrides: {}, confidence: 1, why: "no skills" } };
  const user = `Request: ${text}\n\nSkills:\n${JSON.stringify(request.skills.slice(0, 80), null, 1)}`
    + (request.records?.length ? `\n\nKnown record ids: ${request.records.slice(0, 60).join(", ")}` : "");
  const result = await forcedTool<RouteResult>({ key, model, system: ROUTE_SYSTEM, user, tool: routeTool, maxTokens: 4000, timeoutMs: 30_000, fetchImpl, effort: "low" });
  if (!result.ok) return result;
  const raw = result.value as RouteResult & { overrides: unknown };
  // The schema asks for [{name, value}] (structured outputs has no open maps); older answers were a map.
  if (Array.isArray(raw.overrides)) {
    raw.overrides = Object.fromEntries((raw.overrides as { name?: unknown; value?: unknown }[])
      .filter((o) => typeof o?.name === "string" && typeof o?.value === "string").map((o) => [o.name, o.value]));
  }
  const ids = new Set(request.skills.map((s) => s.id));
  const kind = raw.kind === "skill" || raw.kind === "template" ? raw.kind : "agent";
  const known = typeof raw.id === "string" && ids.has(raw.id);
  return {
    ok: true,
    route: {
      kind: kind !== "agent" && known ? kind : "agent",
      ...(known ? { id: raw.id } : {}),
      items: Array.isArray(raw.items) ? raw.items.filter((i) => typeof i === "string" && i.trim()).map((i) => i.trim()) : [],
      overrides: raw.overrides && typeof raw.overrides === "object"
        ? Object.fromEntries(Object.entries(raw.overrides).filter(([, v]) => typeof v === "string")) as Record<string, string> : {},
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      ...(typeof raw.why === "string" ? { why: raw.why } : {}),
    },
  };
}
