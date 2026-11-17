# The `.okiskill` format

A skill file is UTF-8 JSON. It's meant to be readable and hand-editable.

```json
{
  "format": "okidoki-skill",
  "version": 1,
  "name": "weather check",
  "summary": "3 steps in Safari",
  "exportedAt": "2026-10-27T18:00:00.000Z",
  "steps": [
    {
      "id": "6F1C…",
      "text": "in Safari, click “Address and Search”",
      "app": "Safari",
      "action": "click",
      "x": 640, "y": 60,
      "label": "Address and Search",
      "role": "AXTextField",
      "delay": 1.2,
      "frameX": 530, "frameY": -10, "frameW": 220, "frameH": 140
    },
    { "id": "…", "text": "in Safari, type “weather in {{city}}”", "app": "Safari", "action": "type", "input": "weather in {{city}}" },
    { "id": "…", "text": "in Safari, press ↩", "app": "Safari", "action": "key", "input": "return" }
  ],
  "frames": { "6F1C…": "<base64 PNG, 220×140 points around the click>" }
}
```

## Steps

| field | meaning |
|---|---|
| `action` | `click`, `double-click`, `right-click`, `drag`, `type`, `key`, `scroll`, `switch` |
| `x`, `y` | where it happened, in global screen points with the origin at the top left of the main display |
| `label`, `role` | the accessibility label and role of the control, used to find it again |
| `input` | the text typed (`type`), or a key combo such as `cmd+s` (`key`) |
| `toX`, `toY` | the drag end, or the scroll amount in points (`toY`) |
| `delay` | seconds the recording waited before this step |
| `window`, `winTitle` | the window it happened in, so replay can follow a moved window |
| `frame*` | the picture's box around the click, used to find the control by sight |

