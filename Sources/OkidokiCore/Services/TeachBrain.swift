import Foundation

/// The live tutor's model calls, run natively when the Bun sidecar isn't around.
/// Mirrors brain/src/teach.ts: same prompt, same tool, one step per call.
public enum TeachBrain {
    static let actions = ["click", "double_click", "right_click", "drag", "type", "key", "scroll", "look", "open_app", "done"]
    static let annotationKinds = ["callout", "badge", "bracket", "underline", "flow", "measure", "spotlight", "lens", "sketch", "ghost", "typing", "scroll"]
    static let stepModel = "claude-sonnet-5-5"
    static let fastModel = "claude-haiku-5-5"

    /// Writing a step means reading a busy screen and knowing the app: Sonnet, unless they chose bigger.
    /// Haiku keeps the zoom checks. Mirrors `teachModel` in brain/src/teach.ts.
    public static func stepModel(for configured: String) -> String {
        let name = configured.trimmingCharacters(in: .whitespaces)
        return name.isEmpty || name.lowercased().contains("haiku") ? stepModel : name
    }

    public static func step(_ request: TeachStepRequest, key: String, model: String) async -> TeachLiveStep? {
        guard !key.isEmpty else { return nil }
        var content: [[String: Any]] = []
        if let shot = request.screenshotBase64 {
            content.append(["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": shot]])
        }
        let app = request.app.isEmpty ? "unknown" : request.app
        let turn = request.screenshotBase64 != nil
            ? "Step \(request.stepNumber). Frontmost app: \(app). The screenshot is \(Int(request.imageWidth))x\(Int(request.imageHeight)) pixels\(request.controls.isEmpty ? "" : " with \(request.controls.count) marked elements"). Give the next step."
            : "Step \(request.stepNumber). Frontmost app: \(app). No screenshot this turn — teach with words only (action look, no coordinates)."
        content.append(["type": "text", "text": turn])
        let body: [String: Any] = [
            "model": stepModel(for: model),
            "max_tokens": 1100,
            "system": splitSystem(systemPrompt(request)),
            "messages": [["role": "user", "content": content]],
            "tools": [tool],
            "tool_choice": ["type": "auto"],
        ]
        guard let input = await call(body, key: key, timeout: 60) else { return nil }
        guard let raw = try? JSONSerialization.data(withJSONObject: input) else { return nil }
        return try? JSONDecoder().decode(TeachLiveStep.self, from: raw)
    }

    /// Second look at a zoomed crop so a small icon's ring lands on the exact pixels.
    public static func refine(_ request: TeachRefineRequest, key: String, model: String) async -> TeachRefineResult {
        guard !key.isEmpty, !request.cropBase64.isEmpty else { return TeachRefineResult(found: false) }
        let body: [String: Any] = [
            "model": model.isEmpty ? fastModel : model,
            "max_tokens": 160,
            "system": "You pinpoint one control in a zoomed crop of a Mac screen (\(Int(request.cropWidth))x\(Int(request.cropHeight)) pixels, origin top-left). Return its exact center and size through okidoki_point. If it is not in the crop, found is false.",
            "messages": [["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": request.cropBase64]],
                ["type": "text", "text": "Find: \(request.describe)"],
            ]]],
            "tools": [pointTool],
            "tool_choice": ["type": "auto"],
        ]
        guard let input = await call(body, key: key, timeout: 25),
              input["found"] as? Bool == true,
              let x = input["x"] as? Double, let y = input["y"] as? Double,
              x >= 0, y >= 0, x <= request.cropWidth, y <= request.cropHeight else {
            return TeachRefineResult(found: false)
        }
        return TeachRefineResult(found: true, x: x, y: y, w: input["w"] as? Double, h: input["h"] as? Double)
    }

    /// `tool_choice: auto` — the model may think or write before the tool block; the first tool_use is the answer.
    static func call(_ body: [String: Any], key: String, timeout: TimeInterval) async -> [String: Any]? {
        var urlRequest = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = timeout
        urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        do {
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let blocks = json["content"] as? [[String: Any]] else { return nil }
            return blocks.first(where: { $0["type"] as? String == "tool_use" })?["input"] as? [String: Any]
        } catch {
            return nil
        }
    }

    /// The fixed rules first with a cache marker, so steps reuse them.
    static func splitSystem(_ full: String) -> [[String: Any]] {
        let marker = "\nLoose outline from the planner"
        guard let range = full.range(of: marker) else { return [["type": "text", "text": full]] }
        return [
            ["type": "text", "text": String(full[..<range.lowerBound]), "cache_control": ["type": "ephemeral"]],
            ["type": "text", "text": String(full[range.lowerBound...])],
        ]
    }

    static let tool: [String: Any] = [
        "name": "okidoki_teach",
        "description": "Give the learner exactly one next step on their real screen, or finish the lesson.",
        "input_schema": [
            "type": "object",
            "properties": [
                "previous_done": ["type": "boolean", "description": "did the learner complete the previous step? judge from the screenshot and the log. true on the first step."],
                "waiting": ["type": "boolean", "description": "true when the screen is still loading or mid-animation and you should look again in a moment instead of teaching"],
                "action": ["type": "string", "enum": actions],
                "say": ["type": "string", "description": "one short sentence, spoken aloud and shown in a bubble by the control: its real name, the action, and the idea. two sentences only when the idea needs it"],
                "why": ["type": "string", "description": "rare. one short sentence with the mental model behind this step, only when there is one"],
                "label": ["type": "string", "description": "2-4 lowercase words for the tag beside the ring, e.g. 'frame tool', 'drag to playlist'"],
                "element": ["type": "integer", "description": "the number of the marked element to point at. prefer this over x,y whenever the control has a marker"],
                "x": ["type": "number", "description": "fallback: center of the control in screenshot pixels, origin top-left"],
                "y": ["type": "number"],
                "w": ["type": "number", "description": "for a region (look, a panel, a settings group): width in screenshot pixels. omit for a button or icon"],
                "h": ["type": "number"],
                "from_x": ["type": "number", "description": "drag start"],
                "from_y": ["type": "number"],
                "to_x": ["type": "number", "description": "drag end"],
                "to_y": ["type": "number"],
                "to_element": ["type": "integer", "description": "drag end as a marked element"],
                "target": ["type": "string", "description": "the control's visible text label, exactly as written on screen. always fill it for click, double_click, right_click and type; okidoki checks the marker against it"],
                "key": ["type": "string", "description": "for key: the shortcut, e.g. \"cmd+shift+a\", \"f\", \"return\", \"esc\""],
                "text": ["type": "string", "description": "for type: what to type"],
                "app": ["type": "string", "description": "for open_app: the app name"],
                "risky": ["type": "boolean", "description": "true if this step is irreversible or costly: send, delete, buy, publish, overwrite, post"],
                "summary": ["type": "string", "description": "for done: one warm sentence about what they can now do"],
                "remaining": ["type": "integer", "description": "rough number of steps left after this one"],
                "also_x": ["type": "number", "description": "optional second region worth a glance, e.g. where the result will show up. center x in screenshot pixels"],
                "also_y": ["type": "number"],
                "also_w": ["type": "number"],
                "also_h": ["type": "number"],
                "also_label": ["type": "string", "description": "2-3 lowercase words for the second region"],
                "annotations": [
                    "type": "array",
                    "description": "at most one extra drawing, only when it makes the step land. most steps have none. it has a kind and either element or x,y(,w,h).",
                    "items": [
                        "type": "object",
                        "properties": [
                            "kind": ["type": "string", "enum": annotationKinds],
                            "text": ["type": "string"],
                            "element": ["type": "integer"],
                            "x": ["type": "number"], "y": ["type": "number"], "w": ["type": "number"], "h": ["type": "number"],
                            "to_x": ["type": "number"], "to_y": ["type": "number"],
                            "n": ["type": "integer"],
                        ],
                        "required": ["kind"],
                    ],
                ],
                "next": [
                    "type": "object",
                    "description": "your best guess at the step after this one, shown instantly when they land this step while you check. omit if unsure or if this is the last step.",
                    "properties": [
                        "say": ["type": "string"], "action": ["type": "string", "enum": actions], "label": ["type": "string"],
                        "element": ["type": "integer"], "x": ["type": "number"], "y": ["type": "number"], "key": ["type": "string"],
                    ],
                    "required": ["say", "action"],
                ],
                "milestones": ["type": "array", "items": ["type": "string"], "description": "only on the first step: 3-6 short chapter names for the whole lesson"],
                "milestone": ["type": "integer", "description": "which chapter (0-based) this step belongs to"],
            ],
            "required": ["previous_done", "action", "say"],
        ],
    ]

    static let pointTool: [String: Any] = [
        "name": "okidoki_point",
        "description": "Give the exact pixel center of one control in a zoomed crop of the screen.",
        "input_schema": [
            "type": "object",
            "properties": [
                "found": ["type": "boolean", "description": "false if the control is not in this crop"],
                "x": ["type": "number", "description": "center x in crop pixels, origin top-left"],
                "y": ["type": "number"],
                "w": ["type": "number", "description": "width of the control in crop pixels"],
                "h": ["type": "number"],
            ],
            "required": ["found"],
        ],
    ]

    static func modeLines(_ mode: String) -> String {
        switch mode {
        case "practice":
            return "Mode: PRACTICE. They already saw this once and are trying alone. say names only the goal of the step (\"make a frame\") with no location hints. Still fill element/x,y so the ring can appear if they get stuck. If they do it, previous_done true and move on quickly."
        default:
            return "Mode: GUIDE ME. They do every action themselves. You point at the exact control and explain, one small step at a time, like a patient friend sitting beside them. The ring is how they find the control, so always give element or x,y — a step with no point leaves them searching."
        }
    }

    static func systemPrompt(_ request: TeachStepRequest) -> String {
        let outline = request.outline.isEmpty
            ? "none — teach from what you see."
            : request.outline.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        let log = request.log.isEmpty
            ? "none yet. this is the first step."
            : request.log.enumerated().map { index, entry in
                let label = entry.label.map { " “\($0)”" } ?? ""
                return "\(index + 1). \(entry.action)\(label): \(entry.say)\n   → \(entry.outcome.isEmpty ? "nothing yet" : entry.outcome)"
            }.joined(separator: "\n")
        let app = request.app.isEmpty ? "the app on screen" : request.app
        let controls = request.controls.isEmpty ? "" : "\n\nMarked elements. Each has a small pink number tag on the screenshot at its top-left; the list gives its label, role, center and size in screenshot pixels. When the thing you point at is marked, answer with element (its number). Use x,y only for things without a marker.\n"
            + request.controls.prefix(120).map { c in
                let size = c.w > 0 && c.h > 0 ? " \(Int(c.w))x\(Int(c.h))" : ""
                return "#\(c.id) “\(c.label)” (\(c.role)) at \(Int(c.x)),\(Int(c.y))\(size)"
            }.joined(separator: "\n")
        let known = request.known.isEmpty ? "" : "\n\nWhat they already know here (skip the basics of these):\n" + request.known.map { "· \($0)" }.joined(separator: "\n")
        let milestones = request.milestones.isEmpty ? "" : "\n\nChapters so far:\n" + request.milestones.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n")
        let language = request.language.map { "Write say, why and labels in \($0)." } ?? ""
        let pageBits = [request.pageTitle ?? "", request.pageURL ?? ""].filter { !$0.isEmpty }
        let page = pageBits.isEmpty ? "" : "\nThe browser tab in front is \(pageBits.joined(separator: " — ")). The lesson is about that site, not the browser: teach with its own panels, menus and controls, never the browser's."
        let menus = request.menus.isEmpty ? "" : "\n\nThe app's menu bar, exactly as it is (never name a menu or item that isn't here):\n" + request.menus.joined(separator: "\n")
        let landed = request.landed && !request.log.isEmpty ? "\nlanded — okidoki saw that last action hit its target." : ""
        return """
        You are Okidoki's tutor. A person is learning "\(request.topic)" in \(app) on their own Mac.
        You see their screen right now.\(page)
        \(modeLines(request.mode))
        Reply with exactly ONE step through okidoki_teach.
        \(language)

        How to teach:
        - One action per step: a click, a key, a drag, typing something, or just looking at something while you explain it.
        - say is one short sentence; two only when the idea needs it. Name the control by the label visible on screen, give the action, and the idea in the same breath ("a frame is a screen — click the frame tool, or press F").
        - why is rare: one short sentence with the mental model, only when there is one. Most steps have none.
        - label is 2-4 lowercase words for the tag beside the ring.
        - Point exactly. Prefer element (a marker number). Otherwise x,y are pixels in the \(Int(request.imageWidth))x\(Int(request.imageHeight)) screenshot, origin top-left, at the center of the control. For a region set w,h to hug it. Always set target to the control's visible text label for click, double_click, right_click and type; okidoki checks the marker against it.
        - A drag: action drag with from_x, from_y and to_x, to_y or to_element.
        - A shortcut: action key with key. Still point (element or x,y) at where the result will show up when you can.
        - Typing: action type with text, pointing at the field.
        - Something to notice (a panel, the result of the last step): action look with a region.
        - When the result of this step appears somewhere else, add also_x/also_y/also_w/also_h with also_label so they know where to watch.
        - If they need another app: action open_app with app.
        - Never box the whole window. If the control isn't visible, teach the step that reveals it first (open the menu, scroll, pick the tab). Only use look with no coordinates when there is truly nothing to point at.
        - Only real things: name menus, items and controls that are in the marked elements, on the screenshot, or in the menu bar listed below. Never a path you only remember.
        - No lecturing. Short, warm, lowercase labels, no emoji.

        Extra drawings (annotations): most steps need none. At most one, only when it makes the step land. spotlight at most once a lesson.
        - callout: a short note with a leader line to a spot ("this number is the gap between items"). text required.
        - badge: a numbered dot (n) for a sequence of places to click in order.
        - bracket: a brace spanning a group (w,h) with a 1-3 word text ("the toolbar").
        - underline: a hand-drawn underline under a label or menu item.
        - flow: a cause→effect arrow from x,y to to_x,to_y ("this slider → that number").
        - measure: a dimension line from x,y to to_x,to_y with text as the value ("16px").
        - spotlight: dim everything except this region (x,y,w,h). Use once, for the key moment.
        - lens: a magnifier over a tiny icon (element or x,y).
        - sketch: a loose hand-drawn circle around something to glance at.
        - ghost: a looping cursor demo of this step's click or drag (no coordinates needed; it uses the step's target).
        - typing: a preview of what to type, floating by the field (text).
        - scroll: chevrons showing which way to scroll (x,y; text "down" or "up").

        Checking their work:
        - Look at the screenshot and the log. Set previous_done true if the last step happened: the screen shows its effect, or the log says they hit the target. Otherwise set previous_done false and give the same step again, pointing again, with a DIFFERENT explanation — a landmark ("top left, under the menu"), the icon's shape, or the shortcut. Never repeat yourself word for word, never scold.
        - "landed" at the end of the log means okidoki saw their action hit the target. Its effect may not show (a tool selected, a mode toggled): previous_done is true, don't teach it again. Give the next step, or handle whatever appeared.
        - "while i was checking" in the log lists what they did as you looked: the screenshot is newer than your last step, so judge from it.
        - Start from where they are: if something is already set up or already done, don't redo it. If they already achieved what the next step would do, skip it.
        - They may do it a different way, get ahead of you, or wander. Follow the screen, not the outline.
        - If the screen is mid-load (spinner, blank page, half-drawn window), set waiting true with a short say and no action; you'll be asked again in a moment.
        - If something unexpected appeared (a dialog, a menu, a different app), teach them through it.
        - "skipped" in the log means move on. "okidoki did it" means that step is done. "nothing yet" after a long wait means they're stuck: make the step smaller and more concrete.
        - Never give a step that just failed in the same form. Change the approach.
        - Pace to them: two clean hits in a row and you can take slightly bigger steps; a miss and you go smaller.

        Structure:
        - On the FIRST step only, fill milestones: 3-6 short chapter names for the whole lesson. On every step set milestone to the chapter this step belongs to.
        - Fill next with your best guess at the following step when you are fairly sure; it appears instantly when they land this step.
        - Set risky true for anything irreversible or costly (send, delete, buy, publish, overwrite, post). Okidoki will ask before doing those.

        Finishing:
        - When the goal is reached, action done with summary and a warm one-line say that names what they can now do.
        - Keep it tight: a small skill is 3-8 steps. remaining is your rough count of steps after this one.\(menus)

        Loose outline from the planner (adjust freely):
        \(outline)\(milestones)\(known)\(controls)

        What has happened so far:
        \(log)\(landed)
        """
    }
}
