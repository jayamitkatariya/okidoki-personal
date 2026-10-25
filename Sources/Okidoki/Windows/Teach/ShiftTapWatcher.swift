import AppKit
import OkidokiCore

/// Fires `onDoubleTap` on two quick taps of shift, whichever app has the keyboard.
///
/// It reads the modifier state (`NSEvent.modifierFlags`) on a short timer instead of listening
/// for `flagsChanged`: the state needs no accessibility or input-monitoring grant, arrives no
/// matter which app is in front, and doesn't care which key code a keyboard or remapper reports
/// for shift. Other input (a click, a key) is reported through `interrupt()` so shift+letter
/// typing and chords never count.
@MainActor
final class ShiftTapWatcher {
    var onDoubleTap: (() -> Void)?
    private var tap = TeachKeys.DoubleTap()
    private var timer: Timer?

    func start() {
        stop()
        tap.reset()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        // Common modes: menus and drags block the default mode, and shift taps still count then.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        tap.reset()
    }

    /// Any other key or click between the taps starts the count over.
    func interrupt() {
        tap.reset()
    }

    private func poll() {
        guard timer != nil else { return }
        let flags = NSEvent.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if tap.update(flags: flags, at: ProcessInfo.processInfo.systemUptime) {
            onDoubleTap?()
        }
    }
}