Browser steps (in okidoki's browser) use `navigate`, `click`, `hover`, `type`, `select`, `press`, `login` (filled from the vault), `read` (a capture), `think` (a bounded sub-goal for the model), and `dialog`.

A `dialog` step says how the page's next confirm or prompt pop-up is answered:
- `"input": "dismiss"` means Cancel.
- `"accept:<text>"` types that text into a prompt; `{{params}}` work there too.
- Without a `dialog` step, a confirm gets OK and a prompt keeps its default text.

`{{name}}` anywhere in `input` is a parameter. It's filled from the request (`with city=Lisbon`), from a
record in `records.json`, or from built-ins (`{{today}}`, `{{today_iso}}`).

## Replay order

For each step, replay tries these in order and stops at the first that works:

1. The control is still at the recorded point.
2. The window moved: the point moves with it.
3. Search the app for the same label.
4. Match the recorded picture against the screen.
5. Ask the model to do that one step.

Browser steps (`"surface": "browser"`) use `url` and `selectors` instead of points and pictures. A replay
that had to fall back to a later selector moves the one that worked to the front.

## Version 2: smart replay

Version 2 adds what lets one skill do the same job for different people, invoices or rows, on a
page that has changed since. Every field is optional. A skill that uses none of them is still written
as version 1, and version 1 files replay exactly as before.

```json
{
  "format": "okidoki-skill",
  "version": 2,
  "name": "file a return",
  "skill": {
    "intent": "file an income tax return for a person on Acme Filing",
    "itemNoun": "person",
    "inputs": [
      { "name": "pan", "description": "the person's PAN", "kind": "text", "pattern": "[A-Z]{5}[0-9]{4}[A-Z]",
        "source": "document", "hint": "Form 16, top of page 1" },
      { "name": "income", "description": "gross salary for the year", "kind": "money", "format": "plain",
        "source": "document", "hint": "Form 16 Part B" },
      { "name": "deductions", "description": "each deduction claimed", "kind": "list", "fields": ["section", "amount"],
        "required": false }
    ]
  },
  "steps": [
    { "text": "type “{{pan}}” in “PAN”", "action": "type", "input": "{{pan}}",
      "anchor": { "path": "/form.html", "landmark": "Your details" } },
    { "text": "tick “I sold shares”", "action": "click", "when": "{{gains}}" },
    { "text": "click “Add deduction”", "action": "click", "repeatOver": "deductions", "repeatLength": 3 },
    { "text": "choose “{{item.section}}”", "action": "select", "input": "{{item.section}}" },
    { "text": "type “{{item.amount}}”", "action": "type", "input": "{{item.amount}}" },
    { "text": "click “Submit return”", "action": "click", "irreversible": true,
      "expect": { "urlContains": "done" } },
    { "text": "read the reference number", "action": "read", "capture": "reference" }
  ]
}
```

### Skill fields (under `skill`)

| field | meaning |
|---|---|
| `inputs` | the values each pass needs; see below |
| `intent` | one line on what it achieves, used to pick the skill from an everyday request |
| `itemNoun` | what one pass is for: `person`, `invoice`, `row` |
| `alwaysConfirm` | always pause before irreversible steps (money, deletion) |
| `interrupts` | popups this skill learned to clear: `whenText` / `whenElement` → `clickLabel` / `clickSelector` / `key` |
| `template`, `outline`, `startURL`, `startApp`, `tags` | a library template: the agent follows `outline` the first time, and that run becomes the user's own skill |

### Inputs

`kind` is `text`, `number`, `money`, `date`, `choice`, `list` or `file`.
- `format` sets how the value is typed: money `plain` / `grouped` / `indian`, a date pattern such as `dd/MM/yyyy`, or text `upper` / `lower`.
- `pattern` is a regular expression the value must match before it's typed.
- `source` and `hint` say where to find the value, usually a document in the vault.
- `sensitive` values never reach logs.
- `{{password}}` is a password the request itself gave when the skill was learned ("sign in with password …").
  The value is never in the file: it's remembered in this Mac's `keys.json` for that skill, and a replay that
  isn't given one uses it. Passwords the request didn't give are `{{vault:<site>.password}}`, filled from the vault.
- A plain recording (no inputs) replayed with values it has no placeholder for is refused, not replayed with
  the recorded details; its smart version (same site, with inputs) is used instead when there is one.
- A `list` holds JSON entries with the named `fields`.

### Step fields

| field | meaning |
|---|---|
| `when` | run only when it holds: `{{x}}` (has a value that isn't 0/no/none), `{{x}} == old`, `!=`, `!`, `&&`, `\|\|` |
| `repeatOver`, `repeatLength` | this step and the next `repeatLength − 1` run once per entry of the list input; `{{item.field}}` inside |
| `mode: "think"`, `maxTurns` | a bounded sub-goal the model does with the pass's values; the last resort |
| `anchor` | where the step happens (`path`, `title`, `landmark`, `app`, `window`), for spotting popups and re-syncing |
| `expect` | checked right after the step, with no model (`urlContains`, `textContains`, `elementPresent`, `elementGone`, `windowTitleContains`, `labelPresent`, `focusedRole`) |
| `capture` | read a value off the screen into this input (a reference number) |
| `irreversible` | submits, pays, sends or deletes; the only place smart replay may pause |
| `observedAfter` | the screen right after the step when it was learned |

### Smart replay order

For each pass, smart replay works in this order:
1. Values are bound before anything is touched, from the request, a record or spreadsheet row, or the person's documents in the vault.
2. Conditions are applied and loops are unrolled.
3. Each step runs in this order:
   1. It checks the anchor. A popup is cleared by a known handler. A page that's already further along, or not there yet, makes the replay jump to the step that fits.
   2. The step is done the version 1 way.
   3. Typed values are read back and compared.
   4. `expect` is checked.
   5. Only when one of these fails does the model help with that step. If it can't, the agent finishes the job from where the replay is, and its fix can be saved into the skill.
4. Popups are cleared before a step acts, unless the step's own element is inside the popup. The replay tries these in order:
   1. the skill's own rules and the built-in ones (cookies, "stay signed in", surveys). These rules click only inside the popup.
   2. a button that only closes it ("Maybe later", "No thanks").
   3. one look by the model at a real modal. The model's choice is saved as a `learned` rule in `interrupts`.

   A learned rule fires only on a popup that says its words, never on the same words elsewhere on the page.
5. An irreversible step is never simply done again. The replay waits up to 25 seconds for its `expect`. The step is pressed once more only when the site says it failed for a passing reason ("busy, try again"). Otherwise the pass ends with "the site didn't confirm it — check before doing it again".
6. A pass missing a required value isn't started, but the other passes still run. When a run partly fails, its toast offers to retry only the failed passes, never one that may have gone through.
