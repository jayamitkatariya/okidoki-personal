import SwiftUI
import AppKit
import CoreText

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

// MARK: - Text

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
    /// Extra leading between wrapped lines. The overlay card asks for more air
    /// than the dashboard does.
    var lineSpacing: CGFloat = 3.5

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
                        .lineSpacing(lineSpacing)
                        .fixedSize(horizontal: false, vertical: true)
                case .bullet:
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Rectangle().fill(Color(hex: 0x1FB57A)).frame(width: 4, height: 4).offset(y: -2)
                        Text(inline(block.text))
                            .font(.okBody(size))
                            .foregroundStyle(color.opacity(0.92))
                            .lineSpacing(lineSpacing)
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
