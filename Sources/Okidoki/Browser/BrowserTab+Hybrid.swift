import Foundation
import OkidokiCore

/// The page script's quick looks, for smart replay: where am I, what does this field hold, is that
/// popup there. Each is one call into the page, no model.
extension BrowserTab {
    func headings() async -> [String] {
        await call("return window.__okidoki ? window.__okidoki.headings() : []") as? [String] ?? []
    }

    /// What the element a step's selectors find holds now; nil when none find it.
    func value(of selectors: [String]) async -> (value: String, text: String)? {
        guard let raw = await call("return window.__okidoki ? window.__okidoki.valueOf(s) : null", ["s": selectors]) as? [String: Any] else { return nil }
        return (raw["value"] as? String ?? "", raw["text"] as? String ?? "")
    }

    func options(of selectors: [String]) async -> [String]? {
        await call("return window.__okidoki ? window.__okidoki.optionsOf(s) : null", ["s": selectors]) as? [String]
    }

    func isPresent(_ selector: String) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.present(s) : false", ["s": selector]) as? Bool ?? false
    }

    func clickText(_ label: String) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.clickText(l) : false", ["l": label]) as? Bool ?? false
    }

    /// Popups showing now (open dialogs and overlays), each with its text and button labels.
    /// `modal`: an open dialog or an overlay over the middle of the page, not a bar along an edge.
    func dialogs() async -> [(text: String, buttons: [String], modal: Bool)] {
        guard let raw = await call("return window.__okidoki ? window.__okidoki.dialogs() : []") as? [[String: Any]] else { return [] }
        return raw.map { ($0["text"] as? String ?? "", $0["buttons"] as? [String] ?? [], $0["modal"] as? Bool ?? false) }
    }

    /// The label of the element these selectors find now; nil when none does.
    func label(of selectors: [String]) async -> String? {
        guard let raw = await call("return window.__okidoki ? window.__okidoki.find(s) : null", ["s": selectors]) as? [String: Any] else { return nil }
        return raw["label"] as? String ?? ""
    }

    func inDialog(_ selectors: [String]) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.inDialog(s) : false", ["s": selectors]) as? Bool ?? false
    }

    func clickInDialog(_ label: String) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.clickInDialog(l) : false", ["l": label]) as? Bool ?? false
    }

    /// A check only a person can pass (captcha, "verify you're human", a one-time code), or nil.
    func humanCheck() async -> (kind: String, text: String)? {
        guard let raw = await call("return window.__okidoki ? window.__okidoki.humanCheck() : null") as? [String: Any],
              let kind = raw["kind"] as? String else { return nil }
        return (kind, raw["text"] as? String ?? kind)
    }

    /// The page says it's still loading (a spinner, "Loading…", a busy region).
    func isBusy() async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.busy() : true") as? Bool ?? false
    }

    /// What the page's fields hold (text boxes, chosen options), one per line: a one-page form shows its
    /// values there, not in its text.
    func fieldValues() async -> String {
        await call("""
        return [...document.querySelectorAll('input:not([type=hidden]):not([type=password]),select,textarea')]
          .map(e => e.tagName === 'SELECT' ? ((e.selectedOptions && e.selectedOptions[0]) ? e.selectedOptions[0].text : '') : (e.value || ''))
          .filter(Boolean).join('\\n')
        """) as? String ?? ""
    }

    func pageText() async -> String {
        await call("return window.__okidoki ? window.__okidoki.pageText() : (document.body ? document.body.innerText : '')") as? String ?? ""
    }

    /// The page as smart replay compares it with a step's anchor.
    func observation() async -> HybridReplay.Observation {
        let text = await pageText()
        let heads = await headings()
        return HybridReplay.Observation(url: webView.url?.absoluteString ?? "", title: webView.title ?? "",
                                        text: (heads.joined(separator: "\n") + "\n" + text), app: "okidoki browser", window: webView.title ?? "")
    }

    /// What a learned step saw right after it, kept on the step for the compiler.
    func stepObservation() async -> StepObservation {
        let heads = await headings()
        return StepObservation(url: webView.url?.absoluteString, title: webView.title, landmarks: heads.isEmpty ? nil : Array(heads.prefix(4)))
    }
}
