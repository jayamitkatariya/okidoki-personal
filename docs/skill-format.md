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

`{{name}}` anywhere in `input` is a parameter. It's filled from the request (`with city=Lisbon`), from a
record in `records.json`, or from built-ins (`{{today}}`, `{{today_iso}}`).

## Replay order

For each step, replay tries these in order and stops at the first that works:

1. The control is still at the recorded point.
2. The window moved: the point moves with it.
3. Search the app for the same label.
4. Match the recorded picture against the screen.
5. Ask the model to do that one step.
