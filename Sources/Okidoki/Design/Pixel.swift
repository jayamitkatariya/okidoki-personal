import SwiftUI
import AppKit

struct PixelGlyph: View {
    let name: String
    var size: CGFloat = 16
    var color: Color = .primary

    var body: some View {
        Canvas { context, canvasSize in
            let rows = PixelAtlas.map[name] ?? PixelAtlas.map["spark"]!
            let cell = min(canvasSize.width, canvasSize.height) / 8
            for (rowIndex, row) in rows.enumerated() {
                for (colIndex, character) in row.enumerated() where character == "#" {
                    let rect = CGRect(x: CGFloat(colIndex) * cell,
                                      y: CGFloat(rowIndex) * cell,
                                      width: cell + 0.25,
                                      height: cell + 0.25)
                    context.fill(Path(rect), with: .color(color))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

enum PixelAtlas {
    static let map: [String: [String]] = [
        "spark": [
            "...##...",
            "...##...",
            ".######.",
            "########",
            ".######.",
            "..####..",
            ".##..##.",
            "#......#",
        ],
        "home": [
            "..####..",
            ".######.",
            "########",
            "##....##",
            "##.##.##",
            "##.##.##",
            "##....##",
            "########",
        ],
        "runs": [
            "....##..",
            "...##...",
            "..##....",
            ".######.",
            "...##...",
            "..##....",
            ".##.....",
            "##......",
        ],
        "clock": [
            "..####..",
            ".#....#.",
            "#..#...#",
            "#..#...#",
            "#..###.#",
            "#......#",
            ".#....#.",
            "..####..",
        ],
        "memory": [
            ".##..##.",
            "####.##.",
            "########",
            "###..###",
            "##.##.##",
            "########",
            ".######.",
            "..####..",
        ],
        "wand": [
            "......##",
            ".....###",
            "....##..",
            "...#....",
            "..#..#..",
            ".#..#...",
            "#..#....",
            "..#.....",
        ],
        "grid": [
            "##..##..",
            "##..##..",
            "........",
            "........",
            "##..##..",
            "##..##..",
            "........",
            "........",
        ],
        "key": [
            ".###....",
            "#...#...",
            "#...#...",
            ".###....",
            "..#.....",
            "..###...",
            "..#.....",
            "..#.....",
        ],
        "gear": [
            "..#..#..",
            "########",
            ".##..##.",
            "#..##..#",
            "#..##..#",
            ".##..##.",
            "########",
            "..#..#..",
        ],
        "mic": [
            "..#.....",
            ".###....",
            ".###....",
            ".###....",
            ".###....",
            "..#.....",
            "..###...",
            "...#....",
        ],
        "pencil": [
            "......##",
            ".....##.",
            "....##..",
            "...##...",
            "..##....",
            ".##.....",
            "##......",
            "........",
        ],
        "cursor": [
            "##......",
            "###.....",
            "####....",
            "#####...",
            "######..",
            "###.....",
            "#.#.....",
            "........",
        ],
        "check": [
            "........",
            "......##",
            ".....##.",
            "##..##..",
            ".####...",
            "..##....",
            "........",
            "........",
        ],
        "x": [
            "##....##",
            "###..###",
            ".######.",
            "..####..",
            "..####..",
            ".######.",
            "###..###",
            "##....##",
        ],
        "play": [
            "##......",
            "####....",
            "######..",
            "########",
            "########",
            "######..",
            "####....",
            "##......",
        ],
        "pause": [
            "##..##..",
            "##..##..",
            "##..##..",
            "##..##..",
            "##..##..",
            "##..##..",
            "##..##..",
            "##..##..",
        ],
        "stop": [
            "........",
            ".######.",
            ".######.",
            ".######.",
            ".######.",
            ".######.",
            ".######.",
            "........",
        ],
        "arrow": [
            "........",
            "...#....",
            "...##...",
            "########",
            "########",
            "...##...",
            "...#....",
            "........",
        ],
        "chevron": [
            "........",
            "..#.....",
            "..##....",
            "...##...",
            "...##...",
            "..##....",
            "..#.....",
            "........",
        ],
        "plus": [
            "........",
            "...##...",
            "...##...",
            "########",
            "########",
            "...##...",
            "...##...",
            "........",
        ],
        "search": [
            ".####...",
            "##..##..",
            "#....#..",
            "#....#..",
            "##..##..",
            ".####...",
            "....###.",
            ".....###",
        ],
        "eye": [
            "........",
            "..####..",
            ".#....#.",
            "#..##..#",
            "#..##..#",
            ".#....#.",
            "..####..",
            "........",
        ],
        "bolt": [
            "....###.",
            "...###..",
            "..###...",
            ".#####..",
            "...###..",
            "..###...",
            ".###....",
            "##......",
        ],
        "folder": [
            "........",
            "####....",
            "########",
            "##....##",
            "##....##",
            "##....##",
            "########",
            "........",
        ],
        "terminal": [
            "########",
            "#......#",
            "#.#....#",
            "#..#...#",
            "#.#....#",
            "#......#",
            "########",
            "........",
        ],
        "code": [
            "........",
            "..#..#..",
            ".##..##.",
            "##....##",
            "##....##",
            ".##..##.",
            "..#..#..",
            "........",
        ],
        "screen": [
            "########",
            "#......#",
            "#..##..#",
            "#......#",
            "#......#",
            "########",
            "...##...",
            "..####..",
        ],
        "hand": [
            "..#..#..",
            ".##.##.#",
            "########",
            "########",
            "########",
            ".######.",
            "..####..",
            "........",
        ],
        "lock": [
            "..####..",
            ".##..##.",
            ".##..##.",
            "########",
            "##....##",
            "##.##.##",
            "##....##",
            "########",
        ],
        "moon": [
            "...###..",
            "..###...",
            ".###....",
            ".###....",
            ".###....",
            "..###...",
            "...###..",
            "........",
        ],
        "sun": [
            "#..#..#.",
            "..####..",
            ".######.",
            "########",
            "########",
            ".######.",
            "..####..",
            "#..#..#.",
        ],
        "bell": [
            "...##...",
            "..####..",
            "..####..",
            ".######.",
            ".######.",
            "########",
            "...##...",
            "........",
        ],
        "note": [
            "...####.",
            "...####.",
            "...#..#.",
            "...#..#.",
            "####.##.",
            "####.##.",
            "####.##.",
            "........",
        ],
        "calendar": [
            "##....##",
            "########",
            "#......#",
            "#.####.#",
            "#.#..#.#",
            "#.####.#",
            "#......#",
            "########",
        ],
        "share": [
            "...#....",
            "..###...",
            "...#....",
            "########",
            "...#....",
            "..###...",
            "...#....",
            "........",
        ],
        "refresh": [
            "..####..",
            ".##..##.",
            "##......",
            "##...###",
            "###...##",
            ".##..##.",
            "..####..",
            "........",
        ],
        "trash": [
            "..####..",
            "########",
            ".######.",
            ".#.##.#.",
            ".#.##.#.",
            ".#.##.#.",
            ".######.",
            "........",
        ],
        "copy": [
            "####....",
            "#..#....",
            "#..#....",
            "####....",
            "....####",
            "....#..#",
            "....#..#",
            "....####",
        ],
        "external": [
            "######.#",
            "#....###",
            "#...###.",
            "#..###..",
            "#.####..",
            "#....#..",
            "#....#..",
            "########",
        ],
        "filter": [
            "########",
            "########",
            "..####..",
            "...##...",
            "...##...",
            "...##...",
            "........",
            "........",
        ],
        "edit": [
            "......##",
            ".....##.",
            "....##..",
            "...##...",
            "..##....",
            ".##.....",
            "##......",
            "........",
        ],
        "link": [
            "..####..",
            ".##..##.",
            "##......",
            "##.####.",
            "##.#..#.",
            ".##..##.",
            "..####..",
            "........",
        ],
        "apple": [
            "....#...",
            "...##...",
            "..####..",
            ".######.",
            ".######.",
            "##.##.##",
            ".######.",
            "..####..",
        ],
        "download": [
            "...#....",
            "..###...",
            ".#####..",
            "##.#.##.",
            "...#....",
            "...#....",
            "########",
            "........",
        ],
        "minus": [
            "........",
            "........",
            "........",
            "########",
            "########",
            "........",
            "........",
            "........",
        ],
        "dots": [
            "........",
            "........",
            "##.##.##",
            "........",
            "........",
            "##.##.##",
            "........",
            "........",
        ],
        "wave": [
            "..#.....",
            "..#..#..",
            "..#..#..",
            "#####.##",
            "..#..#..",
            "..#..#..",
            "..#.....",
            "........",
        ],
        "user": [
            "..####..",
            ".######.",
            "..####..",
            ".######.",
            "########",
            "##.##.##",
            "##....##",
            "........",
        ],
        "sticker": [
            "..#####.",
            ".#######",
            "##.####.",
            "#...##..",
            "#..#....",
            "##......",
            ".#######",
            "..#####.",
        ],
        "spinner": [
            "........",
            "..####..",
            ".#....#.",
            "#......#",
            "#......#",
            ".#....#.",
            "..####..",
            "........",
        ],
    ]
}

struct OKLogo: View {
    var size: CGFloat = 26
    var glow: Bool = false

    private var mark: NSImage {
        OKBrandMark.bundleImage ?? OKBrandMark.fallbackImage(size: 256)
    }

    var body: some View {
        ZStack {
            if OKBrandMark.bundleImage != nil {
                Image(nsImage: mark)
                    .resizable()
                    .scaledToFit()
            } else {
                Canvas { context, canvas in
                    let rect = CGRect(origin: .zero, size: canvas).insetBy(dx: canvas.width * 0.08, dy: canvas.height * 0.08)
                    let color = OKBrand.green
                    context.stroke(Path(ellipseIn: rect),
                                   with: .color(color),
                                   lineWidth: max(1.2, canvas.width * 0.075))
                    let s = canvas.width * 0.34
                    let ax = canvas.width / 2 - s * 0.28
                    let ay = canvas.height / 2 - s * 0.38
                    var arrow = Path()
                    arrow.move(to: CGPoint(x: ax, y: ay + s))
                    arrow.addLine(to: CGPoint(x: ax, y: ay))
                    arrow.addLine(to: CGPoint(x: ax + s * 0.72, y: ay + s * 0.48))
                    arrow.addLine(to: CGPoint(x: ax + s * 0.34, y: ay + s * 0.5))
                    arrow.addLine(to: CGPoint(x: ax + s * 0.5, y: ay + s * 0.86))
                    arrow.addLine(to: CGPoint(x: ax + s * 0.24, y: ay + s * 0.96))
                    arrow.addLine(to: CGPoint(x: ax + s * 0.1, y: ay + s * 0.6))
                    arrow.closeSubpath()
                    context.fill(arrow, with: .color(color))
                }
            }
        }
        .frame(width: size, height: size)
        .shadow(color: glow ? OKBrand.green.opacity(0.4) : .clear, radius: size * 0.28, y: 2)
        .accessibilityLabel("Okidoki")
    }

    static func nsImage(size: CGFloat = 18) -> NSImage {
        let renderer = ImageRenderer(content: OKLogo(size: size))
        renderer.scale = 2
        return renderer.nsImage ?? NSImage(size: NSSize(width: size, height: size))
    }
}

struct OKOrb: View {
    var size: CGFloat = 180
    var intensity: Double = 1
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, canvas in
                let w = canvas.width
                let h = canvas.height
                let center = CGPoint(x: w / 2, y: h / 2)
                let dark = scheme == .dark
                context.drawLayer { layer in
                    layer.addFilter(.blur(radius: w * 0.055))
                    for index in 0..<3 {
                        let angle = t * (0.18 + Double(index) * 0.05) + Double(index) * 2.1
                        let orbit = w * (0.13 + Double(index) * 0.02)
                        let cx = center.x + CGFloat(cos(angle)) * orbit
                        let cy = center.y + CGFloat(sin(angle * 1.2)) * orbit * 0.7
                        let radius = w * (0.3 - Double(index) * 0.03)
                        let colors: [Color] = [
                            Color(hex: 0x1FB57A).opacity(0.75 * intensity),
                            Color(hex: 0x8FB7FF).opacity(0.5 * intensity),
                            Color(hex: 0xFFD8A8).opacity(0.55 * intensity),
                        ]
                        let gradient = Gradient(colors: [colors[index % colors.count], colors[index % colors.count].opacity(0)])
                        layer.fill(Path(ellipseIn: CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2)),
                                   with: .radialGradient(gradient, center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: radius))
                    }
                }
                let core = CGRect(x: center.x - w * 0.18, y: center.y - w * 0.18, width: w * 0.36, height: w * 0.36)
                context.fill(Path(ellipseIn: core),
                             with: .radialGradient(Gradient(colors: [Color(hex: dark ? 0xFFF6EA : 0xFFFFFF).opacity(0.95), Color(hex: 0xFFB39D).opacity(0.2)]),
                                                   center: center, startRadius: 0, endRadius: w * 0.18))
                let ringRect = core.insetBy(dx: -w * 0.05, dy: -w * 0.05)
                context.stroke(Path(ellipseIn: ringRect), with: .color(.white.opacity(dark ? 0.18 : 0.55)), lineWidth: 1)
            }
            .frame(width: size, height: size)
        }
    }
}

struct PixelSpinner: View {
    var size: CGFloat = 16
    var color: Color = .primary

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let active = Int(t * 12) % 8
            Canvas { context, canvas in
                let cell = min(canvas.width, canvas.height) / 8
                let positions = [(3, 0), (5, 1), (6, 3), (6, 5), (5, 6), (3, 7), (1, 6), (0, 4)]
                for (index, point) in positions.enumerated() {
                    let opacity = index == active ? 1.0 : 0.22
                    let rect = CGRect(x: CGFloat(point.0) * cell, y: CGFloat(point.1) * cell, width: cell, height: cell)
                    context.fill(Path(roundedRect: rect, cornerRadius: cell * 0.25),
                                 with: .color(color.opacity(opacity)))
                }
            }
        }
        .frame(width: size, height: size)
    }
}

struct StatusDot: View {
    var color: Color = Color(hex: 0x4CD97B)
    var size: CGFloat = 6
    var pulsing: Bool = true
    @State private var pulse = false
    var body: some View {
        ZStack {
            if pulsing {
                Circle().fill(color.opacity(0.28)).frame(width: size * 2.6, height: size * 2.6)
                    .scaleEffect(pulse ? 1.25 : 0.6)
                    .opacity(pulse ? 0.0 : 0.8)
                    .animation(.easeOut(duration: 1.6).repeatForever(autoreverses: false), value: pulse)
            }
            Circle().fill(color).frame(width: size, height: size)
        }
        .onAppear { pulse = true }
    }
}
