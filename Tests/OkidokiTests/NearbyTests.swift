import XCTest
@testable import OkidokiCore

final class NearbyTests: XCTestCase {
    func testAWellFormedRecordBecomesAnInvite() {
        let invite = NearbyService.parse(org: "org_1", name: "Acme", code: " ab12cd ", device: "Jay's MacBook")
        XCTAssertEqual(invite?.orgName, "Acme")
        XCTAssertEqual(invite?.code, "AB12CD")
        XCTAssertEqual(invite?.device, "Jay's MacBook")
        XCTAssertEqual(NearbyService.parse(org: "o", name: "Acme", code: "AB12CD", device: "")?.device, "a Mac")
    }

    func testOddRecordsAreIgnored() {
        XCTAssertNil(NearbyService.parse(org: "", name: "Acme", code: "AB12CD", device: "m"))
        XCTAssertNil(NearbyService.parse(org: "o", name: "", code: "AB12CD", device: "m"))
        XCTAssertNil(NearbyService.parse(org: "o", name: "Acme", code: "AB-12", device: "m"))
        XCTAssertNil(NearbyService.parse(org: "o", name: "Acme", code: "<script>", device: "m"))
        XCTAssertNil(NearbyService.parse(org: String(repeating: "x", count: 65), name: "Acme", code: "AB12CD", device: "m"))
    }

    @MainActor
    func testAdvertisingShowsUpAsTheOwnRecordAndStops() {
        let nearby = NearbyService()
        nearby.advertise(orgID: "org_1", orgName: "Acme", code: "AB12CD", device: "Test Mac")
        XCTAssertEqual(nearby.advertising?.code, "AB12CD")
        nearby.advertise(orgID: "org_1", orgName: "Acme", code: "nope!", device: "Test Mac")
        XCTAssertEqual(nearby.advertising?.code, "AB12CD", "a bad code leaves the current invitation alone")
        nearby.stopAdvertising()
        XCTAssertNil(nearby.advertising)
    }
}
