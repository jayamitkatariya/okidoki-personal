import Foundation

// Skill format v2: what lets a replay stay deterministic while the data and the screen change.
// Every field is optional, so v1 skills and files decode and replay exactly as before.

/// One value a skill needs on each pass: a name, a PAN, an amount, a list of deduction rows.
/// The compiler finds these in a run's typed text; the resolver fills them per item before a replay.
public struct SkillInput: Codable, Equatable, Sendable, Identifiable {
    public var id: String { name }
    /// The placeholder name, as in `{{pan}}`.
    public var name: String
    /// What it is, in words the model can find it by: "the person's PAN (Indian tax id)".
    public var description: String
    /// text · number · money · date · choice · list · file
    public var kind: String
    /// For a `list`: the fields of one entry ("section", "amount"); each is `{{item.field}}` in the loop.
    public var fields: [String]?
    /// How the value is typed: money "plain" (1250000) or "grouped" / "indian" (12,50,000); date as a
    /// DateFormatter pattern ("dd/MM/yyyy"); text "upper" / "lower".
    public var format: String?
    /// A regular expression the value must match before it's typed (a PAN, an IBAN, an invoice number).
    public var pattern: String?
    public var choices: [String]?
    /// Where it usually comes from: document · request · record · page · builtin
    public var source: String?
    /// Where exactly: "Form 16 Part B, gross salary".
    public var hint: String?
    /// Never written to logs or run output.
    public var sensitive: Bool?
    /// A pass can't start without it. Defaults to true.
    public var required: Bool?
    /// The value seen when the skill was learned, for the model's sense of shape (never for secrets).
    public var example: String?
    /// A value the skill always uses ("economy", "1" adult): filled when a pass doesn't give one, so a
    /// replay isn't refused over something the recording already decided.
    public var value: String?

    public init(name: String, description: String = "", kind: String = "text", fields: [String]? = nil,
                format: String? = nil, pattern: String? = nil, choices: [String]? = nil, source: String? = nil,
                hint: String? = nil, sensitive: Bool? = nil, required: Bool? = nil, example: String? = nil,
                value: String? = nil) {
        self.name = name; self.description = description; self.kind = kind; self.fields = fields
        self.format = format; self.pattern = pattern; self.choices = choices; self.source = source
        self.hint = hint; self.sensitive = sensitive; self.required = required; self.example = example
        self.value = value
    }

    public var isRequired: Bool { required ?? true }
    public var isSensitive: Bool { sensitive ?? false }
}

/// What should be true right after a step, checked locally with no model. Any field left nil isn't checked.
public struct StepExpectation: Codable, Equatable, Sendable {
    // Browser
    public var urlContains: String?
    public var textContains: String?
    /// A CSS selector that should now be on the page.
    public var elementPresent: String?
    /// A CSS selector that should now be gone (a dialog that closed).
    public var elementGone: String?
    // Mac
    public var windowTitleContains: String?
    public var labelPresent: String?
    public var focusedRole: String?
    /// A sheet or dialog whose title or first line contains this is gone (the step closed it).
    public var sheetGone: String?
    /// A file exists at this path (`~` allowed): Finder, a save, an export.
    public var fileExists: String?

    public init(urlContains: String? = nil, textContains: String? = nil, elementPresent: String? = nil,
                elementGone: String? = nil, windowTitleContains: String? = nil, labelPresent: String? = nil,
                focusedRole: String? = nil, sheetGone: String? = nil, fileExists: String? = nil) {
        self.urlContains = urlContains; self.textContains = textContains; self.elementPresent = elementPresent
        self.elementGone = elementGone; self.windowTitleContains = windowTitleContains
        self.labelPresent = labelPresent; self.focusedRole = focusedRole; self.sheetGone = sheetGone; self.fileExists = fileExists
    }

    public var isEmpty: Bool {
        [urlContains, textContains, elementPresent, elementGone, windowTitleContains, labelPresent, focusedRole, sheetGone, fileExists]
            .allSatisfy { ($0 ?? "").isEmpty }
    }
}

/// Where a step happens: enough of the page or window to tell "this is the place" from "somewhere else".
/// Replay compares it with the screen to notice a popup, a page that's already past this step, or a
/// page it hasn't reached yet, and to jump to the step that fits.
public struct StepAnchor: Codable, Equatable, Sendable {
    /// The page's path ("/form.html"); host and query are ignored.
    public var path: String?
    public var title: String?
    /// A heading or label that's on the page or in the window when this step is due.
    public var landmark: String?
    public var app: String?
    public var window: String?

    public init(path: String? = nil, title: String? = nil, landmark: String? = nil, app: String? = nil, window: String? = nil) {
        self.path = path; self.title = title; self.landmark = landmark; self.app = app; self.window = window
    }

    public var isEmpty: Bool { [path, title, landmark, app, window].allSatisfy { ($0 ?? "").isEmpty } }
}

/// What the screen looked like after a step when the skill was learned; the compiler turns it into
/// the next step's anchor and this step's expectation.
public struct StepObservation: Codable, Equatable, Sendable {
    public var url: String?
    public var title: String?
    /// Headings and prominent labels, a few.
    public var landmarks: [String]?
    public var app: String?
    public var window: String?

    public init(url: String? = nil, title: String? = nil, landmarks: [String]? = nil, app: String? = nil, window: String? = nil) {
        self.url = url; self.title = title; self.landmarks = landmarks; self.app = app; self.window = window
    }
}

/// Something that can get in the way (a cookie banner, a survey, "save password?") and the one action
/// that clears it. Built-ins ship with okidoki; a skill learns its own when the model clears one.
public struct InterruptHandler: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Text on screen that means it's showing.
    public var whenText: String?
    /// Or a CSS selector that's present (browser).
    public var whenElement: String?
    /// Browser: a selector or label to click. Mac: a label to press.
    public var clickSelector: String?
    public var clickLabel: String?
    /// Or a key to press ("Escape").
    public var key: String?
    /// builtin · learned
    public var source: String?
    public var uses: Int?

    public init(id: String = UUID().uuidString, whenText: String? = nil, whenElement: String? = nil,
                clickSelector: String? = nil, clickLabel: String? = nil, key: String? = nil,
                source: String? = nil, uses: Int? = nil) {
        self.id = id; self.whenText = whenText; self.whenElement = whenElement; self.clickSelector = clickSelector
        self.clickLabel = clickLabel; self.key = key; self.source = source; self.uses = uses
    }
}

extension Skill {
    /// Uses anything only smart replay understands: inputs, conditions, loops, think or read steps.
    /// Such a skill always replays smartly; plain replay would type its placeholders as they are.
    public var usesSmartReplay: Bool {
        !(inputs ?? []).isEmpty || steps.contains { step in
            step.when?.isEmpty == false || step.repeatOver?.isEmpty == false || step.mode == "think"
                || step.action == "read" || step.capture?.isEmpty == false
        }
    }
}
