import AppKit
import SwiftUI
import OkidokiCore

/// Dev-only: renders the island in each of its states to PNGs, offscreen, so the design can be
/// reviewed without hovering or screen-recording permission.
/// Enabled with OKIDOKI_NOTCH_SNAPSHOT=<directory>.
@MainActor
enum NotchSnapshots {
    static func run(env: AppEnvironment, metrics: NotchMetrics, into directory: String) {
        let url = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        // Every state twice: on the notched screen and on a plain one (external display), whose
        // band is a floating pill with its own layout.
        var queue = states(metrics: metrics)
        var plain = metrics
        plain.hasNotch = false
        plain.notchWidth = 0
        plain.notchHeight = 0
        queue += states(metrics: plain).map { ("plain-" + $0.0, $0.1) }
        func next() {
            guard !queue.isEmpty else {
                // The fold, frame by frame: open with a card, then closed around the same card.
                let model = NotchModel(metrics: metrics)
                model.presented = true
                model.expanded = true
                model.toasts = [NotchToast(title: "Done", detail: "Sent \"hi\" to Dad on WhatsApp.", kind: .success,
                                           editLabel: "details", expiresAt: .distantFuture)]
                renderFold(model: model, env: env, into: url) {
                    FileHandle.standardError.write(Data("SNAPSHOT done → \(directory)\n".utf8))
                    // A snapshot run is a one-off; staying open would leave a second island on screen.
                    NSApp.terminate(nil)
                }
                return
            }
            let (name, model) = queue.removeFirst()
            render(model: model, env: env, to: url.appendingPathComponent("\(name).png")) { next() }
        }
        next()
    }

