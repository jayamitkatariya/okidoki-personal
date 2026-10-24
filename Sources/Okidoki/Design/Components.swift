import SwiftUI
import AppKit
import CoreText
import OkidokiCore

// MARK: - Buttons

enum OKButtonKind {
    case primary, secondary, ghost, danger, dark
}

struct OKButtonStyle: ButtonStyle {
    var kind: OKButtonKind = .primary
    var compact: Bool = false
    @Environment(\.colorScheme) private var scheme

    private var theme: OKTheme { OKTheme(scheme) }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.okBody(compact ? 12.5 : 13.5, .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, compact ? 12 : 16)
            .frame(height: compact ? 30 : 38)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous)
                    .stroke(border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous))
            .shadow(color: kind == .primary ? Color(hex: 0x1FB57A).opacity(configuration.isPressed ? 0.05 : 0.22) : .clear,
                    radius: 10, y: 4)
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.94 : 1)
            .animation(OKMotion.snappy, value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return Color(hex: 0xFFFBF3)
        case .secondary: return theme.ink
        case .ghost: return theme.secondary
        case .danger: return Color(hex: 0xFFF7F5)
        case .dark: return Color(hex: 0xF7F2E9)
        }
    }

    @ViewBuilder private var background: some View {
        switch kind {
        case .primary:
            LinearGradient(colors: [Color(hex: 0x0F7A5C), Color(hex: 0x00483C)], startPoint: .top, endPoint: .bottom)
        case .secondary:
            theme.card
        case .ghost:
            Color.black.opacity(0.0001)
        case .danger:
            LinearGradient(colors: [Color(hex: 0xFF5A4C), Color(hex: 0xE33B2C)], startPoint: .top, endPoint: .bottom)
        case .dark:
            Color.white.opacity(0.1)
        }
    }

    private var border: Color {
        switch kind {
        case .primary, .danger: return Color.white.opacity(0.18)
        case .secondary: return theme.lineStrong
        case .ghost: return .clear
        case .dark: return Color.white.opacity(0.15)
        }
    }
}

struct OKIconButton: View {
    let glyph: String
    var size: CGFloat = 28
    var tint: Color = .primary
    var help: String = ""
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            PixelGlyph(name: glyph, size: size * 0.52, color: hovering ? tint : tint.opacity(0.66))
                .frame(width: size, height: size)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(hovering ? Color.primary.opacity(0.07) : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

struct OKSwitch: View {
    @Binding var isOn: Bool
    var tint: Color = Color(hex: 0x1FB57A)
    var size: CGFloat = 1

    var body: some View {
        Button {
            withAnimation(OKMotion.snappy) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? tint : Color.primary.opacity(0.12))
                    .frame(width: 38 * size, height: 22 * size)
                Circle()
                    .fill(isOn ? Color(hex: 0xFFFBF5) : Color.white)
                    .frame(width: 17 * size, height: 17 * size)
                    .padding(.horizontal, 2.5 * size)
                    .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
            }
            .animation(OKMotion.snappy, value: isOn)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "on" : "off")
    }
}

struct OKSlider: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = 0...1
    var step: Double = 0
    var tint: Color = Color(hex: 0x1FB57A)
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            let fraction = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
            let width = max(0, min(1, fraction)) * geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1)).frame(height: height)
                Capsule().fill(tint).frame(width: width, height: height)
                Circle()
                    .fill(Color(hex: 0xFFFCF7))
                    .frame(width: 15, height: 15)
                    .overlay(Circle().stroke(Color.black.opacity(0.12), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.24), radius: 3, y: 1)
                    .offset(x: max(0, min(geo.size.width - 15, width - 7.5)))
            }
            .frame(height: 22)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { drag in
                    let raw = range.lowerBound + (drag.location.x / max(1, geo.size.width)) * (range.upperBound - range.lowerBound)
                    let clamped = min(range.upperBound, max(range.lowerBound, raw))
                    let stepped = step > 0 ? (clamped / step).rounded() * step : clamped
                    value = stepped
                }
            )
        }
        .frame(height: 22)
    }
}

