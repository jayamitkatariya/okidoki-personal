import Foundation

/// The person's turn on a page: a check only they can pass (a captcha, a one-time code), or a pause.
/// Shared by smart replay and the browser agent so both hand off and take back the same way.
@MainActor
enum PersonTurn {
    enum End: Equatable { case cleared, takenBack, stopped, timedOut }

    /// Waits until the person got past the check on `tab`: the page loaded, quiet and free of any check for
    /// 1.5 s at the same address. A page mid-load, or one that can't be read yet, never counts as done, so a
    /// navigation the person makes (or a second check right after the first) doesn't end their turn early.
    static func waitPast(tab: BrowserTab, minutes: Double = 10,
                         takenBack: () -> Bool, alive: () -> Bool) async -> End {
        let deadline = Date().addingTimeInterval(minutes * 60)
        var clearSince: Date?
        var clearURL = ""
        while true {
            if !alive() { return .stopped }
            if takenBack() { return .takenBack }
            if Date() > deadline { return .timedOut }
            try? await Task.sleep(nanoseconds: 400_000_000)
            if !alive() { return .stopped }
            if takenBack() { return .takenBack }
            let state = await tab.checkState()
            if state.known, state.ready, state.check == nil {
                if clearSince == nil || state.url != clearURL {
                    clearSince = Date()
                    clearURL = state.url
                } else if Date().timeIntervalSince(clearSince!) >= 1.5 {
                    return .cleared
                }
            } else {
                clearSince = nil
            }
        }
    }

    /// After the person passed a check but handed back before leaving its page (the box ticked, Continue not
    /// pressed yet): press the page's own continue button, the only thing left on a passed check page. Only
    /// when the page is still where the check was and no check remains. The button's words, or nil.
    static func continuePast(on tab: BrowserTab, checkURL: String) async -> String? {
        let state = await tab.checkState()
        guard state.known, state.check == nil, !checkURL.isEmpty, state.url == checkURL else { return nil }
        let pressed = await tab.call("""
            const words = /^(continue|verify|submit|proceed|next|done|i'?m (a )?human|confirm|go|enter site|let me in)\\b/i;
            const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden'; };
            const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a.button, a.btn')]
              .filter(el => seen(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
              .filter(el => words.test(((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim()));
            if (buttons.length !== 1) return null;
            const label = ((buttons[0].innerText || buttons[0].value || '') + '').trim();
            buttons[0].click();
            return label;
            """) as? String
        if pressed != nil { await tab.settle(limit: 6, fresh: true) }
        return pressed
    }

    /// The same check right after the person passed one is usually the page catching up: look twice
    /// before calling them back.
    static func confirmed(on tab: BrowserTab) async -> String? {
        guard let first = await tab.humanCheck() else { return nil }
        try? await Task.sleep(nanoseconds: 700_000_000)
        guard await tab.humanCheck() != nil else { return nil }
        return first.text
    }
}
