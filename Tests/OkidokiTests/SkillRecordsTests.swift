import XCTest
@testable import OkidokiCore

final class ParameterFillTests: XCTestCase {
    func testFillsLooselyNamedPlaceholdersAndReportsMissingOnes() {
        let values = ["importer_name": "Lakeshore Electronics Inc.", "hts": "8471.30.0100"]
        XCTAssertEqual(ParameterFill.fill("{{ Importer Name }} · {{HTS}}", values: values).text, "Lakeshore Electronics Inc. · 8471.30.0100")
        let partial = ParameterFill.fill("{{hts}} {{value}} {{value}}", values: values)
        XCTAssertEqual(partial.text, "8471.30.0100 {{value}} {{value}}")
        XCTAssertEqual(partial.missing, ["value"])
        XCTAssertEqual(ParameterFill.fill("no placeholders", values: [:]).text, "no placeholders")
        XCTAssertEqual(ParameterFill.fill("{{spi}}", values: ["spi": ""]).text, "")
    }

    func testNamesComeFromTypedStepsOnlyInOrder() {
        let steps = [
            SkillStep(text: "type {{ref}}", app: "Safari", action: "type", input: "{{ref}}"),
            SkillStep(text: "click {{nope}}", app: "Safari", action: "click", label: "{{nope}}"),
            SkillStep(text: "type", app: "Safari", action: "type", input: "{{portal}}/ace/entry {{Ref}}"),
        ]
        XCTAssertEqual(ParameterFill.names(in: steps), ["ref", "portal"])
    }

