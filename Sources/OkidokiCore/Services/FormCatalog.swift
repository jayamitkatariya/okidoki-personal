import Foundation

/// Official forms okidoki can fetch without searching: the agency's own current PDF. Anything not
/// here is searched for on the web.
public struct CatalogForm: Equatable, Sendable {
    public var id: String
    /// "CBP Form 3461"
    public var title: String
    /// "Entry/Immediate Delivery"
    public var subtitle: String
    public var issuer: String
    public var url: URL
    /// Normalized phrases that name it ("3461", "entry immediate delivery").
    public var aliases: [String]

    /// The name it gets in the vault.
    public var fileName: String {
        let sub = subtitle.replacingOccurrences(of: "/", with: "-")
        return "\(title) (\(sub)).pdf"
    }
}

public enum FormCatalog {
    private static func cbp(_ number: String, _ subtitle: String, _ path: String, _ aliases: [String]) -> CatalogForm {
        CatalogForm(id: "cbp-\(number.lowercased())", title: "CBP Form \(number)", subtitle: subtitle, issuer: "cbp.gov",
                    url: URL(string: "https://www.cbp.gov/sites/default/files/\(path)")!,
                    aliases: ["cbp form \(number.lowercased())", "cbp \(number.lowercased())", "cf \(number.lowercased())", "cf-\(number.lowercased())", "form \(number.lowercased())"] + aliases)
    }

    public static let all: [CatalogForm] = [
        cbp("7501", "Entry Summary", "2026-02/cbp_form_7501.pdf", ["7501", "entry summary"]),
        cbp("3461", "Entry/Immediate Delivery", "2025-01/cbp_form_3461.pdf", ["3461", "entry immediate delivery", "immediate delivery"]),
        cbp("7512", "Transportation Entry and Manifest of Goods", "2025-06/cbp_form_7512.pdf", ["7512", "in-bond", "in bond", "transportation entry"]),
        cbp("5106", "Create/Update Importer Identity", "2026-06/cbp_form_5106.pdf", ["5106", "importer identity", "importer id form"]),
        cbp("301", "Customs Bond", "2024-05/cbp_form_301.pdf", ["customs bond", "bond form"]),
        cbp("28", "Request for Information", "2025-05/cbp_form_28.pdf", ["request for information"]),
        cbp("19", "Protest", "2024-05/cbp_form_19.pdf", ["protest form"]),
        cbp("4455", "Certificate of Registration", "2025-06/cbp_form_4455.pdf", ["4455", "certificate of registration"]),
        cbp("434", "NAFTA Certificate of Origin", "2025-05/CBP_Form_434.pdf", ["nafta certificate", "nafta certificate of origin"]),
        CatalogForm(id: "cbsa-ci1", title: "CBSA CI1", subtitle: "Canada Customs Invoice", issuer: "cbsa-asfc.gc.ca",
                    url: URL(string: "https://www.cbsa-asfc.gc.ca/publications/forms-formulaires/ci1.pdf")!,
                    aliases: ["ci1", "ci 1", "canada customs invoice", "canadian customs invoice"]),
        CatalogForm(id: "cbsa-bsf945", title: "CBSA BSF945", subtitle: "Exception CAD Adjustment", issuer: "cbsa-asfc.gc.ca",
                    url: URL(string: "https://www.cbsa-asfc.gc.ca/publications/forms-formulaires/bsf945.pdf")!,
                    aliases: ["bsf945", "bsf 945"]),
    ]

    /// The form a request names, preferring the longest matching alias ("cbp form 28" over "28").
    public static func match(_ text: String) -> CatalogForm? {
        let t = " " + text.lowercased()
            .replacingOccurrences(of: "[^a-z0-9/ -]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression) + " "
        var best: (CatalogForm, Int)?
        for form in all {
            for alias in form.aliases {
                let a = alias.replacingOccurrences(of: "/", with: " ")
                guard t.contains(" \(a) ") else { continue }
                if best == nil || a.count > best!.1 { best = (form, a.count) }
            }
        }
        return best?.0
    }
}