    private static func renderFold(model: NotchModel, env: AppEnvironment, into url: URL, done: @escaping () -> Void) {
        let m = model.metrics
        let size = NSSize(width: m.expandedWidth + 120, height: m.maxIslandHeight + 60)
        let root = ZStack(alignment: .top) {
            LinearGradient(colors: [Color(hex: 0x8C9AA8), Color(hex: 0x5D6B78)], startPoint: .top, endPoint: .bottom)
            NotchRootView(model: model, env: env)
        }
        .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        func snap(_ name: String) {
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent("\(name).png"))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            snap("fold-00-open")
            model.expanded = false
            for i in 1...10 {
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.05) {
                    snap(String(format: "fold-%02d", i))
                    if i == 10 {
                        window.orderOut(nil)
                        done()
                    }
                }
            }
        }
    }

    private static func states(metrics: NotchMetrics) -> [(String, NotchModel)] {
        func model(_ configure: (NotchModel) -> Void) -> NotchModel {
            let m = NotchModel(metrics: metrics)
            m.presented = true
            configure(m)
            return m
        }
        let approval = NotchRunItem(id: "a", title: "pay the electricity bill", kind: .browser, status: .waiting,
                                    step: "", summary: "Logs in to the utility site with your vault login and pays $82.40.",
                                    risk: .medium, commands: [])
        let live = NotchRunItem(id: "l", title: "message dad on whatsapp", kind: .computerUse, status: .running,
                                step: "typing the message", summary: "", risk: .low, commands: [])
        let live2 = NotchRunItem(id: "l2", title: "replay · file the invoice", kind: .watch, status: .running,
                                 step: "step 4 of 12", summary: "", risk: .low, commands: [])
        func toast(_ title: String, _ detail: String) -> NotchToast {
            NotchToast(title: title, detail: detail, kind: .success, editLabel: "details", expiresAt: .distantFuture)
        }
        let recent = [
            NotchRecent(id: "r1", title: "find the largest park in SF", kind: .browser, status: .done, at: Date().addingTimeInterval(-3_900)),
            NotchRecent(id: "r2", title: "cancel the gym subscription", kind: .browser, status: .asked, at: Date().addingTimeInterval(-600)),
            NotchRecent(id: "r3", title: "rename the march invoices", kind: .computerUse, status: .failed, at: Date().addingTimeInterval(-90_000)),
        ]
        var timed = live
        timed.startedAt = Date().addingTimeInterval(-67)
        return [
            ("20-new-home", model { $0.newLook = true; $0.expanded = true; $0.recent = recent }),
            ("21-new-home-empty", model { $0.newLook = true; $0.expanded = true }),
            ("22-new-busy", model {
                $0.newLook = true
                $0.expanded = true
                $0.waiting = [approval]
                $0.live = [timed]
                $0.recent = Array(recent.prefix(2))
            }),
            ("23-new-compact-live", model { $0.newLook = true; $0.live = [timed] }),
            ("24-new-compact-toast", model { $0.newLook = true; $0.toasts = [toast("done", "Sent \"hi\" to Dad on WhatsApp.")] }),
            ("1-home", model { $0.expanded = true }),
            ("2-home-voice-quiet", model { $0.expanded = true; $0.inputMode = .voice; $0.quiet = true }),
            ("3-expanded-busy", model {
                $0.expanded = true
                $0.waiting = [approval]
                $0.live = [live, live2]
                $0.toasts = [toast("done", "Sent \"hi\" to Dad on WhatsApp.")]
            }),
            ("4-compact-toast", model { $0.toasts = [toast("done", "Sent \"hi\" to Dad on WhatsApp.")] }),
            ("5-compact-approval", model { $0.waiting = [approval] }),
            ("6-compact-live", model { $0.live = [live] }),
            ("7-compact-recording", model {
                $0.recording = NotchRecording(name: "file invoices", startedAt: Date().addingTimeInterval(-74), steps: 6)
            }),
            ("8-listening", model { $0.listening = true }),
            ("9-caption", model { $0.caption = "Opening WhatsApp and finding Dad's chat." }),
            // Real copy is longer than the samples above: a start toast with both buttons, a drive
            // narrating its step, a spoken answer. The compact island must hold all of it.
            ("13-compact-long-toast", model {
                $0.toasts = [NotchToast(title: "Okidoki!", detail: "open safari private window and search for blue puma shoes under 150 starts in 5 seconds — undo to stop",
                                        kind: .success, undoLabel: "stop", editLabel: "preview", expiresAt: .distantFuture)]
            }),
            ("14-compact-long-live", model {
                $0.live = [NotchRunItem(id: "l3", title: "search: blue puma shoes in dia under 150 dollars with free shipping", kind: .computerUse, status: .running,
                                        step: "Safari is open with a Private Browsing window showing the Private Browsing start page", summary: "", risk: .low, commands: [])]
            }),
            ("15-compact-long-caption", model {
                $0.caption = String(repeating: "Opening WhatsApp and finding Dad's chat, then typing the message you asked for and pressing return. ", count: 7)
            }),
            ("17-compact-long-approval", model {
                $0.waiting = [NotchRunItem(id: "a2", title: "open every unread invoice in the billing portal, download each pdf into the vault and mark them paid", kind: .browser, status: .waiting,
                                           step: "", summary: "Signs in with your vault login, downloads 14 invoices into Vault/Invoices and marks each one paid once its file is saved.",
                                           risk: .high, commands: [])]
            }),
        ]
    }

    private static func render(model: NotchModel, env: AppEnvironment, to url: URL, done: @escaping () -> Void) {
        let m = model.metrics
        let size = NSSize(width: m.expandedWidth + 120, height: m.maxIslandHeight + 60)
        let root = ZStack(alignment: .top) {
            LinearGradient(colors: [Color(hex: 0x8C9AA8), Color(hex: 0x5D6B78)], startPoint: .top, endPoint: .bottom)
            NotchRootView(model: model, env: env)
        }
        .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: url)
            }
            window.orderOut(nil)
            done()
        }
    }
}

extension NotchRunItem {
    /// Preview data only.
    init(id: String, title: String, kind: RunKind, status: RunStatus, step: String, summary: String,
         risk: RiskLevel, commands: [String], forSpace: String? = nil) {
        self.id = id
        self.title = title
        self.kind = kind
        self.status = status
        self.step = step
        self.summary = summary
        self.risk = risk
        self.commands = commands
    }
}
