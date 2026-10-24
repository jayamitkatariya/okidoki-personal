import AppKit
import OkidokiCore

/// A scripted lesson for checking the visuals: it cycles every drawing kind over whatever is on
/// screen, no model calls. Start with `OKIDOKI_TEACH_LAB=1`; scenes advance every few seconds.
@MainActor
final class TeachLab {
    private var index = Int(ProcessInfo.processInfo.environment["OKIDOKI_TEACH_LAB_START"] ?? "") ?? 0

    func next(for request: TeachStepRequest, elements: [TeachElement], shot: TeachShot?) -> TeachLiveStep? {
        guard let shot else { return TeachLiveStep(action: "look", say: "i can't see the screen in the lab.") }
        let w = shot.sentWidth
        let h = shot.sentHeight
        let pick = elements.indices.contains(index) ? elements[index % max(1, elements.count)] : nil
        let center = CGPoint(x: w * 0.5, y: h * 0.42)
        defer { index += 1 }
        switch index % 12 {
        case 0:
            return TeachLiveStep(action: "click", say: "a ring on a marked element, with the tag and a guide trail from your pointer.",
                                 why: "this is what most steps look like.", label: pick?.label.lowercased() ?? "here",
                                 element: pick?.id, x: center.x, y: center.y, remaining: 11,
                                 milestones: ["rings", "arrows", "notes", "spotlights", "demos"], milestone: 0)
        case 1:
            return TeachLiveStep(action: "look", say: "a region box with a callout and a bracket.", label: "the middle",
                                 x: w * 0.5, y: h * 0.5, w: w * 0.3, h: h * 0.25, remaining: 10,
                                 annotations: [
                                     TeachAnnotation(kind: "callout", text: "this whole area is the canvas — everything you make lives here", x: w * 0.62, y: h * 0.45),
                                     TeachAnnotation(kind: "bracket", text: "the canvas", x: w * 0.5, y: h * 0.5, w: w * 0.3, h: h * 0.25),
                                 ], milestone: 0)
        case 2:
            return TeachLiveStep(action: "drag", say: "a drag: curved arrow, comet, dashed drop target.", label: "drag it over",
                                 fromX: w * 0.3, fromY: h * 0.6, toX: w * 0.7, toY: h * 0.35, remaining: 9,
                                 next: TeachNextGuess(say: "then this would be next", action: "click", label: "next thing", x: w * 0.7, y: h * 0.6), milestone: 1)
        case 3:
            return TeachLiveStep(action: "key", say: "a shortcut step: key caps beside the ring, and the result region.", label: "auto layout",
                                 x: w * 0.8, y: h * 0.3, key: "shift+a", remaining: 8, alsoX: w * 0.85, alsoY: h * 0.5, alsoW: w * 0.2, alsoH: h * 0.15,
                                 alsoLabel: "it shows up here", milestone: 1)
        case 4:
            return TeachLiveStep(action: "look", say: "numbered badges for a sequence, with a flow arrow.", label: "in order",
                                 x: w * 0.3, y: h * 0.3, w: w * 0.1, h: h * 0.1, remaining: 7,
                                 annotations: [
                                     TeachAnnotation(kind: "badge", x: w * 0.3, y: h * 0.3, n: 1),
                                     TeachAnnotation(kind: "badge", x: w * 0.5, y: h * 0.3, n: 2),
                                     TeachAnnotation(kind: "badge", x: w * 0.7, y: h * 0.3, n: 3),
                                     TeachAnnotation(kind: "flow", text: "this → that", x: w * 0.3, y: h * 0.36, toX: w * 0.7, toY: h * 0.36),
                                 ], milestone: 2)
        case 5:
            return TeachLiveStep(action: "look", say: "an underline, a measure line and a sketch circle.", label: "details",
                                 x: w * 0.5, y: h * 0.6, w: w * 0.2, h: h * 0.08, remaining: 6,
                                 annotations: [
                                     TeachAnnotation(kind: "underline", x: w * 0.5, y: h * 0.6, w: w * 0.2, h: h * 0.04),
                                     TeachAnnotation(kind: "measure", text: "16px", x: w * 0.4, y: h * 0.7, toX: w * 0.6, toY: h * 0.7),
                                     TeachAnnotation(kind: "sketch", x: w * 0.25, y: h * 0.75, w: w * 0.08, h: h * 0.08),
                                 ], milestone: 2)
        case 6:
            return TeachLiveStep(action: "click", say: "a spotlight on the key moment, with a lens over the icon.", label: "right here",
                                 x: w * 0.15, y: h * 0.2, remaining: 5,
                                 annotations: [
                                     TeachAnnotation(kind: "spotlight", x: w * 0.15, y: h * 0.2, w: w * 0.12, h: h * 0.1),
                                     TeachAnnotation(kind: "lens", x: w * 0.15, y: h * 0.2),
                                 ], milestone: 3)
        case 7:
            return TeachLiveStep(action: "type", say: "typing: the field ring with a preview of what to type.", label: "the name field",
                                 x: w * 0.5, y: h * 0.2, w: w * 0.25, h: h * 0.05, text: "hello okidoki", remaining: 4,
                                 annotations: [TeachAnnotation(kind: "typing", text: "hello okidoki")], milestone: 3)
        case 8:
            return TeachLiveStep(action: "scroll", say: "scroll chevrons and a ghost cursor demo of the step.", label: "scroll down",
                                 x: w * 0.5, y: h * 0.55, remaining: 3,
                                 annotations: [TeachAnnotation(kind: "scroll", text: "down", x: w * 0.5, y: h * 0.75), TeachAnnotation(kind: "ghost")], milestone: 4)
        case 9:
            return TeachLiveStep(previousDone: false, action: "click", say: "a retry: same step, different words, and the ghost walk-through after a while.",
                                 label: "try here", x: w * 0.6, y: h * 0.4, remaining: 2, milestone: 4)
        case 10:
            return TeachLiveStep(action: "click", say: "a risky one: okidoki asks before doing it for you.", label: "send",
                                 x: w * 0.85, y: h * 0.85, remaining: 1, risky: true, milestone: 4)
        default:
            return TeachLiveStep(action: "done", say: "that's every drawing. looked good?", summary: "the lab ran through all twelve scenes.")
        }
    }
}
