import AppKit
import XCTest
@testable import OkidokiCore

final class TeachToolkitTests: XCTestCase {
    func testKeyCombosMatchHowPeopleWriteThem() {
        XCTAssertTrue(TeachKeys.matches("cmd+shift+a", expected: "⌘⇧A".replacingOccurrences(of: "⌘⇧", with: "cmd+shift+")))
        XCTAssertTrue(TeachKeys.matches("shift+cmd+a", expected: "Command-Shift-A"))
        XCTAssertTrue(TeachKeys.matches("f", expected: "F"))
        XCTAssertTrue(TeachKeys.matches("shift+a", expected: "a"), "a capital letter typed with shift still counts")
        XCTAssertFalse(TeachKeys.matches("cmd+a", expected: "shift+a"))
        XCTAssertTrue(TeachKeys.matches("return", expected: "Enter"))
        XCTAssertTrue(TeachKeys.matches("esc", expected: "escape"))
        XCTAssertEqual(TeachKeys.caps("cmd+shift+a"), ["⌘", "⇧", "A"])
        XCTAssertEqual(TeachKeys.combo(keyCode: 0, characters: "a", flags: [.command, .shift]), "shift+cmd+a")
        XCTAssertEqual(TeachKeys.combo(keyCode: 36, characters: "\r", flags: []), "return")
    }

    private func image(width: Int, height: Int, draw: (CGContext) -> Void) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.95, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        draw(context)
        return context.makeImage()!
    }

    func testIconSnapHugsADarkIconOnALightBackground() {
        let image = image(width: 400, height: 300) { context in
            context.setFillColor(CGColor(gray: 0.1, alpha: 1))
            // CoreGraphics draws bottom-up; the box sits at pixel rows 120...150 from the top.
            context.fill(CGRect(x: 180, y: 300 - 150, width: 30, height: 30))
        }
        let box = TeachImage.iconSnap(in: image, around: CGPoint(x: 195, y: 135), maxSize: 96)
        XCTAssertNotNil(box)
        guard let box else { return }
        XCTAssertEqual(box.minX, 180, accuracy: 1.5)
        XCTAssertEqual(box.minY, 120, accuracy: 1.5)
        XCTAssertEqual(box.width, 30, accuracy: 2)
        XCTAssertEqual(box.height, 30, accuracy: 2)
        XCTAssertNil(TeachImage.iconSnap(in: image, around: CGPoint(x: 40, y: 40)), "nothing but background means no snap")
    }

    func testMarkersKeepTheImageSizeAndSettleHashNoticesChange() {
        let a = image(width: 320, height: 200) { _ in }
        let marked = TeachImage.drawMarkers(on: a, markers: [TeachImage.Marker(id: 7, rect: CGRect(x: 40, y: 40, width: 60, height: 20))])
        XCTAssertEqual(marked?.width, 320)
        XCTAssertEqual(marked?.height, 200)
        let b = image(width: 320, height: 200) { context in
            context.setFillColor(CGColor(gray: 0.05, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 160, height: 200))
        }
        XCTAssertEqual(TeachImage.hammingDistance(TeachImage.settleHash(a), TeachImage.settleHash(a)), 0)
        XCTAssertGreaterThan(TeachImage.hammingDistance(TeachImage.settleHash(a), TeachImage.settleHash(b)), 8)
    }

    func testScaledMatchesRequestedSize() {
        let a = image(width: 3024, height: 1964) { _ in }
        let size = ImageFit.highResolution.resized(width: 3024, height: 1964, longEdgeCap: 2000)
        let scaled = TeachImage.scaled(a, to: size)
        XCTAssertEqual(scaled?.width, size.width)
        XCTAssertEqual(scaled?.height, size.height)
        XCTAssertLessThanOrEqual(size.width, 2000)
    }

    func testOCRFindsALabel() async {
        let image = image(width: 600, height: 200) { context in
            context.saveGState()
            let font = NSFont.systemFont(ofSize: 28, weight: .semibold)
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Auto layout", attributes: attributes))
            context.textPosition = CGPoint(x: 60, y: 90)
            CTLineDraw(line, context)
            context.restoreGState()
        }
        let words = await TeachImage.recognizeText(in: image, fast: false)
        XCTAssertTrue(words.contains { $0.text.lowercased().contains("auto") }, "found: \(words.map(\.text))")
        if let word = words.first(where: { $0.text.lowercased().contains("auto") }) {
            XCTAssertEqual(word.rect.midY, 200 - 90 - 10, accuracy: 25)
        }
    }
}
