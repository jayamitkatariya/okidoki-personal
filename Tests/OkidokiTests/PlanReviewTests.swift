import XCTest
@testable import OkidokiCore

final class PlanReviewTests: XCTestCase {
    func testReviewKeepsTheFullRequestAndContext() throws {
        let original: [String: Any] = ["system": "original rules", "model": "fixture-model", "tools": [["name": "okidoki_respond"]],
            "tool_choice": ["type": "auto"], "messages": [["role": "user", "content": [
                ["type": "image", "source": ["data": "screen-fixture"]],
                ["type": "text", "text": "Convert Word to PDF and zip it. Keep the original."]]]]]
        let proposed: [String: Any] = ["kind": "terminal", "title": "wrong direction", "answer": "convert", "commands": ["pandoc input.pdf -o output.docx"]]
        let reviewed = try PlanReview.body(original: original, proposed: proposed)
        let messages = try XCTUnwrap(reviewed["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.count, 3)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: messages[0], options: [.sortedKeys]),
                       try JSONSerialization.data(withJSONObject: (original["messages"] as! [[String: Any]])[0], options: [.sortedKeys]))
        XCTAssertTrue((reviewed["system"] as? String)?.contains(PlanReview.instruction) == true)
        XCTAssertTrue((messages[1]["content"] as? String)?.contains("pandoc input.pdf -o output.docx") == true)
        XCTAssertEqual((reviewed["tool_choice"] as? [String: String])?["type"], "auto")
    }

    func testReviewAcceptsTheCorrectedDecisionAndRejectsProseAndMalformedReplies() throws {
        let decision: [String: Any] = ["kind": "terminal", "title": "make PDF and ZIP", "answer": "keep the original", "commands": ["make-pdf", "zip-pdf"]]
        let valid = try JSONSerialization.data(withJSONObject: ["content": [["type": "tool_use", "name": "okidoki_respond", "input": decision]]])
        let corrected = try PlanReview.decision(from: valid)
        XCTAssertEqual(corrected["commands"] as? [String], ["make-pdf", "zip-pdf"])
        let invalid: [[String: Any]] = [
            ["content": [["type": "text", "text": "Done, I sent it."]]],
            ["content": [["type": "tool_use", "name": "wrong_tool", "input": decision]]],
            ["content": [["type": "tool_use", "name": "okidoki_respond", "input": ["kind": "terminal"]]]]
        ]
        for response in invalid {
            XCTAssertThrowsError(try PlanReview.decision(from: JSONSerialization.data(withJSONObject: response)))
        }
        for kind in ["terminal", "coding", "background", "connector", "quick_action", "routine", "computer_use", "borrow"] {
            XCTAssertTrue(PlanReview.needsReview(kind))
        }
        for kind in ["answer", "teach", "memory", "watch"] { XCTAssertFalse(PlanReview.needsReview(kind)) }
    }
}
