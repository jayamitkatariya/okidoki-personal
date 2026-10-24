import SwiftUI
import AppKit
import CoreText
import OkidokiCore

// MARK: - Color

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }

    init(hexString: String, fallback: UInt32 = 0x44E45E) {
        let cleaned = hexString.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).uppercased()
        if cleaned.count == 6, let value = UInt32(cleaned, radix: 16) {
            self.init(hex: value)
        } else {
            self.init(hex: fallback)
        }
    }
}

extension NSColor {
    convenience init(hexString: String, fallback: UInt32 = 0x44E45E) {
        let cleaned = hexString.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).uppercased()
        let value = UInt32(cleaned, radix: 16) ?? fallback
        self.init(srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
                  green: CGFloat((value >> 8) & 0xFF) / 255,
                  blue: CGFloat(value & 0xFF) / 255,
                  alpha: 1)
    }
}

// MARK: - Brand

/// The okidoki greens. `mat` is the deep panel green (shared with Bucket's Mat skin);
/// `green` is the neon ring-arrow green used for interactive accents;
/// `mint` reads on dark surfaces like the notch.
enum OKBrand {
    static let matDeep = Color(hex: 0x00372C)
    static let mat = Color(hex: 0x00483C)
    static let matCard = Color(hex: 0x003228)
    static let green = Color(hex: 0x44E45E)
    static let greenInk = Color(hex: 0x0B7A45)
    static let mint = Color(hex: 0x4CFB6A)
    static let paper = Color(hex: 0xF6F8F6)
    static let ink = Color(hex: 0x0E1512)
    static let muted = Color(hex: 0x5E6963)
    static let faint = Color(hex: 0x929C96)
}

/// The ring-arrow brand mark, loaded from the app bundle (or the repo when running bare).
enum OKBrandMark {
    private static let cached: NSImage? = {
        if let image = Bundle.main.image(forResource: NSImage.Name("BrandMark")) { return image }
        return NSImage(contentsOf: URL(fileURLWithPath: "Resources/BrandMark.png"))
    }()
    static var bundleImage: NSImage? { cached }

    /// The mark at a fixed pixel size, ready for cursors and overlays.
    static func image(pointSize: CGFloat, scale: CGFloat = 2) -> NSImage {
        let pixels = pointSize * scale
        if let source = bundleImage {
            let image = NSImage(size: NSSize(width: pointSize, height: pointSize))
            image.lockFocus()
            NSGraphicsContext.current?.imageInterpolation = .high
            source.draw(in: NSRect(x: 0, y: 0, width: pointSize, height: pointSize),
                        from: .zero, operation: .sourceOver, fraction: 1)
            image.unlockFocus()
            let representation = image.bestRepresentation(for: NSRect(x: 0, y: 0, width: pixels, height: pixels),
                                                          context: nil, hints: nil)
            if let bitmap = representation as? NSBitmapImageRep {
                bitmap.size = NSSize(width: pointSize, height: pointSize)
                let fixed = NSImage(size: NSSize(width: pointSize, height: pointSize))
                fixed.addRepresentation(bitmap)
                return fixed
            }
            return image
        }
        return fallbackImage(size: pointSize)
    }

    /// Drawn from scratch when the PNG isn't reachable, so the mark never disappears.
    static func fallbackImage(size: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        let rect = NSRect(x: 0, y: 0, width: size, height: size)
        let color = NSColor(hexString: "44E45E")
        let ring = NSBezierPath(ovalIn: rect.insetBy(dx: size * 0.08, dy: size * 0.08))
        ring.lineWidth = max(1.2, size * 0.075)
        color.setStroke()
        ring.stroke()
        let s = size * 0.34
        let ax = rect.midX - s * 0.28
        let ay = rect.midY - s * 0.38
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: ax, y: ay + s))
        arrow.line(to: NSPoint(x: ax, y: ay))
        arrow.line(to: NSPoint(x: ax + s * 0.72, y: ay + s * 0.48))
        arrow.line(to: NSPoint(x: ax + s * 0.34, y: ay + s * 0.5))
        arrow.line(to: NSPoint(x: ax + s * 0.5, y: ay + s * 0.86))
        arrow.line(to: NSPoint(x: ax + s * 0.24, y: ay + s * 0.96))
        arrow.line(to: NSPoint(x: ax + s * 0.1, y: ay + s * 0.6))
        arrow.close()
        color.setFill()
        arrow.fill()
        image.unlockFocus()
        return image
    }
}

// MARK: - Theme

struct OKTheme {
    let dark: Bool

    init(_ scheme: ColorScheme) { self.dark = scheme == .dark }

