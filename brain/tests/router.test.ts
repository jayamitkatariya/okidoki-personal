import { expect, test } from "bun:test";
import { isWebGoal, localRouter } from "../src/router";

const route = (text: string, extra: Record<string, unknown> = {}) => localRouter({ text, ...extra });

test("web-only goals go to the browser", () => {
  for (const text of [
    "search google for flights to tokyo",
    "look up the opening hours of the louvre",
    "find a used bike on ebay under 200",
    "fill in the visa form on travel.state.gov",
    "download my bank statement from chase.com",
    "book a table online for friday",
  ]) {
    expect([text, route(text).kind]).toEqual([text, "browser"]);
    expect(isWebGoal(text)).toBe(true);
  }
});

test("goals that need desktop apps go to computer use", () => {
  for (const text of [
    "open keynote",
    "message mom on whatsapp",
    "create a page in notion",
    "rename the files on my desktop by date",
    "make blender render the scene",
  ]) {
    expect([text, route(text).kind]).toEqual([text, "computer_use"]);
  }
  expect(isWebGoal("download the report from github and open it in keynote")).toBe(false);
});

test("how-do-i questions are answered, never taught or acted on", () => {
  for (const text of ["how do i add auto layout in figma", "teach me git", "explain recursion", "how to search google faster"]) {
    expect([text, route(text).kind]).toEqual([text, "answer"]);
  }
});

test("reminders, notes and terminal jobs are no longer local routes", () => {
  const kinds = ["remind me to call mom at 6", "note this", "my mac is out of space", "compress this video for discord", "build me a script that renames screenshots"]
    .map((text) => route(text, { clipboardText: "call mom" }).kind);
  for (const kind of kinds) expect(["quick_action", "terminal", "coding", "teach"]).not.toContain(kind);
});

import { asList, normalize as normalizeDecision } from "../src/llm";

test("list fields the model sends as one string still arrive as lists", () => {
  expect(normalizeDecision({ kind: "memory", title: "t", answer: "a", memory: "Favourite city is Lisbon" }).memory).toEqual(["Favourite city is Lisbon"]);
  expect(asList("- one\n- two")).toEqual(["one", "two"]);
  expect(asList('["a","b"]')).toEqual(["a", "b"]);
  expect(asList(["x", 3, " "])).toEqual(["x"]);
  expect(asList(undefined)).toEqual([]);
  expect(normalizeDecision({ kind: "computer_use", title: "t", answer: "", apps: "Notes" }).apps).toEqual(["Notes"]);
});
