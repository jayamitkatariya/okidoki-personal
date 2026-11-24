# The okidoki experience

okidoki is one assistant who gets things done on your Mac. Everything else —
browser tabs, harnesses, skills, runs — is something she uses, not a place you
manage.

## What we learned from the donor product

The donor product works because it has one mental model and spends its whole UI
on it:

- **One inbox.** Work is grouped by what it needs from you, not by tool:
  needs you → in progress → review → settled. Nothing important is buried in a
  tab strip or a per-agent list.
- **One conversation surface.** A workspace is a chat; files, diffs, terminal,
  desktop and previews are panes on that conversation, revealed when relevant.
- **Managers are characters.** A manager has a name, an avatar and notes; its
  ships are visible as delegated work, and reports arrive as messages.
- **Progressive disclosure.** The composer is a composer; model pickers,
  agents, attachments and approvals appear when they matter.
- **Calm density.** Hairline separators, one accent, quiet empty states, short
  sentences, no dashboard decoration.
- **A short path to value.** The first screen asks for the task, not for
  configuration.

What does not fit okidoki: organizations, billing, CI/review queues, repo-first
navigation, and multi-tenant everywhere.

## The okidoki model

```
Notch ── Ask ──▶  okidoki (conversation)
                     │
                     ├─ drives this Mac
                     ├─ works in the browser (your logins)
                     ├─ replays a skill
                     ├─ hands a job to a coding harness
                     └─ delegates to ships (work streams)
                              │
                              ▼
                        Work (inbox)
                        Needs you · Working · Finished
```

### Destinations

Six, at most:

| Place | What it is |
|---|---|
| **okidoki** | The conversation. The front door. |
| **Work** | Inbox of conversations and approvals, grouped by what they need. |
| **Automations** | Tasks okidoki runs on a schedule, on this Mac. |
| **Replay** | Skills you taught, the library, and replays. |
| **Vault** | Documents, sealed logins, the folder okidoki can use. |
| **Settings** | Keys, agents, computer, private Mac, memory, look. |

Browser tabs are **not** navigation. A page opens inside the conversation that
asked for it; ⌘K lists tabs for power use. There is no shake and no global
summon shortcut: the notch's Ask button and the dashboard are the ways in.

### The home conversation

- "What should I get done?" — one composer.
- Four capability cards, each a real task: on my Mac, in the browser, replay a
  skill, with a harness.
- Needs you first, then recent work, then replays worth repeating.
- Pressing a capability sends the task immediately; it does not open a wizard.

### Copy rules

- Say what will happen, not what the feature is called.
- A waiting state names the one thing the person must do (approve, answer,
  captcha, one-time code).
- Empty states invite the next action.
- No exclamation marks, no "Oops", no exclamation-style success toasts.

## Next

1. Themes inspired by the donor's palettes and accents, driven by CSS variables
   and mirrored into the Swift surfaces.
2. Ships inside the Work inbox: a manager's delegated work as rows with
   evidence (screenshot or diff) and one "Needs you" queue.
3. Richer automation triggers (file changes, finished runs) and a run history
   that reads like a schedule, not a CI pipeline.
