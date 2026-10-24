import Foundation

/// The live tutor's model call, run natively when the Bun sidecar isn't around.
/// Mirrors brain/src/teach.ts: same prompt, same tool, one step per call.
public enum TeachBrain {
    public static func step(_ request: TeachStepRequest, key: String, model: String) async -> TeachLiveStep? {
        guard !key.isEmpty else { return nil }
        var urlRequest = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 60
        urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")

        var content: [[String: Any]] = []
        if let shot = request.screenshotBase64 {
            content.append(["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": shot]])
        }
        let turn = request.screenshotBase64 != nil
            ? "Step \(request.stepNumber). Frontmost app: \(request.app.isEmpty ? "unknown" : request.app). The screenshot is \(Int(request.imageWidth))x\(Int(request.imageHeight)) pixels. Give the next step."
            : "Step \(request.stepNumber). Frontmost app: \(request.app.isEmpty ? "unknown" : request.app). No screenshot this turn — teach with words only (action look, no coordinates)."
        content.append(["type": "text", "text": turn])

        let body: [String: Any] = [
            "model": model.isEmpty ? "claude-haiku-5-5" : model,
            "max_tokens": 700,
            "system": systemPrompt(request),
            "messages": [["role": "user", "content": content]],
            "tools": [tool],
            "tool_choice": ["type": "auto"],
        ]
        do {
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let blocks = json["content"] as? [[String: Any]] else { return nil }
            for block in blocks where block["type"] as? String == "tool_use" {
                guard let input = block["input"] as? [String: Any] else { continue }
                let raw = try JSONSerialization.data(withJSONObject: input)
                return try JSONDecoder().decode(TeachLiveStep.self, from: raw)
            }
            return nil
        } catch {
            return nil
        }
    }

    static let tool: [String: Any] = [
        "name": "okidoki_teach",
        "description": "Give the learner exactly one next step on their real screen, or finish the lesson.",
        "input_schema": [
            "type": "object",
            "properties": [
                "previous_done": ["type": "boolean", "description": "did the learner complete the previous step? judge from the screenshot and the log. true on the first step."],
                "action": ["type": "string", "enum": ["click", "double_click", "right_click", "drag", "type", "key", "scroll", "look", "open_app", "done"]],
                "say": ["type": "string", "description": "one or two short sentences, spoken aloud and shown: the control's real name, the action, and the idea"],
                "why": ["type": "string", "description": "optional. one short sentence with the idea or mental model behind this step"],
                "label": ["type": "string", "description": "2-4 lowercase words for the tag drawn next to the ring, e.g. 'frame tool', 'drag to playlist'"],
                "x": ["type": "number", "description": "center of the control in screenshot pixels, origin top-left"],
                "y": ["type": "number"],
                "w": ["type": "number", "description": "for a region (look, a panel, a settings group): width in screenshot pixels. omit for a button or icon"],
                "h": ["type": "number"],
                "from_x": ["type": "number", "description": "drag start"],
                "from_y": ["type": "number"],
                "to_x": ["type": "number", "description": "drag end"],
                "to_y": ["type": "number"],
                "target": ["type": "string", "description": "the control's visible text label, if it has one. the Mac snaps the ring to its real bounds"],
                "key": ["type": "string", "description": "for key: the shortcut, e.g. \"cmd+shift+a\", \"f\", \"return\", \"esc\""],
                "text": ["type": "string", "description": "for type: what to type"],
                "app": ["type": "string", "description": "for open_app: the app name"],
                "summary": ["type": "string", "description": "for done: one warm sentence about what they just learned"],
                "remaining": ["type": "integer", "description": "rough number of steps left after this one"],
                "also_x": ["type": "number", "description": "optional second region worth a glance, e.g. where the result will show up. center x in screenshot pixels"],
                "also_y": ["type": "number"],
                "also_w": ["type": "number"],
                "also_h": ["type": "number"],
                "also_label": ["type": "string", "description": "2-3 lowercase words for the second region"],
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

    /// Second look at a zoomed crop so a small icon's ring lands on the exact pixels.
    public static func refine(_ request: TeachRefineRequest, key: String, model: String) async -> TeachRefineResult {
        guard !key.isEmpty, !request.cropBase64.isEmpty else { return TeachRefineResult(found: false) }
        var urlRequest = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 25
        urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = [
            "model": model.isEmpty ? "claude-sonnet-4-5" : model,
            "max_tokens": 120,
            "system": "You pinpoint one control in a zoomed crop of a Mac screen (\(Int(request.cropWidth))x\(Int(request.cropHeight)) pixels, origin top-left). Return its exact center and size through okidoki_point. If it is not in the crop, found is false.",
            "messages": [["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": request.cropBase64]],
                ["type": "text", "text": "Find: \(request.describe)"],
            ]]],
            "tools": [pointTool],
            "tool_choice": ["type": "auto"],
        ]
        do {
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let blocks = json["content"] as? [[String: Any]],
                  let input = blocks.first(where: { $0["type"] as? String == "tool_use" })?["input"] as? [String: Any],
                  input["found"] as? Bool == true,
                  let x = input["x"] as? Double, let y = input["y"] as? Double,
                  x >= 0, y >= 0, x <= request.cropWidth, y <= request.cropHeight else {
                return TeachRefineResult(found: false)
            }
            return TeachRefineResult(found: true, x: x, y: y, w: input["w"] as? Double, h: input["h"] as? Double)
        } catch {
            return TeachRefineResult(found: false)
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
        let controls = request.controls.isEmpty ? "" : "\n\nControls the Mac can see through accessibility, with centers in screenshot pixels. When the thing you point at is in this list, copy its label into target exactly and use its center for x,y:\n"
            + request.controls.prefix(90).map { c in
                let size = c.w > 0 && c.h > 0 ? " \(Int(c.w))x\(Int(c.h))" : ""
                return "· “\(c.label)” (\(c.role)) at \(Int(c.x)),\(Int(c.y))\(size)"
            }.joined(separator: "\n")
        return """
        You are Okidoki's tutor. A person is learning "\(request.topic)" in \(app) on their own Mac.
        You see their screen right now. They do every action themselves. You point at the exact control and explain, one small step at a time, like a patient friend sitting beside them.
        Reply with exactly ONE step through okidoki_teach.

        How to teach:
        - One action per step: a click, a key, a drag, typing something, or just looking at something while you explain it.
        - say is one or two short sentences, spoken aloud and shown. Name the control by the label visible on screen, give the action, and the idea in the same breath ("a frame is a screen — click the frame tool, or press F").
        - why is optional: one short sentence with the concept or mental model. Skip it for obvious steps.
        - label is 2-4 lowercase words for the tag beside the ring, e.g. "frame tool", "drag to playlist".
        - Point exactly. x,y are pixels in the screenshot, origin top-left, at the center of the control. The image is \(Int(request.imageWidth))x\(Int(request.imageHeight)). For a region set w,h to hug it. Set target to the control's visible text label when it has one.
        - A drag: action drag with from_x, from_y, to_x, to_y.
        - A shortcut: action key with key. Still set x,y to where the result will show up when you can.
        - Typing: action type with text, and x,y on the field they type into.
        - Something to notice (a panel, the result of the last step): action look with x,y,w,h around it.
        - When the result of this step appears somewhere else, add also_x/also_y/also_w/also_h with also_label so they know where to watch.
        - If they need another app: action open_app with app.
        - Never box the whole window. If the control isn't visible, teach the step that reveals it first (open the menu, scroll, pick the tab). Only use look with no coordinates when there is truly nothing to point at.
        - No lecturing. Short, warm, lowercase labels, no emoji.

        Checking their work:
        - Look at the screenshot and the log. Set previous_done true if the last step happened: the screen shows its effect, or the log says they hit the target. Otherwise set previous_done false and give the same step again, pointing again, with a different explanation — a landmark ("top left, under the menu"), the icon's shape, or the shortcut. Never repeat yourself word for word, never scold.
        - They may do it a different way, get ahead of you, or wander. Follow the screen, not the outline. If they already achieved what the next step would do, skip it.
        - If something unexpected appeared (a dialog, a menu, a different app), teach them through it.
        - "skipped" in the log means move on. "okidoki did it" means that step is done. "nothing yet" after a long wait means they're stuck: make the step smaller and more concrete.
        - Pace to them: two clean hits in a row and you can take slightly bigger steps; a miss and you go smaller.

        Finishing:
        - When the goal is reached, action done with summary and a warm one-line say that names what they can now do.
        - Keep it tight: a small skill is 3-8 steps. remaining is your rough count of steps after this one.

        Loose outline from the planner (adjust freely):
        \(outline)\(controls)

        What has happened so far:
        \(log)
        """
    }
}
