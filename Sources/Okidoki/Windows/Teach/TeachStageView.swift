import AppKit
import QuartzCore

// MARK: - Scene description

/// One extra drawing, in overlay-local points (origin top-left of the display).
struct TeachDrawing: Equatable {
    /// callout, badge, bracket, underline, flow, measure, spotlight, lens, sketch, ghost, typing, scroll
    var kind: String
    var rect: CGRect
    var to: CGPoint?
    var text: String?
    var n: Int?
}

/// Everything the stage draws for one step, in overlay-local points.
struct TeachScene: Equatable {
    /// ring, box, arrow, none
    var kind: String
    var rect: CGRect = .zero
    var from: CGPoint = .zero
    var to: CGPoint?
    var label: String?
    var keys: [String] = []
    var also: CGRect?
    var alsoLabel: String?
    var drawings: [TeachDrawing] = []
    /// A lookahead guess that hasn't been confirmed yet: drawn lighter and dashed.
    var provisional = false

    var center: CGPoint { to ?? CGPoint(x: rect.midX, y: rect.midY) }
    var hasTarget: Bool { kind != "none" }
}

// MARK: - Stage

/// Draws every mark of a lesson with Core Animation layers, so the glow, the glide between steps,
/// the comet on a drag and the pulse all run on the render server at the display's refresh rate
/// and cost the main thread nothing. Input geometry is top-left; this view is not flipped and
/// converts in one place (`flip`), so text layers never render upside down.
final class TeachStageView: NSView {
    var accent: NSColor = NSColor(red: 0.27, green: 0.89, blue: 0.37, alpha: 1) {
        didSet { restyle() }
    }
    var reduceMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    var increaseContrast: Bool = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast

    private(set) var scene: TeachScene?
    private var thinking = false

    // Fixed layers, reused across steps so geometry changes can glide.
    private let spotlight = CAShapeLayer()
    private let halo = CAShapeLayer()
    private let glow = CAShapeLayer()
    private let fill = CAShapeLayer()
    private let ring = CAShapeLayer()
    private let orbit = CAShapeLayer()
    private let arrowGlow = CAShapeLayer()
    private let arrow = CAShapeLayer()
    private let arrowHead = CAShapeLayer()
    private let comet = CAShapeLayer()
    private let dropTarget = CAShapeLayer()
    private let alsoBox = CAShapeLayer()
    private let leader = CAShapeLayer()
    private var alsoTag: CALayer?
    private var tagLayer: CALayer?
    /// Where the tag sits, in overlay-local points, so the bubble can stay out of its way.
    private var tagRect: CGRect?
    private var drawingLayers: [CALayer] = []
    private var ghost: CALayer?
    private var transient: [CALayer] = []

    /// For the lens: the current screenshot and how many of its pixels make one local point.
    private var screenshot: CGImage?
    private var pixelsPerPoint: CGFloat = 2

    private let bubble: NSHostingLikeContainer

