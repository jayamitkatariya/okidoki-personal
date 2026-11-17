# okidoki's purpose

**Show it once. It does it forever.**

okidoki learns a task by watching you do it once, then replays it deterministically — finding each
control by name, then by sight, and asking the model only for the one step that broke. That loop is
the product. Everything else exists to serve it.

The loop runs on three stages. The skill is the unit of value; the stage is just where it runs.

| Stage | What it is | Today |
|---|---|---|
| **Your Mac** | Shake the pointer, ask or teach, approve in the notch, Esc takes over. | shipped |
| **Private Mac** | okidoki's own macOS VM. Runs drive it while you keep your screen, cursor and keyboard. Watch it live in the shell. | shipped (Apple silicon) |
| **Shared session** | One Mac hosts its private Mac; everyone on the same WiFi joins in a browser — live screen, a group chat, and the host's skills replayed on request. okidoki acts; the host approves. | next |

The shared session is the flagship, and it is the *same loop*, not a new product: a team's learned
skills, replayed live on a shared Mac, with the agent improvising only when no skill fits. Its privacy
line is the whole design: **collab shares okidoki's Mac, never yours.**

## The hierarchy

Every feature answers to the loop on some stage, or it goes quiet.

- **Core** — watch/replay and skills, Act (computer use), the private Mac, the shared session, and chat
  as the interface. These get the front page, onboarding and the README.
- **Supporting** — the browser (a task surface), memory (smarter asks), the vault (logins for tasks),
  routines (*replay on a schedule*, part of Replay), the inbound `okidoki` CLI/MCP (another way to ask),
  voice (optional delight). Present, in service, never the headline.
- **Advanced** — outbound coding-agent delegation, MCP connectors, Apify, Apple connectors, Moss.
  The "agent platform" surface. Kept, collapsed, off by default, out of the story.
- **One identity** — a local-first app with shared sessions needs one local identity (name + colour),
  not personal/work accounts. The account-scoped data model stays; the switcher does not.

## The rule for every change

Before adding or keeping a feature, ask:

1. **Which stage does it serve?** If none, it doesn't belong.
2. **Does it make learn-once → do-forever better** — faster, more reliable, more shareable, or safer?
   If it's a parallel product wearing the same app, corral it into Advanced or cut it.
3. **Does it work end to end on a real Mac**, with a human fallback when it can't? A feature that
   half-works is clutter with extra steps.

Clutter is not a count of features; it's a count of *purposes*. okidoki has one.
