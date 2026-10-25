import AppKit
import XCTest
@testable import OkidokiCore

/// The recorded crop is found again after the window moved, the nearest of two identical
/// controls wins, and a crop that isn't on screen is not invented.
final class FrameMatcherTests: XCTestCase {
    /// Draws at exactly 1 px per point, so test coordinates are image pixels.
    private func draw(size: CGSize, _ body: () -> Void) -> CGImage {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        body()
        NSGraphicsContext.restoreGraphicsState()
        return rep.cgImage!
    }

    /// A plain-looking window with a few "controls" drawn at known places.
    private func screen(size: CGSize, windowAt origin: CGPoint) -> CGImage {
        return draw(size: size) {
        NSColor(white: 0.93, alpha: 1).setFill()
        NSRect(origin: .zero, size: size).fill()
        // Window body
        NSColor.white.setFill()
        NSRect(x: origin.x, y: origin.y, width: 520, height: 360).fill()
        NSColor(white: 0.75, alpha: 1).setStroke()
        NSRect(x: origin.x, y: origin.y, width: 520, height: 360).frame()
        // Sidebar rows with distinct text
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.black]
        for (row, name) in ["Maggi Meetup <3", "Dad", "Work group", "Alice", "Bob"].enumerated() {
            let y = origin.y + 300 - CGFloat(row) * 44
            NSColor(white: 0.97, alpha: 1).setFill()
            NSRect(x: origin.x + 10, y: y, width: 200, height: 36).fill()
            NSString(string: name).draw(at: NSPoint(x: origin.x + 50, y: y + 10), withAttributes: attributes)
            NSColor(hue: CGFloat(row) / 5, saturation: 0.7, brightness: 0.8, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: origin.x + 16, y: y + 6, width: 24, height: 24)).fill()
        }
        // A "Send" button at the bottom-right
        NSColor.systemBlue.setFill()
        NSRect(x: origin.x + 430, y: origin.y + 16, width: 70, height: 30).fill()
        NSString(string: "Send").draw(at: NSPoint(x: origin.x + 450, y: origin.y + 23),
                                      withAttributes: [.font: NSFont.boldSystemFont(ofSize: 13), .foregroundColor: NSColor.white])
        }
    }

    private func crop(_ image: CGImage, around center: CGPoint, size: CGSize) -> CGImage {
        image.cropping(to: CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height))!
    }

    // Points below are in image (top-left origin) pixels. The drawing above uses AppKit's
    // bottom-left origin, so `flip` converts.
    private func flip(_ p: CGPoint, height: CGFloat) -> CGPoint { CGPoint(x: p.x, y: height - p.y) }

    func testFindsTheRowAgainAfterTheWindowMoved() {
        let size = CGSize(width: 1200, height: 800)
        let before = screen(size: size, windowAt: CGPoint(x: 100, y: 200))
        let after = screen(size: size, windowAt: CGPoint(x: 460, y: 80))
        // "Dad" row centre: origin + (110, 300 - 44 + 18)
        let dadBefore = flip(CGPoint(x: 100 + 110, y: 200 + 274), height: size.height)
        let dadAfter = flip(CGPoint(x: 460 + 110, y: 80 + 274), height: size.height)
        let template = crop(before, around: dadBefore, size: CGSize(width: 200, height: 40))
        let match = FrameMatcher.find(template: template, in: after)
        XCTAssertNotNil(match)
        guard let match else { return }
        XCTAssertGreaterThan(match.score, 0.9)
        XCTAssertEqual(match.center.x, dadAfter.x, accuracy: 2)
        XCTAssertEqual(match.center.y, dadAfter.y, accuracy: 2)
    }

    func testFindsASmallButton() {
        let size = CGSize(width: 1200, height: 800)
        let before = screen(size: size, windowAt: CGPoint(x: 100, y: 200))
        let after = screen(size: size, windowAt: CGPoint(x: 300, y: 300))
        let sendBefore = flip(CGPoint(x: 100 + 465, y: 200 + 31), height: size.height)
        let sendAfter = flip(CGPoint(x: 300 + 465, y: 300 + 31), height: size.height)
        let template = crop(before, around: sendBefore, size: CGSize(width: 90, height: 44))
        let match = FrameMatcher.find(template: template, in: after)
        XCTAssertNotNil(match)
        guard let match else { return }
        XCTAssertEqual(match.center.x, sendAfter.x, accuracy: 2)
        XCTAssertEqual(match.center.y, sendAfter.y, accuracy: 2)
    }

    func testPrefersTheMatchNearestTheOldSpotWhenTwoLookTheSame() {
        let size = CGSize(width: 1200, height: 800)
        let cg = draw(size: size) {
            NSColor.white.setFill()
            NSRect(origin: .zero, size: size).fill()
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.black]
            for x in [150.0, 800.0] {
                NSColor(white: 0.85, alpha: 1).setFill()
                NSRect(x: x, y: 400, width: 120, height: 32).fill()
                NSString(string: "Reply").draw(at: NSPoint(x: x + 36, y: 408), withAttributes: attributes)
            }
        }
        let left = flip(CGPoint(x: 210, y: 416), height: size.height)
        let right = flip(CGPoint(x: 860, y: 416), height: size.height)
        let template = crop(cg, around: left, size: CGSize(width: 130, height: 40))
        let nearRight = FrameMatcher.find(template: template, in: cg, near: CGPoint(x: 900, y: right.y))
        XCTAssertEqual(nearRight?.center.x ?? 0, right.x, accuracy: 2)
        let nearLeft = FrameMatcher.find(template: template, in: cg, near: CGPoint(x: 100, y: left.y))
        XCTAssertEqual(nearLeft?.center.x ?? 0, left.x, accuracy: 2)
    }

    /// Finder icons, chat rows, mail threads: the same big picture with a different little name.
    /// The name is what matters, and it must beat "nearest to the old spot".
    func testTellsLookAlikeItemsApartByTheirSmallText() {
        let size = CGSize(width: 1200, height: 800)
        func icons(at origin: CGPoint, order: [String]) -> CGImage {
            draw(size: size) {
                NSColor(white: 0.14, alpha: 1).setFill()
                NSRect(origin: .zero, size: size).fill()
                let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.white]
                for (index, name) in order.enumerated() {
                    let x = origin.x + CGFloat(index) * 128
                    NSColor.white.setFill()
                    NSBezierPath(roundedRect: NSRect(x: x + 20, y: origin.y + 40, width: 46, height: 56), xRadius: 6, yRadius: 6).fill()
                    let width = NSString(string: name).size(withAttributes: attributes).width
                    NSString(string: name).draw(at: NSPoint(x: x + 43 - width / 2, y: origin.y + 16), withAttributes: attributes)
                }
            }
        }
        let before = icons(at: CGPoint(x: 100, y: 500), order: ["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt"])
        // Recorded on "bravo.txt" (second slot): centre of its name.
        let bravoBefore = flip(CGPoint(x: 100 + 128 + 43, y: 500 + 24), height: size.height)
        let template = crop(before, around: bravoBefore, size: CGSize(width: 220, height: 140))
        // Later: window moved and the icons reordered so bravo is last; alpha now sits nearest the old spot.
        let after = icons(at: CGPoint(x: 400, y: 200), order: ["alpha.txt", "delta.txt", "charlie.txt", "bravo.txt"])
        let bravoAfter = flip(CGPoint(x: 400 + 3 * 128 + 43, y: 200 + 24), height: size.height)
        let match = FrameMatcher.find(template: template, in: after, near: bravoBefore)
        XCTAssertNotNil(match)
        guard let match else { return }
        XCTAssertEqual(match.center.x, bravoAfter.x, accuracy: 2)
        XCTAssertEqual(match.center.y, bravoAfter.y, accuracy: 2)
    }

    /// A click near the edge of the screen gets a crop that can't be centred on it. The answer
    /// must still be where the click is, not where the crop's middle is.
    func testOffCentreAnchorStillPointsAtTheClick() {
        let size = CGSize(width: 1200, height: 800)
        let before = screen(size: size, windowAt: CGPoint(x: 0, y: 200))
        let after = screen(size: size, windowAt: CGPoint(x: 300, y: 100))
        // "Dad" row centre in the before image: window origin + (110, 274); the window hugs the left
        // edge, so a 200-wide crop around x=110 is clamped to start at 0.
        let dadBefore = flip(CGPoint(x: 110, y: 200 + 274), height: size.height)
        let dadAfter = flip(CGPoint(x: 300 + 110, y: 100 + 274), height: size.height)
        let cropRect = CGRect(x: 0, y: dadBefore.y - 20, width: 200, height: 40)
        let template = before.cropping(to: cropRect)!
        let anchor = CGPoint(x: dadBefore.x - cropRect.minX, y: dadBefore.y - cropRect.minY)
        XCTAssertNotEqual(anchor.x, 100, "the click really is off-centre in this crop")
        let match = FrameMatcher.find(template: template, in: after, anchor: anchor)
        XCTAssertNotNil(match)
        guard let match else { return }
        XCTAssertEqual(match.center.x, dadAfter.x, accuracy: 2)
        XCTAssertEqual(match.center.y, dadAfter.y, accuracy: 2)
    }

    func testDoesNotInventAMatchWhenTheControlIsGone() {
        let size = CGSize(width: 1200, height: 800)
        let before = screen(size: size, windowAt: CGPoint(x: 100, y: 200))
        let dad = flip(CGPoint(x: 100 + 110, y: 200 + 274), height: size.height)
        let template = crop(before, around: dad, size: CGSize(width: 200, height: 40))
        // A screen with the window gone: only the desktop colour.
        let empty = draw(size: size) {
            NSColor(white: 0.93, alpha: 1).setFill()
            NSRect(origin: .zero, size: size).fill()
        }
        XCTAssertNil(FrameMatcher.find(template: template, in: empty))
        // And a screen with different rows at the same spot shouldn't pass either.
        let other = draw(size: size) {
            NSColor.white.setFill()
            NSRect(origin: .zero, size: size).fill()
            for row in 0..<8 {
                NSString(string: "Row number \(row) with other text").draw(at: NSPoint(x: 120, y: 100 + CGFloat(row) * 60),
                                                                           withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.black])
            }
        }
        let match = FrameMatcher.find(template: template, in: other)
        XCTAssertNil(match, "scored \(match?.score ?? 0)")
    }

    func testIsFastEnoughForAReplayStep() {
        let size = CGSize(width: 2880, height: 1800) // a Retina laptop display in pixels
        let before = screen(size: size, windowAt: CGPoint(x: 200, y: 400))
        let after = screen(size: size, windowAt: CGPoint(x: 1500, y: 900))
        let dad = flip(CGPoint(x: 200 + 110, y: 400 + 274), height: size.height)
        let template = crop(before, around: dad, size: CGSize(width: 440, height: 280))
        let start = Date()
        let match = FrameMatcher.find(template: template, in: after)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertNotNil(match)
        XCTAssertLessThan(elapsed, 1.0, "took \(elapsed)s")
    }
}
