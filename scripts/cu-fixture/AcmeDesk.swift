// AcmeDesk: the Mac twin of scripts/replay-fixture, for scripts/cu-replay-eval.py.
//
// A tiny AppKit app with one window whose screens change the way a web app's pages do: sign in,
// return details (name, PAN with a mask, income with money grouping, a regime pop-up, a capital
// gains box that reveals a field), deductions (a row per deduction, "Add row"), a review sheet,
// and a Submit that writes the return to submissions.json and shows a reference number.
//
// Every return filed is kept, so the eval checks what was actually filed, never what a run claimed.
// Hard modes come from config.json (re-read every half second), mirroring the web fixture:
//   drift, randomIds, slow, popups, expire, busy, random, wipe, moveWindow
// plus `offscreen` (default on): the window lives far off every display, so it can be driven through
// Accessibility while nothing shows on the person's screen and nothing can catch their clicks.
//
// The app never activates itself: it's an accessory app with no Dock icon.
//
//   scripts/cu-fixture/build.sh                     # → build/cu-fixture/AcmeDesk.app
//   ACMEDESK_HOME=/tmp/acme open -g build/cu-fixture/AcmeDesk.app
import AppKit

// MARK: - Files

let home: URL = {
    if let path = ProcessInfo.processInfo.environment["ACMEDESK_HOME"], !path.isEmpty { return URL(fileURLWithPath: path) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AcmeDesk")
}()
let configURL = home.appendingPathComponent("config.json")
let submissionsURL = home.appendingPathComponent("submissions.json")
let logURL = home.appendingPathComponent("events.log")

func log(_ line: String) {
    let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile(); handle.write(Data(stamped.utf8)); try? handle.close()
    } else {
        try? Data(stamped.utf8).write(to: logURL)
    }
}

struct Config: Equatable {
    var drift = false, randomIds = false, slow = false, popups = false, expire = false
    var busy = false, random = false, wipe = false, moveWindow = false, offscreen = true
    var seed: Int?

    static func read() -> Config {
        guard let data = try? Data(contentsOf: configURL),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return Config() }
        var c = Config()
        let flag: (String) -> Bool = { (raw[$0] as? Bool) ?? false }
        c.drift = flag("drift"); c.randomIds = flag("randomIds"); c.slow = flag("slow"); c.popups = flag("popups")
        c.expire = flag("expire"); c.busy = flag("busy"); c.random = flag("random"); c.wipe = flag("wipe")
        c.moveWindow = flag("moveWindow"); c.offscreen = (raw["offscreen"] as? Bool) ?? true
        c.seed = raw["seed"] as? Int
        return c
    }
}

// MARK: - Controls that behave like a real form

/// Swallows input while a sheet covers its window, the way a modal sheet blocks clicks and typing.
func blocked(_ view: NSView) -> Bool { view.window?.attachedSheet != nil && view.window?.sheetParent == nil }

final class Field: NSTextField {
    /// Formats what's typed: a PAN mask, money grouping.
    var mask: ((String) -> String)?
    override func setAccessibilityValue(_ value: Any?) {
        guard !blocked(self) else { log("swallowed a value: a sheet is in the way"); return }
        stringValue = (value as? String) ?? ""
        applyMask()
    }
    override func textDidChange(_ notification: Notification) {
        super.textDidChange(notification)
        applyMask()
    }
    func applyMask() {
        guard let mask else { return }
        let masked = mask(stringValue)
        if masked != stringValue { stringValue = masked }
    }
}

final class Secure: NSSecureTextField {
    override func setAccessibilityValue(_ value: Any?) {
        guard !blocked(self) else { return }
        stringValue = (value as? String) ?? ""
    }
}

/// A pop-up whose choice can also be set through Accessibility, so the eval never opens its menu on
/// the person's screen. (Pressing it and then the menu item works too.)
final class Popup: NSPopUpButton {
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == #selector(NSView.setAccessibilityValue(_:)) ? true : super.isAccessibilitySelectorAllowed(selector)
    }
    override func setAccessibilityValue(_ value: Any?) {
        guard !blocked(self), let title = value as? String, let item = itemArray.first(where: { $0.title.caseInsensitiveCompare(title) == .orderedSame }) else { return }
        select(item)
    }
    /// Its choices, listed without opening the menu (a menu would open on the person's screen).
    override func accessibilityChildren() -> [Any]? {
        itemArray.map { item in
            let element = NSAccessibilityElement()
            element.setAccessibilityRole(.menuItem)
            element.setAccessibilityTitle(item.title)
            element.setAccessibilityParent(self)
            element.setAccessibilityFrameInParentSpace(.zero)
            return element
        }
    }
}

