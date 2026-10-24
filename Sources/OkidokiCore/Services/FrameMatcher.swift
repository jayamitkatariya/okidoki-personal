import Accelerate
import CoreGraphics
import Foundation

/// Finds where a small recorded crop appears in a fresh screenshot, by normalized cross-correlation
/// on grayscale. A coarse pass over the whole screen picks a few candidates; each is refined at
/// working resolution. Pure CPU through vDSP: a 220×140 pt crop on a laptop display takes well
/// under a quarter of a second, with no model involved.
public enum FrameMatcher {
    public struct Match: Equatable, Sendable {
        /// Centre of the template in haystack pixels.
        public var center: CGPoint
        /// Brightness correlation, 0…1.
        public var score: Double
        /// Edge correlation, 0…1: text and outlines, not fills.
        public var edge: Double
        /// The weakest parts of the crop, 0…1: the crop in a 3×3 grid, each cell correlated on its
        /// own, second-lowest cell. A look-alike with a different name fails here even when the
        /// whole-crop numbers look fine, and one changed cell (a badge, a caret) is forgiven.
        public var detail: Double
        public init(center: CGPoint, score: Double, edge: Double = 1, detail: Double = 1) {
            self.center = center; self.score = score; self.edge = edge; self.detail = detail
        }
    }

    /// What a match has to reach to be trusted. Measured on real screens: the same control
    /// scores edge 0.97+ and detail 0.9+; a neighbour with the same icon and a different name
    /// reaches edge 0.84 and detail under 0.6.
    public static let minScore = 0.8
    public static let minEdgeScore = 0.9
    public static let minDetailScore = 0.8

    struct Gray {
        var data: [Float]
        var width: Int
        var height: Int
        subscript(_ x: Int, _ y: Int) -> Float { data[y * width + x] }
    }

    /// Template long edge in the coarse pass. Small enough that the pass is cheap, big enough
    /// that a toolbar button still has a shape.
    static let coarseEdge = 40.0
    /// Template long edge in the middle pass.
    static let midEdge = 120.0

    /// `near` (haystack pixels) breaks ties between equally good matches, so the row nearest to
    /// where the control used to be wins over an identical one elsewhere.
    ///
    /// Candidates come from plain brightness correlation, but they are ranked by correlation of
    /// edges: a list of look-alike rows (same icon, different name) differs only in a little
    /// text, which is most of the edge energy and almost none of the brightness energy.
    ///
    /// Only the middle `focus` of the crop is compared: the control is at the centre, and what
    /// surrounds it (the next row, the next icon) is the part most likely to have changed.
    ///
    /// `anchor` is the point of interest in template pixels (the recorded click); the middle of
    /// the crop when nil. The match's `center` is where that point is in the haystack.
    public static func find(template whole: CGImage, in haystack: CGImage, near: CGPoint? = nil, anchor: CGPoint? = nil,
                            minScore: Double = FrameMatcher.minScore, minEdgeScore: Double = FrameMatcher.minEdgeScore,
                            minDetailScore: Double = FrameMatcher.minDetailScore, focus: Double = 0.6) -> Match? {
        let scored = rank(template: whole, in: haystack, focus: focus, anchor: anchor)
            .filter { $0.score >= minScore && $0.edge >= minEdgeScore && $0.detail >= minDetailScore }
        guard let top = scored.first else { return nil }
        guard let near else { return top }
        let close = scored.filter { $0.edge >= top.edge - 0.03 }
        return close.min { hypot($0.center.x - near.x, $0.center.y - near.y) < hypot($1.center.x - near.x, $1.center.y - near.y) }
    }

