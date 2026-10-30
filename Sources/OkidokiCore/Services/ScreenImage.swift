import AppKit
import CoreGraphics
import Foundation
import Vision
import CoreText

/// Pixel work on screen captures: scaling, crops, numbered markers, the icon snap and a settle hash.
/// Everything here is pure CoreGraphics and safe to call from a detached task.
public enum ScreenImage {
    public static func png(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }

    public static func scaled(_ image: CGImage, to size: (width: Int, height: Int)) -> CGImage? {
        guard size.width > 0, size.height > 0 else { return nil }
        if image.width == size.width, image.height == size.height { return image }
        guard let context = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return context.makeImage()
    }

    public static func crop(_ image: CGImage, to rect: CGRect) -> CGImage? {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let clipped = rect.integral.intersection(bounds)
        guard clipped.width > 4, clipped.height > 4 else { return nil }
        return image.cropping(to: clipped)
    }

    // MARK: Numbered markers

    public struct Marker {
        public var id: Int
        /// In pixels of the image being drawn on, origin top-left.
        public var rect: CGRect
        public init(id: Int, rect: CGRect) { self.id = id; self.rect = rect }
    }

    /// Draws a small numbered tag at the top-left of every element so the model can answer with
    /// a number instead of guessing pixels. The learner never sees this copy.
    public static func drawMarkers(on image: CGImage, markers: [Marker]) -> CGImage? {
        guard !markers.isEmpty else { return image }
        let width = image.width
        let height = image.height
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        // Flip to a top-left origin for the tags.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        let scale = max(1, CGFloat(width) / 1400)
        let fontSize = 11 * scale
        let font = NSFont.boldSystemFont(ofSize: fontSize)
        let tagColor = CGColor(red: 1.0, green: 0.27, blue: 0.62, alpha: 0.92)
        let outline = CGColor(red: 1.0, green: 0.27, blue: 0.62, alpha: 0.75)
        for marker in markers {
            let rect = marker.rect
            context.setStrokeColor(outline)
            context.setLineWidth(1 * scale)
            context.stroke(rect.insetBy(dx: -1, dy: -1))
            let text = "\(marker.id)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
            let size = text.size(withAttributes: attributes)
            let padX = 3 * scale
            let tag = CGRect(x: rect.minX, y: rect.minY - size.height - 2 * scale,
                             width: size.width + padX * 2, height: size.height + 1 * scale)
            let placed = tag.minY < 0 ? tag.offsetBy(dx: 0, dy: size.height + 3 * scale) : tag
            let path = CGPath(roundedRect: placed, cornerWidth: 3 * scale, cornerHeight: 3 * scale, transform: nil)
            context.setFillColor(tagColor)
            context.addPath(path)
            context.fillPath()
            // CoreText draws with a bottom-left origin; flip back around the tag for the glyphs.
            context.saveGState()
            context.translateBy(x: placed.minX + padX, y: placed.maxY - 1.5 * scale)
            context.scaleBy(x: 1, y: -1)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text as String, attributes: attributes))
            context.textPosition = CGPoint(x: 0, y: font.descender.magnitude)
            CTLineDraw(line, context)
            context.restoreGState()
        }
        return context.makeImage()
    }

    // MARK: Icon snap

    /// Finds the pixels that stand out from the background around `point` and returns their
    /// bounding box: a free, local way to hug an icon when accessibility has nothing to say.
    /// `point` and the result are in image pixels, origin top-left.
    public static func iconSnap(in image: CGImage, around point: CGPoint, maxSize: CGFloat = 96) -> CGRect? {
        let half = maxSize / 2
        let region = CGRect(x: point.x - half, y: point.y - half, width: maxSize, height: maxSize)
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height)).integral
        guard region.width > 8, region.height > 8, let crop = image.cropping(to: region) else { return nil }
        let w = crop.width
        let h = crop.height
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = context.data else { return nil }
        let pixels = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
        func luma(_ x: Int, _ y: Int) -> Int {
            let i = (y * w + x) * 4
            return (Int(pixels[i]) * 299 + Int(pixels[i + 1]) * 587 + Int(pixels[i + 2]) * 114) / 1000
        }
        // Background: the median luma of the border ring.
        var border: [Int] = []
        for x in 0..<w { border.append(luma(x, 0)); border.append(luma(x, h - 1)) }
        for y in 0..<h { border.append(luma(0, y)); border.append(luma(w - 1, y)) }
        border.sort()
        let background = border[border.count / 2]
        let threshold = 38
        func foreground(_ x: Int, _ y: Int) -> Bool { abs(luma(x, y) - background) > threshold }

        // Flood fill from the centre over foreground pixels, allowing 2px gaps so glyph strokes join.
        let cx = Int(point.x - region.minX)
        let cy = Int(point.y - region.minY)
        var seeds: [(Int, Int)] = []
        for dy in -4...4 { for dx in -4...4 {
            let x = cx + dx, y = cy + dy
            if x >= 0, y >= 0, x < w, y < h, foreground(x, y) { seeds.append((x, y)) }
        } }
        guard !seeds.isEmpty else { return nil }
        var visited = [Bool](repeating: false, count: w * h)
        var stack = seeds
        var minX = w, minY = h, maxX = 0, maxY = 0
        var count = 0
        while let (x, y) = stack.popLast() {
            if x < 0 || y < 0 || x >= w || y >= h || visited[y * w + x] { continue }
            visited[y * w + x] = true
            guard foreground(x, y) else { continue }
            count += 1
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            for dy in -2...2 { for dx in -2...2 where dx != 0 || dy != 0 { stack.append((x + dx, y + dy)) } }
        }
        guard count > 12 else { return nil }
        let box = CGRect(x: CGFloat(minX), y: CGFloat(minY), width: CGFloat(maxX - minX + 1), height: CGFloat(maxY - minY + 1))
        // Touching the crop edge means the thing is bigger than an icon; let the model's box stand.
        guard box.minX > 1, box.minY > 1, box.maxX < CGFloat(w) - 1, box.maxY < CGFloat(h) - 1 else { return nil }
        guard box.width >= 6, box.height >= 6 else { return nil }
        return box.offsetBy(dx: region.minX, dy: region.minY)
    }

    // MARK: Settle hash

    /// A 16×16 average hash. Two frames with a small Hamming distance mean the screen has settled.
    public static func settleHash(_ image: CGImage) -> UInt64 {
        guard let tiny = scaled(image, to: (16, 16)),
              let context = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
        context.draw(tiny, in: CGRect(x: 0, y: 0, width: 16, height: 16))
        guard let data = context.data else { return 0 }
        let p = data.bindMemory(to: UInt8.self, capacity: 16 * 16 * 4)
        var lumas = [Int](repeating: 0, count: 256)
        var total = 0
        for i in 0..<256 {
            let v = (Int(p[i * 4]) * 299 + Int(p[i * 4 + 1]) * 587 + Int(p[i * 4 + 2]) * 114) / 1000
            lumas[i] = v
            total += v
        }
        let mean = total / 256
        var hash: UInt64 = 0
        // 256 cells into 64 bits: 2×2 blocks vote.
        for by in 0..<8 { for bx in 0..<8 {
            let sum = lumas[(by * 2) * 16 + bx * 2] + lumas[(by * 2) * 16 + bx * 2 + 1]
                + lumas[(by * 2 + 1) * 16 + bx * 2] + lumas[(by * 2 + 1) * 16 + bx * 2 + 1]
            if sum / 4 > mean { hash |= 1 << UInt64(by * 8 + bx) }
        } }
        return hash
    }

    public static func hammingDistance(_ a: UInt64, _ b: UInt64) -> Int {
        (a ^ b).nonzeroBitCount
    }

    // MARK: OCR

    public struct Word: Sendable {
        public var text: String
        /// Image pixels, origin top-left.
        public var rect: CGRect
    }

    /// On-device text recognition so apps without accessibility still have exact text targets.
    public static func recognizeText(in image: CGImage, fast: Bool = true) async -> [Word] {
        await withCheckedContinuation { continuation in
            // Vision may call the completion with an error and then throw from perform(); resume once.
            var resumed = false
            let request = VNRecognizeTextRequest { request, _ in
                guard !resumed else { return }
                resumed = true
                let width = CGFloat(image.width)
                let height = CGFloat(image.height)
                let words: [Word] = (request.results as? [VNRecognizedTextObservation] ?? []).compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first,
                          candidate.confidence > 0.3 else { return nil }
                    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard text.count >= 2, text.count <= 48 else { return nil }
                    let box = observation.boundingBox
                    let rect = CGRect(x: box.minX * width, y: (1 - box.maxY) * height,
                                      width: box.width * width, height: box.height * height)
                    return Word(text: text, rect: rect)
                }
                continuation.resume(returning: words)
            }
            request.recognitionLevel = fast ? .fast : .accurate
            request.usesLanguageCorrection = false
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do {
                try handler.perform([request])
            } catch {
                if !resumed {
                    resumed = true
                    continuation.resume(returning: [])
                }
            }
        }
    }
}
