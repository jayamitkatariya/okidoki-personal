import { expect, test } from "bun:test";
import { think } from "../src/llm";
import { PLAN_REVIEW_PROMPT } from "../src/plan-review";

const cases = [
  {
    text: "Can you compress this video to 720p and save the copy in Downloads without changing the original?",
    proposed: { kind: "terminal", title: "compress video", answer: "Make a smaller copy", commands: ["ffmpeg -i input.mov output.mp4"] },
    corrected: { kind: "terminal", title: "compress to 720p in Downloads", answer: "Save a 720p copy in Downloads and preserve the original", commands: ["ffmpeg -nostdin -n -i {{file}} -vf scale=-2:720 ~/Downloads/video-small.mp4"], pick_file: "video" },
  },
  {
    text: "Convert my Word document to PDF and zip the PDF, keeping both originals.",
    proposed: { kind: "terminal", title: "convert to Word", answer: "Convert your document", commands: ["pandoc {{file}} -o output.docx"] },
    corrected: { kind: "terminal", title: "make PDF and ZIP", answer: "Make the PDF, then zip it; keep the source and PDF", commands: ["pandoc {{file}} -o output.pdf", "ditto -c -k output.pdf output.zip"], pick_file: "document" },
  },
  {
    text: "Preview which cache files can be removed. Do not delete anything.",
    proposed: { kind: "terminal", title: "clean caches", answer: "Preview caches", commands: ["mo clean"] },
    corrected: { kind: "terminal", title: "preview caches", answer: "Show the preview without removing files", commands: ["mo clean --dry-run"] },
  },
  {
    text: "Use the terminal file search to locate my presentation and return its full path.",
    proposed: { kind: "computer_use", title: "open Finder", answer: "Opening Finder", apps: ["Finder"] },
    corrected: { kind: "terminal", title: "find presentation", answer: "Search the filesystem and return paths", commands: ["find ~/Desktop ~/Documents ~/Downloads -type f -iname '*.pptx' -print"] },
  },
];

for (const scenario of cases) {
  test(`plan review repairs an incomplete or contradictory plan: ${scenario.text}`, async () => {
    const requests: any[] = [];
    const api = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return Response.json({ content: [{ type: "tool_use", name: "okidoki_respond",
        input: requests.length === 1 ? scenario.proposed : scenario.corrected }] });
    }) as typeof fetch;
    const result = await think({ text: scenario.text }, "fixture-key", api);
    expect(requests).toHaveLength(2);
    expect(requests[1].system).toContain(PLAN_REVIEW_PROMPT);
    expect(JSON.stringify(requests[1].messages)).toContain(scenario.text);
    expect(requests[1].messages.at(-2).content).toContain(JSON.stringify(scenario.proposed));
    expect(result.usedModel).toBe(true);
    expect(result.decision.kind).toBe(scenario.corrected.kind as any);
    expect(result.decision.title).toBe(scenario.corrected.title);
    expect(result.decision.commands).toEqual(scenario.corrected.commands);
  });
}

test("a reviewer keeps the original screenshot, document, history and constraints", async () => {
  const requests: any[] = [];
  const input = { kind: "terminal", title: "check", answer: "Check only", commands: ["pwd"] };
  const api = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ content: [{ type: "tool_use", name: "okidoki_respond", input }] });
  }) as typeof fetch;
  await think({ text: "check the project I mentioned, without editing it", documentText: "project context", screenshotBase64: "screen-fixture",
    history: [{ role: "user", text: "The project is /tmp/a folder" }, { role: "assistant", text: "Understood." }] }, "fixture-key", api);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.slice(0, -2)).toEqual(requests[0].messages);
  expect(requests[1].tool_choice).toEqual({ type: "auto" });
});

test("review errors and unstructured claims cannot become executable or successful work", async () => {
  for (const invalid of [Response.json({ error: "unavailable" }, { status: 503 }),
    Response.json({ content: [{ type: "text", text: "I completed the job." }] }),
    Response.json({ content: [{ type: "tool_use", name: "other_tool", input: { kind: "terminal", title: "bad", answer: "", commands: ["echo BAD"] } }] })]) {
    let calls = 0;
    const api = (async () => ++calls === 1
      ? Response.json({ content: [{ type: "tool_use", name: "okidoki_respond", input: { kind: "terminal", title: "work", answer: "work", commands: ["echo BAD"] } }] })
      : invalid) as typeof fetch;
    const result = await think({ text: "do the whole job" }, "fixture-key", api);
    expect(result.decision.kind).toBe("answer");
    expect(result.decision.commands).toBeUndefined();
    expect(result.error).toContain("plan review");
  }
  const proseOnly = (async () => Response.json({ content: [{ type: "text", text: "Done. I sent it." }] })) as typeof fetch;
  const result = await think({ text: "draft a message, don't send it" }, "fixture-key", proseOnly);
  expect(result.usedModel).toBe(false);
  expect(result.decision.answer).not.toContain("I sent it");
  expect(result.error).toContain("structured decision");
});
