import Foundation

/// How Claude resizes an image before it looks at it. Coordinates the model returns are in the
/// resized image, so a screenshot has to be sent at exactly this size for rings to land.
/// Mirrors the reference implementation in Anthropic's vision docs.
public struct ImageFit: Equatable, Sendable {
    public var maxEdge: Int
    public var maxTokens: Int

    /// Claude 4.7 and later: 2576px long edge, 4784 visual tokens.
    public static let highResolution = ImageFit(maxEdge: 2576, maxTokens: 4784)
    /// Everything earlier: 1568px long edge, 1568 visual tokens.
    public static let standard = ImageFit(maxEdge: 1568, maxTokens: 1568)

    public init(maxEdge: Int, maxTokens: Int) {
        self.maxEdge = maxEdge
        self.maxTokens = maxTokens
    }

    /// The tier for a model id. Haiku/Sonnet/Opus 4.7+ and 5.x are high resolution.
    public static func tier(for model: String) -> ImageFit {
        let lower = model.lowercased()
        guard let range = lower.range(of: #"(\d+)[-.](\d+)"#, options: .regularExpression) else {
            return .standard
        }
        let digits = lower[range].split { $0 == "-" || $0 == "." }.compactMap { Int($0) }
        guard digits.count == 2 else { return .standard }
        let (major, minor) = (digits[0], digits[1])
        if major > 4 || (major == 4 && minor >= 7) { return .highResolution }
        return .standard
    }

    public static func tokens(width: Int, height: Int) -> Int {
        Int((Double(width) / 28).rounded(.up)) * Int((Double(height) / 28).rounded(.up))
    }

    public func fits(width: Int, height: Int) -> Bool {
        let paddedW = Int((Double(width) / 28).rounded(.up)) * 28
        let paddedH = Int((Double(height) / 28).rounded(.up)) * 28
        return paddedW <= maxEdge && paddedH <= maxEdge && Self.tokens(width: width, height: height) <= maxTokens
    }

    /// The size Claude would resize `width`×`height` to. Unchanged when it already fits.
    public func resized(width: Int, height: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (max(1, width), max(1, height)) }
        if fits(width: width, height: height) { return (width, height) }
        if height > width {
            let swapped = resized(width: height, height: width)
            return (swapped.height, swapped.width)
        }
        let aspect = Double(width) / Double(height)
        var lo = 1
        var hi = width
        while lo + 1 < hi {
            let mid = (lo + hi) / 2
            if fits(width: mid, height: max(1, Self.roundHalfEven(Double(mid) / aspect))) {
                lo = mid
            } else {
                hi = mid
            }
        }
        return (lo, max(1, Self.roundHalfEven(Double(lo) / aspect)))
    }

    /// Cap the long edge below the tier limit to save tokens and time; still a size Claude keeps as is.
    public func resized(width: Int, height: Int, longEdgeCap: Int) -> (width: Int, height: Int) {
        let capped = Self(maxEdge: min(maxEdge, longEdgeCap), maxTokens: maxTokens)
        return capped.resized(width: width, height: height)
    }

    /// Python's round(): ties go to the even neighbour, which is what the API does.
    static func roundHalfEven(_ value: Double) -> Int {
        let floor = value.rounded(.down)
        if value - floor == 0.5 {
            return Int(floor).isMultiple(of: 2) ? Int(floor) : Int(floor) + 1
        }
        return Int(value.rounded())
    }
}