struct OKSegmented<T: Hashable>: View {
    let options: [T]
    let label: (T) -> String
    @Binding var selection: T
    var compact: Bool = false
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                Button {
                    withAnimation(OKMotion.snappy) { selection = option }
                } label: {
                    Text(label(option))
                        .font(.okBody(compact ? 11.5 : 12.5, .medium))
                        .foregroundStyle(selection == option ? OKBrand.ink : OKBrand.muted)
                        .padding(.horizontal, compact ? 9 : 13)
                        .frame(height: compact ? 26 : 30)
                        .background {
                            if selection == option {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(Color.white)
                                    .shadow(color: .black.opacity(0.1), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "seg", in: namespace)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(0.06))
        )
    }
}

// MARK: - Surfaces

struct OKCardModifier: ViewModifier {
    var hoverable: Bool = true
    var padding: CGFloat = 18
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    private var theme: OKTheme { OKTheme(scheme) }

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(hovering ? theme.cardHover : theme.card.opacity(theme.dark ? 0.86 : 0.78))
                    .shadow(color: Color.black.opacity(hovering ? 0.14 : 0.05), radius: hovering ? 22 : 12, y: hovering ? 10 : 5)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(theme.lineStrong.opacity(hovering ? 1 : 0.7), lineWidth: 1)
            )
            .offset(y: hovering ? -2 : 0)
            .animation(OKMotion.spring, value: hovering)
            .onHover { if hoverable { hovering = $0 } }
    }
}

struct OKDarkCardModifier: ViewModifier {
    var padding: CGFloat = 18
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.045))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(0.09), lineWidth: 1)
            )
    }
}

extension View {
    func okCard(hoverable: Bool = true, padding: CGFloat = 18) -> some View {
        modifier(OKCardModifier(hoverable: hoverable, padding: padding))
    }
    func okDarkCard(padding: CGFloat = 18) -> some View {
        modifier(OKDarkCardModifier(padding: padding))
    }
    func okHoverLift() -> some View {
        modifier(HoverLift())
    }
}

struct HoverLift: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .scaleEffect(hovering ? 1.005 : 1)
            .offset(y: hovering ? -2 : 0)
            .animation(OKMotion.spring, value: hovering)
            .onHover { hovering = $0 }
    }
}

// MARK: - Small pieces

struct OKChip: View {
    var text: String
    var color: Color = Color(hex: 0x6E685E)
    var filled: Bool = false
    var body: some View {
        Text(text)
            .font(.okMono(9.5, .medium))
            .textCase(.lowercase)
            .foregroundStyle(filled ? Color(hex: 0xFFFBF4) : color)
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(
                Capsule().fill(filled ? color : color.opacity(0.085))
            )
            .overlay(Capsule().stroke(filled ? .clear : color.opacity(0.16), lineWidth: 0.6))
    }
}

struct RiskBadge: View {
    var risk: RiskLevel
    var body: some View {
        let color: Color = risk == .high ? Color(hex: 0xE33B2C) : (risk == .medium ? Color(hex: 0xC98A1B) : Color(hex: 0x3E8E5B))
        HStack(spacing: 4) {
            Rectangle().fill(color).frame(width: 4, height: 4)
            Text(risk.label)
                .font(.okMono(9, .medium))
                .textCase(.uppercase)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .frame(height: 19)
        .background(Capsule().fill(color.opacity(0.09)))
        .overlay(Capsule().stroke(color.opacity(0.18), lineWidth: 0.5))
    }
}

struct RunStatusBadge: View {
    var status: RunStatus
    var body: some View {
        let color: Color = {
            switch status {
            case .running: return Color(hex: 0x3E8E5B)
            case .waiting: return Color(hex: 0xC98A1B)
            case .done: return Color(hex: 0x3E8E5B)
            case .failed: return Color(hex: 0xE33B2C)
            case .cancelled: return Color(hex: 0x8A8377)
            case .paused: return Color(hex: 0x6C6CF8)
            case .previewing: return Color(hex: 0x8A8377)
            }
        }()
        HStack(spacing: 5) {
            if status == .running { StatusDot(color: color, size: 4) } else { Circle().fill(color).frame(width: 4, height: 4) }
            Text(status.label)
                .font(.okMono(9.5, .medium))
                .textCase(.lowercase)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .frame(height: 21)
        .background(Capsule().fill(color.opacity(0.09)))
        .overlay(Capsule().stroke(color.opacity(0.18), lineWidth: 0.5))
    }
}

struct RunKindGlyph: View {
    var kind: RunKind
    var size: CGFloat = 15
    var body: some View {
        PixelGlyph(name: glyph, size: size, color: .secondary)
    }
    private var glyph: String {
        switch kind {
        case .answer: return "spark"
        case .quickAction: return "bolt"
        case .terminal: return "terminal"
        case .coding: return "code"
        case .background: return "runs"
        case .teach: return "wand"
        case .watch: return "eye"
        case .borrow: return "hand"
        case .computerUse: return "hand"
        case .routine: return "clock"
        }
    }
}

struct AccountAvatar: View {
    var account: Account
    var size: CGFloat = 30
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .fill(Color(hexString: account.colorHex).gradient)
            Text(account.initials)
                .font(.okMono(size * 0.34, .bold))
                .foregroundStyle(Color(hex: 0xFFFBF4))
        }
        .frame(width: size, height: size)
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .stroke(Color.white.opacity(0.3), lineWidth: 0.7)
        )
        .shadow(color: Color(hexString: account.colorHex).opacity(0.25), radius: 6, y: 2)
    }
}

