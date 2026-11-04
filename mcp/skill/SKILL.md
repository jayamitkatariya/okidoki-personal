---
name: okidoki
description: Hand tasks to okidoki, the person's Mac assistant. Use it for web tasks that need their logins (okidoki's browser), for tasks in Mac apps (computer use), and for replaying their saved workflows (skills) for many items at once. Also reads what okidoki remembers about them and finds documents in their vault. Use whenever the person asks you to do something on a website or in a Mac app, or to repeat a workflow they've done before.
---

# okidoki

okidoki runs on this Mac. Talk to it with the `okidoki` command (or the `okidoki` MCP tools, if they're connected).

1. **Look for a skill first.** Run `okidoki skills --json`. If one does the job, replay it once with every item:
   `okidoki replay "<skill>" --item k=v k=v --item k=v … --wait 600`. That takes seconds per item and adapts to new data.
2. **Otherwise say the task.** Use `okidoki do "<task in plain words>" --wait 300`, or `browse` / `computer` to force where it runs.
3. **Read the result.** Check the exit code and the `needs` line:
   - **0:** done. The result is in the output; `--json` gives it as `result` and `said`.
   - **2:** it needs the person. Tell them what (an okay in the notch, a captcha in okidoki's browser, or a question). Then run `okidoki wait <id>`. For a question, ask the person, then `okidoki reply <id> "<their answer>"`. Never try to get past a captcha or approve a risky step yourself.
   - **3:** still running. Run `okidoki wait <id> --timeout 600`.
   - **1:** it failed or was stopped. `okidoki run <id> --log` says why.
4. **Follow-ups go in the same conversation.** Use `okidoki do --thread <thread id> "<next step>"`.
5. **Drive pages yourself for fine control.** Run `okidoki open <url>`, then `okidoki page`, which numbers the elements. Then use `okidoki click <n>`, `okidoki type <n> "<text>" --submit`, `okidoki select <n> "<option>"` and `okidoki screenshot -o shot.png`. Only tabs you opened can be driven.
6. **Personal context:** `okidoki memory` shows what it remembers, `okidoki remember "<lasting fact>"` adds to it, and `okidoki vault "<name>"` finds documents.

Keep the person in charge. Anything that pays, sends, submits or deletes waits for their okay in the notch, and that is by design.
