import { expect, test } from "bun:test";
import { pageLine, think } from "../src/llm";
import { teachSystemPrompt } from "../src/teach";
import { fakeAPI, systemText } from "./fixtures/fake-api";

test("pageLine joins the tab title and url, and is empty outside a browser", () => {
  expect(pageLine(undefined)).toBe("");
  expect(pageLine({ now: "x" })).toBe("");
  expect(pageLine({ now: "x", pageTitle: "Circuits · Tinkercad", pageURL: "https://www.tinkercad.com/things/abc" }))
    .toBe("Browser tab: Circuits · Tinkercad — https://www.tinkercad.com/things/abc");
  expect(pageLine({ now: "x", pageURL: "https://example.com" })).toBe("Browser tab: https://example.com");
  expect(pageLine({ now: "x", pageTitle: "  ", pageURL: " " })).toBe("");
});

test("the router sees the browser tab, the window and the display shot before it decides", async () => {
  const requests: Record<string, any>[] = [];
  const api = fakeAPI(requests, {
    kind: "teach", lesson_kind: "app", title: "teach: a circuit in tinkercad", answer: "let's build it right here",
    teach_plan: [{ say: "drag a battery from the Components panel" }],
  });
  const result = await think({
    text: "show me how to make a circuit",
    appName: "Google Chrome",
    screenshotBase64: "display-fixture",
    screenshotMediaType: "image/png",
    nativeContext: {
      now: "2026-10-24T10:00:00Z",
      frontWindow: "Circuits · Tinkercad",
      pageTitle: "Circuits · Tinkercad",
      pageURL: "https://www.tinkercad.com/things/abc/editel",
      screenshotIsDisplay: true,
    },
  }, "test-key", api);

  expect(result.usedModel).toBe(true);
  expect(result.decision.kind).toBe("teach");
  expect(result.decision.lessonKind).toBe("app");

  const system = systemText(requests[0]);
  expect(system).toContain("Current app: Google Chrome");
  expect(system).toContain("Browser tab: Circuits · Tinkercad — https://www.tinkercad.com/things/abc/editel");
  expect(system).toContain("Front window: Circuits · Tinkercad");
  // The rule that turns "show me how to make X" in the tool on screen into an app lesson.
  expect(system).toContain("Set scene first, then lesson_kind by this table");
  expect(system).toContain("Never a concept model while the place to build it is open in front of them");
  // The display shot is context, not a circled region.
  expect(system).toContain("whole display as it was when they asked");

  const user = requests[0].messages.at(-1);
  const image = user.content.find((c: { type: string }) => c.type === "image");
  expect(image?.source?.data).toBe("display-fixture");
});

test("a circled region keeps the old wording: no display-context note, no tab line", async () => {
  const requests: Record<string, any>[] = [];
  const api = fakeAPI(requests, { kind: "answer", title: "what this is", answer: "a resistor" });
  await think({
    text: "what is this",
    appName: "Finder",
    screenshotBase64: "circle-fixture",
    nativeContext: { now: "2026-10-24T10:00:00Z", frontWindow: "Downloads" },
  }, "test-key", api);
  const system = systemText(requests[0]);
  expect(system).not.toContain("whole display as it was when they asked");
  expect(system).not.toContain("Browser tab:");
  expect(system).toContain("Front window: Downloads");
});

test("the live tutor is told which site it is teaching", () => {
  const base = { topic: "a circuit", app: "Google Chrome", outline: [], log: [], stepNumber: 1, imageWidth: 800, imageHeight: 600 };
  const plain = teachSystemPrompt(base);
  expect(plain).not.toContain("browser tab in front");

  const onSite = teachSystemPrompt({ ...base, pageTitle: "Circuits · Tinkercad", pageURL: "https://www.tinkercad.com/things/abc" });
  expect(onSite).toContain("The browser tab in front is Circuits · Tinkercad — https://www.tinkercad.com/things/abc.");
  expect(onSite).toContain("never the browser's");

  const urlOnly = teachSystemPrompt({ ...base, pageURL: "https://www.tinkercad.com/" });
  expect(urlOnly).toContain("The browser tab in front is https://www.tinkercad.com/.");
});
