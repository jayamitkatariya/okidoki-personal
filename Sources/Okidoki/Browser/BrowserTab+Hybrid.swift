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

    func isPresent(_ selector: String) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.present(s) : false", ["s": selector]) as? Bool ?? false
    }

    func clickText(_ label: String) async -> Bool {
        await call("return window.__okidoki ? window.__okidoki.clickText(l) : false", ["l": label]) as? Bool ?? false
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
