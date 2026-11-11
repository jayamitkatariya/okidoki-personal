import { expect, test } from "bun:test";
import { actionLines, hostOf, looksLikeAddress, looksLikeTask, parseView, runUnread, splitTabs, threadInfo, threadUnread, workingFor } from "../src/shell/model";
import { demoState } from "../src/demo";
import type { BrowserTab, Run, Thread } from "../src/types";

const run = (patch: Partial<Run>): Run => ({
  id: "r",
  accountID: "a",
  kind: "browser",
  title: "t",
  prompt: "p",
  status: "running",
  steps: [],
  output: "",
  summary: "",
  createdAt: "2026-11-11T10:00:00Z",
  ...patch,
});

test("routes read back into views, and unknown ones are rejected", () => {
  expect(parseView("#/home")).toEqual({ kind: "home" });
  expect(parseView("")).toEqual({ kind: "home" });
  expect(parseView("#/chat/thread-1")).toEqual({ kind: "chat", id: "thread-1" });
  expect(parseView("tab/ABC")).toEqual({ kind: "tab", id: "ABC" });
  expect(parseView("skills")).toEqual({ kind: "page", page: "skills" });
  expect(parseView("browser")).toBe("browser");
  expect(parseView("keys")).toEqual({ settingsSection: "keys" });
  expect(parseView("nope")).toBeNull();
});

test("the card lists the last three things a run did, with an icon for each", () => {
  const lines = actionLines(
    run({ output: "searched browsing history and memory\nopen chase.com\n➤ click “Sign in”\ncapturing a screenshot\nsaving in artifacts folder" }),
  );
  expect(lines.map((line) => line.text)).toEqual(["Click “Sign in”", "Capturing a screenshot", "Saving in artifacts folder"]);
  expect(lines.map((line) => line.icon)).toEqual(["cursor", "screen", "download"]);
  expect(actionLines(run({ output: "spawning subagents in parallel" }))[0].icon).toBe("switch");
  // No log yet: the steps it has started stand in.
  const fromSteps = actionLines(
    run({ steps: [{ id: "1", title: "read the page", detail: "", status: "done" }, { id: "2", title: "report back", detail: "", status: "previewing" }] }),
  );
  expect(fromSteps).toEqual([{ icon: "eye", text: "Read the page" }]);
});

test("unread means finished after the person last looked", () => {
  expect(runUnread(run({ status: "done", endedAt: "2026-11-11T10:05:00Z" }))).toBe(true);
  expect(runUnread(run({ status: "done", endedAt: "2026-11-11T10:05:00Z", seenAt: "2026-11-11T10:06:00Z" }))).toBe(false);
  expect(runUnread(run({ status: "running" }))).toBe(false);
  expect(runUnread(run({ status: "cancelled", endedAt: "2026-11-11T10:05:00Z" }))).toBe(false);

  const thread: Thread = {
    id: "t",
    accountID: "a",
    title: "x",
    app: "okidoki",
    topic: "",
    createdAt: "2026-11-11T10:00:00Z",
    updatedAt: "2026-11-11T10:01:00Z",
    archived: false,
    messages: [
      { id: "1", role: "user", text: "hi", createdAt: "2026-11-11T10:00:00Z" },
      { id: "2", role: "assistant", text: "hello", createdAt: "2026-11-11T10:01:00Z" },
    ],
  };
  expect(threadUnread(thread)).toBe(true);
  expect(threadUnread({ ...thread, seenAt: "2026-11-11T10:02:00Z" })).toBe(false);
  expect(threadUnread({ ...thread, messages: thread.messages.slice(0, 1) })).toBe(false);
});

test("threads know when they're running, waiting on you, or unread", () => {
  const info = threadInfo(demoState);
  const byID = Object.fromEntries(info.map((item) => [item.thread.id, item]));
  expect(byID["thread-cancel"].active?.id).toBe("run-cancel-sub");
  expect(byID["thread-park"].unread).toBe(true);
  expect(byID["thread-figma"].needsYou).toBe(true);
  // Newest first.
  expect(info[0].thread.id).toBe("thread-cancel");
});

test("agent tabs are listed apart, blank tabs are Home", () => {
  const tab = (patch: Partial<BrowserTab>): BrowserTab => ({
    id: "x",
    number: 1,
    title: "",
    address: "",
    host: "",
    loading: false,
    blank: false,
    canGoBack: false,
    canGoForward: false,
    hasLogin: false,
    bookmarked: false,
    ...patch,
  });
  const { mine, agent } = splitTabs([tab({ id: "a" }), tab({ id: "b", blank: true }), tab({ id: "c", ownerRunID: "r" }), tab({ id: "d", blank: true, status: "opening" })]);
  expect(mine.map((item) => item.id)).toEqual(["a"]);
  expect(agent.map((item) => item.id)).toEqual(["c", "d"]);
});

test("working-for ticks in seconds, then minutes, then hours", () => {
  const start = "2026-11-11T10:00:00Z";
  const at = (seconds: number) => Date.parse(start) + seconds * 1000;
  expect(workingFor(start, at(9))).toBe("9s");
  expect(workingFor(start, at(61))).toBe("1m 1s");
  expect(workingFor(start, at(3720))).toBe("1h 2m");
  expect(workingFor(null, at(5))).toBe("");
});

test("the address bar tells sites from searches from tasks", () => {
  expect(looksLikeAddress("github.com")).toBe(true);
  expect(looksLikeAddress("https://x.dev/a b")).toBe(true);
  expect(looksLikeAddress("localhost:5174")).toBe(true);
  expect(looksLikeAddress("largest park in sf")).toBe(false);
  expect(looksLikeTask("cancel my netflix subscription")).toBe(true);
  expect(looksLikeTask("weather")).toBe(false);
  expect(hostOf("https://www.github.com/x")).toBe("github.com");
});
