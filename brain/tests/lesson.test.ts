import { expect, test } from "bun:test";
import { resolveLessonKind, wantsToDo, wantsToUnderstand } from "../src/lesson";
import { normalize, think } from "../src/llm";
import { fakeAPI, systemText } from "./fixtures/fake-api";

test("intent words: doing vs understanding", () => {
  for (const text of ["show me how to make a circuit", "how do I add auto layout", "walk me through exporting", "teach me to rig this", "how to wire an LED"]) {
    expect(wantsToDo(text)).toBe(true);
    expect(wantsToUnderstand(text)).toBe(false);
  }
  for (const text of ["explain this", "what is she talking about", "how does a transistor work", "what's compound interest", "why does this happen", "summarize the lecture", "what is this video about"]) {
    expect(wantsToUnderstand(text)).toBe(true);
    expect(wantsToDo(text)).toBe(false);
  }
  // Mixed: both signals, so the model's choice stands.
  expect(wantsToDo("explain how to use the speed control")).toBe(true);
  expect(wantsToUnderstand("explain how to use the speed control")).toBe(true);
  // "show me how X works" is understanding, not doing.
  expect(wantsToUnderstand("show me how a transistor works")).toBe(true);
});

test("working in a tool: a how-to is never a concept model, an idea with nothing to point at still is", () => {
  expect(resolveLessonKind("concept", "working", "show me how to make a circuit")).toBe("app");
  expect(resolveLessonKind(undefined, "working", "how do I add auto layout")).toBe("app");
  expect(resolveLessonKind(undefined, "working", "rig the character")).toBe("app");
  expect(resolveLessonKind("concept", "working", "explain Ohm's law")).toBe("concept");
  expect(resolveLessonKind(undefined, "working", "what is recursion")).toBe("concept");
  // The model said app for an "explain" in a tool (a feature of the tool): keep it.
  expect(resolveLessonKind("app", "working", "what does this node do")).toBe("app");
  // Mixed signals keep the model's call either way.
  expect(resolveLessonKind("concept", "working", "explain how to use the pen tool")).toBe("concept");
  expect(resolveLessonKind("app", "working", "explain how to use the pen tool")).toBe("app");
});

test("watching a lecture or reading: an explain is never an app lesson on the player", () => {
  expect(resolveLessonKind("app", "watching", "explain this")).toBe("concept");
  expect(resolveLessonKind("app", "reading", "what is she talking about")).toBe("concept");
  expect(resolveLessonKind(undefined, "watching", "how does a transistor work")).toBe("concept");
  expect(resolveLessonKind(undefined, "watching", "a transistor")).toBe("concept");
  // They want to do it somewhere: the model's app lesson (opening the app) stands.
  expect(resolveLessonKind("app", "watching", "show me how to do that in blender")).toBe("app");
  expect(resolveLessonKind(undefined, "watching", "show me how to do that in blender")).toBe("app");
  // A feature of the player itself, explicitly chosen by the model: keep it.
  expect(resolveLessonKind("app", "watching", "explain how to use the speed control")).toBe("app");
});

test("no scene: the model's choice stands, else the legacy default is an app lesson unless they only want to understand", () => {
  expect(resolveLessonKind("concept", undefined, "show me how to make a circuit")).toBe("concept");
  expect(resolveLessonKind(undefined, undefined, "teach me figma")).toBe("app");
  expect(resolveLessonKind(undefined, "other", "explain compound interest")).toBe("concept");
  expect(resolveLessonKind(undefined, "other", "show me how to use finder tags")).toBe("app");
});

test("normalize settles scene and lesson_kind on teach decisions and ignores junk", () => {
  const teach = normalize({ kind: "teach", title: "teach: a circuit", answer: "ok", scene: "working", lesson_kind: "concept" }, "show me how to make a circuit");
  expect(teach.scene).toBe("working");
  expect(teach.lessonKind).toBe("app");
  const lecture = normalize({ kind: "teach", title: "teach: transistors", answer: "ok", scene: "watching" }, "explain this");
  expect(lecture.lessonKind).toBe("concept");
  const junk = normalize({ kind: "teach", title: "t", answer: "ok", scene: "banana", lesson_kind: "video" }, "teach me figma");
  expect(junk.scene).toBeUndefined();
  expect(junk.lessonKind).toBe("app");
  const answer = normalize({ kind: "answer", title: "t", answer: "ok", scene: "reading", lesson_kind: "concept" }, "what time is it");
  expect(answer.lessonKind).toBe("concept");
  expect(answer.scene).toBe("reading");
});

test("end to end: a lecture gets a model beside it, a tool gets a tutor in it", async () => {
  // Watching a lecture on YouTube, asking to understand. Model answers concept; stays concept.
  let requests: Record<string, any>[] = [];
  let api = fakeAPI(requests, { scene: "watching", kind: "teach", lesson_kind: "concept", title: "teach: transistors", answer: "here's a model" });
  let result = await think({
    text: "explain what he's saying about transistors",
    appName: "Safari",
    screenshotBase64: "display-fixture",
    nativeContext: { now: "2026-10-24T10:00:00Z", pageTitle: "Lecture 4: Transistors - YouTube", pageURL: "https://www.youtube.com/watch?v=abc", screenshotIsDisplay: true },
  }, "test-key", api);
  expect(result.decision.kind).toBe("teach");
  expect(result.decision.lessonKind).toBe("concept");
  expect(result.decision.scene).toBe("watching");
  let system = systemText(requests[0]);
  expect(system).toContain("Browser tab: Lecture 4: Transistors - YouTube — https://www.youtube.com/watch?v=abc");
  expect(system).toContain("Set scene first, then lesson_kind by this table");
  expect(requests[0].tools[0].input_schema.properties.scene.enum).toEqual(["watching", "reading", "working", "other"]);
  // scene comes first in the schema so the model classifies before it chooses.
  expect(Object.keys(requests[0].tools[0].input_schema.properties)[0]).toBe("scene");

  // Same words while watching, but the model slipped and said app: the player is not the lesson.
  requests = [];
  api = fakeAPI(requests, { scene: "watching", kind: "teach", lesson_kind: "app", title: "teach: transistors", answer: "ok", teach_plan: [{ say: "pause the video" }] });
  result = await think({ text: "explain what he's saying about transistors", appName: "Safari" }, "test-key", api);
  expect(result.decision.lessonKind).toBe("concept");

  // Working in Tinkercad, asking how to make it. Model slipped to concept: the tutor takes over.
  requests = [];
  api = fakeAPI(requests, { scene: "working", kind: "teach", lesson_kind: "concept", title: "teach: a circuit", answer: "ok" });
  result = await think({
    text: "show me how to make a circuit",
    appName: "Google Chrome",
    nativeContext: { now: "2026-10-24T10:00:00Z", pageTitle: "Circuits · Tinkercad", pageURL: "https://www.tinkercad.com/things/abc" },
  }, "test-key", api);
  expect(result.decision.kind).toBe("teach");
  expect(result.decision.lessonKind).toBe("app");

  // Working in Blender, asking for a general idea: the model beside the screen is right.
  requests = [];
  api = fakeAPI(requests, { scene: "working", kind: "teach", lesson_kind: "concept", title: "teach: quaternions", answer: "ok" });
  result = await think({ text: "explain quaternions", appName: "Blender", nativeContext: { now: "x", frontWindow: "Blender — scene.blend" } }, "test-key", api);
  expect(result.decision.lessonKind).toBe("concept");
  expect(systemText(requests[0])).toContain("Front window: Blender — scene.blend");
});