struct EmptyState: View {
    var glyph: String
    var title: String
    var message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = OKTheme(scheme)
        VStack(alignment: .leading, spacing: 12) {
            PixelGlyph(name: glyph, size: 26, color: theme.tertiary)
            Text(title)
                .font(.okDisplay(28))
                .foregroundStyle(theme.ink)
            Text(message)
                .font(.okBody(13))
                .foregroundStyle(theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.card.opacity(0.45))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(theme.line))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Backgrounds

enum OKNoise {
    static let image: NSImage? = {
        let size = NSSize(width: 180, height: 180)
        let image = NSImage(size: size)
        image.lockFocus()
        for _ in 0..<4200 {
            let x = CGFloat.random(in: 0..<size.width)
            let y = CGFloat.random(in: 0..<size.height)
            let alpha = CGFloat.random(in: 0.02...0.14)
            (Bool.random() ? NSColor.white : NSColor.black).withAlphaComponent(alpha).setFill()
            NSRect(x: x, y: y, width: 1, height: 1).fill()
        }
        image.unlockFocus()
        return image
    }()
}

struct OKPaperBackground: View {
    var showGrid: Bool = true
    @Environment(\.colorScheme) private var scheme
    private var theme: OKTheme { OKTheme(scheme) }

    var body: some View {
        ZStack {
            theme.bg
            LinearGradient(colors: [theme.bg, theme.bgDeep.opacity(0.65), theme.bg],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            if showGrid {
                Canvas { context, size in
                    let step: CGFloat = 28
                    var path = Path()
                    var x: CGFloat = 0
                    while x <= size.width {
                        path.move(to: CGPoint(x: x, y: 0))
                        path.addLine(to: CGPoint(x: x, y: size.height))
                        x += step
                    }
                    var y: CGFloat = 0
                    while y <= size.height {
                        path.move(to: CGPoint(x: 0, y: y))
                        path.addLine(to: CGPoint(x: size.width, y: y))
                        y += step
                    }
                    context.stroke(path, with: .color(theme.dark ? .white.opacity(0.022) : .black.opacity(0.026)), lineWidth: 0.6)
                }
                .mask(
                    RadialGradient(colors: [.black, .black.opacity(0.35), .clear],
                                   center: .topTrailing, startRadius: 40, endRadius: 760)
                )
            }
            Circle()
                .fill(Color(hex: 0x1FB57A).opacity(theme.dark ? 0.14 : 0.1))
                .frame(width: 520, height: 520)
                .blur(radius: 130)
                .offset(x: 380, y: -340)
            Circle()
                .fill(Color(hex: 0x8FB7FF).opacity(theme.dark ? 0.07 : 0.08))
                .frame(width: 420, height: 420)
                .blur(radius: 120)
                .offset(x: -420, y: 360)
            if let noise = OKNoise.image {
                Image(nsImage: noise)
                    .resizable(resizingMode: .tile)
                    .interpolation(.none)
                    .opacity(theme.dark ? 0.24 : 0.18)
                    .blendMode(theme.dark ? .screen : .multiply)
                    .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea()
    }
}

struct OKDarkBackground: View {
    var body: some View {
        ZStack {
            Color(hex: 0x0A0A0B)
            LinearGradient(colors: [Color(hex: 0x111114), Color(hex: 0x08080A)], startPoint: .top, endPoint: .bottom)
            Circle().fill(Color(hex: 0x1FB57A).opacity(0.16)).frame(width: 320, height: 320).blur(radius: 100).offset(x: 140, y: -120)
            if let noise = OKNoise.image {
                Image(nsImage: noise).resizable(resizingMode: .tile).interpolation(.none).opacity(0.18).blendMode(.screen)
            }
        }
    }
}

// MARK: - Text

struct SectionLabel: View {
    var text: String
    var color: Color = Color.secondary
    var body: some View {
        HStack(spacing: 7) {
            Rectangle().fill(Color(hex: 0x1FB57A)).frame(width: 5, height: 5)
            Text(text)
                .font(.okMono(9.5, .medium))
                .textCase(.uppercase)
                .tracking(0.9)
                .foregroundStyle(color)
        }
    }
}

struct PageTitle: View {
    var title: String
    var subtitle: String?
    var icon: String = "spark"
    var trailing: AnyView? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                PixelGlyph(name: icon, size: 22, color: Color(hex: 0x1FB57A))
                ScrambleText(text: title, font: .okDisplay(46), color: Color.primary)
                Spacer(minLength: 0)
                if let trailing { trailing }
            }
            if let subtitle {
                Text(subtitle)
                    .font(.okMono(10.5))
                    .foregroundStyle(Color.secondary)
                    .lineSpacing(3)
            }
        }
    }
}

struct ScrambleText: View {
    var text: String
    var font: Font
    var color: Color
    @State private var display: String = ""
    @State private var work: DispatchWorkItem?

