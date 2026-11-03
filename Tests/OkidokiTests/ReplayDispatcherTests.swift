import XCTest
@testable import OkidokiCore

final class ReplayDispatcherTests: XCTestCase {
    private func skill(_ id: String, inputs: [SkillInput]? = nil, template: Bool? = nil) -> Skill {
        var s = Skill(id: id, accountID: "a", name: id, summary: "", steps: template == true ? [] : [SkillStep(text: "x")])
        s.inputs = inputs; s.template = template
        return s
    }

    func testDecisions() {
        let smart = skill("smart", inputs: [SkillInput(name: "pan")])
        let plain = skill("plain")
        let template = skill("flights", template: true)
        let skills = [smart, plain, template]

        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "smart", items: ["Jay", "Neha"], confidence: 0.9), skills: skills),
                       .replay(skillID: "smart", passes: [["ref": "Jay"], ["ref": "Neha"]]))
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "smart", items: [], overrides: ["pan": "X"], confidence: 0.95), skills: skills),
                       .replay(skillID: "smart", passes: [["pan": "X"]]))
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "smart", confidence: 0.6), skills: skills), .agent, "not sure enough")
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "gone", confidence: 0.99), skills: skills), .agent)
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "plain", confidence: 0.99), skills: skills), .replay(skillID: "plain", passes: [[:]]))
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "skill", id: "plain", items: ["Jay", "Neha"], confidence: 0.99), skills: skills), .agent,
                       "a recording without inputs would type the same thing for everyone")
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "template", id: "flights", overrides: ["to": "Goa"], confidence: 0.9), skills: skills),
                       .template(skillID: "flights", passes: [["to": "Goa"]]))
        XCTAssertEqual(ReplayDispatcher.decide(.init(kind: "agent", confidence: 1), skills: skills), .agent)
    }

    func testAPlainRecordingHandsOverToItsSmartVersion() {
        func site(_ id: String, _ name: String, inputs: [SkillInput]?) -> Skill {
            var s = Skill(id: id, accountID: "a", name: name, summary: "",
                          steps: [SkillStep.browser("navigate", text: "open", url: "http://127.0.0.1:8777/login.html")])
            s.inputs = inputs
            return s
        }
        let plain = site("p", "acme filing", inputs: nil)
        let smart = site("s", "acme filing smart", inputs: [SkillInput(name: "pan")])
        let other = site("o", "wiki search", inputs: [SkillInput(name: "q")])
        let route = ReplayDispatcher.Route(kind: "skill", id: "p", items: ["Bharat", "Chandra"], confidence: 0.9)
        XCTAssertEqual(ReplayDispatcher.decide(route, skills: [plain, smart, other]),
                       .replay(skillID: "s", passes: [["ref": "Bharat"], ["ref": "Chandra"]]))
        // Another site's skill with inputs isn't a stand-in.
        XCTAssertEqual(ReplayDispatcher.decide(route, skills: [plain, other]), .agent)
    }

    func testAskingForTheAgentSkipsReplay() {
        XCTAssertTrue(ReplayDispatcher.wantsAgent("file it for Neha, but use the agent"))
        XCTAssertFalse(ReplayDispatcher.wantsAgent("file it for Neha"))
    }
}