    /// Every candidate spot with its scores, best edge first. Thresholds are the caller's
    /// business; this is what `find` chooses from.
    static func rank(template whole: CGImage, in haystack: CGImage, focus: Double, anchor: CGPoint? = nil) -> [Match] {
        let wanted = anchor ?? CGPoint(x: Double(whole.width) / 2, y: Double(whole.height) / 2)
        guard let focused = centre(of: whole, fraction: focus, around: wanted) else { return [] }
        let template = focused.image
        // Where the anchor sits relative to the focused crop's centre, carried onto each match.
        let lead = CGPoint(x: wanted.x - focused.rect.midX, y: wanted.y - focused.rect.midY)
        guard template.width >= 8, template.height >= 8,
              haystack.width >= template.width, haystack.height >= template.height else { return [] }
        let coarseScale = min(1, coarseEdge / Double(max(template.width, template.height)))
        guard let coarseT = gray(template, scale: coarseScale), let coarseH = gray(haystack, scale: coarseScale),
              coarseT.width >= 3, coarseT.height >= 3 else { return [] }
        let coarseMap = nccMap(haystack: coarseH, template: coarseT)
        let candidates = peaks(in: coarseMap, width: coarseH.width, height: coarseH.height,
                               suppress: max(coarseT.width, coarseT.height) / 2, limit: 8, floor: 0.45)
        guard !candidates.isEmpty else { return [] }

        // Middle pass: narrows each candidate down cheaply. Final pass: native pixels, no
        // resampling, so a true match scores as itself and a look-alike row doesn't tie with it.
        let midScale = min(1, midEdge / Double(max(template.width, template.height)))
        guard let midT = gray(template, scale: midScale), let midH = gray(haystack, scale: midScale),
              let fullT = gray(template, scale: 1), let fullH = gray(haystack, scale: 1) else { return [] }
        let normalizedMid = zeroMean(midT)
        let normalizedFull = zeroMean(fullT)
        guard normalizedFull.norm > 1e-3 else { return [] } // a flat crop matches everything and nothing
        let edgesH = edges(fullH)
        let edgesT = zeroMean(edges(fullT))
        guard edgesT.norm > 1e-3 else { return [] }
        // Each pass is accurate to about one pixel of the pass before it.
        let midRadius = Int((midScale / coarseScale).rounded(.up)) + 2
        let fullRadius = Int((1 / midScale).rounded(.up)) + 1
        var scored: [Match] = []
        for candidate in candidates {
            let mx = Int((Double(candidate.x) * midScale / coarseScale).rounded())
            let my = Int((Double(candidate.y) * midScale / coarseScale).rounded())
            guard let mid = refine(haystack: midH, template: normalizedMid, around: (mx, my), radius: midRadius),
                  mid.score >= 0.5 else { continue }
            let fx = Int((Double(mid.x) / midScale).rounded())
            let fy = Int((Double(mid.y) / midScale).rounded())
            guard let full = refine(haystack: fullH, template: normalizedFull, around: (fx, fy), radius: fullRadius),
                  full.score >= 0.5 else { continue }
            // Edges are compared at the refined spot, give or take a pixel of text anti-aliasing.
            guard let edge = refine(haystack: edgesH, template: edgesT, around: (full.x, full.y), radius: 1),
                  edge.score >= 0.3 else { continue }
            let detail = cellScore(haystack: fullH, template: fullT, at: (edge.x, edge.y))
            scored.append(Match(center: CGPoint(x: Double(edge.x) + lead.x, y: Double(edge.y) + lead.y), score: full.score,
                                edge: edge.score, detail: detail))
        }
        return scored.sorted { $0.edge > $1.edge }
    }

    /// The template against the haystack window centred at a point, one 3×3 cell at a time:
    /// each cell's own normalized correlation, second-lowest of the cells that have anything in
    /// them. 1 when fewer than two cells have detail.
    static func cellScore(haystack: Gray, template: Gray, at center: (x: Int, y: Int), grid: Int = 3) -> Double {
        let tw = template.width
        let th = template.height
        let left = center.x - tw / 2
        let top = center.y - th / 2
        guard left >= 0, top >= 0, left + tw <= haystack.width, top + th <= haystack.height else { return 0 }
        var scores: [Double] = []
        for row in 0..<grid {
            for column in 0..<grid {
                let x0 = column * tw / grid
                let x1 = (column + 1) * tw / grid
                let y0 = row * th / grid
                let y1 = (row + 1) * th / grid
                let cw = x1 - x0
                let ch = y1 - y0
                guard cw >= 4, ch >= 4 else { continue }
                var t = [Float](repeating: 0, count: cw * ch)
                var w = [Float](repeating: 0, count: cw * ch)
                for y in 0..<ch {
                    let ts = (y0 + y) * tw + x0
                    let ws = (top + y0 + y) * haystack.width + left + x0
                    t.replaceSubrange((y * cw)..<(y * cw + cw), with: template.data[ts..<(ts + cw)])
                    w.replaceSubrange((y * cw)..<(y * cw + cw), with: haystack.data[ws..<(ws + cw)])
                }
                let n = Float(cw * ch)
                var tSum: Float = 0, tSq: Float = 0, wSum: Float = 0, wSq: Float = 0, cross: Float = 0
                vDSP_sve(t, 1, &tSum, vDSP_Length(t.count))
                vDSP_svesq(t, 1, &tSq, vDSP_Length(t.count))
                vDSP_sve(w, 1, &wSum, vDSP_Length(w.count))
                vDSP_svesq(w, 1, &wSq, vDSP_Length(w.count))
                vDSP_dotpr(t, 1, w, 1, &cross, vDSP_Length(t.count))
                let tVar = tSq - tSum * tSum / n
                let wVar = wSq - wSum * wSum / n
                // A cell with nothing in it on the recording (flat background) says nothing either way.
                guard tVar > 16 * n else { continue }
                guard wVar > 4 * n else { scores.append(0); continue }
                scores.append(Double((cross - tSum * wSum / n) / (tVar.squareRoot() * wVar.squareRoot())))
            }
        }
        scores.sort()
        guard scores.count >= 2 else { return scores.first ?? 1 }
        return scores[1]
    }

