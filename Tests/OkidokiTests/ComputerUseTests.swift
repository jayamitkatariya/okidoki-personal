import XCTest
import AppKit
@testable import OkidokiCore

@MainActor
final class ComputerUseTests: XCTestCase {

    func testAppResolverFindsSystemApps() {
        let notes = AppResolver.resolve(name: "Notes")
        XCTAssertNotNil(notes, "Notes should resolve to a system app")
        XCTAssertTrue(notes!.url.path.contains("Notes.app"))

        let calculator = AppResolver.resolve(name: "calculator")
        XCTAssertNotNil(calculator, "calculator should resolve case-insensitively to Calculator.app")

        let fuzzy = AppResolver.resolve(name: "Fin")
        XCTAssertNotNil(fuzzy, "partial names should still resolve to Finder")
    }

    func testAppResolverAliases() {
        if FileManager.default.fileExists(atPath: "/Applications/FreeCAD.app") {
            XCTAssertEqual(AppResolver.resolve(name: "cad")?.url.lastPathComponent, "FreeCAD.app")
        }
        let nonsense = AppResolver.resolve(name: "DefinitelyNotAnApp99")
        XCTAssertNil(nonsense)
    }

    func testImageCoordinateMapping() {
        let box = ScreenBox(x: 100, y: 50, width: 1512, height: 982)
        // 2x retina image, click at image center should map to screen center.
        let point = ComputerUseService.mapImage(x: 1512, y: 982, box: box, imageWidth: 3024, imageHeight: 1964)
        XCTAssertEqual(point?.x ?? 0, 100 + 756, accuracy: 0.5)
        XCTAssertEqual(point?.y ?? 0, 50 + 491, accuracy: 0.5)

        // Out-of-bounds clicks are rejected.
        XCTAssertNil(ComputerUseService.mapImage(x: 5000, y: 10, box: box, imageWidth: 3024, imageHeight: 1964))
        XCTAssertNil(ComputerUseService.mapImage(x: -5, y: 10, box: box, imageWidth: 3024, imageHeight: 1964))
    }

    func testComputerActionLenientDecoding() throws {
        // The brain sends snake_case; ints and floats both appear depending on the model.
        let json = #"{"type":"click","x":120,"y":80,"say":"clicking send"}"#.data(using: .utf8)!
        let click = try JSONDecoder().decode(ComputerAction.self, from: json)
        XCTAssertEqual(click.type, "click")
        XCTAssertEqual(click.x, 120)
        XCTAssertEqual(click.y, 80)
        XCTAssertEqual(click.say, "clicking send")

        let dragJSON = #"{"type":"drag","from_x":1,"from_y":2.5,"to_x":300,"to_y":400}"#.data(using: .utf8)!
        let drag = try JSONDecoder().decode(ComputerAction.self, from: dragJSON)
        XCTAssertEqual(drag.fromX, 1)
        XCTAssertEqual(drag.fromY, 2.5)
        XCTAssertEqual(drag.toX, 300)

        let missing = #"{}"#.data(using: .utf8)!
        let fallback = try JSONDecoder().decode(ComputerAction.self, from: missing)
        XCTAssertEqual(fallback.type, "fail")
    }

    func testComputerActionDictionaryRoundTrip() throws {
        let action = ComputerAction(type: "type", text: "hey mom", say: "typing")
        let dict = action.dictionary
        XCTAssertEqual(dict["type"] as? String, "type")
        XCTAssertEqual(dict["text"] as? String, "hey mom")
        let encoded = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(ComputerAction.self, from: encoded)
        XCTAssertEqual(decoded, action)
    }

    func testTeachPlanAndDecisionDecoding() throws {
        let json = """
        {"kind":"overlay","title":"flow","answer":"here you go",
         "overlay_html":"<html></html>","overlay_title":"flow","overlay_width":560,"overlay_height":380,
         "teach_plan":[{"say":"press shift+a","marks":[{"kind":"circle","target":"New chat"}]}]}
        """.data(using: .utf8)!
        let decision = try JSONDecoder().decode(BrainDecision.self, from: json)
        XCTAssertEqual(decision.kind, .overlay)
        XCTAssertEqual(decision.overlayHTML, "<html></html>")
        XCTAssertEqual(decision.overlayWidth, 560)
        XCTAssertEqual(decision.teachPlan.count, 1)
        XCTAssertEqual(decision.teachPlan[0].marks.first?.kind, "circle")
        XCTAssertEqual(decision.teachPlan[0].marks.first?.target, "New chat")

        // Old-format teach decisions still decode.
        let legacy = #"{"kind":"teach","title":"t","answer":"a","teach_steps":["one","two"]}"#.data(using: .utf8)!
        let teach = try JSONDecoder().decode(BrainDecision.self, from: legacy)
        XCTAssertEqual(teach.teachSteps, ["one", "two"])
        XCTAssertEqual(teach.teachPlan, [])
    }

    func testRunningAppsAndFrontmost() {
        let apps = ComputerUseService.shared.runningApps()
        XCTAssertTrue(apps.contains { $0.name == "Finder" }, "Finder is always running")
        _ = ComputerUseService.shared.frontmost()
    }

    func testTypingDefaultInput() {
        XCTAssertEqual(AppSettings().defaultInput, .typing)
    }
}
