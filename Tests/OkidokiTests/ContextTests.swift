import XCTest
@testable import OkidokiCore

/// What reaches the model: which thread a request joins, and when the clipboard rides along.
@MainActor
final class ContextTests: XCTestCase {
    private func freshStore() -> OkidokiStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("state.json")
        let store = OkidokiStore(stateURL: url)
        if store.accounts.isEmpty { store.createAccount(name: "test", email: "", kind: .personal) }
        return store
    }

    func testUnrelatedRequestHoursLaterStartsAFreshThread() {
        let store = freshStore()
        let now = Date()
        let old = store.threadForContext(app: "Safari", text: "open a private browsing tab", now: now)
        store.appendMessage(threadID: old.id, role: .user, text: "open a private browsing tab")
        store.threads[0].updatedAt = now.addingTimeInterval(-60 * 50)

        let fresh = store.threadForContext(app: "Safari", text: "teach me how to use notes", now: now)
        XCTAssertNotEqual(fresh.id, old.id, "an unrelated request 50 minutes later must not continue the old thread")

        let soon = store.threadForContext(app: "Safari", text: "teach me how to use notes", now: now.addingTimeInterval(60))
        XCTAssertEqual(soon.id, fresh.id, "a request a minute later continues the thread just started")
    }

    func testFollowUpWordingContinuesTheRecentThread() {
        let store = freshStore()
        let now = Date()
        let thread = store.threadForContext(app: "Dia", text: "find me nike boots size 9", now: now)
        store.appendMessage(threadID: thread.id, role: .user, text: "find me nike boots size 9")
        store.threads[0].updatedAt = now.addingTimeInterval(-60 * 40)
        XCTAssertEqual(store.threadForContext(app: "Dia", text: "and add them to the cart", now: now).id, thread.id)
        XCTAssertEqual(store.threadForContext(app: "Dia", text: "yes", now: now).id, thread.id)
        XCTAssertNotEqual(store.threadForContext(app: "Dia", text: "open the convex homepage in safari", now: now).id, thread.id)
        store.threads[0].updatedAt = now.addingTimeInterval(-60 * 60 * 3)
        XCTAssertNotEqual(store.threadForContext(app: "Dia", text: "and add them to the cart", now: now).id, thread.id,
                          "even a follow-up doesn't reach back three hours")
    }

    func testClipboardTravelsOnlyWhenTheRequestNamesIt() {
        let answer = "**Make the repo closed** means change a repository from public to private."
        let copied = BrainService.relevantClipboard(answer, request: "and how do i do that on github?",
                                                    history: ["explain this to me", answer],
                                                    hasScreenshot: false, hasDocument: false)
        XCTAssertEqual(copied, "", "a copied answer never goes back to the model as clipboard")
        XCTAssertEqual(BrainService.relevantClipboard(answer, request: "what's on my clipboard?",
                                                      history: ["explain this to me", answer],
                                                      hasScreenshot: false, hasDocument: false), "",
                       "even when asked by name, an echo of the chat stays out")
        // Named outright: it goes along.
        XCTAssertEqual(BrainService.relevantClipboard("a long article", request: "summarize what i copied",
                                                      history: [], hasScreenshot: false, hasDocument: false), "a long article")
        XCTAssertEqual(BrainService.relevantClipboard("git fetch origin main", request: "explain my clipboard",
                                                      history: [], hasScreenshot: false, hasDocument: false), "git fetch origin main")
        XCTAssertEqual(BrainService.relevantClipboard("call mom at 5", request: "note this",
                                                      history: [], hasScreenshot: false, hasDocument: false), "call mom at 5")
        // Typed questions stand on their own; whatever is on the clipboard stays out of them.
        for request in ["open safari private browsing", "explain this to me", "fix this error", "summarize this page",
                        "copy that file to the desktop", "what's this", "teach me how to use notes"] {
            XCTAssertEqual(BrainService.relevantClipboard("git fetch origin main", request: request,
                                                          history: [], hasScreenshot: false, hasDocument: false), "",
                           "\"\(request)\" must not drag the clipboard along")
        }
        XCTAssertEqual(BrainService.relevantClipboard("git fetch", request: "do this",
                                                      history: [], hasScreenshot: true, hasDocument: false), "")
        XCTAssertTrue(BrainService.mentionsClipboard("paste what I copied"))
        XCTAssertFalse(BrainService.mentionsClipboard("how do i fix this"))
    }

    func testModelSavedClipboardNotesArePrunedAtLoad() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("state.json")
        let store = OkidokiStore(stateURL: url)
        store.addMemory("Do not run the git fetch on the clipboard unless Jay explicitly asks", source: "said")
        store.addMemory("Okidoki cannot open, focus, or change its own windows", source: "said")
        store.addMemory("Jay wants purchases stopped before checkout", source: "said")
        store.addMemory("remind me what's on the clipboard every morning", source: "you")
        store.saveNow()

        let reloaded = OkidokiStore(stateURL: url)
        let texts = reloaded.memories.map(\.text)
        XCTAssertFalse(texts.contains { $0.contains("git fetch on the clipboard") }, "a model note about the clipboard is dropped")
        XCTAssertFalse(texts.contains { $0.hasPrefix("Okidoki cannot") }, "a model note about its own limits is dropped")
        XCTAssertTrue(texts.contains("Jay wants purchases stopped before checkout"), "a real fact the model saved stays")
        XCTAssertTrue(texts.contains("remind me what's on the clipboard every morning"), "the person's own notes are never pruned")
    }

    func testOnlyDurableFactsBecomeMemories() {
        XCTAssertTrue(BrainService.isDurableFact("Jay studies at Purdue"))
        XCTAssertFalse(BrainService.isDurableFact("Do not run the git fetch on the clipboard unless Jay explicitly asks"))
        XCTAssertFalse(BrainService.isDurableFact("Okidoki cannot open its own windows"))
        XCTAssertFalse(BrainService.isDurableFact("I couldn't finish because accessibility is off"))
        XCTAssertFalse(BrainService.isDurableFact(""))
    }
}
