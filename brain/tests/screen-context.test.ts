import { expect, test } from "bun:test";
import { pageLine, think } from "../src/llm";
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
    kind: "browser", title: "a circuit in tinkercad", answer: "building it right here",
  });
  const result = await think({
    text: "make a circuit with a battery and an led",
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
  expect(result.decision.kind).toBe("browser");

  const system = systemText(requests[0]);
  expect(system).toContain("Current app: Google Chrome");
  expect(system).toContain("Browser tab: Circuits · Tinkercad — https://www.tinkercad.com/things/abc/editel");
  expect(system).toContain("Front window: Circuits · Tinkercad");
  // Web-only goals go to the browser; anything needing a desktop app to computer use.
  expect(system).toContain("→ browser");
  expect(system).toContain("anything that needs desktop apps or files on their Mac");
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
