import Foundation

/// A short description of an app's AppleScript dictionary, so the model writes scripts that
/// use the app's real commands and objects instead of guessing.
public enum ScriptHints {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: String] = [:]

    public static let maxLength = 1600

    /// Abridged dictionary for the app at `appURL`, or empty when the app isn't scriptable.
    public static func summary(appURL: URL) async -> String {
        let path = appURL.path
        if let cached = cached(path) { return cached }
        let text = await Task.detached(priority: .utility) { () -> String in
            guard let xml = runSDEF(path: path) else { return "" }
            return summarize(sdefXML: xml)
        }.value
        store(text, for: path)
        return text
    }

    private static func cached(_ path: String) -> String? {
        lock.withLock { cache[path] }
    }

    private static func store(_ text: String, for path: String) {
        lock.withLock { cache[path] = text }
    }

    nonisolated static func runSDEF(path: String, timeout: TimeInterval = 4) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sdef")
        process.arguments = [path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        // Drain on another thread so a big dictionary can't fill the pipe and stall, and so a
        // wedged sdef can't hold us past the timeout.
        let reader = pipe.fileHandleForReading
        let done = DispatchSemaphore(value: 0)
        let box = DataBox()
        DispatchQueue.global(qos: .utility).async {
            box.data = reader.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            return nil
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0, box.data.count > 200 else { return nil }
        return box.data
    }

    /// Parses the sdef XML into "classes — …; commands — …" per suite. Standard Suite is
    /// collapsed to its command names since every scriptable app has it.
    nonisolated public static func summarize(sdefXML: Data) -> String {
        let parser = XMLParser(data: sdefXML)
        let collector = Collector()
        parser.delegate = collector
        parser.parse()
        guard !collector.suites.isEmpty else { return "" }
        var lines: [String] = []
        for suite in collector.suites {
            if suite.name.lowercased().contains("standard suite") {
                let commands = suite.commands.map(\.name)
                if !commands.isEmpty { lines.append("Standard Suite commands: \(commands.joined(separator: ", "))") }
                continue
            }
            var parts: [String] = []
            let classes = suite.classes.filter { !$0.name.isEmpty }.prefix(14).map { cls -> String in
                var bits = [cls.properties.prefix(10).joined(separator: ", ")]
                if !cls.elements.isEmpty { bits.append("contains " + cls.elements.prefix(6).joined(separator: ", ")) }
                let inner = bits.filter { !$0.isEmpty }.joined(separator: "; ")
                return inner.isEmpty ? cls.name : "\(cls.name) (\(inner))"
            }
            if !classes.isEmpty { parts.append("classes — " + classes.joined(separator: "; ")) }
            let commands = suite.commands.prefix(16).map { cmd -> String in
                var bits: [String] = []
                if let direct = cmd.direct, !direct.isEmpty { bits.append(direct) }
                bits.append(contentsOf: cmd.parameters.prefix(6))
                return bits.isEmpty ? cmd.name : "\(cmd.name) [\(bits.joined(separator: ", "))]"
            }
            if !commands.isEmpty { parts.append("commands — " + commands.joined(separator: "; ")) }
            if !parts.isEmpty { lines.append("\(suite.name): " + parts.joined(separator: ". ")) }
        }
        var text = lines.joined(separator: "\n")
        if text.count > maxLength { text = String(text.prefix(maxLength)) + "…" }
        return text
    }

    private final class DataBox: @unchecked Sendable {
        var data = Data()
    }

    struct SuiteInfo {
        var name: String
        var classes: [ClassInfo] = []
        var commands: [CommandInfo] = []
    }
    struct ClassInfo {
        var name: String
        var properties: [String] = []
        var elements: [String] = []
    }
    struct CommandInfo {
        var name: String
        var direct: String?
        var parameters: [String] = []
    }

    private final class Collector: NSObject, XMLParserDelegate {
        var suites: [SuiteInfo] = []
        private var suite: SuiteInfo?
        private var cls: ClassInfo?
        private var command: CommandInfo?

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String]) {
            switch name {
            case "suite":
                suite = SuiteInfo(name: attributes["name"] ?? "")
            case "class", "class-extension":
                cls = ClassInfo(name: attributes["name"] ?? attributes["extends"] ?? "")
            case "property":
                if cls != nil, let n = attributes["name"], attributes["hidden"] != "yes" { cls?.properties.append(n) }
            case "element":
                if cls != nil, let t = attributes["type"] { cls?.elements.append(t) }
            case "command":
                command = CommandInfo(name: attributes["name"] ?? "")
            case "direct-parameter":
                command?.direct = attributes["type"] ?? "value"
            case "parameter":
                if let n = attributes["name"] { command?.parameters.append(n) }
            default:
                break
            }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            switch name {
            case "class", "class-extension":
                if let cls, !cls.name.isEmpty { suite?.classes.append(cls) }
                cls = nil
            case "command":
                if let command, !command.name.isEmpty { suite?.commands.append(command) }
                command = nil
            case "suite":
                if let suite, attributesKeep(suite) { suites.append(suite) }
                suite = nil
            default:
                break
            }
        }

        private func attributesKeep(_ suite: SuiteInfo) -> Bool {
            !(suite.classes.isEmpty && suite.commands.isEmpty)
        }
    }
}