    override init(frame: NSRect) {
        bubble = NSHostingLikeContainer()
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        setupLayers()
        addSubview(bubble)
        bubble.isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    // MARK: Geometry

    private func flip(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: bounds.height - p.y) }
    private func flip(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: bounds.height - r.maxY, width: r.width, height: r.height) }

    private var motionScale: CGFloat { reduceMotion ? 0 : 1 }

    // MARK: Setup

    private func setupLayers() {
        guard let root = layer else { return }
        for shape in [spotlight, halo, glow, fill, ring, orbit, arrowGlow, arrow, arrowHead, comet, dropTarget, alsoBox, leader] {
            shape.contentsScale = window?.backingScaleFactor ?? 2
            shape.fillColor = nil
            shape.lineCap = .round
            shape.lineJoin = .round
            shape.isHidden = true
            root.addSublayer(shape)
        }
        spotlight.fillRule = .evenOdd
        spotlight.fillColor = NSColor.black.withAlphaComponent(0.42).cgColor
        spotlight.opacity = 0
        spotlight.isHidden = false

        halo.lineWidth = 5
        glow.lineWidth = 6
        fill.lineWidth = 0
        ring.lineWidth = 2
        orbit.lineWidth = 2.4
        arrowGlow.lineWidth = 7
        arrow.lineWidth = 2.6
        comet.lineWidth = 1.8
        dropTarget.lineWidth = 2
        dropTarget.lineDashPattern = [7, 5]
        alsoBox.lineWidth = 1.6
        alsoBox.lineDashPattern = [6, 6]
        leader.lineWidth = 1
        leader.lineDashPattern = [3, 4]
        restyle()
    }

    private func restyle() {
        let color = accent.cgColor
        halo.strokeColor = NSColor.black.withAlphaComponent(increaseContrast ? 0.7 : 0.35).cgColor
        glow.strokeColor = accent.withAlphaComponent(0.2).cgColor
        glow.shadowColor = color
        glow.shadowOpacity = 0.3
        glow.shadowRadius = 7
        glow.shadowOffset = .zero
        fill.fillColor = accent.withAlphaComponent(0.05).cgColor
        ring.strokeColor = color
        orbit.strokeColor = NSColor.white.withAlphaComponent(0.9).cgColor
        arrowGlow.strokeColor = accent.withAlphaComponent(0.14).cgColor
        arrow.strokeColor = accent.withAlphaComponent(0.85).cgColor
        arrowHead.fillColor = color
        comet.strokeColor = NSColor.white.withAlphaComponent(0.9).cgColor
        dropTarget.strokeColor = accent.withAlphaComponent(0.9).cgColor
        dropTarget.fillColor = accent.withAlphaComponent(0.04).cgColor
        alsoBox.strokeColor = accent.withAlphaComponent(0.6).cgColor
        leader.strokeColor = accent.withAlphaComponent(0.55).cgColor
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        layer?.sublayers?.forEach { $0.contentsScale = scale }
    }

    func setScreenshot(_ image: CGImage?, pixelsPerPoint: CGFloat) {
        screenshot = image
        self.pixelsPerPoint = max(1, pixelsPerPoint)
    }

    // MARK: Present

    /// Show a step. Same-kind geometry glides; a new kind draws in.
    func present(_ next: TeachScene?, animated: Bool = true) {
        let previous = scene
        scene = next
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        clearDrawings()
        removeGhost()

        guard let next, next.hasTarget || !next.drawings.isEmpty || next.also != nil else {
            hideTarget()
            hideArrow()
            alsoBox.isHidden = true
            alsoTag?.removeFromSuperlayer(); alsoTag = nil
            tagLayer?.removeFromSuperlayer(); tagLayer = nil; tagRect = nil
            setSpotlight(nil)
            return
        }

        let glide = animated && previous?.kind == next.kind && previous?.hasTarget == true && motionScale > 0
        switch next.kind {
        case "arrow":
            hideTarget()
            presentArrow(next, redraw: !glide)
        case "ring", "box":
            hideArrow()
            presentTarget(next, glide: glide, redraw: !glide)
        default:
            hideTarget()
            hideArrow()
        }
        presentAlso(next)
        presentTag(next)
        presentDrawings(next)
        if let ghost = next.drawings.first(where: { $0.kind == "ghost" }), next.hasTarget {
            _ = ghost
            startGhostLoop(for: next)
        }
        if thinking { setThinking(true) }
    }

    /// The window moved (or scrolled) under a step: carry every mark along by the same amount instead
    /// of drawing the step again, so nothing blinks, re-animates or re-crops while it follows.
    /// `shifted` is the same scene with its geometry already moved, in overlay-local points.
    func translate(to shifted: TeachScene, dx: CGFloat, dy: CGFloat) {
        guard scene != nil else { return present(shifted, animated: false) }
        scene = shifted
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let marks: [CALayer] = [halo, glow, fill, ring, orbit, arrowGlow, arrow, arrowHead, comet, dropTarget, alsoBox, leader]
            + (tagLayer.map { [$0] } ?? []) + (alsoTag.map { [$0] } ?? []) + (ghost.map { [$0] } ?? []) + drawingLayers
        // Scene points run top-down; layers run bottom-up.
        for mark in marks { mark.position = CGPoint(x: mark.position.x + dx, y: mark.position.y - dy) }
        tagRect = tagRect?.offsetBy(dx: dx, dy: dy)
        if let hole = shifted.drawings.first(where: { $0.kind == "spotlight" })?.rect, spotlight.opacity > 0 {
            let path = CGMutablePath()
            path.addRect(bounds)
            path.addPath(CGPath(roundedRect: flip(hole.insetBy(dx: -10, dy: -10)), cornerWidth: 12, cornerHeight: 12, transform: nil))
            spotlight.path = path
        }
    }

    private func hideTarget() {
        for shape in [halo, glow, fill, ring, orbit] { shape.isHidden = true; shape.removeAllAnimations() }
    }

    private func hideArrow() {
        for shape in [arrowGlow, arrow, arrowHead, comet, dropTarget] { shape.isHidden = true; shape.removeAllAnimations() }
    }

    private func targetPath(for scene: TeachScene) -> CGPath {
        let r = flip(scene.rect)
        let radius = scene.kind == "box" ? 12 : min(r.width, r.height) / 2
        return CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }

    private func presentTarget(_ scene: TeachScene, glide: Bool, redraw: Bool) {
        let path = targetPath(for: scene)
        let layers = [halo, glow, fill, ring, orbit]
        for shape in layers { shape.isHidden = false }
        halo.isHidden = !increaseContrast
        orbit.isHidden = !thinking

        if glide, let old = ring.presentation()?.path ?? ring.path {
            for shape in layers {
                let morph = CASpringAnimation(keyPath: "path")
                morph.fromValue = old
                morph.toValue = path
                morph.damping = 18
                morph.stiffness = 170
                morph.mass = 1
                morph.initialVelocity = 0
                morph.duration = morph.settlingDuration
                morph.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                shape.add(morph, forKey: "morph")
            }
        }
        for shape in layers { shape.path = path }

        ring.lineDashPattern = scene.provisional ? [6, 5] : nil
        ring.opacity = scene.provisional ? 0.7 : 1
        glow.opacity = scene.provisional ? 0.5 : 1

        if redraw {
            ring.removeAnimation(forKey: "drawIn")
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.6 * Double(motionScale)
            drawIn.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ring.add(drawIn, forKey: "drawIn")
            let pop = CABasicAnimation(keyPath: "opacity")
            pop.fromValue = 0
            pop.toValue = glow.opacity
            pop.duration = 0.45 * Double(motionScale)
            glow.add(pop, forKey: "fadeIn")
            fill.add(pop, forKey: "fadeIn")
        }
        startPulse()
    }

    private func startPulse() {
        glow.removeAnimation(forKey: "pulse")
        ring.removeAnimation(forKey: "pulse")
        guard motionScale > 0 else { return }
        let breathe = CABasicAnimation(keyPath: "lineWidth")
        breathe.fromValue = 5
        breathe.toValue = 8
        breathe.duration = 1.8
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glow.add(breathe, forKey: "pulse")
        let shimmer = CABasicAnimation(keyPath: "shadowOpacity")
        shimmer.fromValue = 0.18
        shimmer.toValue = 0.4
        shimmer.duration = 1.8
        shimmer.autoreverses = true
        shimmer.repeatCount = .infinity
        shimmer.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glow.add(shimmer, forKey: "pulseShadow")
    }

    private func arrowPath(from: CGPoint, to: CGPoint) -> (path: CGPath, control: CGPoint) {
        let a = flip(from)
        let b = flip(to)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let length = max(1, hypot(dx, dy))
        let control = CGPoint(x: (a.x + b.x) / 2 + (-dy / length) * length * 0.18,
                              y: (a.y + b.y) / 2 + (dx / length) * length * 0.18)
        let path = CGMutablePath()
        path.move(to: a)
        path.addQuadCurve(to: b, control: control)
        return (path, control)
    }

    private func presentArrow(_ scene: TeachScene, redraw: Bool) {
        guard let to = scene.to else { hideArrow(); return }
        let built = arrowPath(from: scene.from, to: to)
        for shape in [arrowGlow, arrow, arrowHead, comet, dropTarget] { shape.isHidden = false }
        arrowGlow.path = built.path
        arrow.path = built.path
        comet.path = built.path

        let tip = flip(to)
        let angle = atan2(tip.y - built.control.y, tip.x - built.control.x)
        let wing = CGPoint(x: tip.x - cos(angle) * 17, y: tip.y - sin(angle) * 17)
        let head = CGMutablePath()
        head.move(to: tip)
        head.addLine(to: CGPoint(x: wing.x + cos(angle + .pi / 2) * 7, y: wing.y + sin(angle + .pi / 2) * 7))
        head.addLine(to: CGPoint(x: wing.x - cos(angle + .pi / 2) * 7, y: wing.y - sin(angle + .pi / 2) * 7))
        head.closeSubpath()
        arrowHead.path = head

        let drop = CGRect(x: tip.x - 32, y: tip.y - 23, width: 64, height: 46)
        dropTarget.path = CGPath(roundedRect: drop, cornerWidth: 8, cornerHeight: 8, transform: nil)

        if redraw, motionScale > 0 {
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.65
            drawIn.timingFunction = CAMediaTimingFunction(name: .easeOut)
            arrow.add(drawIn, forKey: "drawIn")
            arrowGlow.add(drawIn, forKey: "drawIn")
            let late = CABasicAnimation(keyPath: "opacity")
            late.fromValue = 0
            late.toValue = 1
            late.beginTime = CACurrentMediaTime() + 0.45
            late.duration = 0.25
            late.fillMode = .backwards
            arrowHead.add(late, forKey: "fadeIn")
            dropTarget.add(late, forKey: "fadeIn")
        }

        comet.removeAllAnimations()
        dropTarget.removeAnimation(forKey: "march")
        guard motionScale > 0 else { comet.isHidden = true; return }
        let start = CABasicAnimation(keyPath: "strokeStart")
        start.fromValue = -0.22
        start.toValue = 1
        let end = CABasicAnimation(keyPath: "strokeEnd")
        end.fromValue = 0
        end.toValue = 1.22
        let group = CAAnimationGroup()
        group.animations = [start, end]
        group.duration = 1.6
        group.repeatCount = .infinity
        group.beginTime = CACurrentMediaTime() + (redraw ? 0.7 : 0)
        comet.add(group, forKey: "comet")
        let march = CABasicAnimation(keyPath: "lineDashPhase")
        march.fromValue = 0
        march.toValue = -24
        march.duration = 0.9
        march.repeatCount = .infinity
        dropTarget.add(march, forKey: "march")
    }

    private func presentAlso(_ scene: TeachScene) {
        alsoTag?.removeFromSuperlayer()
        alsoTag = nil
        guard let also = scene.also else { alsoBox.isHidden = true; alsoBox.removeAllAnimations(); return }
        alsoBox.isHidden = false
        alsoBox.path = CGPath(roundedRect: flip(also), cornerWidth: 10, cornerHeight: 10, transform: nil)
        if motionScale > 0 {
            let march = CABasicAnimation(keyPath: "lineDashPhase")
            march.fromValue = 0
            march.toValue = -24
            march.duration = 1.2
            march.repeatCount = .infinity
            alsoBox.add(march, forKey: "march")
        }
        if let text = scene.alsoLabel, !text.isEmpty {
            let pill = makePill(text: text, dot: false, fontSize: 11)
            let above = also.minY - 24 < 4
            let origin = CGPoint(x: also.minX + 6, y: above ? also.maxY + 6 : also.minY - pill.bounds.height - 6)
            pill.frame.origin = flip(CGRect(origin: origin, size: pill.bounds.size)).origin
            layer?.addSublayer(pill)
            alsoTag = pill
        }
    }

    private func presentTag(_ scene: TeachScene) {
        tagLayer?.removeFromSuperlayer()
        tagLayer = nil
        tagRect = nil
        leader.isHidden = true
        let hasLabel = !(scene.label ?? "").isEmpty
        guard scene.hasTarget, hasLabel || !scene.keys.isEmpty else { return }
        let container = CALayer()
        var x: CGFloat = 0
        var height: CGFloat = 0
        if hasLabel {
            let pill = makePill(text: scene.label ?? "", dot: true, fontSize: 13)
            pill.frame.origin = .zero
            container.addSublayer(pill)
            x = pill.bounds.width + 8
            height = pill.bounds.height
        }
        if !scene.keys.isEmpty {
            let caps = makeKeyCaps(scene.keys)
            caps.frame.origin = CGPoint(x: x, y: (height - caps.bounds.height) / 2)
            container.addSublayer(caps)
            x += caps.bounds.width
            height = max(height, caps.bounds.height)
        }
        container.bounds = CGRect(x: 0, y: 0, width: x, height: height)

        let anchor = tagAnchor(for: scene, size: container.bounds.size)
        let frame = CGRect(x: anchor.x - x / 2, y: anchor.y - height / 2, width: x, height: height)
        container.frame = flip(frame)
        layer?.addSublayer(container)
        tagLayer = container
        tagRect = frame

        // When the tag had to move away from the ring, a hairline keeps them attached.
        let pivot = scene.kind == "arrow" && scene.to != nil
            ? CGPoint(x: (scene.from.x + scene.to!.x) / 2, y: (scene.from.y + scene.to!.y) / 2)
            : CGPoint(x: scene.rect.midX, y: scene.rect.midY)
        if hypot(anchor.x - pivot.x, anchor.y - pivot.y) > 110 {
            let path = CGMutablePath()
            path.move(to: flip(pivot))
            path.addLine(to: flip(anchor))
            leader.path = path
            leader.isHidden = false
        }
        if motionScale > 0 {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.35
            fade.beginTime = CACurrentMediaTime() + 0.15
            fade.fillMode = .backwards
            container.add(fade, forKey: "fadeIn")
            let rise = CABasicAnimation(keyPath: "position.y")
            rise.fromValue = container.position.y - 6
            rise.toValue = container.position.y
            rise.duration = 0.35
            rise.beginTime = fade.beginTime
            rise.fillMode = .backwards
            rise.timingFunction = CAMediaTimingFunction(name: .easeOut)
            container.add(rise, forKey: "rise")
        }
    }

    private func tagAnchor(for scene: TeachScene, size: CGSize) -> CGPoint {
        var anchor: CGPoint
        if scene.kind == "arrow", let to = scene.to {
            let mid = CGPoint(x: (scene.from.x + to.x) / 2, y: (scene.from.y + to.y) / 2)
            let dx = to.x - scene.from.x
            let dy = to.y - scene.from.y
            let length = max(1, hypot(dx, dy))
            anchor = CGPoint(x: mid.x + (-dy / length) * 30, y: mid.y + (dx / length) * 30)
        } else {
            let above = scene.rect.minY - 14 - size.height / 2
            anchor = CGPoint(x: scene.rect.midX, y: above < 26 ? scene.rect.maxY + 14 + size.height / 2 : above)
        }
        anchor.x = min(max(size.width / 2 + 8, anchor.x), bounds.width - size.width / 2 - 8)
        anchor.y = min(max(size.height / 2 + 8, anchor.y), bounds.height - size.height / 2 - 8)
        return anchor
    }

    // MARK: Drawings

    private func clearDrawings() {
        for layer in drawingLayers { layer.removeFromSuperlayer() }
        drawingLayers = []
        setSpotlight(nil)
    }

    private func presentDrawings(_ scene: TeachScene) {
        var index = 0
        for drawing in scene.drawings.prefix(4) {
            let made: CALayer?
            switch drawing.kind {
            case "callout": made = makeCallout(drawing)
            case "badge": made = makeBadge(drawing)
            case "bracket": made = makeBracket(drawing)
            case "underline": made = makeUnderline(drawing)
            case "flow": made = makeFlow(drawing)
            case "measure": made = makeMeasure(drawing)
            case "spotlight": setSpotlight(drawing.rect); made = nil
            case "lens": made = makeLens(drawing)
            case "sketch": made = makeSketch(drawing)
            case "typing": made = makeTyping(drawing)
            case "scroll": made = makeScroll(drawing)
            default: made = nil
            }
            guard let made else { continue }
            layer?.addSublayer(made)
            drawingLayers.append(made)
            if motionScale > 0 {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0
                fade.toValue = 1
                fade.duration = 0.4
                fade.beginTime = CACurrentMediaTime() + 0.35 + Double(index) * 0.09
                fade.fillMode = .backwards
                made.add(fade, forKey: "fadeIn")
                let scale = CABasicAnimation(keyPath: "transform.scale")
                scale.fromValue = 0.92
                scale.toValue = 1
                scale.duration = 0.4
                scale.beginTime = fade.beginTime
                scale.fillMode = .backwards
                scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
                made.add(scale, forKey: "pop")
            }
            index += 1
        }
    }

    private func setSpotlight(_ hole: CGRect?) {
        guard let hole else {
            spotlight.removeAllAnimations()
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = spotlight.presentation()?.opacity ?? spotlight.opacity
            fade.toValue = 0
            fade.duration = 0.3 * Double(motionScale)
            spotlight.add(fade, forKey: "fade")
            spotlight.opacity = 0
            return
        }
        let path = CGMutablePath()
        path.addRect(bounds)
        path.addPath(CGPath(roundedRect: flip(hole.insetBy(dx: -10, dy: -10)), cornerWidth: 12, cornerHeight: 12, transform: nil))
        spotlight.path = path
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.45 * Double(motionScale)
        spotlight.add(fade, forKey: "fade")
        spotlight.opacity = 1
    }

    private func makeCallout(_ d: TeachDrawing) -> CALayer? {
        guard let text = d.text, !text.isEmpty else { return nil }
        let point = CGPoint(x: d.rect.midX, y: d.rect.midY)
        let card = makeCard(text: text, maxWidth: 240, fontSize: 12.5)
        var origin = CGPoint(x: point.x + 26, y: point.y - card.bounds.height - 26)
        if origin.x + card.bounds.width > bounds.width - 12 { origin.x = point.x - card.bounds.width - 26 }
        if origin.y < 12 { origin.y = point.y + 26 }
        origin.x = max(12, origin.x)
        let group = CALayer()
        card.frame = flip(CGRect(origin: origin, size: card.bounds.size))
        let line = CAShapeLayer()
        line.strokeColor = accent.withAlphaComponent(0.85).cgColor
        line.lineWidth = 1.5
        line.fillColor = nil
        line.lineCap = .round
        let cardRect = CGRect(origin: origin, size: card.bounds.size)
        let nearest = CGPoint(x: min(max(point.x, cardRect.minX), cardRect.maxX), y: min(max(point.y, cardRect.minY), cardRect.maxY))
        let path = CGMutablePath()
        path.move(to: flip(nearest))
        path.addLine(to: flip(point))
        line.path = path
        let dot = CAShapeLayer()
        dot.path = CGPath(ellipseIn: CGRect(x: flip(point).x - 4, y: flip(point).y - 4, width: 8, height: 8), transform: nil)
        dot.fillColor = accent.cgColor
        group.addSublayer(line)
        group.addSublayer(dot)
        group.addSublayer(card)
        return group
    }

    private func makeBadge(_ d: TeachDrawing) -> CALayer? {
        let n = d.n ?? 1
        let size: CGFloat = 24
        let point = CGPoint(x: d.rect.midX, y: d.rect.midY)
        let badge = CALayer()
        badge.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        badge.cornerRadius = size / 2
        badge.backgroundColor = accent.cgColor
        badge.shadowColor = NSColor.black.cgColor
        badge.shadowOpacity = 0.3
        badge.shadowRadius = 4
        badge.shadowOffset = CGSize(width: 0, height: -1)
        let text = makeText("\(n)", fontSize: 13, weight: .bold, color: .black)
        text.frame = CGRect(x: (size - text.bounds.width) / 2, y: (size - text.bounds.height) / 2, width: text.bounds.width, height: text.bounds.height)
        badge.addSublayer(text)
        // Sits at the top-left corner of the thing, like a numbered sticker.
        let origin = d.rect.width > 30 ? CGPoint(x: d.rect.minX - size / 2, y: d.rect.minY - size / 2) : CGPoint(x: point.x - size / 2, y: point.y - size - 10)
        badge.frame = flip(CGRect(origin: origin, size: badge.bounds.size))
        return badge
    }

    private func makeBracket(_ d: TeachDrawing) -> CALayer? {
        let r = d.rect.insetBy(dx: -6, dy: -6)
        let group = CALayer()
        let shape = CAShapeLayer()
        shape.strokeColor = accent.cgColor
        shape.fillColor = nil
        shape.lineWidth = 2
        shape.lineCap = .round
        let path = CGMutablePath()
        let horizontal = r.width >= r.height
        if horizontal {
            let y = r.minY - 8
            path.move(to: flip(CGPoint(x: r.minX, y: y + 7)))
            path.addLine(to: flip(CGPoint(x: r.minX, y: y)))
            path.addLine(to: flip(CGPoint(x: r.maxX, y: y)))
            path.addLine(to: flip(CGPoint(x: r.maxX, y: y + 7)))
            path.move(to: flip(CGPoint(x: r.midX, y: y)))
            path.addLine(to: flip(CGPoint(x: r.midX, y: y - 6)))
        } else {
            let x = r.minX - 8
            path.move(to: flip(CGPoint(x: x + 7, y: r.minY)))
            path.addLine(to: flip(CGPoint(x: x, y: r.minY)))
            path.addLine(to: flip(CGPoint(x: x, y: r.maxY)))
            path.addLine(to: flip(CGPoint(x: x + 7, y: r.maxY)))
            path.move(to: flip(CGPoint(x: x, y: r.midY)))
            path.addLine(to: flip(CGPoint(x: x - 6, y: r.midY)))
        }
        shape.path = path
        group.addSublayer(shape)
        if let text = d.text, !text.isEmpty {
            let pill = makePill(text: text, dot: false, fontSize: 11.5)
            let origin = horizontal
                ? CGPoint(x: r.midX - pill.bounds.width / 2, y: r.minY - 14 - 6 - pill.bounds.height)
                : CGPoint(x: r.minX - 14 - 6 - pill.bounds.width, y: r.midY - pill.bounds.height / 2)
            pill.frame = flip(CGRect(origin: clamp(origin, size: pill.bounds.size), size: pill.bounds.size))
            group.addSublayer(pill)
        }
        if motionScale > 0 {
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.5
            shape.add(drawIn, forKey: "drawIn")
        }
        return group
    }

    private func makeUnderline(_ d: TeachDrawing) -> CALayer? {
        let shape = CAShapeLayer()
        shape.strokeColor = accent.cgColor
        shape.fillColor = nil
        shape.lineWidth = 2.4
        shape.lineCap = .round
        let y = d.rect.maxY + 4
        let path = CGMutablePath()
        var x = d.rect.minX
        path.move(to: flip(CGPoint(x: x, y: y)))
        var seed: UInt32 = UInt32(abs(Int(d.rect.minX + d.rect.minY))) % 97
        while x < d.rect.maxX {
            let step = min(14, d.rect.maxX - x)
            seed = (seed &* 1103515245 &+ 12345) & 0x7fffffff
            let wobble = CGFloat(Int(seed % 5)) - 2
            x += step
            path.addLine(to: flip(CGPoint(x: x, y: y + wobble * 0.6)))
        }
        shape.path = path
        if motionScale > 0 {
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.45
            shape.add(drawIn, forKey: "drawIn")
        }
        return shape
    }

    private func makeFlow(_ d: TeachDrawing) -> CALayer? {
        guard let to = d.to else { return nil }
        let from = CGPoint(x: d.rect.midX, y: d.rect.midY)
        let built = arrowPath(from: from, to: to)
        let group = CALayer()
        let shaft = CAShapeLayer()
        shaft.path = built.path
        shaft.strokeColor = accent.withAlphaComponent(0.85).cgColor
        shaft.fillColor = nil
        shaft.lineWidth = 2.2
        shaft.lineCap = .round
        shaft.lineDashPattern = [8, 6]
        let tip = flip(to)
        let angle = atan2(tip.y - built.control.y, tip.x - built.control.x)
        let wing = CGPoint(x: tip.x - cos(angle) * 13, y: tip.y - sin(angle) * 13)
        let head = CGMutablePath()
        head.move(to: tip)
        head.addLine(to: CGPoint(x: wing.x + cos(angle + .pi / 2) * 5.5, y: wing.y + sin(angle + .pi / 2) * 5.5))
        head.addLine(to: CGPoint(x: wing.x - cos(angle + .pi / 2) * 5.5, y: wing.y - sin(angle + .pi / 2) * 5.5))
        head.closeSubpath()
        let headLayer = CAShapeLayer()
        headLayer.path = head
        headLayer.fillColor = accent.cgColor
        group.addSublayer(shaft)
        group.addSublayer(headLayer)
        if let text = d.text, !text.isEmpty {
            let pill = makePill(text: text, dot: false, fontSize: 11.5)
            let mid = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
            let dx = to.x - from.x, dy = to.y - from.y
            let length = max(1, hypot(dx, dy))
            let anchor = CGPoint(x: mid.x + (-dy / length) * 22, y: mid.y + (dx / length) * 22)
            let origin = clamp(CGPoint(x: anchor.x - pill.bounds.width / 2, y: anchor.y - pill.bounds.height / 2), size: pill.bounds.size)
            pill.frame = flip(CGRect(origin: origin, size: pill.bounds.size))
            group.addSublayer(pill)
        }
        if motionScale > 0 {
            let march = CABasicAnimation(keyPath: "lineDashPhase")
            march.fromValue = 0
            march.toValue = -28
            march.duration = 1.1
            march.repeatCount = .infinity
            shaft.add(march, forKey: "march")
        }
        return group
    }

    private func makeMeasure(_ d: TeachDrawing) -> CALayer? {
        guard let to = d.to else { return nil }
        let from = CGPoint(x: d.rect.midX, y: d.rect.midY)
        let group = CALayer()
        let shape = CAShapeLayer()
        shape.strokeColor = accent.cgColor
        shape.fillColor = nil
        shape.lineWidth = 1.5
        shape.lineCap = .round
        let dx = to.x - from.x, dy = to.y - from.y
        let length = max(1, hypot(dx, dy))
        let nx = -dy / length, ny = dx / length
        let path = CGMutablePath()
        path.move(to: flip(from))
        path.addLine(to: flip(to))
        for p in [from, to] {
            path.move(to: flip(CGPoint(x: p.x + nx * 6, y: p.y + ny * 6)))
            path.addLine(to: flip(CGPoint(x: p.x - nx * 6, y: p.y - ny * 6)))
        }
        shape.path = path
        group.addSublayer(shape)
        if let text = d.text, !text.isEmpty {
            let pill = makePill(text: text, dot: false, fontSize: 11)
            let mid = CGPoint(x: (from.x + to.x) / 2 + nx * 16, y: (from.y + to.y) / 2 + ny * 16)
            let origin = clamp(CGPoint(x: mid.x - pill.bounds.width / 2, y: mid.y - pill.bounds.height / 2), size: pill.bounds.size)
            pill.frame = flip(CGRect(origin: origin, size: pill.bounds.size))
            group.addSublayer(pill)
        }
        return group
    }

    private func makeLens(_ d: TeachDrawing) -> CALayer? {
        guard let screenshot else { return nil }
        let center = CGPoint(x: d.rect.midX, y: d.rect.midY)
        let zoom: CGFloat = 2.2
        let size: CGFloat = 132
        let source = size / zoom
        let crop = CGRect(x: (center.x - source / 2) * pixelsPerPoint, y: (center.y - source / 2) * pixelsPerPoint,
                          width: source * pixelsPerPoint, height: source * pixelsPerPoint)
        guard let image = screenshot.cropping(to: crop.integral) else { return nil }
        let lens = CALayer()
        lens.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        lens.cornerRadius = size / 2
        lens.masksToBounds = true
        lens.contents = image
        lens.contentsGravity = .resizeAspectFill
        lens.borderColor = accent.cgColor
        lens.borderWidth = 2
        let holder = CALayer()
        holder.shadowColor = NSColor.black.cgColor
        holder.shadowOpacity = 0.3
        holder.shadowRadius = 8
        holder.shadowOffset = CGSize(width: 0, height: -2)
        var origin = CGPoint(x: center.x + 30, y: center.y - size - 30)
        if origin.y < 8 { origin.y = center.y + 30 }
        if origin.x + size > bounds.width - 8 { origin.x = center.x - size - 30 }
        let frame = CGRect(origin: origin, size: CGSize(width: size, height: size))
        lens.frame = flip(frame)
        holder.addSublayer(lens)
        let connector = CAShapeLayer()
        connector.strokeColor = accent.withAlphaComponent(0.7).cgColor
        connector.lineWidth = 1.2
        connector.fillColor = nil
        let path = CGMutablePath()
        path.move(to: flip(center))
        path.addLine(to: flip(CGPoint(x: frame.midX, y: frame.midY)))
        connector.path = path
        holder.insertSublayer(connector, at: 0)
        // A tiny ring on the real icon so the eye links the two.
        let mini = CAShapeLayer()
        mini.path = CGPath(ellipseIn: CGRect(x: flip(center).x - 12, y: flip(center).y - 12, width: 24, height: 24), transform: nil)
        mini.strokeColor = accent.cgColor
        mini.fillColor = nil
        mini.lineWidth = 1.5
        holder.addSublayer(mini)
        return holder
    }

    private func makeSketch(_ d: TeachDrawing) -> CALayer? {
        let shape = CAShapeLayer()
        shape.strokeColor = accent.withAlphaComponent(0.9).cgColor
        shape.fillColor = nil
        shape.lineWidth = 2.2
        shape.lineCap = .round
        let r = d.rect.insetBy(dx: -10, dy: -8)
        let path = CGMutablePath()
        var seed: UInt32 = UInt32(abs(Int(r.minX * 3 + r.minY))) % 89
        func jitter() -> CGFloat {
            seed = (seed &* 1103515245 &+ 12345) & 0x7fffffff
            return CGFloat(Int(seed % 7)) - 3
        }
        let steps = 40
        for loop in 0..<2 {
            for i in 0...steps {
                let t = CGFloat(i) / CGFloat(steps) * 2 * .pi + CGFloat(loop) * 0.25
                let p = CGPoint(x: r.midX + cos(t) * (r.width / 2 + jitter()), y: r.midY + sin(t) * (r.height / 2 + jitter()))
                if loop == 0 && i == 0 { path.move(to: flip(p)) } else { path.addLine(to: flip(p)) }
            }
        }
        shape.path = path
        if motionScale > 0 {
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.8
            drawIn.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            shape.add(drawIn, forKey: "drawIn")
        }
        return shape
    }

    private func makeTyping(_ d: TeachDrawing) -> CALayer? {
        guard let text = d.text, !text.isEmpty else { return nil }
        let card = makePill(text: "type: \(text)", dot: false, fontSize: 12, mono: true)
        let caret = CALayer()
        caret.backgroundColor = accent.cgColor
        caret.frame = CGRect(x: card.bounds.width - 10, y: 7, width: 1.5, height: card.bounds.height - 14)
        card.addSublayer(caret)
        if motionScale > 0 {
            let blink = CABasicAnimation(keyPath: "opacity")
            blink.fromValue = 1
            blink.toValue = 0
            blink.duration = 0.55
            blink.autoreverses = true
            blink.repeatCount = .infinity
            caret.add(blink, forKey: "blink")
        }
        let origin = clamp(CGPoint(x: d.rect.midX - card.bounds.width / 2, y: d.rect.maxY + 14), size: card.bounds.size)
        card.frame = flip(CGRect(origin: origin, size: card.bounds.size))
        return card
    }

    private func makeScroll(_ d: TeachDrawing) -> CALayer? {
        let down = (d.text ?? "down").lowercased().contains("down")
        let group = CALayer()
        let center = CGPoint(x: d.rect.midX, y: d.rect.midY)
        for i in 0..<3 {
            let chevron = CAShapeLayer()
            chevron.strokeColor = accent.cgColor
            chevron.fillColor = nil
            chevron.lineWidth = 3
            chevron.lineCap = .round
            chevron.lineJoin = .round
            let y = center.y + CGFloat(i - 1) * 16 * (down ? 1 : -1)
            let path = CGMutablePath()
            let dir: CGFloat = down ? 1 : -1
            path.move(to: flip(CGPoint(x: center.x - 11, y: y - 5 * dir)))
            path.addLine(to: flip(CGPoint(x: center.x, y: y + 5 * dir)))
            path.addLine(to: flip(CGPoint(x: center.x + 11, y: y - 5 * dir)))
            chevron.path = path
            group.addSublayer(chevron)
            if motionScale > 0 {
                let wave = CABasicAnimation(keyPath: "opacity")
                wave.fromValue = 0.25
                wave.toValue = 1
                wave.duration = 0.5
                wave.autoreverses = true
                wave.repeatCount = .infinity
                wave.beginTime = CACurrentMediaTime() + Double(i) * 0.18
                chevron.add(wave, forKey: "wave")
            }
        }
        return group
    }

    // MARK: Ghost cursor

    private func removeGhost() {
        ghost?.removeFromSuperlayer()
        ghost = nil
    }

    /// A looping pantomime of the step: the cursor glides in, clicks (or drags), and fades.
    private func startGhostLoop(for scene: TeachScene) {
        guard motionScale > 0 else { return }
        let start: CGPoint
        let end: CGPoint
        if scene.kind == "arrow", let to = scene.to {
            start = scene.from
            end = to
        } else {
            start = CGPoint(x: min(bounds.width - 40, scene.center.x + 150), y: min(bounds.height - 40, scene.center.y + 110))
            end = scene.center
        }
        ghost = makeGhost(from: start, to: end, repeats: true, duration: scene.kind == "arrow" ? 1.6 : 1.1)
    }

    /// One pass of the ghost cursor: the walk-through when they're stuck, and right before okidoki does a step for them.
    func demoGhostOnce(to: CGPoint, from: CGPoint?) {
        removeGhost()
        let start = from ?? CGPoint(x: min(bounds.width - 40, to.x + 150), y: min(bounds.height - 40, to.y + 110))
        ghost = makeGhost(from: start, to: to, repeats: false, duration: 0.8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            self?.removeGhost()
        }
    }

    private func makeGhost(from: CGPoint, to: CGPoint, repeats: Bool, duration: Double) -> CALayer {
        let group = CALayer()
        layer?.addSublayer(group)
        let image = NSCursor.arrow.image
        let cursor = CALayer()
        cursor.contents = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        cursor.contentsGravity = .resizeAspect
        cursor.bounds = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
        cursor.anchorPoint = CGPoint(x: 0.2, y: 0.95)
        cursor.shadowColor = NSColor.black.cgColor
        cursor.shadowOpacity = 0.35
        cursor.shadowRadius = 3
        cursor.shadowOffset = CGSize(width: 0, height: -1)
        cursor.position = flip(from)
        group.addSublayer(cursor)

        let ripple = CAShapeLayer()
        ripple.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
        ripple.strokeColor = accent.cgColor
        ripple.fillColor = accent.withAlphaComponent(0.14).cgColor
        ripple.lineWidth = 1.6
        ripple.position = flip(to)
        ripple.opacity = 0
        group.addSublayer(ripple)

        let total = duration + 1.2
        let path = CGMutablePath()
        let a = flip(from), b = flip(to)
        let dx = b.x - a.x, dy = b.y - a.y
        let length = max(1, hypot(dx, dy))
        path.move(to: a)
        path.addQuadCurve(to: b, control: CGPoint(x: (a.x + b.x) / 2 + (-dy / length) * min(60, length * 0.15),
                                                  y: (a.y + b.y) / 2 + (dx / length) * min(60, length * 0.15)))
        let move = CAKeyframeAnimation(keyPath: "position")
        move.path = path
        move.duration = duration
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        move.fillMode = .forwards
        let hold = CABasicAnimation(keyPath: "position")
        hold.fromValue = b
        hold.toValue = b
        hold.beginTime = duration
        hold.duration = total - duration
        let appear = CAKeyframeAnimation(keyPath: "opacity")
        appear.values = [0, 1, 1, 1, 0]
        appear.keyTimes = [0, 0.1, 0.75, 0.9, 1].map { NSNumber(value: $0) }
        appear.duration = total
        let cursorGroup = CAAnimationGroup()
        cursorGroup.animations = [move, hold, appear]
        cursorGroup.duration = total
        cursorGroup.repeatCount = repeats ? .infinity : 1
        cursorGroup.isRemovedOnCompletion = false
        cursorGroup.fillMode = .forwards
        cursor.add(cursorGroup, forKey: "pantomime")

        let click = CAKeyframeAnimation(keyPath: "transform.scale")
        click.values = [0.3, 1, 1.5]
        click.keyTimes = [0, 0.5, 1]
        click.duration = 0.5
        click.beginTime = duration
        let clickFade = CAKeyframeAnimation(keyPath: "opacity")
        clickFade.values = [0, 1, 0]
        clickFade.keyTimes = [0, 0.3, 1]
        clickFade.duration = 0.5
        clickFade.beginTime = duration
        let rippleGroup = CAAnimationGroup()
        rippleGroup.animations = [click, clickFade]
        rippleGroup.duration = total
        rippleGroup.repeatCount = repeats ? .infinity : 1
        ripple.add(rippleGroup, forKey: "click")
        return group
    }

    // MARK: Thinking, guide, pointer, celebrate

    /// While the tutor looks at the screen the marks dim and a small arc orbits the ring.
    func setThinking(_ on: Bool) {
        thinking = on
        let targets: [CALayer] = [halo, glow, fill, ring, arrowGlow, arrow, arrowHead, comet, dropTarget, alsoBox, leader] + (tagLayer.map { [$0] } ?? []) + (alsoTag.map { [$0] } ?? []) + drawingLayers
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        for target in targets { target.opacity = on ? 0.42 : (target === ring && scene?.provisional == true ? 0.7 : 1) }
        CATransaction.commit()
        orbit.removeAllAnimations()
        guard on, let scene, scene.kind == "ring" || scene.kind == "box", motionScale > 0 else {
            orbit.isHidden = true
            return
        }
        orbit.isHidden = false
        orbit.path = ring.path
        let r = scene.rect
        let perimeter = scene.kind == "box" ? 2 * (r.width + r.height) : .pi * (r.width + r.height) / 2
        let arc = max(18, perimeter * 0.16)
        orbit.lineDashPattern = [NSNumber(value: Double(arc)), NSNumber(value: Double(max(1, perimeter - arc)))]
        let spin = CABasicAnimation(keyPath: "lineDashPhase")
        spin.fromValue = 0
        spin.toValue = -perimeter
        spin.duration = 1.4
        spin.repeatCount = .infinity
        orbit.add(spin, forKey: "orbit")
    }

    /// A dot runs from the pointer to the control once, leaving a trail that fades behind it.
    func showGuide(from: CGPoint, to: CGPoint) {
        guard motionScale > 0 else { return }
        let a = flip(from), b = flip(to)
        let dx = b.x - a.x, dy = b.y - a.y
        let length = max(1, hypot(dx, dy))
        let bend = min(90, length * 0.16)
        let control = CGPoint(x: (a.x + b.x) / 2 + (-dy / length) * bend, y: (a.y + b.y) / 2 + (dx / length) * bend)
        let path = CGMutablePath()
        path.move(to: a)
        path.addQuadCurve(to: b, control: control)

        let trail = CAShapeLayer()
        trail.path = path
        trail.strokeColor = accent.withAlphaComponent(0.6).cgColor
        trail.fillColor = nil
        trail.lineWidth = 1.8
        trail.lineCap = .round
        trail.strokeEnd = 0
        let dot = CAShapeLayer()
        dot.path = CGPath(ellipseIn: CGRect(x: -5, y: -5, width: 10, height: 10), transform: nil)
        dot.fillColor = accent.cgColor
        dot.shadowColor = accent.cgColor
        dot.shadowOpacity = 0.4
        dot.shadowRadius = 4
        dot.shadowOffset = .zero
        dot.position = a
        layer?.addSublayer(trail)
        layer?.addSublayer(dot)
        transient.append(contentsOf: [trail, dot])

        let head = CABasicAnimation(keyPath: "strokeEnd")
        head.fromValue = 0
        head.toValue = 1
        head.duration = 0.8
        head.beginTime = CACurrentMediaTime() + 0.15
        head.fillMode = .forwards
        head.isRemovedOnCompletion = false
        head.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        let tail = CABasicAnimation(keyPath: "strokeStart")
        tail.fromValue = 0
        tail.toValue = 1
        tail.duration = 0.8
        tail.beginTime = CACurrentMediaTime() + 0.5
        tail.fillMode = .forwards
        tail.isRemovedOnCompletion = false
        tail.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        trail.add(head, forKey: "head")
        trail.add(tail, forKey: "tail")
        let move = CAKeyframeAnimation(keyPath: "position")
        move.path = path
        move.duration = 0.8
        move.beginTime = CACurrentMediaTime() + 0.15
        move.fillMode = .forwards
        move.isRemovedOnCompletion = false
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.add(move, forKey: "move")
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = CACurrentMediaTime() + 0.95
        fade.duration = 0.35
        fade.fillMode = .forwards
        fade.isRemovedOnCompletion = false
        dot.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            trail.removeFromSuperlayer()
            dot.removeFromSuperlayer()
            self?.transient.removeAll { $0 === trail || $0 === dot }
        }
    }

    func cancelGuide() {
        for layer in transient where layer is CAShapeLayer { layer.removeFromSuperlayer() }
        transient = []
    }

    /// Hover magnetism: as the pointer nears the ring it tightens and brightens; inside, it fills.
    func pointer(at point: CGPoint?) {
        guard let scene, scene.kind == "ring" || scene.kind == "box", !thinking else { return }
        let center = scene.center
        let distance = point.map { hypot($0.x - center.x, $0.y - center.y) } ?? 1000
        let inside = point.map { scene.rect.contains($0) } ?? false
        let near = max(0, min(1, 1 - (distance - 30) / 220))
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.18)
        fill.fillColor = accent.withAlphaComponent(inside ? 0.12 : 0.05 + 0.04 * near).cgColor
        ring.lineWidth = 2 + 0.6 * near
        glow.opacity = Float(0.75 + 0.25 * near) * (scene.provisional ? 0.5 : 1)
        CATransaction.commit()
    }

    /// A quick tick where the learner landed it.
    func celebrate(at point: CGPoint, big: Bool) {
        let size: CGFloat = big ? 64 : 34
        let p = flip(point)
        let disc = CAShapeLayer()
        disc.path = CGPath(ellipseIn: CGRect(x: -size / 2, y: -size / 2, width: size, height: size), transform: nil)
        disc.fillColor = accent.cgColor
        disc.shadowColor = accent.cgColor
        disc.shadowOpacity = 0.35
        disc.shadowRadius = big ? 10 : 6
        disc.shadowOffset = .zero
        disc.position = p
        let check = CAShapeLayer()
        let s = size * 0.5
        let mark = CGMutablePath()
        mark.move(to: CGPoint(x: -s * 0.42, y: 0.02 * s))
        mark.addLine(to: CGPoint(x: -s * 0.1, y: -s * 0.32))
        mark.addLine(to: CGPoint(x: s * 0.46, y: s * 0.34))
        check.path = mark
        check.strokeColor = NSColor.black.withAlphaComponent(0.85).cgColor
        check.fillColor = nil
        check.lineWidth = big ? 5 : 3
        check.lineCap = .round
        check.lineJoin = .round
        disc.addSublayer(check)
        layer?.addSublayer(disc)
        let rings = (0..<2).map { i -> CAShapeLayer in
            let ripple = CAShapeLayer()
            ripple.path = disc.path
            ripple.strokeColor = accent.withAlphaComponent(i == 0 ? 0.9 : 0.5).cgColor
            ripple.fillColor = nil
            ripple.lineWidth = i == 0 ? 2 : 1
            ripple.position = p
            layer?.addSublayer(ripple)
            return ripple
        }
        guard motionScale > 0 else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { disc.removeFromSuperlayer(); rings.forEach { $0.removeFromSuperlayer() } }
            return
        }
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.4
        pop.toValue = 1
        pop.damping = 9
        pop.stiffness = 220
        pop.duration = pop.settlingDuration
        disc.add(pop, forKey: "pop")
        let drawIn = CABasicAnimation(keyPath: "strokeEnd")
        drawIn.fromValue = 0
        drawIn.toValue = 1
        drawIn.duration = 0.3
        drawIn.beginTime = CACurrentMediaTime() + 0.08
        drawIn.fillMode = .backwards
        check.add(drawIn, forKey: "drawIn")
        let total = big ? 1.7 : 1.05
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = CACurrentMediaTime() + total * 0.7
        fade.duration = total * 0.3
        fade.fillMode = .forwards
        fade.isRemovedOnCompletion = false
        disc.add(fade, forKey: "fade")
        for (i, ripple) in rings.enumerated() {
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.7
            grow.toValue = (big ? 2.2 : 1.6) + CGFloat(i) * 0.7
            grow.duration = total
            grow.timingFunction = CAMediaTimingFunction(name: .easeOut)
            let vanish = CABasicAnimation(keyPath: "opacity")
            vanish.fromValue = 1
            vanish.toValue = 0
            vanish.duration = total
            let group = CAAnimationGroup()
            group.animations = [grow, vanish]
            group.duration = total
            group.fillMode = .forwards
            group.isRemovedOnCompletion = false
            ripple.add(group, forKey: "ripple")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + total + 0.1) {
            disc.removeFromSuperlayer()
            rings.forEach { $0.removeFromSuperlayer() }
        }
    }

    /// Circles for a concept beat that points at the real screen. Fade on their own.
    func flashPoints(_ points: [CGPoint]) {
        for point in points {
            let ring = CAShapeLayer()
            let p = flip(point)
            ring.path = CGPath(ellipseIn: CGRect(x: p.x - 28, y: p.y - 28, width: 56, height: 56), transform: nil)
            ring.strokeColor = accent.cgColor
            ring.fillColor = accent.withAlphaComponent(0.06).cgColor
            ring.lineWidth = 2
            ring.shadowColor = accent.cgColor
            ring.shadowOpacity = 0.3
            ring.shadowRadius = 6
            ring.shadowOffset = .zero
            layer?.addSublayer(ring)
            let drawIn = CABasicAnimation(keyPath: "strokeEnd")
            drawIn.fromValue = 0
            drawIn.toValue = 1
            drawIn.duration = 0.5 * Double(motionScale)
            ring.add(drawIn, forKey: "drawIn")
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.beginTime = CACurrentMediaTime() + 3.2
            fade.duration = 0.5
            fade.fillMode = .forwards
            fade.isRemovedOnCompletion = false
            ring.add(fade, forKey: "fade")
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.8) { ring.removeFromSuperlayer() }
        }
    }

    // MARK: Bubble

    /// Place the instruction bubble next to the target (or at a resting spot when there is none).
    func placeBubble(_ view: NSView, near scene: TeachScene?, animated: Bool) {
        if bubble.content !== view {
            bubble.content = view
        }
        bubble.isHidden = false
        let size = view.fittingSize
        var frame: CGRect
        if let scene, scene.hasTarget {
            // The thing being pointed at. For a drag that is the whole arrow, not just its tip.
            let target: CGRect
            if scene.kind == "arrow", let to = scene.to {
                target = CGRect(x: min(scene.from.x, to.x), y: min(scene.from.y, to.y),
                                width: abs(to.x - scene.from.x), height: abs(to.y - scene.from.y)).insetBy(dx: -30, dy: -30)
            } else {
                target = scene.rect
            }
            // Everything else drawn for this step is in the way too: the second region, callouts, badges, arrows.
            var obstacles = [target.insetBy(dx: -8, dy: -8)]
            if let also = scene.also { obstacles.append(also) }
            if let tagRect { obstacles.append(tagRect.insetBy(dx: -10, dy: -10)) }
            for drawing in scene.drawings where drawing.kind != "ghost" && drawing.kind != "spotlight" {
                var rect = drawing.rect
                if let to = drawing.to { rect = rect.union(CGRect(x: to.x, y: to.y, width: 1, height: 1)) }
                obstacles.append(rect.insetBy(dx: -12, dy: -12))
            }
            let gap: CGFloat = 22
            let candidates = [
                CGRect(x: target.maxX + gap, y: target.midY - size.height / 2, width: size.width, height: size.height),
                CGRect(x: target.minX - gap - size.width, y: target.midY - size.height / 2, width: size.width, height: size.height),
                CGRect(x: target.midX - size.width / 2, y: target.maxY + gap + 36, width: size.width, height: size.height),
                CGRect(x: target.midX - size.width / 2, y: target.minY - gap - 36 - size.height, width: size.width, height: size.height),
                CGRect(x: target.maxX + gap, y: target.maxY + gap, width: size.width, height: size.height),
                CGRect(x: target.minX - gap - size.width, y: target.maxY + gap, width: size.width, height: size.height),
                CGRect(x: target.maxX + gap, y: target.minY - gap - size.height, width: size.width, height: size.height),
                CGRect(x: target.minX - gap - size.width, y: target.minY - gap - size.height, width: size.width, height: size.height),
            ]
            let safe = bounds.insetBy(dx: 16, dy: 16)
            func overlap(_ candidate: CGRect) -> CGFloat {
                obstacles.reduce(0) { total, obstacle in
                    let cut = candidate.intersection(obstacle)
                    return total + (cut.isNull ? 0 : cut.width * cut.height)
                }
            }
            let onScreen = candidates.filter { safe.contains($0) }
            frame = onScreen.first(where: { overlap($0) == 0 })
                ?? onScreen.min(by: { overlap($0) < overlap($1) })
                ?? candidates[2]
            frame.origin.x = min(max(16, frame.minX), bounds.width - size.width - 16)
            frame.origin.y = min(max(16, frame.minY), bounds.height - size.height - 90)
            // Leader from the bubble's nearest edge to the ring.
            let from = CGPoint(x: min(max(target.midX, frame.minX), frame.maxX), y: min(max(target.midY, frame.minY), frame.maxY))
            let to = CGPoint(x: min(max(from.x, target.minX), target.maxX), y: min(max(from.y, target.minY), target.maxY))
            let path = CGMutablePath()
            path.move(to: flip(from))
            path.addLine(to: flip(to))
            bubbleLeader.path = path
            bubbleLeader.isHidden = false
        } else {
            frame = CGRect(x: bounds.midX - size.width / 2, y: bounds.height * 0.3, width: size.width, height: size.height)
            bubbleLeader.isHidden = true
        }
        let flipped = flip(frame)
        if animated, motionScale > 0, !bubble.frame.isEmpty {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.4
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                context.allowsImplicitAnimation = true
                bubble.animator().frame = flipped
            }
        } else {
            bubble.frame = flipped
        }
    }

    func hideBubble() {
        bubble.isHidden = true
        bubbleLeader.isHidden = true
    }

    private lazy var bubbleLeader: CAShapeLayer = {
        let line = CAShapeLayer()
        line.strokeColor = accent.withAlphaComponent(0.55).cgColor
        line.lineWidth = 1.2
        line.fillColor = nil
        line.lineCap = .round
        line.isHidden = true
        layer?.addSublayer(line)
        return line
    }()

    // MARK: Text helpers

    private func clamp(_ origin: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: min(max(8, origin.x), bounds.width - size.width - 8),
                y: min(max(8, origin.y), bounds.height - size.height - 8))
    }

    private func makeText(_ string: String, fontSize: CGFloat, weight: NSFont.Weight, color: NSColor, mono: Bool = false) -> CATextLayer {
        let font = mono ? NSFont.monospacedSystemFont(ofSize: fontSize, weight: weight) : NSFont.systemFont(ofSize: fontSize, weight: weight)
        let text = CATextLayer()
        text.string = string
        text.font = font
        text.fontSize = fontSize
        text.foregroundColor = color.cgColor
        text.alignmentMode = .left
        text.contentsScale = window?.backingScaleFactor ?? 2
        text.isWrapped = false
        text.truncationMode = .end
        let size = (string as NSString).size(withAttributes: [.font: font])
        text.bounds = CGRect(x: 0, y: 0, width: ceil(size.width) + 1, height: ceil(size.height))
        return text
    }

    private func makePill(text: String, dot: Bool, fontSize: CGFloat, mono: Bool = false) -> CALayer {
        let label = makeText(text, fontSize: fontSize, weight: .semibold, color: .white, mono: mono)
        let padX: CGFloat = 11
        let padY: CGFloat = 6
        let dotSpace: CGFloat = dot ? 14 : 0
        let pill = CALayer()
        pill.bounds = CGRect(x: 0, y: 0, width: label.bounds.width + padX * 2 + dotSpace, height: label.bounds.height + padY * 2)
        pill.cornerRadius = pill.bounds.height / 2
        pill.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        pill.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
        pill.borderWidth = 0.5
        pill.shadowColor = NSColor.black.cgColor
        pill.shadowOpacity = 0.22
        pill.shadowRadius = 5
        pill.shadowOffset = CGSize(width: 0, height: -1)
        if dot {
            let point = CALayer()
            point.bounds = CGRect(x: 0, y: 0, width: 7, height: 7)
            point.cornerRadius = 3.5
            point.backgroundColor = accent.cgColor
            point.shadowColor = accent.cgColor
            point.shadowOpacity = 0.4
            point.shadowRadius = 2
            point.shadowOffset = .zero
            point.position = CGPoint(x: padX + 3.5, y: pill.bounds.midY)
            pill.addSublayer(point)
        }
        label.frame = CGRect(x: padX + dotSpace, y: padY, width: label.bounds.width, height: label.bounds.height)
        pill.addSublayer(label)
        return pill
    }

    private func makeKeyCaps(_ keys: [String]) -> CALayer {
        let holder = CALayer()
        var x: CGFloat = 7
        var height: CGFloat = 0
        for key in keys {
            let text = makeText(key, fontSize: 11.5, weight: .medium, color: NSColor.white.withAlphaComponent(0.95), mono: true)
            let cap = CALayer()
            let width = max(24, text.bounds.width + (key.count > 1 ? 14 : 8))
            cap.bounds = CGRect(x: 0, y: 0, width: width, height: 24)
            cap.cornerRadius = 6
            cap.backgroundColor = NSColor.white.withAlphaComponent(0.12).cgColor
            cap.borderColor = accent.withAlphaComponent(0.7).cgColor
            cap.borderWidth = 1
            text.frame = CGRect(x: (width - text.bounds.width) / 2, y: (24 - text.bounds.height) / 2, width: text.bounds.width, height: text.bounds.height)
            cap.addSublayer(text)
            cap.frame.origin = CGPoint(x: x, y: 4)
            holder.addSublayer(cap)
            x += width + 4
            height = 24
        }
        holder.bounds = CGRect(x: 0, y: 0, width: x + 3, height: height + 8)
        holder.cornerRadius = 11
        holder.backgroundColor = NSColor.black.withAlphaComponent(0.72).cgColor
        holder.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        holder.borderWidth = 0.5
        return holder
    }

    private func makeCard(text: String, maxWidth: CGFloat, fontSize: CGFloat) -> CALayer {
        let font = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 2
        let attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.white, .paragraphStyle: paragraph])
        let bounding = attributed.boundingRect(with: CGSize(width: maxWidth, height: 400), options: [.usesLineFragmentOrigin, .usesFontLeading])
        let label = CATextLayer()
        label.string = attributed
        label.isWrapped = true
        label.contentsScale = window?.backingScaleFactor ?? 2
        label.bounds = CGRect(x: 0, y: 0, width: ceil(bounding.width) + 2, height: ceil(bounding.height) + 2)
        let pad: CGFloat = 10
        let card = CALayer()
        card.bounds = CGRect(x: 0, y: 0, width: label.bounds.width + pad * 2 + 10, height: label.bounds.height + pad * 2)
        card.cornerRadius = 12
        card.backgroundColor = NSColor.black.withAlphaComponent(0.74).cgColor
        card.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        card.borderWidth = 0.5
        card.shadowColor = NSColor.black.cgColor
        card.shadowOpacity = 0.25
        card.shadowRadius = 6
        card.shadowOffset = CGSize(width: 0, height: -2)
        let bar = CALayer()
        bar.backgroundColor = accent.cgColor
        bar.frame = CGRect(x: pad, y: pad, width: 3, height: label.bounds.height)
        bar.cornerRadius = 1.5
        card.addSublayer(bar)
        label.frame = CGRect(x: pad + 10, y: pad, width: label.bounds.width, height: label.bounds.height)
        card.addSublayer(label)
        return card
    }

    // MARK: Reset

    func clear() {
        present(nil, animated: false)
        cancelGuide()
        hideBubble()
        for layer in transient { layer.removeFromSuperlayer() }
        transient = []
    }
}

/// Holds whichever NSView the controller wants as the bubble, so it can be swapped and animated as one.
final class NSHostingLikeContainer: NSView {
    var content: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let content {
                content.translatesAutoresizingMaskIntoConstraints = false
                addSubview(content)
                NSLayoutConstraint.activate([
                    content.leadingAnchor.constraint(equalTo: leadingAnchor),
                    content.trailingAnchor.constraint(equalTo: trailingAnchor),
                    content.topAnchor.constraint(equalTo: topAnchor),
                    content.bottomAnchor.constraint(equalTo: bottomAnchor),
                ])
            }
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
