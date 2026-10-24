import XCTest
@testable import OkidokiCore

final class ImageFitTests: XCTestCase {
    func testDocumentedExamplesOnStandardTier() {
        let fit = ImageFit.standard
        XCTAssertEqual(fit.resized(width: 1920, height: 1080).width, 1456)
        XCTAssertEqual(fit.resized(width: 1920, height: 1080).height, 819)
        XCTAssertEqual(fit.resized(width: 1075, height: 1520).width, 924)
        XCTAssertEqual(fit.resized(width: 1075, height: 1520).height, 1307)
        // The docs table says 1269×952; their own reference implementation (and this one) give 1270×952,
        // which still fits the 1568-token budget (46 × 34 = 1564).
        XCTAssertEqual(fit.resized(width: 2000, height: 1500).width, 1270)
        XCTAssertEqual(fit.resized(width: 2000, height: 1500).height, 952)
        XCTAssertTrue(fit.fits(width: 1270, height: 952))
        let same = fit.resized(width: 1000, height: 1000)
        XCTAssertEqual(same.width, 1000)
        XCTAssertEqual(same.height, 1000)
    }

    func testHighResolutionTierKeepsLargerImages() {
        let fit = ImageFit.highResolution
        let kept = fit.resized(width: 1920, height: 1080)
        XCTAssertEqual(kept.width, 1920)
        XCTAssertEqual(kept.height, 1080)
        let fourK = fit.resized(width: 3840, height: 2160)
        XCTAssertEqual(fourK.width, 2576)
        XCTAssertEqual(fourK.height, 1449)
    }

    func testTierDetection() {
        XCTAssertEqual(ImageFit.tier(for: "claude-sonnet-4-5"), .standard)
        XCTAssertEqual(ImageFit.tier(for: "claude-haiku-4-5"), .standard)
        XCTAssertEqual(ImageFit.tier(for: "claude-haiku-5-5"), .highResolution)
        XCTAssertEqual(ImageFit.tier(for: "claude-opus-4-7"), .highResolution)
        XCTAssertEqual(ImageFit.tier(for: "claude-opus-5.5"), .highResolution)
        XCTAssertEqual(ImageFit.tier(for: "something-else"), .standard)
    }

    func testLongEdgeCapStaysUnderTokenBudget() {
        let fit = ImageFit.highResolution
        let size = fit.resized(width: 3024, height: 1964, longEdgeCap: 2000)
        XCTAssertLessThanOrEqual(size.width, 2000)
        XCTAssertTrue(fit.fits(width: size.width, height: size.height))
    }

    func testRoundHalfEven() {
        XCTAssertEqual(ImageFit.roundHalfEven(2.5), 2)
        XCTAssertEqual(ImageFit.roundHalfEven(3.5), 4)
        XCTAssertEqual(ImageFit.roundHalfEven(3.2), 3)
        XCTAssertEqual(ImageFit.roundHalfEven(3.7), 4)
    }
}
