import Foundation
import AppKit

public enum AppleError: LocalizedError {
    case notAuthorized(String)
    case scriptFailed(String)
    case notConnected(String)

    public var errorDescription: String? {
        switch self {
        case .notAuthorized(let app): return "Okidoki doesn't have permission to control \(app) yet."
        case .scriptFailed(let message): return message
        case .notConnected(let app): return "\(app) isn't connected."
        }
    }
}

public struct CalendarEventBrief: Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var start: Date
    public var calendar: String
}

public final class AppleBridge: @unchecked Sendable {
    public static let shared = AppleBridge()
    private init() {}

    private func runJXA(_ script: String, args: [String] = []) async throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-l", "JavaScript", "-e", script] + args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            throw AppleError.scriptFailed(error.localizedDescription)
        }
        process.waitUntilExit()
        let output = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errorOutput = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            let message = errorOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            if message.lowercased().contains("not authorized") || message.lowercased().contains("not allowed") || message.contains("-1743") {
                throw AppleError.notAuthorized("that app")
            }
            throw AppleError.scriptFailed(message.isEmpty ? "the app didn't answer" : message)
        }
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func probe(_ service: String) async throws -> String {
        let appName: String
        switch service {
        case "calendar": appName = "Calendar"
        case "reminders": appName = "Reminders"
        case "notes": appName = "Notes"
        default: appName = service
        }
        let script = """
        function run(argv) {
            const app = Application(argv[0]);
            app.includeStandardAdditions = true;
            return app.name();
        }
        """
        return try await runJXA(script, args: [appName])
    }

    // MARK: - Reminders

    public func addReminder(title: String, due: Date?) async throws -> String {
        let script = """
        function run(argv) {
            const app = Application("Reminders");
            app.includeStandardAdditions = true;
            const props = { name: argv[0] };
            if (argv[1]) props.dueDate = new Date(argv[1]);
            const reminder = app.Reminder(props);
            app.reminders.push(reminder);
            try { return reminder.id(); } catch (e) { return argv[0]; }
        }
        """
        let iso = due.map { ISO8601DateFormatter().string(from: $0) } ?? ""
        return try await runJXA(script, args: [title, iso])
    }

    public func deleteReminder(id: String) async throws {
        let script = """
        function run(argv) {
            const app = Application("Reminders");
            const matches = app.reminders.whose({ id: argv[0] })();
            matches.forEach(r => { try { app.delete(r); } catch (e) {} });
            return "ok";
        }
        """
        _ = try await runJXA(script, args: [id])
    }

    // MARK: - Calendar

    public func addEvent(title: String, start: Date, end: Date) async throws -> String {
        let script = """
        function run(argv) {
            const app = Application("Calendar");
            app.includeStandardAdditions = true;
            const calendars = app.calendars();
            if (calendars.length === 0) throw new Error("Calendar has no calendars");
            const cal = calendars[0];
            const event = app.Event({ summary: argv[0], startDate: new Date(argv[1]), endDate: new Date(argv[2]) });
            cal.events.push(event);
            try { return event.uid(); } catch (e) { return "created"; }
        }
        """
        let formatter = ISO8601DateFormatter()
        return try await runJXA(script, args: [title, formatter.string(from: start), formatter.string(from: end)])
    }

    public func deleteEvent(uid: String) async throws {
        let script = """
        function run(argv) {
            const app = Application("Calendar");
            const calendars = app.calendars();
            for (let i = 0; i < calendars.length; i++) {
                const events = calendars[i].events.whose({ uid: argv[0] })();
                events.forEach(e => { try { app.delete(e); } catch (err) {} });
            }
            return "ok";
        }
        """
        _ = try await runJXA(script, args: [uid])
    }

    public func upcomingEvents(withinMinutes: Int = 15) async throws -> [CalendarEventBrief] {
        let script = """
        function run(argv) {
            const app = Application("Calendar");
            const now = new Date();
            const end = new Date(now.getTime() + Number(argv[0]) * 60000);
            const out = [];
            const calendars = app.calendars();
            for (let i = 0; i < calendars.length; i++) {
                const cal = calendars[i];
                let events = [];
                try { events = cal.events(); } catch (e) { continue; }
                for (let j = 0; j < events.length; j++) {
                    try {
                        const s = events[j].startDate();
                        if (s >= now && s <= end) {
                            out.push({ id: events[j].uid(), title: events[j].summary(), start: s.toISOString(), calendar: cal.name() });
                        }
                    } catch (e) {}
                }
            }
            out.sort((a, b) => new Date(a.start) - new Date(b.start));
            return JSON.stringify(out.slice(0, 12));
        }
        """
        let raw = try await runJXA(script, args: [String(withinMinutes)])
        guard let data = raw.data(using: .utf8) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([CalendarEventBrief].self, from: data)) ?? []
    }

    public func eventsToday() async throws -> [CalendarEventBrief] {
        let script = """
        function run(argv) {
            const app = Application("Calendar");
            const start = new Date(); start.setHours(0,0,0,0);
            const end = new Date(start.getTime() + 24 * 60 * 60000);
            const out = [];
            const calendars = app.calendars();
            for (let i = 0; i < calendars.length; i++) {
                let events = [];
                try { events = calendars[i].events(); } catch (e) { continue; }
                for (let j = 0; j < events.length; j++) {
                    try {
                        const s = events[j].startDate();
                        if (s >= start && s <= end) {
                            out.push({ id: events[j].uid(), title: events[j].summary(), start: s.toISOString(), calendar: calendars[i].name() });
                        }
                    } catch (e) {}
                }
            }
            out.sort((a, b) => new Date(a.start) - new Date(b.start));
            return JSON.stringify(out.slice(0, 20));
        }
        """
        let raw = try await runJXA(script)
        guard let data = raw.data(using: .utf8) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([CalendarEventBrief].self, from: data)) ?? []
    }

    public func moveEvent(startingHour: Int, toWeekday: Int, hour: Int? = nil) async throws -> String {
        let script = """
        function run(argv) {
            const app = Application("Calendar");
            const targetHour = Number(argv[0]);
            const targetWeekday = Number(argv[1]); // 0 = sunday
            const newHour = argv[2] ? Number(argv[2]) : targetHour;
            const now = new Date();
            const today = now.getDay();
            let delta = (targetWeekday - today + 7) % 7;
            if (delta === 0) delta = 7;
            const calendars = app.calendars();
            let moved = "";
            for (let i = 0; i < calendars.length && !moved; i++) {
                let events = [];
                try { events = calendars[i].events(); } catch (e) { continue; }
                for (let j = 0; j < events.length; j++) {
                    try {
                        const s = events[j].startDate();
                        if (s.toDateString() === now.toDateString() && s.getHours() === targetHour) {
                            const duration = events[j].endDate().getTime() - s.getTime();
                            const target = new Date(s.getTime());
                            target.setDate(target.getDate() + delta);
                            target.setHours(newHour);
                            events[j].startDate = target;
                            events[j].endDate = new Date(target.getTime() + duration);
                            moved = events[j].summary();
                            break;
                        }
                    } catch (e) {}
                }
            }
            if (!moved) throw new Error("No event found at " + targetHour + ":00 today");
            return moved;
        }
        """
        return try await runJXA(script, args: [String(startingHour), String(toWeekday), hour.map(String.init) ?? ""])
    }

    // MARK: - Notes

    public func addNote(title: String, body: String) async throws -> String {
        let script = """
        function run(argv) {
            const app = Application("Notes");
            app.includeStandardAdditions = true;
            const note = app.Note({ name: argv[0], body: argv[1] });
            app.notes.push(note);
            try { return note.id(); } catch (e) { return argv[0]; }
        }
        """
        return try await runJXA(script, args: [title, body])
    }

    public func deleteNote(id: String) async throws {
        let script = """
        function run(argv) {
            const app = Application("Notes");
            const matches = app.notes.whose({ id: argv[0] })();
            matches.forEach(n => { try { app.delete(n); } catch (e) {} });
            return "ok";
        }
        """
        _ = try await runJXA(script, args: [id])
    }

    // MARK: - Keynote batch export

    public func exportKeynoteDecks(in folder: String, to outputFolder: String) async throws -> String {
        let script = """
        function run(argv) {
            const app = Application("Keynote");
            const fm = $.NSFileManager.defaultManager;
            const files = fm.contentsOfDirectoryAtPathError(argv[0], null);
            const paths = [];
            for (let i = 0; i < files.count; i++) {
                const name = ObjC.unwrap(files.objectAtIndex(i));
                if (name.toLowerCase().endsWith(".key")) paths.push(argv[0] + "/" + name);
            }
            let exported = 0;
            for (let i = 0; i < paths.length; i++) {
                const doc = app.open($(paths[i]));
                const base = paths[i].split("/").pop().replace(/\\.key$/i, "");
                const out = $(argv[1] + "/" + base + ".pdf");
                doc.export({ to: out, as: "PDF" });
                doc.close({ saving: "no" });
                exported++;
            }
            return String(exported);
        }
        """
        return try await runJXA(script, args: [folder, outputFolder])
    }
}