final class Button: NSButton {
    var onPress: (() -> Void)?
    convenience init(_ title: String, id: String, press: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        setAccessibilityIdentifier(id)
        onPress = press
        target = self
        action = #selector(fire)
    }
    @objc func fire() {
        guard !blocked(self) else { log("swallowed a press on “\(title)”: a sheet is in the way"); return }
        onPress?()
    }
}

func panMask(_ s: String) -> String { String(s.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(10)) }

/// 1250000 → 12,50,000 (Indian grouping), as the form shows money.
func moneyMask(_ s: String) -> String {
    let digits = s.filter(\.isNumber)
    guard !digits.isEmpty else { return "" }
    var whole = digits
    guard whole.count > 3 else { return whole }
    var out = "," + String(whole.suffix(3))
    whole = String(whole.dropLast(3))
    while whole.count > 2 { out = "," + String(whole.suffix(2)) + out; whole = String(whole.dropLast(2)) }
    return whole + out
}

func label(_ text: String) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    return field
}

// MARK: - The app

struct Deduction { var section: NSPopUpButton; var amount: Field }

final class Desk: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var config = Config.read()
    var rng = SystemRandomNumberGenerator()
    var seeded: UInt64 = 0
    var signedIn = false
    /// Where to go after signing in again (the session expired mid-return).
    var resumeAt: String?
    var expiredThisReturn = false
    var whatsNewShown = false
    var busySeen: Set<String> = []
    var idSalt = ""

    // The return being filled, kept across screens.
    var name = "", pan = "", income = "", regime = "New", gains = "", hasGains = false
    var deductions: [(section: String, amount: String)] = []

    // Live controls of the screen in front.
    var fields: [String: NSControl] = [:]
    var rows: [Deduction] = []
    var rowsStack: NSStackView?
    var review: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.accessory)
        idSalt = config.randomIds ? String(UInt32.random(in: 0...UInt32.max), radix: 36) : ""
        placed = frame()
        window = OffscreenWindow(contentRect: placed, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.isReleasedWhenClosed = false
        // A fixed host: screens swap inside it, so a screen's layout never resizes or moves the window.
        host = NSView(frame: NSRect(origin: .zero, size: placed.size))
        window.contentView = host
        showLogin(note: nil)
        place()
        window.orderFront(nil)
        place()
        log("launched · \(config) · window at \(window.frame)")
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            // Never on a display while offscreen is on: if anything moved it there, put it back at once.
            if self.config.offscreen, NSScreen.screens.contains(where: { $0.frame.intersects(self.window.frame) }) {
                log("window drifted onto a display (\(self.window.frame)); moving it off again")
                self.place()
            }
            let fresh = Config.read()
            if fresh != self.config { self.config = fresh; log("config · \(fresh)") }
        }
    }

    var placed = NSRect.zero
    var host: NSView!

    func place() {
        window.setFrame(placed, display: false)
    }

    func frame() -> NSRect {
        var size = NSSize(width: 560, height: 520)
        var origin = NSPoint(x: 200, y: 200)
        if config.moveWindow {
            size = NSSize(width: Double.random(in: 520...760), height: Double.random(in: 500...700))
            origin = NSPoint(x: Double.random(in: 0...600), y: Double.random(in: 0...400))
        }
        if config.offscreen { origin.x -= 30_000; origin.y -= 30_000 }
        return NSRect(origin: origin, size: size)
    }

    func id(_ base: String) -> String {
        if config.randomIds { return "\(base)-\(idSalt)-\(Int.random(in: 100...999))" }
        return config.drift ? "acme-" + base : base
    }

    func chance(_ p: Double) -> Bool { Double.random(in: 0..<1) < p }

    // MARK: Screens

    func screen(_ title: String, build: @escaping (NSStackView) -> Void) {
        fields = [:]
        rows = []
        rowsStack = nil
        window.title = "AcmeDesk — \(title)"
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        let heading = label(title)
        heading.font = .boldSystemFont(ofSize: 18)
        stack.addArrangedSubview(heading)
        stack.frame = host.bounds
        stack.autoresizingMask = [.width, .height]
        host.subviews = [stack]
        place()
        guard config.slow else { build(stack); return }
        // Slow: the screen shows a spinner, and its controls arrive 0.7–2.4s later.
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        stack.addArrangedSubview(spinner)
        let delay = Double.random(in: 0.7...2.4)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.window.contentView === stack else { return }
            spinner.removeFromSuperview()
            build(stack)
        }
    }

    func textField(_ title: String, id base: String, value: String = "", mask: ((String) -> String)? = nil) -> Field {
        let field = Field(string: value)
        field.placeholderString = title
        field.setAccessibilityLabel(title)
        field.setAccessibilityIdentifier(id(base))
        field.mask = mask
        field.widthAnchor.constraint(equalToConstant: 280).isActive = true
        fields[base] = field
        return field
    }

    func row(_ title: String, _ control: NSView) -> NSView {
        let row = NSStackView(views: [label(title), control])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    func showLogin(note: String?) {
        screen("Sign in") { [self] stack in
            if let note { stack.addArrangedSubview(label(note)) }
            let user = textField("Username", id: "username")
            let password = Secure(string: "")
            password.placeholderString = "Password"
            password.setAccessibilityLabel("Password")
            password.setAccessibilityIdentifier(id("password"))
            password.widthAnchor.constraint(equalToConstant: 280).isActive = true
            fields["password"] = password
            stack.addArrangedSubview(row("Username", user))
            stack.addArrangedSubview(row("Password", password))
            stack.addArrangedSubview(Button(config.drift ? "Log in" : "Sign in", id: id("sign-in")) { [self] in
                guard user.stringValue == "eval", password.stringValue == "eval" else {
                    stack.addArrangedSubview(label("Wrong username or password."))
                    return
                }
                signedIn = true
                log("signed in")
                if config.random, chance(0.5) { showVerify(); return }
                afterSignIn()
            })
        }
    }

    func afterSignIn() {
        let target = resumeAt
        resumeAt = nil
        if target == "deductions" { showDeductions() } else { showDetails() }
        if config.popups, !whatsNewShown {
            whatsNewShown = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.sheet(title: "What's new in AcmeDesk 3", text: "Returns now save as you type, and the review step shows every deduction.",
                            buttons: ["Take the tour", "Start filing"]) { _ in }
            }
        }
    }

    func showVerify() {
        screen("Verify email") { [self] stack in
            stack.addArrangedSubview(label("Verify your email address to keep your account secure."))
            stack.addArrangedSubview(Button("Send code", id: id("send-code")) { stack.addArrangedSubview(label("We sent a code.")) })
            stack.addArrangedSubview(Button("Skip for now", id: id("skip-verify")) { [self] in afterSignIn() })
        }
    }

    func showDetails() {
        screen("Return details") { [self] stack in
            let nameField = textField(config.drift ? "Taxpayer name" : "Full name", id: "name", value: name)
            let panField = textField("PAN", id: "pan", value: pan, mask: panMask)
            let incomeField = textField(config.drift ? "Annual income" : "Income", id: "income", value: moneyMask(income), mask: moneyMask)
            let regimePop = Popup(frame: .zero, pullsDown: false)
            regimePop.addItems(withTitles: ["New", "Old"])
            regimePop.selectItem(withTitle: regime)
            regimePop.setAccessibilityLabel("Regime")
            regimePop.setAccessibilityIdentifier(id("regime"))
            fields["regime"] = regimePop
            let gainsBox = NSButton(checkboxWithTitle: "I have capital gains", target: nil, action: nil)
            gainsBox.setAccessibilityIdentifier(id("has-gains"))
            gainsBox.state = hasGains ? .on : .off
            let gainsField = textField("Capital gains", id: "gains", value: moneyMask(gains), mask: moneyMask)
            let gainsRow = row("Capital gains", gainsField)
            gainsRow.isHidden = !hasGains
            let toggle = Toggle { [self] on in
                guard !blocked(gainsBox) else { gainsBox.state = hasGains ? .on : .off; return }
                hasGains = on
                gainsRow.isHidden = !on
            }
            gainsBox.target = toggle
            gainsBox.action = #selector(Toggle.fire(_:))
            objc_setAssociatedObject(gainsBox, "toggle", toggle, .OBJC_ASSOCIATION_RETAIN)
            let rows = [row(config.drift ? "Taxpayer name" : "Full name", nameField), row("PAN", panField),
                        row(config.drift ? "Annual income" : "Income", incomeField), row("Regime", regimePop)]
            // Drift: the fields come in another order.
            for r in config.drift ? [rows[1], rows[0], rows[3], rows[2]] : rows { stack.addArrangedSubview(r) }
            stack.addArrangedSubview(gainsBox)
            stack.addArrangedSubview(gainsRow)
            stack.addArrangedSubview(Button(config.drift ? "Continue" : "Next", id: id("details-next")) { [self] in
                name = nameField.stringValue; pan = panField.stringValue; income = incomeField.stringValue.filter(\.isNumber)
                regime = regimePop.titleOfSelectedItem ?? "New"; gains = hasGains ? gainsField.stringValue.filter(\.isNumber) : ""
                if config.expire, !expiredThisReturn {
                    // The session runs out once per return: sign in again, then carry on where it was going.
                    expiredThisReturn = true
                    signedIn = false
                    resumeAt = "deductions"
                    log("session expired")
                    showLogin(note: "Your session expired. Sign in again.")
                    return
                }
                showDeductions()
            })
            if config.popups {
                // "Stay signed in?" turns up mid-typing, and swallows input until it's answered.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                    guard let self, self.window.title.hasSuffix("Return details") else { return }
                    self.sheet(title: "Stay signed in?", text: "You've been idle for a while. Do you want to stay signed in?",
                               buttons: ["Sign out", "Stay signed in"]) { [weak self] pressed in
                        if pressed == "Sign out" { self?.signedIn = false; self?.showLogin(note: nil) }
                    }
                }
            }
        }
    }

    func showDeductions() {
        screen("Deductions") { [self] stack in
            stack.addArrangedSubview(label("Add one row per deduction you claim."))
            let list = NSStackView()
            list.orientation = .vertical
            list.alignment = .leading
            list.spacing = 6
            list.setAccessibilityElement(true)
            list.setAccessibilityRole(.group)
            list.setAccessibilityLabel("Deduction rows")
            rowsStack = list
            stack.addArrangedSubview(list)
            for existing in deductions { addRow(section: existing.section, amount: existing.amount) }
            stack.addArrangedSubview(Button(config.drift ? "Add deduction" : "Add row", id: id("add-row")) { [self] in
                addRow(section: "80C", amount: "")
                if config.random, chance(0.4) { toast("Row added", undo: true) }
            })
            stack.addArrangedSubview(Button(config.drift ? "Continue" : "Next", id: id("deductions-next")) { [self] in
                deductions = rows.map { ($0.section.titleOfSelectedItem ?? "", $0.amount.stringValue.filter(\.isNumber)) }
                showReview()
            })
        }
    }

    func addRow(section: String, amount: String) {
        guard let list = rowsStack else { return }
        let n = rows.count + 1
        let pop = Popup(frame: .zero, pullsDown: false)
        pop.addItems(withTitles: ["80C", "80D", "80G", "24B"])
        pop.selectItem(withTitle: section)
        pop.setAccessibilityLabel("Section \(n)")
        pop.setAccessibilityIdentifier(id("section-\(n)"))
        let field = textField("Amount \(n)", id: "amount-\(n)", value: moneyMask(amount), mask: moneyMask)
        let line = NSStackView(views: [label("\(n)."), pop, field])
        line.orientation = .horizontal
        line.spacing = 8
        line.setAccessibilityElement(true)
        line.setAccessibilityRole(.group)
        line.setAccessibilityLabel("Deduction \(n)")
        list.addArrangedSubview(line)
        rows.append(Deduction(section: pop, amount: field))
    }

    func toast(_ text: String, undo: Bool) {
        guard let stack = window.contentView as? NSStackView else { return }
        let bar = NSStackView()
        bar.addArrangedSubview(label(text))
        if undo {
            bar.addArrangedSubview(Button("Undo", id: id("undo")) { [self] in
                if let last = rows.popLast() { (last.amount.superview)?.removeFromSuperview() }
                bar.removeFromSuperview()
            })
        }
        stack.addArrangedSubview(bar)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { bar.removeFromSuperview() }
    }

    // MARK: Review and submit

    func showReview() {
        let lost = config.wipe && name.lowercased().contains("chandra")
        if lost { log("wiped \(name)'s details before review") }
        let shown = (name: lost ? "" : name, pan: lost ? "" : pan, income: lost ? "" : income)
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.title = "Review your return"
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        let heading = label("Review your return")
        heading.font = .boldSystemFont(ofSize: 15)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(label("Name: \(shown.name)"))
        stack.addArrangedSubview(label("PAN: \(shown.pan)"))
        stack.addArrangedSubview(label("Income: \(moneyMask(shown.income))"))
        stack.addArrangedSubview(label("Regime: \(regime)"))
        stack.addArrangedSubview(label("Capital gains: \(gains.isEmpty ? "none" : moneyMask(gains))"))
        stack.addArrangedSubview(label("Deductions: " + (deductions.isEmpty ? "none" : deductions.map { "\($0.section) \(moneyMask($0.amount))" }.joined(separator: ", "))))
        let declaration = NSButton(checkboxWithTitle: "I declare these details are correct", target: nil, action: nil)
        declaration.setAccessibilityIdentifier(id("declaration"))
        let needsDeclaration = config.random && chance(0.5)
        if needsDeclaration { stack.addArrangedSubview(declaration) }
        let message = label("")
        stack.addArrangedSubview(message)
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.isHidden = true
        stack.addArrangedSubview(spinner)
        var buttons: [NSView] = [Button("Back", id: id("review-back")) { [self] in
            window.endSheet(sheet)
            review = nil
            showDeductions()
        }]
        if config.random, chance(0.5) {
            buttons.append(Button("Save draft", id: id("save-draft")) { message.stringValue = "Draft saved. It hasn't been filed." })
        }
        var filing = false
        buttons.append(Button(config.drift ? "File return" : "Submit", id: id("submit")) { [self] in
            guard !filing else { return }
            if needsDeclaration, declaration.state != .on {
                message.stringValue = "Please confirm the declaration before you submit."
                return
            }
            filing = true
            message.stringValue = ""
            spinner.isHidden = false
            spinner.startAnimation(nil)
            let wait = config.slow ? 2.5 : 0.3
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [self] in
                spinner.stopAnimation(nil)
                spinner.isHidden = true
                filing = false
                if config.busy, !busySeen.contains(pan) {
                    busySeen.insert(pan)
                    message.stringValue = "The service is busy right now. Please try again."
                    log("busy for \(pan)")
                    return
                }
                let ref = "REF-" + String(format: "%06d", Int.random(in: 0...999_999))
                file(name: shown.name, pan: shown.pan, income: shown.income, ref: ref)
                window.endSheet(sheet)
                review = nil
                showFiled(ref)
            }
        })
        stack.addArrangedSubview(NSStackView(views: buttons))
        sheet.contentView = stack
        review = sheet
        window.beginSheet(sheet)
    }

    func file(name: String, pan: String, income: String, ref: String) {
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: submissionsURL))) as? [[String: Any]] ?? []
        all.append(["name": name, "pan": pan, "income": income, "regime": regime.lowercased(), "gains": gains,
                    "deductions": deductions.map { ["section": $0.section, "amount": $0.amount] }, "ref": ref,
                    "at": ISO8601DateFormatter().string(from: Date())])
        if let data = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted]) { try? data.write(to: submissionsURL, options: .atomic) }
        log("filed \(name) \(pan) → \(ref)")
    }

    func showFiled(_ ref: String) {
        screen("Filed") { [self] stack in
            stack.addArrangedSubview(label("Your return has been filed."))
            stack.addArrangedSubview(label("Reference \(ref)"))
            stack.addArrangedSubview(Button(config.drift ? "Finish" : "Done", id: id("done")) { [self] in
                // A kiosk: the next return starts from signing in, with an empty form.
                name = ""; pan = ""; income = ""; regime = "New"; gains = ""; hasGains = false; deductions = []
                expiredThisReturn = false
                signedIn = false
                showLogin(note: nil)
            })
        }
    }

    /// A modal sheet on the main window: a title, a line, and buttons; answering closes it.
    func sheet(title: String, text: String, buttons: [String], answered: @escaping (String) -> Void) {
        guard window.attachedSheet == nil else { return }
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 150), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.title = title
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        let heading = label(title)
        heading.font = .boldSystemFont(ofSize: 14)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(label(text))
        let row = NSStackView(views: buttons.map { name in
            let b = NSButton(title: name, target: nil, action: nil)
            let press = Toggle { [weak self, weak sheet] _ in
                guard let self, let sheet else { return }
                self.window.endSheet(sheet)
                log("popup “\(title)” → \(name)")
                answered(name)
            }
            b.target = press
            b.action = #selector(Toggle.fire(_:))
            objc_setAssociatedObject(b, "press", press, .OBJC_ASSOCIATION_RETAIN)
            return b
        })
        stack.addArrangedSubview(row)
        sheet.contentView = stack
        log("popup “\(title)”")
        window.beginSheet(sheet)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

final class Toggle: NSObject {
    let handler: (Bool) -> Void
    init(_ handler: @escaping (Bool) -> Void) { self.handler = handler }
    @objc func fire(_ sender: NSButton) { handler(sender.state == .on) }
}

/// A window that stays wherever it's put, even far off every display.
final class OffscreenWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

let app = NSApplication.shared
let desk = Desk()
app.delegate = desk
app.run()