    var bg: Color { dark ? Color(hex: 0x0A0C0B) : Color(hex: 0xF3F6F3) }
    var bgDeep: Color { dark ? Color(hex: 0x070908) : Color(hex: 0xE9EEEA) }
    var sidebar: Color { dark ? Color(hex: 0x0E1110) : Color(hex: 0xF6F8F6) }
    var surface: Color { dark ? Color(hex: 0x141716) : Color(hex: 0xFAFBFA) }
    var card: Color { dark ? Color(hex: 0x171A19) : Color(hex: 0xFFFFFF) }
    var cardHover: Color { dark ? Color(hex: 0x1C1C20) : Color(hex: 0xFFFFFF) }
    var ink: Color { dark ? Color(hex: 0xF2F5F3) : Color(hex: 0x0E1512) }
    var secondary: Color { dark ? Color(hex: 0xA3ACA7) : Color(hex: 0x5E6963) }
    var tertiary: Color { dark ? Color(hex: 0x6E7772) : Color(hex: 0x929C96) }
    var faint: Color { dark ? Color(hex: 0x3F4542) : Color(hex: 0xC3CBC6) }
    var line: Color { dark ? Color.white.opacity(0.075) : Color.black.opacity(0.085) }
    var lineStrong: Color { dark ? Color.white.opacity(0.14) : Color.black.opacity(0.16) }
    var coral: Color { OKBrand.green }
    var coralSoft: Color { OKBrand.green.opacity(dark ? 0.16 : 0.1) }
    var lime: Color { Color(hex: 0xB8F26B) }
    var sky: Color { Color(hex: 0x8FB7FF) }
    var lavender: Color { Color(hex: 0xC9A7FF) }
    var amber: Color { Color(hex: 0xFFC95C) }
    var danger: Color { Color(hex: 0xFF453A) }
    var success: Color { Color(hex: 0x4CD97B) }
    var codeBg: Color { dark ? Color(hex: 0x0C0C0E) : Color(hex: 0x201F1D) }
    var codeText: Color { dark ? Color(hex: 0xD8D2C7) : Color(hex: 0xEDE8DE) }
    var notch: Color { Color(hex: 0x080808) }
    var notchText: Color { Color(hex: 0xF2F5F3) }
    var notchMuted: Color { Color.white.opacity(0.48) }

    var shadow: Color { Color.black.opacity(dark ? 0.45 : 0.14) }
}

// MARK: - Fonts

extension Font {
    static func okDisplay(_ size: CGFloat) -> Font {
        .custom("PPNeueBit-Bold", size: size)
    }
    static func okSerif(_ size: CGFloat) -> Font {
        .custom("PPMondwest-Regular", size: size)
    }
    static func okBody(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .medium: name = "Inter-Regular_Medium"
        case .semibold: name = "Inter-Regular_SemiBold"
        case .bold, .heavy, .black: name = "Inter-Regular_Bold"
        case .light, .thin, .ultraLight: name = "Inter-Regular_Light"
        default: name = "Inter-Regular"
        }
        return .custom(name, size: size)
    }
    static func okMono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .medium: name = "JetBrainsMonoRoman-Medium"
        case .semibold: name = "JetBrainsMonoRoman-Medium"
        case .bold, .heavy, .black: name = "JetBrainsMonoRoman-Bold"
        default: name = "JetBrainsMono-Regular"
        }
        return .custom(name, size: size)
    }
}

// MARK: - Motion

enum OKMotion {
    static let soft = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.55)
    static let quick = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.22)
    static let spring = Animation.spring(response: 0.44, dampingFraction: 0.84)
    static let bouncy = Animation.spring(response: 0.5, dampingFraction: 0.7)
    static let snappy = Animation.spring(response: 0.3, dampingFraction: 0.86)
}

// MARK: - Appearance helper

extension View {
    @ViewBuilder
    func okPreferredScheme(_ appearance: AppAppearance) -> some View {
        switch appearance {
        case .system: self
        case .light: self.preferredColorScheme(.light)
        case .dark: self.preferredColorScheme(.dark)
        }
    }
}

// MARK: - Glass

struct VisualEffectBlur: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    var blending: NSVisualEffectView.BlendingMode = .behindWindow
    var state: NSVisualEffectView.State = .active

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = state
        view.isEmphasized = false
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blending
        view.state = state
    }
}

// MARK: - Registry

enum OKRegistry {
    static func registerFonts() {
        let bundleURL = Bundle.main.resourceURL
        let fontURLs = (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "otf", subdirectory: "Fonts") ?? [])
        for url in fontURLs {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        if fontURLs.isEmpty, let bundleURL {
            let folder = bundleURL.appendingPathComponent("Fonts")
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            for file in files where ["ttf", "otf"].contains(file.pathExtension.lowercased()) {
                CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
            }
        }
    }
}

extension Color {
    static var tertiary: Color { Color.secondary.opacity(0.72) }
}
