import XCTest
@testable import OkidokiCore

/// Mirrors brain/tests/lesson.test.ts case for case, so the sidecar and the native fallback agree.
final class LessonRoutingTests: XCTestCase {
    func testIntentWords() {
        for text in ["show me how to make a circuit", "how do I add auto layout", "walk me through exporting", "teach me to rig this", "how to wire an LED"] {
            XCTAssertTrue(LessonRouting.wantsToDo(text), text)
            XCTAssertFalse(LessonRouting.wantsToUnderstand(text), text)
        }
        for text in ["explain this", "what is she talking about", "how does a transistor work", "what's compound interest", "why does this happen", "summarize the lecture", "what is this video about"] {
            XCTAssertTrue(LessonRouting.wantsToUnderstand(text), text)
            XCTAssertFalse(LessonRouting.wantsToDo(text), text)
        }
        XCTAssertTrue(LessonRouting.wantsToDo("explain how to use the speed control"))
        XCTAssertTrue(LessonRouting.wantsToUnderstand("explain how to use the speed control"))
        XCTAssertTrue(LessonRouting.wantsToUnderstand("show me how a transistor works"))
    }

    func testWorkingInATool() {
        XCTAssertEqual(LessonRouting.resolve(chosen: .concept, scene: .working, text: "show me how to make a circuit"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .working, text: "how do I add auto layout"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .working, text: "rig the character"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: .concept, scene: .working, text: "explain Ohm's law"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .working, text: "what is recursion"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .working, text: "what does this node do"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: .concept, scene: .working, text: "explain how to use the pen tool"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .working, text: "explain how to use the pen tool"), .app)
    }

    func testWatchingOrReading() {
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .watching, text: "explain this"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .reading, text: "what is she talking about"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .watching, text: "how does a transistor work"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .watching, text: "a transistor"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .watching, text: "show me how to do that in blender"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .watching, text: "show me how to do that in blender"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: .app, scene: .watching, text: "explain how to use the speed control"), .app)
    }

    func testNoScene() {
        XCTAssertEqual(LessonRouting.resolve(chosen: .concept, scene: nil, text: "show me how to make a circuit"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: nil, text: "teach me figma"), .app)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .other, text: "explain compound interest"), .concept)
        XCTAssertEqual(LessonRouting.resolve(chosen: nil, scene: .other, text: "show me how to use finder tags"), .app)
    }

    func testStringForm() {
        XCTAssertEqual(LessonRouting.resolve(lessonKind: "concept", scene: "working", text: "show me how to make a circuit"), "app")
        XCTAssertEqual(LessonRouting.resolve(lessonKind: "video", scene: "banana", text: "teach me figma"), "app")
        XCTAssertEqual(LessonRouting.resolve(lessonKind: nil, scene: "watching", text: "explain this"), "concept")
    }

    func testDecisionDecodesSceneAndLessonKindFromEitherCase() throws {
        let snake = #"{"kind":"teach","title":"teach: a circuit","answer":"ok","lesson_kind":"app","scene":"working"}"#
        let decoded = try JSONDecoder().decode(BrainDecision.self, from: Data(snake.utf8))
        XCTAssertEqual(decoded.lessonKind, "app")
        XCTAssertEqual(decoded.scene, "working")
        let camel = #"{"kind":"teach","title":"t","answer":"ok","lessonKind":"concept","scene":"watching"}"#
        let decoded2 = try JSONDecoder().decode(BrainDecision.self, from: Data(camel.utf8))
        XCTAssertEqual(decoded2.lessonKind, "concept")
        XCTAssertEqual(decoded2.scene, "watching")
        let roundTrip = try JSONDecoder().decode(BrainDecision.self, from: JSONEncoder().encode(decoded2))
        XCTAssertEqual(roundTrip.scene, "watching")
    }

    func testScreenContextSummaryAndSettingsDefault() throws {
        XCTAssertTrue(ScreenContext().isEmpty)
        XCTAssertEqual(ScreenContext(windowTitle: "Blender — scene.blend").summary, "Blender — scene.blend")
        XCTAssertEqual(ScreenContext(windowTitle: "Chrome", pageTitle: "Circuits · Tinkercad", pageURL: "https://tinkercad.com/x").summary,
                       "Circuits · Tinkercad — https://tinkercad.com/x")
        // Old settings files without the key keep the feature on.
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data("{}".utf8))
        XCTAssertTrue(settings.screenContext)
        let off = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"screenContext":false}"#.utf8))
        XCTAssertFalse(off.screenContext)
    }
}
