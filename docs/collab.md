# Collaboration — the shared session (stage 3)

One Mac hosts its **private Mac** (the VM). Everyone on the same WiFi joins in a browser — no install —
and gets a live screen, a group chat, and okidoki acting in the VM. **Collab shares okidoki's Mac,
never yours.** The host approves anything risky in the notch, exactly as today.

This is the same loop as stage 1, shared: the host's saved skills are one tap away, and okidoki does
the task in the shared Mac while everyone watches and talks.

## What a session is

- The host starts a session from the dashboard. okidoki listens on the LAN (port **4331**) and
  advertises `_okidoki._tcp` over Bonjour. A 6-character code gates joining.
- A joiner opens `http://<host>.local:4331/` (or the IP), enters a name and the code, and gets a
  per-participant token. The page is served by the host app from its bundled web build.
- Everyone sees: the VM screen (a few frames a second), the group chat, who's present, the current
  run step by step, and the host's shared skill cards.
- Anyone can ask okidoki to do something. The ask drives the **VM** via computer use. okidoki's replies
  and step narration post back into the group chat. Risky steps wait for the **host's** okay in the
  notch; joiners see "waiting for the host".
- The host can kick a participant, reclaim the wheel, or end the session. Ending stops the listener.

## A note on replay

The VM is driven by pixels and synthesized events; Accessibility does not reach into the guest. So the
deterministic accessibility replay of stage 1 runs on **your Mac**, not in the VM. In a session,
okidoki performs tasks with computer use, guided by the skill's intent when you tap a skill card.
Deterministic replay inside the guest is a future enhancement.

## Privacy

Joiners see only the VM screen, the session chat, session runs, and skill **names + inputs** (the
shareable part of a skill). Never the host's keys, vault, memory, screen, browser tabs, or skill step
pictures. Vault secrets a task uses stay on the host. The listener exists only while a session is
active. macOS 15+ asks for Local Network permission the first time; okidoki explains why.

## HTTP contract (host LAN, port 4331)

Static: `GET /` serves the joiner page; `GET /<asset>` serves bundled files (brand.png, fonts…).

API is JSON. Every route except `join` needs `Authorization: Bearer <participant token>` (or `?token=`
for the SSE and frame routes, which a browser cannot send headers for). The code is never a token.

| Route | Body / query | Returns |
|---|---|---|
| `POST /api/join` | `{name, code}` | `{token, you, session}` · 403 bad code · 409 full/ended |
| `GET /api/state` | `?token=` | `{you, session}` |
| `GET /api/events` | `?token=` | SSE stream (below) |
| `GET /api/frame` | `?token=` | latest VM screen as `image/jpeg` |
| `POST /api/chat` | `{text, ask?}` | `{ok}` — `ask` (or an "okidoki, …" prefix) starts a VM task |
| `POST /api/skills/run` | `{id, values?}` | `{ok, runID}` — a VM task from a skill card |
| `POST /api/runs/stop` | `{id}` | `{ok}` — host or the person who asked |
| `POST /api/wheel` | `{action: request\|release}` | `{ok, holder}` · 409 mid-run or already held |
| `POST /api/input` | `{kind, …}` | `{ok}` — wheel holder only, 409 mid-run or VM off |

**Take-the-wheel.** One participant drives at a time; the host can always reclaim. Input packets use
normalized coordinates (0–1 across the guest display), so any screen size aims true:
`move {x,y}` · `click {x,y,button?,count?,modifiers?}` · `drag {fromX,fromY,toX,toY}` ·
`scroll {x,y,dx,dy}` · `key {key,times?}` (okidoki combos like `cmd+l`) · `type {text}`.
The host parses them into the same `ComputerAction`s okidoki drives the VM with, clamped
(`CollabInput`). The wheel and okidoki never drive at once: a wheel request is refused mid-run, an ask
is refused while the wheel is held, and a run that starts reclaims the wheel. Every pointer event is
broadcast as a `pointer` event so all other joiners see the driver's cursor live; Esc releases.

SSE events, each `data: {type, …}\n\n`:

- `hello` `{you, session}` · `chat` `{message}` · `presence` `{participants}`
- `run` `{run}` (null when idle) · `vm` `{phase, running}` · `skills` `{skills}`
- `wheel` `{holder, holderName}` · `pointer` `{x, y, by, color, click?}` (normalized, the driver's cursor) · `ended` `{}`

`session` snapshot: `{hostName, startedAt, participants, wheelHolder, wheelHolderName, vm, run, skills, chat}`.
`message`: `{id, authorID, authorName, colorHex, text, kind: chat|ask|okidoki|system, at}`.
`run`: `{id, title, status, goal, requestedBy, needs?, steps: [{index, say, kind, detail, result, status}]}`.
`skill` card: `{id, name, summary, intent, inputs: [{name, description}]}`.

The host manages the session through the native bridge (`invoke("collab", {action: start|stop|kick|…})`),
not over HTTP. `NativeState.collab` carries `{active, code, url, port, participants, wheelHolder, runID, error}`.
