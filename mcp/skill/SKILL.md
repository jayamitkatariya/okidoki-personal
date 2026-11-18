---
name: okidoki
description: Hand tasks to okidoki, the person's assistant app on this Mac, through the `okidoki` command. Use it for anything on a website that needs the person's own logins (okidoki's browser is signed in as them), for anything in a Mac app (Notes, Mail, Calendar, Finder… via computer use), and for replaying a workflow they have saved as a skill, once or for many items at once. Also reads what okidoki remembers about the person and finds documents in their vault. Use whenever the person asks you to do something on a website or in a Mac app, to check an account, order, booking or inbox, to fill or submit a form, to repeat something they've done before, or mentions okidoki.
---

# okidoki

okidoki is an app running on this Mac. You reach it with the `okidoki` command; it does the work in its own
browser (with the person's logins) or in the Mac's apps, and anything risky waits for the person's okay.
Add `--json` to any command for the raw answer. `okidoki help` lists everything.

## 1. Look for a saved skill first

```sh
okidoki skills --json          # the person's saved skills and their inputs
okidoki library                # ready-made templates
```

If a skill does the job, replay it once with every item. Replays take seconds per item and adapt to new data:

```sh
okidoki replay "<skill>" --item name=Asha pan=AB12 --item name=Ravi pan=CD34 --wait 600
okidoki replay "<skill>" --set year=2026 --items items.json --times 3
```

`--item k=v …` is one item (repeat it), `--set k=v …` sets values shared by all, `--items file.json` reads an array.

## 2. Otherwise say the task in plain words

```sh
okidoki do "find the cheapest flight from SFO to JFK next Friday" --wait 300   # okidoki picks: a skill if one fits, else the agent
okidoki browse "check my Amazon order status"                                  # in okidoki's browser
okidoki computer "make a new note in Notes titled Groceries"                   # drives this Mac's apps
okidoki chat "what's on my calendar tomorrow?"                                 # an answer only, nothing done
```

`--wait <seconds>` is how long to wait for the result (default 180; `0` returns at once with the run id).

## 3. Read the exit code

| code | meaning | what to do |
|---|---|---|
| 0 | done | the result is printed (`--json`: `result`, `said`) |
| 1 | failed or stopped | `okidoki run <id> --log` says why |
| 2 | needs the person | tell them what (the `needs` line): an okay in the notch, a captcha in okidoki's browser, or a question. Then `okidoki wait <id>`. For a question, ask them and pass it on with `okidoki reply <id> "<their answer>"` |
| 3 | still running | `okidoki wait <id> --timeout 600` |
| 4 | error | okidoki isn't running, or the command was wrong |

Never try to get past a captcha or approve a risky step yourself; those belong to the person.

## 4. Runs and follow-ups

```sh
okidoki status                 # what's running now
okidoki runs --limit 10        # recent runs
okidoki run <id> --log         # one run, with its log
okidoki stop|pause|resume|takeback <id>
okidoki save <id> "<name>"     # keep a finished web run as a skill that replays with new data
okidoki do --thread <thread id> "<next step>"   # continue the same conversation (the id is printed after each run)
```

## 5. Drive a page yourself for fine control

Only tabs you opened can be driven (a tab a run you started is working in can be read with `page`).

```sh
okidoki open https://example.com          # prints the tab number
okidoki page --tab 4                       # page text and numbered elements
okidoki click 12 --tab 4                   # a number from `page`, or a CSS selector
okidoki type 7 "hello" --submit --tab 4
okidoki select 9 "Express" --tab 4
okidoki press Enter --tab 4
okidoki scroll down --tab 4
okidoki goto https://example.com/next --tab 4
okidoki screenshot --tab 4 -o shot.png
okidoki tabs
okidoki close 4
```

Without `--tab`, commands act on the last tab you opened. If `page` says the page needs a person, hand it to them.

## 6. Personal context

```sh
okidoki memory                         # what okidoki remembers about the person
okidoki remember "<a lasting fact>"
okidoki vault "<query>"                # find documents in their vault
```

## If `okidoki` isn't on PATH

- Run the bundled CLI directly: `bun "/Applications/Okidoki.app/Contents/Resources/cli/okidoki.js" <command>`
  (or `~/.local/bin/okidoki` if it exists but isn't on PATH).
- Or ask the person to open okidoki → Settings › Agents, which installs the command and this skill.
- "okidoki isn't running on this Mac (no control.json)" means the app is closed: ask the person to open it.

## When okidoki started you

okidoki hands coding agents the jobs on files, folders, documents, code and the terminal (its own Settings ›
Agents). If `OKIDOKI_DELEGATED=1` is set, okidoki is the one that started you: do the file and terminal work
yourself, and call `okidoki` only for what needs the web with their logins, a Mac app, a saved skill, memory or
the vault. Stay inside the working folder you were started in.

Keep the person in charge: anything that pays, sends, submits or deletes waits for their okay in the notch, by design.
