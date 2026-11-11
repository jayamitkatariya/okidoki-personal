import AppKit
import Foundation
import OkidokiCore

/// What the new shell asks of the Mac: requests from its composer, and the browser driven from its
/// sidebar and toolbar instead of the native tab strip.
extension AppEnvironment {
    /// The dashboard window is the one taking the keyboard.
    var dashboardWindowIsKey: Bool { dashboard?.window?.isKeyWindow == true }

    /// A request from the composer. Returns the conversation it lands in, so the shell can open it.
    /// `mode` is the Where chip: auto, browser, act or chat. A conversation whose last task asked
    /// a question takes this as the answer.
    @discardableResult
    func askFromShell(_ text: String, mode: String, threadID: String?) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let thread = threadID.flatMap { store.thread($0) }
            ?? store.createThread(title: String(trimmed.prefix(60)), app: "okidoki", topic: inferTopic(trimmed))
        if let last = store.runs.first(where: { $0.threadID == thread.id && [.computerUse, .browser].contains($0.kind) }),
           last.status == .asked {
            answerDriveQuestion(runID: last.id, text: trimmed)
            return thread.id
        }
        store.markSeen(threadID: thread.id)
        noteSpokenInput(false)
        let known = ["auto", "browser", "act", "chat"]
        Task {
            await handleRequestFromShell(text: trimmed, threadID: thread.id, mode: known.contains(mode) ? mode : "auto")
        }
        return thread.id
    }

    /// A task for the tab in front of the person, from its assistant panel: the browser agent works in
    /// that tab, in the tab's own conversation.
    func askInTab(_ text: String, tabID: String?) -> String? {
        let tab = tabID.flatMap(UUID.init(uuidString:)).flatMap { browser.tab($0) } ?? browser.activeTab
        startBrowserTask(text, in: tab)
        return tab.threadID
    }

    // MARK: - Browser from the shell

    func shellBrowserGo(_ text: String, tabID: String?, choice: String, newTab: Bool) {
        let choice: BrowserAddressChoice = choice == "search" ? .search : choice == "ask" ? .ask : .open
        let tab: BrowserTab
        if let tabID, let id = UUID(uuidString: tabID), let existing = browser.tab(id) {
            tab = existing
        } else if newTab {
            // Reuse a blank tab nobody's in rather than leave empty tabs behind.
            if let blank = browser.model.tabs.first(where: { $0.isBlank && !$0.working && $0.ownerRunID == nil }) {
                tab = blank
            } else {
                tab = browser.openTab(activate: true)
            }
        } else {
            tab = browser.activeTab
        }
        browser.select(tab)
        browser.go(typed: text, in: tab, choice: choice)
    }

    func shellBrowserNav(_ action: String, tabID: String?) {
        let tab = tabID.flatMap(UUID.init(uuidString:)).flatMap { browser.tab($0) } ?? browser.activeTab
        switch action {
        case "back": tab.webView.goBack()
        case "forward": tab.webView.goForward()
        case "reload": tab.webView.reload()
        case "stop": tab.webView.stopLoading()
        case "retry": tab.retryFailedLoad()
        case "takeOver": tab.onEscape?()
        default: break
        }
    }

    func shellSelectTab(_ tabID: String) {
        guard let id = UUID(uuidString: tabID), let tab = browser.tab(id) else { return }
        browser.select(tab)
        if let runID = tab.ownerRunID { store.markSeen(runID: runID) }
    }

    func shellCloseTab(_ tabID: String) {
        guard let id = UUID(uuidString: tabID), let tab = browser.tab(id) else { return }
        browser.closeTab(tab)
    }

    func shellOpenURL(_ url: String, newTab: Bool) {
        shellBrowserGo(url, tabID: nil, choice: "open", newTab: newTab)
    }

    /// The new shell's first open: pins come from what the person already uses.
    func seedShellPins() {
        store.seedPinsIfNeeded(loginSites: vault.logins.map(\.site))
    }

    /// Bookmarks the tab's page, or removes the bookmark.
    func shellToggleBookmark(tabID: String?) {
        let tab = tabID.flatMap(UUID.init(uuidString:)).flatMap { browser.tab($0) } ?? browser.activeTab
        guard !tab.isBlank else { return }
        let saved = store.toggleBookmark(url: tab.address, title: tab.title)
        toast(title: saved ? "bookmarked" : "bookmark removed", detail: tab.label, kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    func shellPinTab(tabID: String?) {
        let tab = tabID.flatMap(UUID.init(uuidString:)).flatMap { browser.tab($0) } ?? browser.activeTab
        guard !tab.isBlank else { return }
        if !store.pin(url: tab.address, title: tab.title) {
            toast(title: "the pins are full", detail: "unpin one to make room", kind: .info,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }

    /// A still of the tab in front, for the page to show while an overlay covers the native view.
    func shellFreeze(_ done: @escaping (String?) -> Void) {
        guard let tab = browser.model.active else { done(nil); return }
        BrowserFreeze.capture(tab, done: done)
    }
}