    var body: some View {
        Text(display.isEmpty ? text : display)
            .font(font)
            .foregroundStyle(color)
            .onAppear { animate() }
            .onChange(of: text) { _, _ in animate() }
            .onDisappear { work?.cancel() }
    }

    private func animate() {
        work?.cancel()
        let glyphs = Array("abcdefghijklmnopqrstuvwxyz#%&*+")
        let target = Array(text)
        var frames: [String] = []
        for frame in 0..<9 {
            var value = ""
            for (index, char) in target.enumerated() {
                if char == " " { value.append(" "); continue }
                let threshold = Double(index) / Double(max(1, target.count)) * 6
                if Double(frame) > threshold + 2 { value.append(char) }
                else { value.append(glyphs[(index * 7 + frame * 5) % glyphs.count]) }
            }
            frames.append(value)
        }
        display = frames.first ?? text
        for (index, value) in frames.enumerated() {
            let item = DispatchWorkItem { display = value }
            work = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(index) * 0.028, execute: item)
        }
        let final = DispatchWorkItem { display = text }
        work = final
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(frames.count) * 0.028 + 0.02, execute: final)
    }
}

struct TypewriterText: View {
    var text: String
    var font: Font
    var color: Color
    var speed: Double = 0.032
    var onDone: (() -> Void)? = nil
    @State private var shown = ""
    @State private var work: DispatchWorkItem?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(shown)
            .font(font)
            .foregroundStyle(color)
            .onAppear { run() }
            .onChange(of: text) { _, _ in run() }
            .onDisappear { work?.cancel() }
    }

    private func run() {
        work?.cancel()
        if reduceMotion {
            shown = text
            onDone?()
            return
        }
        shown = ""
        let characters = Array(text)
        for (index, _) in characters.enumerated() {
            let item = DispatchWorkItem {
                shown = String(characters.prefix(index + 1))
                if index == characters.count - 1 { onDone?() }
            }
            work = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(index) * speed, execute: item)
        }
    }
}

// MARK: - Markdown

struct OKMarkdown: View {
    var text: String
    var size: CGFloat = 13.5
    var color: Color = .primary