    func testOverridesAndBuiltins() {
        XCTAssertEqual(ParameterFill.overrides(in: "replay file ace entry with value=52000, importer=\"Acme Inc\" spi=S"),
                       ["value": "52000", "importer": "Acme Inc", "spi": "S"])
        let builtins = ParameterFill.builtins(now: Date(timeIntervalSince1970: 1_792_900_000))
        XCTAssertNil(builtins["portal"])
        XCTAssertNotNil(builtins["today"]?.range(of: #"^\d{2}/\d{2}/\d{4}$"#, options: .regularExpression))
    }

    func testKeyboardStepsKeepTheirOwnPace() {
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", action: "type", delay: 0.05)), 0.2)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", action: "key", input: "tab", delay: 0.3)), 0.3)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", action: "click", label: "Go", delay: 0.05)), 0.45)
    }

    func testRecordsFileTakesABookOrABareList() {
        let book = #"{"records":[{"id":"MTS-4471","title":"laptops","skill":"file ACE entry","values":{"hts":"8471.30.0100"}}]}"#
        XCTAssertEqual(SkillRecords.decode(Data(book.utf8)).first?.values["hts"], "8471.30.0100")
        XCTAssertEqual(SkillRecords.decode(Data(#"[{"id":"A-1","title":"","skill":"","values":{}}]"#.utf8)).map(\.id), ["A-1"])
        XCTAssertEqual(SkillRecords.decode(Data("nonsense".utf8)), [])
        XCTAssertEqual(SkillRecord(id: "MTS-4471").fillValues["ref"], "MTS-4471")
    }
}

final class RecordCommandTests: XCTestCase {
    private let skills = [
        Skill(id: "ace", accountID: "a", name: "file ACE entry", summary: "7501 in the workbench", source: "taught"),
        Skill(id: "ace-shared", accountID: "a", name: "file ACE entry", summary: "shared", source: "shared:xyz"),
        Skill(id: "wa", accountID: "a", name: "message chaitanya", summary: "WhatsApp"),
    ]
    private let records = ["MTS-4471", "MTS-4472", "MTS-4473"].map { SkillRecord(id: $0, title: $0, skill: "file ACE entry") }
    private var context: ChatCommands.Context { .init(skills: skills, records: records) }
    private func parse(_ text: String) -> ChatCommand? { ChatCommands.parse(text, context: context) }

    func testFilingOneRecordUsesItsSkill() {
        XCTAssertEqual(parse("file the entry for MTS-4471"), .replayRecords(skillID: "ace", recordIDs: ["MTS-4471"], values: [:]))
        XCTAssertEqual(parse("Please file MTS 4472."), .replayRecords(skillID: "ace", recordIDs: ["MTS-4472"], values: [:]))
        XCTAssertEqual(parse("replay file ACE entry for mts4473"), .replayRecords(skillID: "ace", recordIDs: ["MTS-4473"], values: [:]))
    }

    func testSeveralRecordsInTheOrderAskedAndAll() {
        XCTAssertEqual(parse("file entries for MTS-4473, MTS-4471 and MTS-4472"),
                       .replayRecords(skillID: "ace", recordIDs: ["MTS-4473", "MTS-4471", "MTS-4472"], values: [:]))
        XCTAssertEqual(parse("file all pending entries"), .replayRecords(skillID: "ace", recordIDs: ["MTS-4471", "MTS-4472", "MTS-4473"], values: [:]))
    }

    func testOverridesRideAlong() {
        XCTAssertEqual(parse("file the entry for MTS-4471 with value=150000"),
                       .replayRecords(skillID: "ace", recordIDs: ["MTS-4471"], values: ["value": "150000"]))
        XCTAssertEqual(parse("replay file ace entry with ref=TEST-1 hts=8517.13.0000"),
                       .replayRecords(skillID: "ace", recordIDs: [], values: ["ref": "TEST-1", "hts": "8517.13.0000"]))
    }

    func testEverythingElseIsLeftAlone() {
        XCTAssertEqual(parse("file the entry for MTS-9999"), .unknownRecord(query: "MTS-9999"))
        XCTAssertNil(parse("file all my taxes"))
        XCTAssertNil(parse("do all my emails"))
        XCTAssertEqual(parse("replay message chaitanya"), .replay(skillID: "wa", times: 1))
        XCTAssertNil(ChatCommands.parse("file the entry for MTS-4471", context: .init(skills: skills)), "no records file, no hijack")
    }
}

final class VaultCommandTests: XCTestCase {
    private func parse(_ text: String) -> ChatCommand? { ChatCommands.parse(text, context: .init(skills: [])) }

    func testAddingADocumentByNameOrLink() {
        XCTAssertEqual(parse("add the W-9 form to the vault"), .addToVault(query: "w-9 form", url: nil, folder: ""))
        XCTAssertEqual(parse("find the irs form 1040 and put it in the taxes vault"),
                       .addToVault(query: "irs form 1040", url: nil, folder: "taxes"))
        XCTAssertEqual(parse("grab the lease template and add it to the vault for #home"),
                       .addToVault(query: "lease template", url: nil, folder: "home"))
        XCTAssertEqual(parse("can you download the latest form 8843 into our vault?"), .addToVault(query: "form 8843", url: nil, folder: ""))
        XCTAssertEqual(parse("save https://example.com/files/form-19.pdf to the vault"),
                       .addToVault(query: "", url: "https://example.com/files/form-19.pdf", folder: ""))
    }

    func testLookingInTheVaultIsNotAdding() {
        XCTAssertNil(parse("find the commercial invoice for INV-4471 in the vault"))
        XCTAssertNil(parse("what's in the vault"))
        XCTAssertNil(parse("open the vault"))
    }
}

final class SharedSkillImportTests: XCTestCase {
    @MainActor
    func testThePublishingMacKeepsItsOwnCopy() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-tests-\(UUID().uuidString)").appendingPathComponent("state.json")
        let store = OkidokiStore(seedDemo: false, stateURL: url)
        let steps = [SkillStep(text: "in Safari, type “{{ref}}”", app: "Safari", action: "type", input: "{{ref}}")]
        let own = store.createSkill(name: "file ACE entry", summary: "mine", steps: steps, source: "taught")
        let json = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(steps))
        XCTAssertEqual(store.importSkill(sharedID: "org-1", name: "file ACE entry", summary: "", stepsJSON: json, version: 1)?.id, own.id)
        XCTAssertEqual(store.activeSkills.count, 1)
        // A colleague's different version of the same name still comes in as its own skill.
        let theirs = [SkillStep(text: "in Safari, type “{{ref}}”", app: "Safari", action: "type", input: "{{ref}} ")]
        let other = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(theirs))
        XCTAssertNotEqual(store.importSkill(sharedID: "org-2", name: "file ACE entry", summary: "", stepsJSON: other, version: 1)?.id, own.id)
    }
}
