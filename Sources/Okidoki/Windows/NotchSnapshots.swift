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
        var queue = states(metrics: metrics)
        func next() {
            guard !queue.isEmpty else {
                FileHandle.standardError.write(Data("SNAPSHOT done → \(directory)\n".utf8))
                // A snapshot run is a one-off; staying open would leave a second island on screen.
                NSApp.terminate(nil)
                return
            }
            let (name, model) = queue.removeFirst()
            render(model: model, env: env, to: url.appendingPathComponent("\(name).png")) { next() }
        }
        next()
    }

    private static func states(metrics: NotchMetrics) -> [(String, NotchModel)] {
        func model(_ configure: (NotchModel) -> Void) -> NotchModel {
            let m = NotchModel(metrics: metrics)
            m.presented = true
            configure(m)
            return m
        }
        let approval = NotchRunItem(id: "a", title: "clear 4.2 GB of caches", kind: .terminal, status: .waiting,
                                    step: "", summary: "Removes Xcode DerivedData and old simulator runtimes.",
                                    risk: .medium, commands: ["rm -rf ~/Library/Developer/Xcode/DerivedData"])
        let live = NotchRunItem(id: "l", title: "message dad on whatsapp", kind: .computerUse, status: .running,
                                step: "typing the message", summary: "", risk: .low, commands: [])
        let live2 = NotchRunItem(id: "l2", title: "summarize the q3 report", kind: .background, status: .running,
                                 step: "reading page 4 of 12", summary: "", risk: .low, commands: [])
        func toast(_ title: String, _ detail: String) -> NotchToast {
            NotchToast(title: title, detail: detail, kind: .success, editLabel: "details", expiresAt: .distantFuture)
        }
        let teamApproval = NotchSpaceApproval(EnterpriseSummary.Approval(
            id: "j1", spaceId: "sp1", spaceName: "sales", prompt: "clean up the shared drive", title: "Clean up the shared drive",
            requestedBy: "Jay", workerName: "Pat", workerIsYou: false, summary: "Deletes 14 stale folders under Shared/Archive.",
            risk: .high, steps: ["list", "delete"], commands: ["rm -rf '/Volumes/Shared/Archive/2019 *'"], apps: ["Finder"], createdAt: Date()))
        let forSpace = NotchRunItem(id: "w", title: "export the deck as PDF", kind: .computerUse, status: .running,
                                    step: "exporting slide 7 of 12", summary: "", risk: .low, commands: [], forSpace: "design")
        let unread = [NotchSpaceUnread(id: "sp1", name: "sales", colorHex: "F2B84B", unread: 3, lastMessage: "Jay: can someone replay the expense report?"),
                      NotchSpaceUnread(id: "sp2", name: "general", colorHex: "44E45E", unread: 1, lastMessage: "okidoki: Done: launch-discord.mp4 is 7.9 MB.")]
        return [
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
            ("10-compact-team-approval", model { $0.approvals = [teamApproval]; $0.hasTeam = true }),
            ("11-expanded-team", model {
                $0.expanded = true
                $0.hasTeam = true
                $0.approvals = [teamApproval]
                $0.live = [forSpace]
                $0.unread = unread
            }),
            ("12-compact-for-space", model { $0.live = [forSpace]; $0.hasTeam = true }),
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
        self.forSpace = forSpace
    }
}
