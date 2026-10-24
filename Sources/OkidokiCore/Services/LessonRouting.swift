import Foundation

/// The last word on which kind of lesson starts. The model picks the lesson kind after classifying
/// the scene; this only steps in when it left the field empty or chose against a one-sided signal:
/// a how-to in the tool they're working in is never a concept model, and an "explain" while they
/// watch a lecture is never an app lesson on the video player. Mixed requests keep the model's call.
/// Mirrors `brain/src/lesson.ts` so the sidecar and the native fallback agree.
public enum LessonRouting {
    public enum Scene: String, Sendable { case watching, reading, working, other }
    public enum Kind: String, Sendable { case app, concept }

    static let wantsToDoPattern =
        #"\b(show me how|how (do|can|would|should) (i|we|you)|how to|walk me through|teach me (how )?to|guide me|help me (make|build|create|add|set ?up|do|wire|draw|design|write|connect))\b"#

    static let wantsToUnderstandPattern =
        #"\b(explain|what (is|are|was|were|does|did|do|means?)\b|what's|whats|why\b|how\b[^?.!]{0,60}\bworks?\b|meaning of|understand|tell me about|summari[sz]e|what (is|was) (he|she|they|this|that) (saying|talking|about|on about)|what is (this|that|the) (video|lecture|talk|page|about))"#

    public static func scene(_ value: String?) -> Scene? {
        value.flatMap(Scene.init(rawValue:))
    }

    public static func kind(_ value: String?) -> Kind? {
        value.flatMap(Kind.init(rawValue:))
    }

    public static func wantsToDo(_ text: String) -> Bool {
        text.range(of: wantsToDoPattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    public static func wantsToUnderstand(_ text: String) -> Bool {
        text.range(of: wantsToUnderstandPattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    public static func resolve(chosen: Kind?, scene: Scene?, text: String) -> Kind {
        let doing = wantsToDo(text)
        let understanding = wantsToUnderstand(text)
        let onlyDoing = doing && !understanding
        let onlyUnderstanding = understanding && !doing

        switch scene {
        case .working:
            if chosen == .concept, onlyDoing { return .app }
            if let chosen { return chosen }
            return onlyUnderstanding ? .concept : .app
        case .watching, .reading:
            if chosen == .app, onlyUnderstanding { return .concept }
            if let chosen { return chosen }
            return onlyDoing ? .app : .concept
        case .other, .none:
            if let chosen { return chosen }
            return onlyUnderstanding ? .concept : .app
        }
    }

    /// String-in, string-out form for decisions straight off the wire.
    public static func resolve(lessonKind: String?, scene: String?, text: String) -> String {
        resolve(chosen: kind(lessonKind), scene: self.scene(scene), text: text).rawValue
    }
}
