import Foundation
import AppKit
import PDFKit

public final class DocumentReader {
    public static func read(url: URL) -> String? {
        if url.pathExtension.lowercased() == "pdf" {
            guard let document = PDFDocument(url: url) else { return nil }
            var text = ""
            for index in 0..<min(document.pageCount, 60) {
                if let page = document.page(at: index), let string = page.string {
                    text += string + "\n"
                }
            }
            return text
        }
        if let text = try? String(contentsOf: url, encoding: .utf8) { return text }
        return nil
    }
}

@MainActor
public final class BrainService {
    private let store: OkidokiStore
    private let session: URLSession

    public init(store: OkidokiStore) {
        self.store = store
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 75
        config.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: config)
    }

    public func think(_ request: BrainRequest) async -> BrainResult {
        let key = Keychain.get("anthropic") ?? ""
        if !key.isEmpty {
            do {
                let decision = try await anthropic(request, key: key)
                return BrainResult(decision: decision, usedModel: true)
            } catch {
                let local = await LocalBrain.decide(request, store: store)
                return BrainResult(decision: local, usedModel: false, error: friendlyError(error))
            }
        }
        let local = await LocalBrain.decide(request, store: store)
        return BrainResult(decision: local, usedModel: false, error: nil)
    }

    private func friendlyError(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet: return "no internet — answered locally"
            case .timedOut: return "the model took too long — answered locally"
            default: return "model unavailable — answered locally"
            }
        }
        return "model unavailable — answered locally"
    }

    // MARK: - Anthropic

    private func anthropic(_ request: BrainRequest, key: String) async throws -> BrainDecision {
        var urlRequest = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")

        var messages: [[String: Any]] = []
        if let threadID = request.threadID, let thread = store.thread(threadID) {
            for message in thread.messages.suffix(10) {
                let role = message.role == .assistant ? "assistant" : "user"
                messages.append(["role": role, "content": message.text])
            }
        }
        if messages.isEmpty || messages.last?["role"] as? String != "user" {
            var content: [[String: Any]] = []
            if let png = request.screenshotPNG {
                content.append([
                    "type": "image",
                    "source": ["type": "base64", "media_type": "image/png", "data": png.base64EncodedString()],
                ])
            }
            content.append(["type": "text", "text": userText(request)])
            messages.append(["role": "user", "content": content])
        } else {
            messages[messages.count - 1] = ["role": "user", "content": userText(request)]
        }
        // Anthropic requires alternating roles. Collapse adjacent turns.
        var normalized: [[String: Any]] = []
        for message in messages {
            if let last = normalized.last, last["role"] as? String == message["role"] as? String {
                normalized[normalized.count - 1] = message
            } else {
                normalized.append(message)
            }
        }

        let body: [String: Any] = [
            "model": store.settings.claudeModel,
            "max_tokens": 1600,
            "system": systemPrompt(request),
            "messages": normalized,
            "tools": [responseTool],
            "tool_choice": ["type": "tool", "name": "okidoki_respond"],
        ]
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw BrainError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "http \(http.statusCode)"
            if http.statusCode == 401 { throw BrainError.invalidKey }
            if http.statusCode == 429 { throw BrainError.rateLimited }
            throw BrainError.server(message)
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]] else { throw BrainError.badResponse }

        for block in content {
            if block["type"] as? String == "tool_use",
               let input = block["input"] as? [String: Any] {
                let normalized = normalize(input)
                let inputData = try JSONSerialization.data(withJSONObject: normalized)
                let decoder = JSONDecoder()
                if let decision = try? decoder.decode(BrainDecision.self, from: inputData) {
                    return decision
                }
            }
        }
        if let textBlock = content.first(where: { $0["type"] as? String == "text" }),
           let text = textBlock["text"] as? String, !text.isEmpty {
            return BrainDecision(kind: .answer, title: "okidoki", answer: text, speak: text)
        }
        throw BrainError.empty
    }

    private var responseTool: [String: Any] {
        let schema: [String: Any] = [
            "type": "object",
            "properties": [
                "kind": ["type": "string", "enum": ["answer", "quick_action", "terminal", "coding", "background", "teach", "borrow", "watch", "memory", "routine"]],
                "title": ["type": "string", "description": "short lowercase title, max 6 words"],
                "answer": ["type": "string", "description": "the response to show in the card; short, warm, concrete, markdown allowed"],
                "speak": ["type": "string", "description": "what to say aloud; 1-2 sentences, or empty"],
                "risk": ["type": "string", "enum": ["low", "medium", "high"]],
                "preview_summary": ["type": "string"],
                "preview_steps": ["type": "array", "items": ["type": "string"]],
                "commands": ["type": "array", "items": ["type": "string"], "description": "exact shell commands. Use {{file}}, {{outputDir}}, {{basename}}, {{dir}} placeholders; the app fills them after a file picker."],
                "apps": ["type": "array", "items": ["type": "string"]],
                "files": ["type": "array", "items": ["type": "string"]],
                "teach_steps": ["type": "array", "items": ["type": "string"], "description": "for teach: 4-7 steps, each one action"],
                "memory": ["type": "array", "items": ["type": "string"], "description": "durable facts worth remembering"],
                "routine_name": ["type": "string"],
                "routine_cadence": ["type": "string", "enum": ["hourly", "daily", "weekdays", "weekly", "manual"]],
                "routine_weekday": ["type": "integer"],
                "routine_hour": ["type": "integer"],
                "routine_minute": ["type": "integer"],
                "quick_action": [
                    "type": "object",
                    "properties": [
                        "type": ["type": "string", "enum": ["reminder", "note", "event", "move_event"]],
                        "title": ["type": "string"],
                        "body": ["type": "string"],
                        "date": ["type": "string", "description": "ISO8601"],
                        "hour": ["type": "integer"],
                        "weekday": ["type": "integer", "description": "1=Sunday ... 7=Saturday"],
                    ],
                    "required": ["type", "title"],
                ],
                "pick_file": ["type": "string", "enum": ["video", "pdf", "document", "images", "folder"]],
                "builtin": ["type": "string"],
                "clarification": ["type": "string"],
                "actions": ["type": "array", "items": ["type": "string"]],
            ],
            "required": ["kind", "title", "answer"],
        ]
        return [
            "name": "okidoki_respond",
            "description": "Always respond with this. Decide how to help: answer, quick_action, terminal, coding, background, teach, borrow, watch, memory, or routine.",
            "input_schema": schema,
        ]
    }

    private func normalize(_ input: [String: Any]) -> [String: Any] {
        var mapped: [String: Any] = [:]
        let keyMap = [
            "preview_summary": "previewSummary",
            "preview_steps": "previewSteps",
            "teach_steps": "teachSteps",
            "routine_name": "routineName",
            "routine_cadence": "routineCadence",
            "routine_weekday": "routineWeekday",
            "routine_hour": "routineHour",
            "routine_minute": "routineMinute",
            "quick_action": "quickAction",
            "pick_file": "pickFile",
        ]
        for (key, value) in input {
            mapped[keyMap[key] ?? key] = value
        }
        return mapped
    }

    private func userText(_ request: BrainRequest) -> String {
        var parts: [String] = []
        parts.append("Request: \(request.text.isEmpty ? "(no words — they circled something)" : request.text)")
        if !request.appName.isEmpty { parts.append("Frontmost app: \(request.appName)") }
        if let selection = request.selection {
            parts.append(String(format: "They circled screen area x=%.0f y=%.0f w=%.0f h=%.0f.", selection.origin.x, selection.origin.y, selection.width, selection.height))
        }
        if !request.attachmentName.isEmpty {
            parts.append("Attached document: \(request.attachmentName)")
        }
        if !request.documentText.isEmpty {
            parts.append("Document text (truncated):\n\(String(request.documentText.prefix(40000)))")
        }
        if !request.clipboardText.isEmpty {
            parts.append("Clipboard:\n\(String(request.clipboardText.prefix(6000)))")
        }
        return parts.joined(separator: "\n\n")
    }

    private func systemPrompt(_ request: BrainRequest) -> String {
        var parts: [String] = []
        parts.append("""
        You are Okidoki, a warm, quick Mac assistant that lives in the notch and beside your cursor.
        Speak like a sharp friend: lowercase in labels, short sentences, no emoji, no corporate voice.
        You always respond through the okidoki_respond tool.

        Decide how to help without asking the person to pick a mode:
        - a question → answer
        - a small action in Reminders, Calendar or Notes → quick_action
        - a terminal job using free open-source tools → terminal, always with an action preview
        - writing or fixing code → coding (the app runs their chosen coding agent)
        - a long batch job → background
        - learning → teach, with 4-7 tiny steps
        - something that needs their screen → borrow, with a clear preview
        - "watch me" → watch
        - a durable fact → memory
        - a recurring job → routine
        If the request is genuinely unclear, answer with one short question in `clarification` and set `actions` to ["show", "do"]. Ask once, not twice.

        Rules:
        - Never claim an action is done. The app asks for approval and then executes it.
        - Keep answers under 120 words unless they asked for depth.
        - For risky or destructive work set risk=high and explain plainly.
        - Never target Okidoki's own windows (dashboard, notch, cards, overlays). This is a hard self-guard.
        - Screenshots are never stored; don't suggest keeping them.
        - Prefer Apple apps and free tools. Never buy, send or delete without approval.
        - When they sound stuck, offer a walkthrough rather than a lecture.
        - If there is a screenshot, actually look at it. Refer to what is visible.
        """)
        let ctx = store.memoryContext
        if !ctx.isEmpty { parts.append("What you remember:\n\(ctx)") }
        if !store.settings.customInstructions.isEmpty {
            parts.append("Their custom instructions:\n\(store.settings.customInstructions)")
        }
        parts.append("Current app: \(request.appName.isEmpty ? "unknown" : request.appName)")
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE, MMM d, yyyy 'at' h:mm a"
        parts.append("Now: \(formatter.string(from: Date()))")
        if let thread = request.threadID.flatMap({ store.thread($0) }) {
            parts.append("This is the ongoing thread “\(thread.title)”. Continue it instead of starting over.")
        }
        return parts.joined(separator: "\n\n")
    }
}

