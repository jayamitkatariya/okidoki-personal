import Foundation

/// ISO 8601 dates with fractional seconds, for the state file: two edits a moment apart stay apart.
public enum ISODates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func string(from date: Date) -> String { fractional.string(from: date) }

    public static func date(from text: String) -> Date? { fractional.date(from: text) ?? whole.date(from: text) }

    public static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(string(from: date))
        }
        return encoder
    }

    public static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer()
            if let seconds = try? value.decode(Double.self) { return Date(timeIntervalSinceReferenceDate: seconds) }
            let text = try value.decode(String.self)
            if let parsed = date(from: text) { return parsed }
            throw DecodingError.dataCorruptedError(in: value, debugDescription: "not an ISO 8601 date: \(text)")
        }
        return decoder
    }
}