    /// A `fraction`-sized part of a crop around a point, kept inside the crop. Odd dimensions,
    /// so the part has a centre pixel.
    static func centre(of image: CGImage, fraction: Double, around point: CGPoint) -> (image: CGImage, rect: CGRect)? {
        let f = min(max(fraction, 0.1), 1)
        let w = min(image.width, max(8, Int((Double(image.width) * f).rounded(.down)) | 1))
        let h = min(image.height, max(8, Int((Double(image.height) * f).rounded(.down)) | 1))
        var x = Int((point.x - Double(w) / 2).rounded())
        var y = Int((point.y - Double(h) / 2).rounded())
        x = min(max(x, 0), image.width - w)
        y = min(max(y, 0), image.height - h)
        let rect = CGRect(x: x, y: y, width: w, height: h)
        guard let part = image.cropping(to: rect) else { return nil }
        return (part, rect)
    }

    /// Gradient magnitude (|dx| + |dy|, central differences), same size as the input.
    static func edges(_ gray: Gray) -> Gray {
        let w = gray.width
        let h = gray.height
        var out = [Float](repeating: 0, count: w * h)
        guard w >= 3, h >= 3 else { return Gray(data: out, width: w, height: h) }
        gray.data.withUnsafeBufferPointer { src in
            out.withUnsafeMutableBufferPointer { dst in
                for y in 1..<(h - 1) {
                    let row = y * w
                    for x in 1..<(w - 1) {
                        let i = row + x
                        dst[i] = abs(src[i + 1] - src[i - 1]) + abs(src[i + w] - src[i - w])
                    }
                }
            }
        }
        return Gray(data: out, width: w, height: h)
    }

    // MARK: - Grayscale

    static func gray(_ image: CGImage, scale: Double) -> Gray? {
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let base = context.data else { return nil }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var floats = [Float](repeating: 0, count: width * height)
        let rowBytes = context.bytesPerRow
        for y in 0..<height {
            vDSP_vfltu8(bytes + y * rowBytes, 1, &floats[y * width], 1, vDSP_Length(width))
        }
        return Gray(data: floats, width: width, height: height)
    }

    struct Template {
        var data: [Float]
        var width: Int
        var height: Int
        var norm: Float
    }

    static func zeroMean(_ gray: Gray) -> Template {
        var mean: Float = 0
        vDSP_meanv(gray.data, 1, &mean, vDSP_Length(gray.data.count))
        var centred = [Float](repeating: 0, count: gray.data.count)
        var negative = -mean
        vDSP_vsadd(gray.data, 1, &negative, &centred, 1, vDSP_Length(gray.data.count))
        var sumSquares: Float = 0
        vDSP_svesq(centred, 1, &sumSquares, vDSP_Length(centred.count))
        return Template(data: centred, width: gray.width, height: gray.height, norm: sumSquares.squareRoot())
    }

    // MARK: - Coarse map