public enum BrainError: LocalizedError {
    case badResponse, empty, invalidKey, rateLimited, server(String)
    public var errorDescription: String? {
        switch self {
        case .badResponse: return "the model sent something unexpected"
        case .empty: return "the model came back empty"
        case .invalidKey: return "that Anthropic key was rejected"
        case .rateLimited: return "the model is rate limited right now"
        case .server(let message): return message
        }
    }
}

// MARK: - Local brain

public enum LocalBrain {
    @MainActor public static func decide(_ request: BrainRequest, store: OkidokiStore) async -> BrainDecision {
        let raw = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = raw.lowercased()

        if t.isEmpty {
            if request.screenshotPNG != nil {
                return BrainDecision(kind: .answer, title: "what i see",
                                     answer: "i can see the area you circled. tell me what you want to know about it — “what's wrong here?” or “make this better.”",
                                     speak: "I can see what you circled. What do you want to know?")
            }
            return BrainDecision(kind: .answer, title: "okidoki", answer: "i'm here. ask me anything, or circle something on screen.")
        }

        if t == "nevermind" || t == "never mind" || t == "cancel" {
            return BrainDecision(kind: .answer, title: "okidoki", answer: "okay, nevermind.")
        }

        if t == "start fresh" || t.contains("new thread") {
            return BrainDecision(kind: .answer, title: "fresh thread", answer: "fresh thread. what are we doing?")
        }

        if ["hi", "hey", "hello", "yo", "okidoki", "hey okidoki"].contains(t) {
            let name = store.activeAccount.firstName
            return BrainDecision(kind: .answer, title: "hey \(name)",
                                 answer: "hey \(name). shake anytime. i can answer, do, teach, or hand it to a coding agent.",
                                 speak: "Hey \(name). What do you need?")
        }

        if t.contains("who are you") || t.contains("what are you") {
            return BrainDecision(kind: .answer, title: "okidoki",
                                 answer: "i'm okidoki — a little Mac assistant that lives in your notch. i answer questions, do small jobs, take over the boring parts, and teach when you'd rather learn. you're in charge of what i remember.",
                                 speak: "I'm Okidoki. I live in your notch and help you get things done.")
        }

        if t.contains("what can you do") || t == "help" || t.contains("how do you work") {
            return BrainDecision(kind: .answer, title: "what i do",
                                 answer: """
                                 a few things, without picking a mode:

                                 - answer: “what's this error?” or “summarize this pdf”
                                 - quick actions: “remind me to call mom at 6”
                                 - terminal: “my mac is out of space” → mole, with approval
                                 - coding: “build me a script…” → your chosen agent
                                 - teach: “teach me auto layout in figma”
                                 - watch: “watch me do this once” → a reusable skill

                                 shake again to dismiss.
                                 """,
                                 speak: "I can answer, do, teach, or hand it to your coding agent. Try asking me what's on your screen.")
        }

        // Memory
        if t.contains("remember") {
            var fact = raw
            for prefix in ["remember that ", "remember ", "keep in mind that ", "keep in mind "] {
                if let range = fact.lowercased().range(of: prefix) {
                    fact = String(fact[range.upperBound...])
                    break
                }
            }
            let section: MemorySection = t.contains("right now") || t.contains("i'm working") ? .rightNow : .aboutYou
            return BrainDecision(kind: .memory, title: "noted", answer: "noted. i'll remember: \(fact)",
                                 speak: "Noted.", previewSummary: fact, memory: [fact])
        }
        if t.contains("what do you remember") || t.contains("what do you know about me") {
            let about = store.memories(.aboutYou).prefix(8).map { "· \($0.text)" }.joined(separator: "\n")
            let now = store.memories(.rightNow).prefix(4).map { "· \($0.text)" }.joined(separator: "\n")
            var body = "about you:\n\(about.isEmpty ? "nothing yet." : about)"
            if !now.isEmpty { body += "\n\nright now:\n\(now)" }
            body += "\n\nyou can edit or delete all of this in memory."
            return BrainDecision(kind: .answer, title: "what i remember", answer: body)
        }

        // Watch me
        if t.hasPrefix("watch me") || t.contains("record what i do") {
            return BrainDecision(kind: .watch, title: "watching you",
                                 answer: "go ahead — do it once, slowly. i'll watch app changes and clicks, then repeat it back as plain steps. shake again when you're done.",
                                 speak: "I'm watching. Do it once, then shake again.")
        }

        // Computer use: open any app
        if let openApp = openAppName(from: t) {
            return BrainDecision(kind: .computerUse, title: "open \(openApp.lowercased())",
                                 answer: "i'll open \(openApp) and take it from there. approve once, then i drive — you'll see every move and can stop me anytime.",
                                 speak: "Opening \(openApp).",
                                 risk: .medium,
                                 previewSummary: "open \(openApp) and do the rest if needed",
                                 previewSteps: ["open \(openApp)", "look at the screen", "finish anything else you asked"],
                                 apps: [openApp],
                                 actions: ["go ahead"])
        }

        // Computer use: messaging apps end to end
        let messengers = ["whatsapp", "telegram", "slack", "discord", "imessage", "messages"]
        if let messenger = messengers.first(where: { t.contains($0) }) {
            let appName = messenger == "imessage" || messenger == "messages" ? "Messages"
                : messenger.prefix(1).uppercased() + messenger.dropFirst()
            return BrainDecision(kind: .computerUse, title: "\(messenger) it",
                                 answer: "i can do that end to end — open \(appName), find the chat, write the message, press send. one approval, then i drive it live and you can stop me anytime.",
                                 speak: "I can message them for you. Want me to drive?",
                                 risk: .medium,
                                 previewSummary: "drive \(appName) end to end",
                                 previewSteps: ["open \(appName)", "open the right chat", "type the message", "send it"],
                                 apps: [appName],
                                 actions: ["go ahead"])
        }
        if t.hasPrefix("message ") || t.hasPrefix("text ") || t.hasPrefix("send ") || t.contains(" message ") {
            return BrainDecision(kind: .computerUse, title: "send the message",
                                 answer: "i'll drive the messaging app end to end — find the person, write it, press send. one approval, then i take over live; move your mouse and i stop.",
                                 speak: "I can send that for you. Want me to drive?",
                                 risk: .medium,
                                 previewSummary: "drive the messaging app end to end",
                                 previewSteps: ["open the messaging app", "open the right chat", "type the message", "send it"],
                                 apps: [],
                                 actions: ["go ahead"])
        }
        if ["notion", "blender", "figma", "freecad", "sketch", "autocad"].contains(where: { t.contains($0) }) {
            return BrainDecision(kind: .computerUse, title: shortTitle(raw),
                                 answer: "i can drive that app end to end — menus, buttons, typing, the whole flow. approve once, then i take over live; move your mouse and i stop.",
                                 speak: "I can do that in the app. Want me to drive?",
                                 risk: .medium,
                                 previewSummary: shortTitle(raw),
                                 previewSteps: ["open the app", "look at the screen", "click and type through it", "hand control back"],
                                 apps: [],
                                 actions: ["go ahead"])
        }

        // Simulation / overlay
        if t.contains("simulat") || t.contains("visualiz") || t.contains("visualis") {
            return BrainDecision(kind: .answer, title: "simulation",
                                 answer: "i can render a live simulation right on your screen — physics, flow, anything — but building one needs the brain running and an Anthropic key. add one in keys and ask again.",
                                 actions: ["add key"])
        }

        // Routine
        if t.hasPrefix("every ") || t.contains("every friday") || t.contains("every monday") || t.contains("every day at") || t.contains("each week") {
            if let routine = parseRoutine(raw) {
                return BrainDecision(kind: .routine, title: "routine: \(routine.name)",
                                     answer: "got it — \(routine.schedule). “\(routine.action)”. i'll run it and leave the result in the notch. you can change or pause it anytime.",
                                     speak: "Routine saved.",
                                     previewSummary: routine.action,
                                     commands: [routine.action],
                                     routineName: routine.name, routineCadence: "weekly",
                                     routineWeekday: routine.weekday, routineHour: routine.hour,
                                     routineMinute: routine.minute, actions: ["run now"])
            }
        }

        // Reminder
        if t.contains("remind") || t.hasPrefix("reminder") {
            let title = reminderTitle(raw)
            let date = detectedDate(in: raw)
            var qa = QuickActionPayload(type: "reminder", title: title,
                                        date: date.map { ISO8601DateFormatter().string(from: $0) })
            qa.title = title
            let when = date.map { naturalDate($0) } ?? "no date"
            return BrainDecision(kind: .quickAction, title: "reminder",
                                 answer: "done — “\(title)” is in reminders\(date == nil ? "" : " for \(when)"). tap the notch to undo or edit.",
                                 speak: "Reminder set.",
                                 previewSummary: "add reminder: \(title) · \(when)",
                                 actions: ["undo", "edit"],
                                 quickAction: qa)
        }

        // Note
        if t.hasPrefix("note ") || t == "note this" || t == "note that" || t.contains("make a note") {
            let body: String
            if t.contains("clipboard") || t == "note this" || t == "note that" || t.contains("note this") {
                body = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? request.text
            } else {
                body = raw.replacingOccurrences(of: "(?i)^(make a note|note)( that| this)?[ :]*", with: "", options: .regularExpression)
            }
            let title = "okidoki · " + ISO8601DateFormatter().string(from: Date()).prefix(10)
            return BrainDecision(kind: .quickAction, title: "note saved",
                                 answer: "saved to notes as “\(title)”. tap the notch to undo.",
                                 speak: "Note saved.",
                                 previewSummary: "new note in Notes",
                                 actions: ["undo", "open"],
                                 quickAction: QuickActionPayload(type: "note", title: String(title), body: body.isEmpty ? request.text : body))
        }

        // Move a calendar event
        if (t.contains("move") || t.contains("reschedule")) && (t.contains("pm") || t.contains("am")) {
            let hour = parseClockHour(t) ?? 15
            let weekday = parseWeekday(t) ?? 6
            let dayName = weekdayName(weekday)
            return BrainDecision(kind: .quickAction, title: "move event",
                                 answer: "i'll move your \(hour):00 event to \(dayName). approval in the notch?",
                                 speak: "I can move that to \(dayName).",
                                 risk: .medium,
                                 previewSummary: "move today's \(hour):00 event to \(dayName)",
                                 actions: ["do it"],
                                 quickAction: QuickActionPayload(type: "move_event", title: "move \(hour):00 event", hour: hour, weekday: weekday))
        }

        // Calendar questions
        if t.contains("calendar") || t.contains("meeting") || t.contains("schedule") || t.contains("what's next") {
            if store.settings.appleCalendar || UserDefaults.standard.bool(forKey: "okidoki.automationGranted") {
                do {
                    let events = try await AppleBridge.shared.eventsToday()
                    if events.isEmpty {
                        return BrainDecision(kind: .answer, title: "calendar", answer: "nothing on the calendar today. a clear deck.")
                    }
                    let lines = events.prefix(6).map { "· \(timeString($0.start)) — \($0.title)" }.joined(separator: "\n")
                    return BrainDecision(kind: .answer, title: "today", answer: "here's today:\n\n\(lines)")
                } catch {
                    return BrainDecision(kind: .answer, title: "calendar",
                                         answer: "i can't read calendar yet — connect it in toolbox, or grant automation when macOS asks.")
                }
            }
            return BrainDecision(kind: .answer, title: "calendar",
                                 answer: "calendar isn't connected yet. turn it on in toolbox → apple apps, and i'll answer this properly.")
        }

        // Free space / cleanup
        if t.contains("out of space") || t.contains("free space") || t.contains("disk space") || t.contains("clean my mac") || t.contains("storage") {
            let snapshot = DiskInspector.snapshot()
            let breakdown = await DiskInspector.cacheBreakdown()
            let mole = ShellRunner.which("mo") != nil || ShellRunner.which("mole") != nil
            var lines: [String] = []
            if let snapshot {
                lines.append("you're using \(Bytes.human(snapshot.used)) of \(Bytes.human(snapshot.total)) — \(Int(snapshot.usedFraction * 100))%.")
            }
            if !breakdown.isEmpty {
                lines.append("")
                for (name, size) in breakdown.prefix(4) {
                    lines.append("· \(name.split(separator: "/").last.map(String.init) ?? name) — \(Bytes.human(size))")
                }
            }
            lines.append("")
            if mole {
                lines.append("mole is installed. i can clean caches, logs and trash with a preview first.")
            } else {
                lines.append("mole is the free cleaner i'd use. installing it is one homebrew command, and i'll ask first.")
            }
            let commands = mole ? ["mo clean --dry-run", "mo clean"] : ["brew install mole", "mo clean --dry-run", "mo clean"]
            return BrainDecision(kind: .terminal, title: "free up space",
                                 answer: lines.joined(separator: "\n"),
                                 speak: "Here's what's using space. I can clean it with Mole, with your approval.",
                                 risk: mole ? .medium : .medium,
                                 previewSummary: mole ? "scan with Mole, then clean caches and trash" : "install Mole, scan, then clean caches and trash",
                                 previewSteps: mole ? ["dry-run scan with mole", "clean caches, logs and trash", "show freed space"] : ["install mole with homebrew", "dry-run scan", "clean caches, logs and trash"],
                                 commands: commands,
                                 apps: ["Terminal"],
                                 actions: ["review"])
        }

        if t.contains("downloads folder") || (t.contains("clean") && t.contains("downloads")) {
            let command = "find \"$HOME/Downloads\" -maxdepth 1 -type f -mtime +30 -print0 | xargs -0 -I{} mv {} \"$HOME/.Trash/\""
            return BrainDecision(kind: .terminal, title: "clean downloads",
                                 answer: "i'll move files older than 30 days from Downloads to the Trash — nothing is deleted for good. approval first.",
                                 risk: .high, previewSummary: "move Downloads files older than 30 days to Trash",
                                 previewSteps: ["list files older than 30 days", "move them to Trash", "leave recent files alone"],
                                 commands: ["find \"$HOME/Downloads\" -maxdepth 1 -type f -mtime +30 -ls", command],
                                 apps: ["Finder"], actions: ["review"])
        }

        // Video compression
        if t.contains("compress") || (t.contains("video") && t.contains("discord")) || t.contains("make this video smaller") {
            return BrainDecision(kind: .terminal, title: "compress video",
                                 answer: "pick the video. i'll make a smaller H.264 copy at 1280 wide — good for Discord — and leave the original untouched.",
                                 speak: "Pick a video and I'll compress a copy.",
                                 risk: .low, previewSummary: "compress a video for Discord with ffmpeg",
                                 previewSteps: ["read the video", "scale to 1280 wide, h.264 crf 28", "write a new file next to it"],
                                 commands: ["ffmpeg -i {{file}} -vf \"scale='min(1280,iw)':-2\" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart {{outputDir}}/{{basename}}-discord.mp4"],
                                 apps: ["Terminal"], actions: ["choose file"], pickFile: "video")
        }

        // OCR
        if t.contains("ocr") || t.contains("searchable") || t.contains("scanned") {
            let hasTool = ShellRunner.which("ocrmypdf") != nil
            return BrainDecision(kind: .terminal, title: "make scans searchable",
                                 answer: "pick the PDF. i'll add a searchable text layer without touching the original.\(hasTool ? "" : " ocrmypdf needs a one-time install; i'll ask first.")",
                                 risk: .medium, previewSummary: "OCR a PDF with ocrmypdf",
                                 previewSteps: ["read the scan", "recognise text", "write a searchable copy"],
                                 commands: hasTool
                                    ? ["ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"]
                                    : ["brew install ocrmypdf", "ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"],
                                 apps: ["Terminal"], actions: ["choose file"], pickFile: "pdf")
        }

        // Document conversion
        if t.contains("convert this to word") || t.contains("convert to word") || t.contains("make this a pdf") || t.contains("pandoc") || (t.contains("convert") && t.contains("document")) {
            return BrainDecision(kind: .terminal, title: "convert document",
                                 answer: "pick the document. pandoc will make a copy in a format Word can open, right beside it.",
                                 risk: .low, previewSummary: "convert a document with pandoc",
                                 previewSteps: ["read the source", "convert with pandoc", "write a new file"],
                                 commands: ["pandoc {{file}} -o {{outputDir}}/{{basename}}.docx"],
                                 apps: ["Terminal"], actions: ["choose file"], pickFile: "document")
        }

        // Image batch
        if t.contains("resize") && (t.contains("image") || t.contains("photo") || t.contains("picture")) || t.contains("heic") {
            return BrainDecision(kind: .terminal, title: "resize images",
                                 answer: "pick a folder. i'll write resized copies to a sibling folder and leave the originals alone.",
                                 risk: .low, previewSummary: "batch resize images with ImageMagick",
                                 previewSteps: ["read the folder", "resize to 1600px", "write copies to a new folder"],
                                 commands: ["mkdir -p {{outputDir}} && magick mogrify -resize '1600x1600>' -path {{outputDir}} {{dir}}/*.{jpg,jpeg,png,heic}"],
                                 apps: ["Terminal"], actions: ["choose folder"], pickFile: "images")
        }

        // Keynote export / big batch
        if (t.contains("keynote") || t.contains("decks")) && t.contains("export") {
            return BrainDecision(kind: .background, title: "export keynote decks",
                                 answer: "pick the folder of decks. i'll export each one to PDF into a new folder, quietly, while you keep working.",
                                 speak: "Pick the folder and I'll export them in the background.",
                                 risk: .low, previewSummary: "batch-export Keynote decks to PDF",
                                 previewSteps: ["scan the folder for .key files", "open each deck in Keynote", "export PDFs into one folder"],
                                 apps: ["Keynote"], actions: ["choose folder"], pickFile: "folder", builtin: "export-keynote")
        }
        if t.contains("batch") && (t.contains("convert") || t.contains("video")) {
            return BrainDecision(kind: .background, title: "batch convert videos",
                                 answer: "pick a folder. i'll convert every video to a smaller MP4 into a new folder, one at a time, while you keep working.",
                                 risk: .medium, previewSummary: "batch-convert a folder of videos with ffmpeg",
                                 previewSteps: ["scan the folder", "convert each video", "leave originals alone"],
                                 commands: ["mkdir -p {{outputDir}}; for f in {{dir}}/*.{mov,mp4,avi,mkv}; do [ -f \"$f\" ] || continue; ffmpeg -i \"$f\" -vf \"scale='min(1280,iw)':-2\" -c:v libx264 -crf 28 -c:a aac \"{{outputDir}}/$(basename \"${f%.*}\")-small.mp4\"; done"],
                                 apps: ["Terminal"], actions: ["choose folder"], pickFile: "folder")
        }

        // PDF summarize
        if t.contains("summarize") || t.contains("summarise") {
            if !request.documentText.isEmpty {
                let summary = summarize(request.documentText, name: request.attachmentName)
                return BrainDecision(kind: .answer, title: "summary",
                                     answer: summary, speak: "Here's the short version.")
            }
            if !request.clipboardText.isEmpty {
                let summary = summarize(request.clipboardText, name: "clipboard")
                return BrainDecision(kind: .answer, title: "summary", answer: summary)
            }
            return BrainDecision(kind: .answer, title: "summarize",
                                 answer: "pick the PDF and ask again — i'll read the whole thing, not just the page you're on.",
                                 actions: ["choose pdf"], pickFile: "pdf")
        }

        // What's this error
        if t.contains("error") || t.contains("not working") || t.contains("broken") || t.contains("what's this") || t.contains("what is this") {
            if request.screenshotPNG == nil {
                let clip = request.clipboardText.isEmpty ? (NSPasteboard.general.string(forType: .string) ?? "") : request.clipboardText
                if !clip.isEmpty {
                    return BrainDecision(kind: .answer, title: "looks like",
                                         answer: explainError(clip), actions: ["explain more", "fix it"])
                }
                return BrainDecision(kind: .answer, title: "show me",
                                     answer: "circle the error — press the pencil when you summon me — or copy it and ask again. i'll read the whole thing.",
                                     actions: ["circle it"])
            }
            return BrainDecision(kind: .answer, title: "what i see",
                                 answer: "i can see the area you circled. to read the actual text I need an Anthropic key — add one in keys, or paste the error here. without it i can still walk you through common fixes.",
                                 actions: ["add key"])
        }

        // Teach
        if t.contains("teach me") || t.hasPrefix("how do i") || t.hasPrefix("how to") || t.contains("walk me through") || t.contains("show me how") || t.contains("learn ") {
            let topic = teachTopic(from: raw)
            let steps = TeachLibrary.steps(for: topic)
            return BrainDecision(kind: .teach, title: "teach: \(topic)",
                                 answer: "alright — \(topic). i'll mark each step on screen and wait for you. take your time; i'll only move when you do.",
                                 speak: "Let's learn \(topic). I'll show you one step at a time.",
                                 teachSteps: steps)
        }

        // Coding
        if t.contains("build me") || t.contains("write a script") || t.contains("make a script") || t.contains("fix this bug") || t.contains("fix the bug") || t.contains("refactor") || t.contains("set up this repo") || t.contains("set up this github") || t.contains("run it") || (t.contains("code") && t.contains("write")) {
            let agent = store.settings.selectedAgent
            return BrainDecision(kind: .coding, title: shortTitle(raw),
                                 answer: "i'll hand this to \(agent.displayName). first you'll see the plan and the files it wants to touch — nothing runs until you say so.",
                                 speak: "I'll hand this to \(agent.displayName).",
                                 risk: .medium,
                                 previewSummary: "\(agent.displayName) works on: \(shortTitle(raw))",
                                 previewSteps: ["read the project", "plan the change", "edit files", "run tests or a check", "summarise in plain english"],
                                 commands: [],
                                 apps: [agent.displayName],
                                 actions: ["review"])
        }

        // Screenshot present and a normal question → answer honestly
        if request.screenshotPNG != nil {
            return BrainDecision(kind: .answer, title: "what i see",
                                 answer: "i have the screen area, but reading it needs an Anthropic key. paste the text here, or add a key in keys and ask again. i can still help from what you type.",
                                 actions: ["add key"])
        }

        // Generic terminal hints
        if t.contains("install") && t.contains("tool") {
            return BrainDecision(kind: .terminal, title: "find a tool",
                                 answer: "tell me what you want to do — “find me a free tool for video compression” — and i'll compare the options by upkeep, popularity and license.",
                                 actions: ["find a tool"])
        }

        // Fallback: a useful answer, plus a single clarification
        let name = store.activeAccount.firstName
        return BrainDecision(kind: .answer, title: "okidoki",
                             answer: "i heard “\(shortTitle(raw))”. i can answer it, do the small version now, or teach you how. which one?",
                             speak: "Want me to show you, or do it?",
                             clarification: "want me to show you, or do it?",
                             actions: ["show me", "do it"])
    }

