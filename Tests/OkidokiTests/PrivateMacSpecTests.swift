import XCTest
@testable import OkidokiCore

final class PrivateMacSpecTests: XCTestCase {
    private let gib: UInt64 = 1024 * 1024 * 1024

    func testCPUCountLeavesHostTwoCoresAndCapsAtFour() {
        XCTAssertEqual(PrivateMacSpec.cpuCount(host: 10, minimum: 1, maximum: 10), 4)
        XCTAssertEqual(PrivateMacSpec.cpuCount(host: 4, minimum: 1, maximum: 10), 2)
        XCTAssertEqual(PrivateMacSpec.cpuCount(host: 2, minimum: 1, maximum: 10), 1)
    }

    func testCPUCountRespectsHypervisorBounds() {
        XCTAssertEqual(PrivateMacSpec.cpuCount(host: 2, minimum: 2, maximum: 8), 2)
        XCTAssertEqual(PrivateMacSpec.cpuCount(host: 16, minimum: 1, maximum: 3), 3)
    }

    func testMemoryIsHalfTheHostBetweenFourAndEightGB() {
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 8 * gib, minimum: gib, maximum: 64 * gib), 4 * gib)
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 12 * gib, minimum: gib, maximum: 64 * gib), 6 * gib)
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 64 * gib, minimum: gib, maximum: 64 * gib), 8 * gib)
    }

    func testMemoryRespectsHypervisorBoundsAndMebibyteAlignment() {
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 64 * gib, minimum: gib, maximum: 6 * gib), 6 * gib)
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 4 * gib, minimum: 5 * gib, maximum: 64 * gib), 5 * gib)
        let odd = PrivateMacSpec.memoryBytes(host: 7 * gib + 12345, minimum: gib, maximum: 64 * gib)
        XCTAssertEqual(odd % (1024 * 1024), 0)
    }

    func testPickedMemoryWinsButLeavesTheHostRoom() {
        // 4 GB on a big Mac really is 4 GB, not the automatic 8.
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 32 * gib, minimum: gib, maximum: 64 * gib, preferredGB: 4), 4 * gib)
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 32 * gib, minimum: gib, maximum: 64 * gib, preferredGB: 16), 16 * gib)
        // Never more than the host minus 4 GB.
        XCTAssertEqual(PrivateMacSpec.memoryBytes(host: 16 * gib, minimum: gib, maximum: 64 * gib, preferredGB: 16), 12 * gib)
        XCTAssertEqual(PrivateMacSpec.memoryChoicesGB(host: 16 * gib), [4, 6, 8, 12])
        XCTAssertEqual(PrivateMacSpec.memoryChoicesGB(host: 8 * gib), [4])
    }

    func testDisplayIsRetinaAtTheModelFriendlySize() {
        XCTAssertEqual(PrivateMacSpec.displayPointWidth, 1440)
        XCTAssertEqual(PrivateMacSpec.displayPointHeight, 900)
    }

    func testFilesLiveTogetherUnderApplicationSupport() {
        let folder = PrivateMacSpec.directory
        XCTAssertEqual(folder.path, AppPaths.support("PrivateMac", isDirectory: true).path)
        for url in [PrivateMacSpec.restoreImageURL, PrivateMacSpec.diskImageURL, PrivateMacSpec.auxiliaryStorageURL,
                    PrivateMacSpec.hardwareModelURL, PrivateMacSpec.machineIdentifierURL, PrivateMacSpec.installedMarkerURL] {
            XCTAssertEqual(url.deletingLastPathComponent().path, folder.path)
        }
    }

    func testComputerTargetSettingDecodesAndFallsBack() throws {
        let decoder = JSONDecoder()
        let vm = try decoder.decode(AppSettings.self, from: Data(#"{"computerTarget":"vm"}"#.utf8))
        XCTAssertEqual(vm.computerTarget, "vm")
        let missing = try decoder.decode(AppSettings.self, from: Data("{}".utf8))
        XCTAssertEqual(missing.computerTarget, "mac")
        let junk = try decoder.decode(AppSettings.self, from: Data(#"{"computerTarget":"toaster"}"#.utf8))
        XCTAssertEqual(junk.computerTarget, "mac")
    }
}
