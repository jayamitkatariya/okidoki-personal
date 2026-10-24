import Foundation

/// Keeps progress frames for the whole plan while bounding the visible log.
public final class TerminalOutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let marker: String
    private let commandCount: Int
    private let framePattern: NSRegularExpression
    private var frames = ""
    private var scanTail = ""
    private var output = ""

    public init(marker: String, commandCount: Int) {
        self.marker = marker
        self.commandCount = commandCount
        self.framePattern = try! NSRegularExpression(pattern: "\u{1e}" + NSRegularExpression.escapedPattern(for: marker)
            + #":(?:start|end):\d+(?::\d+)?"# + "\u{1f}\n")
    }

    public func append(_ text: String) {
        lock.lock(); defer { lock.unlock() }
        output = String((output + text).suffix(80_000))
        scanTail += text
        let range = NSRange(scanTail.startIndex..., in: scanTail)
        let matches = framePattern.matches(in: scanTail, range: range)
        for match in matches {
            if let frame = Range(match.range, in: scanTail) { frames += String(scanTail[frame]) }
        }
        if let last = matches.last, let end = Range(last.range, in: scanTail)?.upperBound {
            scanTail = String(scanTail[end...])
        }
        scanTail = String(scanTail.suffix(512))
    }

    public var progress: TerminalActions.Progress {
        lock.lock(); defer { lock.unlock() }
        return TerminalActions.progress(in: frames + output, marker: marker, commandCount: commandCount)
    }
}