    // MARK: - Parsing helpers

    private static func openAppName(from text: String) -> String? {
        guard let range = text.range(of: #"^(please\s+)?(open|launch|start)\s+(the\s+)?([\w .+]+?)(\s+app)?[.!?]*$"#,
                                     options: [.regularExpression, .caseInsensitive]) else { return nil }
        let match = text[range]
        let cleaned = match
            .replacingOccurrences(of: #"^(please\s+)?(open|launch|start)\s+(the\s+)?"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"(\s+app)?[.!?]*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned.count < 40 else { return nil }
        if ["fresh", "a routine", "recording", "timer", "watch", "stop"].contains(where: { cleaned.lowercased().contains($0) }) { return nil }
        return cleaned
    }

    private static func detectedDate(in text: String) -> Date? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        let matches = detector.matches(in: text, options: [], range: range)
        if let date = matches.compactMap({ $0.date }).first { return date }
        // "at 6" without a meridiem
        let lower = text.lowercased()
        if let hour = parseClockHour(lower) {
            var comps = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            var h = hour
            if !lower.contains("pm") && !lower.contains("am") && h < 8 { h += 12 }
            comps.hour = h
            comps.minute = 0
            return Calendar.current.date(from: comps)
        }
        return nil
    }

    private static func parseClockHour(_ text: String) -> Int? {
        let pattern = #"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in regex.matches(in: text, range: range) {
            guard let hourRange = Range(match.range(at: 1), in: text),
                  var hour = Int(text[hourRange]) else { continue }
            let meridiem = match.range(at: 3).location != NSNotFound ? (Range(match.range(at: 3), in: text).map { text[$0].lowercased() } ?? "") : ""
            if hour > 23 || hour < 0 { continue }
            if meridiem == "pm" && hour < 12 { hour += 12 }
            if meridiem == "am" && hour == 12 { hour = 0 }
            return hour
        }
        return nil
    }

    private static func parseWeekday(_ text: String) -> Int? {
        let days = ["sunday": 1, "monday": 2, "tuesday": 3, "wednesday": 4, "thursday": 5, "friday": 6, "saturday": 7]
        for (name, value) in days where text.contains(name) { return value }
        if text.contains("tomorrow") {
            let weekday = Calendar.current.component(.weekday, from: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
            return weekday
        }
        return nil
    }

    private static func weekdayName(_ weekday: Int) -> String {
        let names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        return names[max(0, min(6, weekday - 1))]
    }

    private static func reminderTitle(_ text: String) -> String {
        var title = text
        let patterns = [
            #"(?i)^remind me (to|about)\s+"#,
            #"(?i)^set a reminder (to|for)\s+"#,
            #"(?i)^reminder (to|for)\s+"#,
            #"(?i)^remind me\s+"#,
        ]
        for pattern in patterns {
            title = title.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) {
            let matches = detector.matches(in: title, options: [], range: NSRange(title.startIndex..., in: title))
            for match in matches.reversed() {
                if let range = Range(match.range, in: title) { title.removeSubrange(range) }
            }
        }
        title = title.replacingOccurrences(of: #"(?i)\s+at$"#, with: "", options: .regularExpression)
        title = title.replacingOccurrences(of: #"(?i)\s+on$"#, with: "", options: .regularExpression)
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: " .,-"))
        return title.isEmpty ? "reminder" : sentence(title)
    }

    private static func parseRoutine(_ text: String) -> (name: String, action: String, weekday: Int, hour: Int, minute: Int, schedule: String)? {
        let lower = text.lowercased()
        guard lower.hasPrefix("every") else { return nil }
        let weekday = parseWeekday(lower) ?? 6
        let hour = parseClockHour(lower) ?? 17
        let minute = 0
        var action = text
        if let comma = action.firstIndex(of: ",") {
            action = String(action[action.index(after: comma)...]).trimmingCharacters(in: .whitespaces)
        } else {
            action = text.replacingOccurrences(of: #"(?i)^every\s+\w+\s+at\s+\d{1,2}(:\d{2})?\s*(am|pm)?"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
        }
        if action.isEmpty { action = "run my routine" }
        let name = String(action.prefix(40))
        let schedule = "every \(weekdayName(weekday)) at \(hour % 12 == 0 ? 12 : hour % 12)\(hour < 12 ? "am" : "pm")"
        return (name, action, weekday, hour, minute, schedule)
    }

    private static func teachTopic(from text: String) -> String {
        var topic = text.lowercased()
        for prefix in ["teach me ", "how do i ", "how to ", "walk me through ", "show me how to ", "learn "] {
            if topic.hasPrefix(prefix) { topic = String(topic.dropFirst(prefix.count)); break }
        }
        topic = topic.replacingOccurrences(of: "?", with: "")
        return sentence(String(topic.prefix(48)))
    }

    private static func summarize(_ text: String, name: String) -> String {
        let words = text.split { $0.isWhitespace || $0.isNewline }
        let sentences = text.replacingOccurrences(of: "\n", with: " ")
            .split(separator: ".")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count > 40 }
        let lead = sentences.prefix(3).joined(separator: ". ")
        let title = name.isEmpty ? "this" : name
        var result = "\(title) — \(words.count) words.\n\n"
        result += lead.isEmpty ? "not much prose in here; it looks like a scan or a table. i can OCR it if you want the text." : lead + "."
        result += "\n\nwant the long version, or should i pull out the actions?"
        return result
    }

    private static func explainError(_ text: String) -> String {
        let lower = text.lowercased()
        if lower.contains("command not found") {
            return "that's a path problem, not a code problem. the shell can't find the command. run `which <tool>`; if it's empty, install it or add its folder to PATH."
        }
        if lower.contains("eacces") || lower.contains("permission denied") {
            return "the app is trying to touch something macOS is protecting. check the exact path — if it's in Desktop, Documents or Downloads, grant file access; otherwise fix the permissions on that file."
        }
        if lower.contains("module not found") || lower.contains("cannot find module") {
            return "a dependency is missing or you're in the wrong folder. run `pwd` and `ls node_modules`; then `npm install` in the folder with package.json."
        }
        if lower.contains("eaddrinuse") {
            return "something else is already on that port. `lsof -i :3000` shows the process; stop it or pick another port."
        }
        return "i can see the error text, but i don't want to guess. the useful bits are the first line and the path in the stack. paste the full text and i'll explain it line by line."
    }

    private static func shortTitle(_ text: String) -> String {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(cleaned.prefix(54))
    }

    private static func sentence(_ value: String) -> String {
        guard let first = value.first else { return value }
        return first.uppercased() + String(value.dropFirst())
    }

    private static func timeString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }

    private static func naturalDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) { formatter.dateFormat = "'today at' h:mm a" }
        else if Calendar.current.isDateInTomorrow(date) { formatter.dateFormat = "'tomorrow at' h:mm a" }
        else { formatter.dateFormat = "EEE 'at' h:mm a" }
        return formatter.string(from: date)
    }
}