    /// NCC score for the template centred at every pixel of the haystack (edges score 0).
    static func nccMap(haystack: Gray, template: Gray) -> [Float] {
        // vDSP_imgfir needs odd kernel dimensions; drop one row/column when needed.
        let tw = template.width | 1 == template.width ? template.width : template.width - 1
        let th = template.height | 1 == template.height ? template.height : template.height - 1
        var kernelSource = Gray(data: [], width: tw, height: th)
        kernelSource.data.reserveCapacity(tw * th)
        for y in 0..<th { kernelSource.data.append(contentsOf: template.data[(y * template.width)..<(y * template.width + tw)]) }
        let kernel = zeroMean(kernelSource)
        let count = haystack.width * haystack.height
        guard kernel.norm > 1e-3, haystack.width >= tw, haystack.height >= th else { return [Float](repeating: 0, count: count) }
        let n = Float(tw * th)

        var cross = [Float](repeating: 0, count: count)
        vDSP_imgfir(haystack.data, vDSP_Length(haystack.height), vDSP_Length(haystack.width), kernel.data, &cross,
                    vDSP_Length(th), vDSP_Length(tw))
        let ones = [Float](repeating: 1, count: tw * th)
        var sum = [Float](repeating: 0, count: count)
        vDSP_imgfir(haystack.data, vDSP_Length(haystack.height), vDSP_Length(haystack.width), ones, &sum,
                    vDSP_Length(th), vDSP_Length(tw))
        var squared = [Float](repeating: 0, count: count)
        vDSP_vsq(haystack.data, 1, &squared, 1, vDSP_Length(count))
        var sumSquares = [Float](repeating: 0, count: count)
        vDSP_imgfir(squared, vDSP_Length(haystack.height), vDSP_Length(haystack.width), ones, &sumSquares,
                    vDSP_Length(th), vDSP_Length(tw))

        var scores = [Float](repeating: 0, count: count)
        for i in 0..<count {
            let variance = sumSquares[i] - sum[i] * sum[i] / n
            // Flat windows (blank wall) would divide by noise; they can't be the control.
            guard variance > 4 * n else { continue }
            scores[i] = cross[i] / (variance.squareRoot() * kernel.norm)
        }
        return scores
    }

    struct Peak { var x: Int; var y: Int; var score: Float }

    /// Highest-scoring local maxima, at least `suppress` pixels apart.
    static func peaks(in map: [Float], width: Int, height: Int, suppress: Int, limit: Int, floor: Float) -> [Peak] {
        var indexed: [(index: Int, score: Float)] = []
        indexed.reserveCapacity(map.count / 8)
        for (index, score) in map.enumerated() where score >= floor { indexed.append((index, score)) }
        indexed.sort { $0.score > $1.score }
        var picked: [Peak] = []
        for entry in indexed {
            let x = entry.index % width
            let y = entry.index / width
            if picked.contains(where: { abs($0.x - x) <= suppress && abs($0.y - y) <= suppress }) { continue }
            picked.append(Peak(x: x, y: y, score: entry.score))
            if picked.count >= limit { break }
        }
        return picked
    }

    // MARK: - Refine

    /// Direct NCC of the template at every centre within `radius` of a point. Returns the best.
    static func refine(haystack: Gray, template: Template, around center: (x: Int, y: Int), radius: Int) -> (x: Int, y: Int, score: Double)? {
        let tw = template.width
        let th = template.height
        let n = Float(tw * th)
        var best: (x: Int, y: Int, score: Double)?
        var window = [Float](repeating: 0, count: tw * th)
        for cy in (center.y - radius)...(center.y + radius) {
            let top = cy - th / 2
            guard top >= 0, top + th <= haystack.height else { continue }
            for cx in (center.x - radius)...(center.x + radius) {
                let left = cx - tw / 2
                guard left >= 0, left + tw <= haystack.width else { continue }
                for row in 0..<th {
                    let start = (top + row) * haystack.width + left
                    window.replaceSubrange((row * tw)..<(row * tw + tw), with: haystack.data[start..<(start + tw)])
                }
                var sum: Float = 0
                vDSP_sve(window, 1, &sum, vDSP_Length(window.count))
                var sumSquares: Float = 0
                vDSP_svesq(window, 1, &sumSquares, vDSP_Length(window.count))
                let variance = sumSquares - sum * sum / n
                guard variance > 4 * n else { continue }
                var cross: Float = 0
                vDSP_dotpr(window, 1, template.data, 1, &cross, vDSP_Length(window.count))
                let score = Double(cross / (variance.squareRoot() * template.norm))
                if best == nil || score > best!.score { best = (cx, cy, score) }
            }
        }
        return best
    }
}