    private var blocks: [MDBlock] {
        var result: [MDBlock] = []
        var inCode = false
        var code = ""
        var index = 0
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if inCode {
                    result.append(MDBlock(index: index, kind: .code, text: code.trimmingCharacters(in: .newlines)))
                    index += 1
                    code = ""
                    inCode = false
                } else {
                    inCode = true
                }
                continue
            }
            if inCode { code += line + "\n"; continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("### ") {
                result.append(MDBlock(index: index, kind: .heading, text: String(trimmed.dropFirst(4)))); index += 1
            } else if trimmed.hasPrefix("## ") {
                result.append(MDBlock(index: index, kind: .heading, text: String(trimmed.dropFirst(3)))); index += 1
            } else if trimmed.hasPrefix("# ") {
                result.append(MDBlock(index: index, kind: .heading, text: String(trimmed.dropFirst(2)))); index += 1
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("· ") {
                result.append(MDBlock(index: index, kind: .bullet, text: String(trimmed.dropFirst(2)))); index += 1
            } else if let match = trimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) {
                result.append(MDBlock(index: index, kind: .bullet, text: String(trimmed[match.upperBound...]))); index += 1
            } else if trimmed.hasPrefix("> ") {
                result.append(MDBlock(index: index, kind: .quote, text: String(trimmed.dropFirst(2)))); index += 1
            } else {
                result.append(MDBlock(index: index, kind: .paragraph, text: trimmed)); index += 1
            }
        }
        if inCode, !code.isEmpty { result.append(MDBlock(index: index, kind: .code, text: code)) }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(blocks) { block in
                switch block.kind {
                case .heading:
                    Text(inline(block.text))
                        .font(.okBody(size + 2, .semibold))
                        .foregroundStyle(color)
                        .padding(.top, 3)
                case .paragraph:
                    Text(inline(block.text))
                        .font(.okBody(size))
                        .foregroundStyle(color.opacity(0.92))
                        .lineSpacing(3.5)
                        .fixedSize(horizontal: false, vertical: true)
                case .bullet:
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Rectangle().fill(Color(hex: 0x1FB57A)).frame(width: 4, height: 4).offset(y: -2)
                        Text(inline(block.text))
                            .font(.okBody(size))
                            .foregroundStyle(color.opacity(0.92))
                            .lineSpacing(3.5)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .quote:
                    Text(inline(block.text))
                        .font(.okBody(size))
                        .italic()
                        .foregroundStyle(color.opacity(0.72))
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Color(hex: 0x1FB57A).opacity(0.5)).frame(width: 2)
                        }
                case .code:
                    Text(block.text)
                        .font(.okMono(11))
                        .foregroundStyle(Color(hex: 0xE7E1D5))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x191816)))
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func inline(_ value: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: value, options: options) { return attributed }
        return AttributedString(value)
    }
}

struct MDBlock: Identifiable {
    enum Kind { case heading, paragraph, bullet, quote, code }
    var id: Int
    var kind: Kind
    var text: String

    init(index: Int, kind: Kind, text: String) {
        self.id = index
        self.kind = kind
        self.text = text
    }
}

// MARK: - Waveform

struct WaveformView: View {
    var level: Double
    var active: Bool
    var color: Color = Color(hex: 0x1FB57A)
    var bars: Int = 22
    var height: CGFloat = 22

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                let spacing = size.width / CGFloat(bars)
                let barWidth = max(1.6, spacing * 0.38)
                for index in 0..<bars {
                    let phase = t * 5.2 + Double(index) * 0.72
                    let envelope = 0.25 + 0.75 * abs(sin(phase * 0.5))
                    let amplitude = active ? min(1.0, 0.12 + level * 1.4) : 0.1
                    let barHeight = max(2.0, size.height * CGFloat(envelope * amplitude))
                    let rect = CGRect(x: CGFloat(index) * spacing + (spacing - barWidth) / 2,
                                      y: (size.height - barHeight) / 2,
                                      width: barWidth, height: barHeight)
                    context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2),
                                 with: .color(color.opacity(active ? 0.55 + 0.45 * envelope : 0.3)))
                }
            }
        }
        .frame(height: height)
    }
}

struct BreathingGlow: View {
    var color: Color
    var size: CGFloat
    @State private var breathing = false
    var body: some View {
        Circle()
            .fill(color.opacity(0.18))
            .frame(width: size, height: size)
            .blur(radius: size * 0.14)
            .scaleEffect(breathing ? 1.08 : 0.94)
            .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true), value: breathing)
            .onAppear { breathing = true }
    }
}

struct OKDivider: View {
    var body: some View {
        Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1)
    }
}

struct Metric: View {
    var value: String
    var label: String
    var accent: Color = Color(hex: 0x1FB57A)
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.okDisplay(38))
                .foregroundStyle(Color.primary)
                .contentTransition(.numericText())
            Text(label)
                .font(.okMono(9.5))
                .textCase(.uppercase)
                .foregroundStyle(Color.secondary)
        }
    }
}

// MARK: - Reveal

struct RevealModifier: ViewModifier {
    var delay: Double
    var offset: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : offset)
            .onAppear {
                if reduceMotion { shown = true; return }
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    withAnimation(OKMotion.soft) { shown = true }
                }
            }
    }
}

extension View {
    func reveal(_ delay: Double = 0, offset: CGFloat = 10) -> some View {
        modifier(RevealModifier(delay: delay, offset: offset))
    }
}