public enum TeachLibrary {
    public static func steps(for topic: String) -> [String] {
        let t = topic.lowercased()
        if t.contains("auto layout") || (t.contains("figma") && t.contains("layout")) {
            return [
                "select the two cards you want to arrange, then press shift + a. figma wraps them in an auto layout frame.",
                "in the right panel, set direction to ↓ and gap to 16.",
                "click the padding field and set 24 on all four sides.",
                "resize the frame from its edge — the cards reflow instead of overlapping.",
                "now drag a third card into the frame. it joins the stack automatically.",
                "turn on “clip content” only if you want the frame to crop. that's auto layout.",
            ]
        }
        if t.contains("git") {
            return [
                "open terminal in a project folder and run `git status` — read what git thinks is going on.",
                "run `git init` once per project, then `git add -A` to stage everything.",
                "run `git commit -m \"first commit\"` — that's your first save point.",
                "make a branch with `git switch -c experiment`, change a file, and commit again.",
                "run `git switch main` to jump back. the files change with you.",
                "run `git merge experiment` — this is how the two lines come back together.",
            ]
        }
        if t.contains("terminal") || t.contains("shell") || t.contains("bash") || t.contains("zsh") {
            return [
                "`pwd` prints where you are. try it.",
                "`ls` lists what's here; `ls -la` includes hidden files.",
                "`cd folder` walks in; `cd ..` walks back out. tab completes names.",
                "`mkdir new-folder` makes one; `touch note.txt` makes an empty file.",
                "`cat note.txt` prints a file. `man ls` opens the manual — press q to leave.",
                "that's the loop: look, move, make, read.",
            ]
        }
        if t.contains("swiftui") || t.contains("swift") {
            return [
                "open a SwiftUI file. a view is a struct with a `body`.",
                "put a `VStack` inside `body` and add two `Text` views.",
                "add `.padding()` to the stack, then build with ⌘B.",
                "make a `@State var count = 0` and a Button that adds one.",
                "move the view into its own file and pass data in with a plain property.",
            ]
        }
        return [
            "open \(topic) and find the main canvas or window.",
            "find the one control that creates something new — a plus, a button, or a menu item.",
            "make the smallest possible version. don't perfect it yet.",
            "change one property and watch what moves. that's the mental model.",
            "undo once. if you can get back, you're safe to explore.",
            "tell me what confused you and we'll go one level deeper.",
        ]
    }
}
