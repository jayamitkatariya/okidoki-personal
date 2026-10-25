import AppKit
import Combine
import ScreenCaptureKit
import Virtualization
import OkidokiCore

// MARK: - Service

/// okidoki's private Mac: a macOS virtual machine computer-use runs can drive while the user
/// keeps their own screen, cursor and keyboard. Built on Apple's Virtualization framework, so
/// it is Apple silicon only and needs the `com.apple.security.virtualization` entitlement.
///
/// Files live in `~/Library/Application Support/Okidoki/PrivateMac`. Setting up means
/// downloading the latest macOS restore image (about 15 GB), installing it onto a sparse disk,
/// and booting into Setup Assistant once, which the user clicks through in the VM window.
@MainActor
final class PrivateMacService: NSObject, ObservableObject {
    enum Phase: String {
        case unsupported, notSetUp, downloading, installing, stopped, starting, running, stopping, failed
    }

    @Published private(set) var phase: Phase = .notSetUp
    /// 0–1 while downloading or installing.
    @Published private(set) var progress: Double = 0
    /// One human line about what is happening, e.g. "Downloading macOS 26.1 · 3.2 GB of 15.4 GB".
    @Published private(set) var detail = ""
    @Published private(set) var error: String?
    /// True from the first boot after install until the user says Setup Assistant is done.
    @Published private(set) var needsFirstBoot = false

    private(set) var machine: VZVirtualMachine?
    private var windowController: PrivateMacWindowController?
    private var setupTask: Task<Void, Never>?
    private var startTask: Task<Bool, Never>?
    private var downloadTask: URLSessionDownloadTask?
    private var progressObservation: NSKeyValueObservation?
    /// When the VM last entered `running`, so a run that just booted it waits for the desktop.
    private var bootedAt: Date?

    private let defaults = UserDefaults.standard
    private let firstBootKey = "okidoki.privateMac.firstBootDone"
    private let versionKey = "okidoki.privateMac.macOSVersion"

    static var isSupported: Bool {
        #if arch(arm64)
        return VZVirtualMachine.isSupported
        #else
        return false
        #endif
    }

    override init() {
        super.init()
        refreshPhaseFromDisk()
    }

    // MARK: Status

    var isRunning: Bool { phase == .running }
    var isSetUp: Bool { FileManager.default.fileExists(atPath: PrivateMacSpec.installedMarkerURL.path) }
    var macOSVersion: String { defaults.string(forKey: versionKey) ?? "" }
    var restoreImageDownloaded: Bool { FileManager.default.fileExists(atPath: PrivateMacSpec.restoreImageURL.path) }

    var cpuCount: Int {
        PrivateMacSpec.cpuCount(host: ProcessInfo.processInfo.processorCount,
                                minimum: VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                                maximum: VZVirtualMachineConfiguration.maximumAllowedCPUCount)
    }

    var memoryBytes: UInt64 {
        PrivateMacSpec.memoryBytes(host: ProcessInfo.processInfo.physicalMemory,
                                   minimum: VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                                   maximum: VZVirtualMachineConfiguration.maximumAllowedMemorySize)
    }

    /// What the dashboard and onboarding show for the current phase.
    var statusLine: String {
        switch phase {
        case .unsupported: return "Needs a Mac with Apple silicon."
        case .notSetUp: return restoreImageDownloaded ? "macOS is downloaded. Install it to finish setup." : "Not set up yet."
        case .downloading, .installing: return detail
        case .stopped: return needsFirstBoot ? "Installed. Start it to finish macOS setup." : "Off. Starts when a run needs it."
        case .starting: return "Starting up…"
        case .running: return needsFirstBoot ? "Running. Finish macOS setup in its window." : "Running."
        case .stopping: return "Shutting down…"
        case .failed: return error ?? "Something went wrong."
        }
    }

    private func refreshPhaseFromDisk() {
        guard Self.isSupported else { phase = .unsupported; return }
        if isSetUp {
            phase = .stopped
            needsFirstBoot = !defaults.bool(forKey: firstBootKey)
        } else {
            phase = .notSetUp
        }
    }

    // MARK: Set up

    /// Download macOS (if needed), install it, and boot into Setup Assistant. Safe to call again
    /// after a failure; it picks up from whatever already finished.
    func setUp() {
        guard Self.isSupported, [.notSetUp, .failed].contains(phase), setupTask == nil else { return }
        error = nil
        setupTask = Task { [weak self] in
            await self?.runSetup()
            self?.setupTask = nil
        }
    }

    /// Stops a download in progress. An install can't be interrupted safely, so it runs to the end.
    func cancelSetup() {
        guard phase == .downloading else { return }
        setupTask?.cancel()
        downloadTask?.cancel()
    }

    private func runSetup() async {
        let files = FileManager.default
        do {
            try files.createDirectory(at: PrivateMacSpec.directory, withIntermediateDirectories: true)
            if !restoreImageDownloaded {
                phase = .downloading
                progress = 0
                detail = "Finding the latest macOS…"
                let image = try await VZMacOSRestoreImage.latestSupported
                let version = image.operatingSystemVersion
                defaults.set("\(version.majorVersion).\(version.minorVersion)", forKey: versionKey)
                try await download(image.url, to: PrivateMacSpec.restoreImageURL)
            }
            try Task.checkCancellation()

            phase = .installing
            progress = 0
            detail = "Checking the download…"
            let restore = try await VZMacOSRestoreImage.image(from: PrivateMacSpec.restoreImageURL)
            guard let requirements = restore.mostFeaturefulSupportedConfiguration else {
                throw PrivateMacError.unsupportedImage
            }
            let version = restore.operatingSystemVersion
            defaults.set("\(version.majorVersion).\(version.minorVersion)", forKey: versionKey)

            detail = "Preparing the disk…"
            try prepareIdentity(hardwareModel: requirements.hardwareModel)
            try createSparseDisk()
            let configuration = try makeConfiguration(requirements: requirements)
            let vm = VZVirtualMachine(configuration: configuration)
            vm.delegate = self
            machine = vm

            let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: PrivateMacSpec.restoreImageURL)
            let installProgress: Progress = installer.progress
            progressObservation = installProgress.observe(\Progress.fractionCompleted, options: [.new]) { [weak self] progress, _ in
                let fraction = progress.fractionCompleted
                Task { @MainActor in self?.noteInstallProgress(fraction) }
            }
            detail = "Installing macOS \(macOSVersion)…"
            try await installer.install()
            progressObservation = nil
            try Data().write(to: PrivateMacSpec.installedMarkerURL)
            defaults.set(false, forKey: firstBootKey)
            needsFirstBoot = true
            phase = .stopped
            detail = ""
            progress = 0
            // Boot straight into Setup Assistant so the user can finish while it's fresh.
            _ = await start(showWindow: true)
        } catch is CancellationError {
            cleanupAfterCancel()
        } catch let urlError as URLError where urlError.code == .cancelled {
            cleanupAfterCancel()
        } catch {
            progressObservation = nil
            machine = nil
            phase = .failed
            self.error = Self.describe(error)
            detail = ""
        }
    }

    private func cleanupAfterCancel() {
        progressObservation = nil
        downloadTask = nil
        try? FileManager.default.removeItem(at: PrivateMacSpec.restoreImageURL)
        detail = ""
        progress = 0
        refreshPhaseFromDisk()
    }

    private func noteInstallProgress(_ fraction: Double) {
        guard phase == .installing else { return }
        // KVO fires constantly; the dashboard only needs whole percents.
        guard abs(fraction - progress) >= 0.005 || fraction >= 1 else { return }
        progress = fraction
        detail = "Installing macOS \(macOSVersion) · \(Int(fraction * 100))%"
    }

    private func download(_ url: URL, to destination: URL) async throws {
        let version = macOSVersion
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let task = URLSession.shared.downloadTask(with: url) { temp, _, error in
                    if let error { continuation.resume(throwing: error); return }
                    guard let temp else { continuation.resume(throwing: PrivateMacError.download); return }
                    do {
                        try? FileManager.default.removeItem(at: destination)
                        try FileManager.default.moveItem(at: temp, to: destination)
                        continuation.resume()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
                self.downloadTask = task
                self.progressObservation = task.progress.observe(\Progress.fractionCompleted, options: [.new]) { [weak self] progress, _ in
                    let fraction = progress.fractionCompleted
                    let done = progress.completedUnitCount
                    let total = progress.totalUnitCount
                    Task { @MainActor in
                        guard let self, self.phase == .downloading else { return }
                        guard abs(fraction - self.progress) >= 0.005 || fraction >= 1 else { return }
                        self.progress = fraction
                        let doneText = PrivateMacSpec.format(bytes: done)
                        let totalText = total > 0 ? PrivateMacSpec.format(bytes: total) : PrivateMacSpec.format(bytes: Int64(PrivateMacSpec.approximateDownloadBytes))
                        self.detail = "Downloading macOS \(version) · \(doneText) of \(totalText)"
                    }
                }
                task.resume()
            }
        } onCancel: {
            Task { @MainActor in self.downloadTask?.cancel() }
        }
        progressObservation = nil
        downloadTask = nil
    }

    private func prepareIdentity(hardwareModel: VZMacHardwareModel) throws {
        let files = FileManager.default
        try hardwareModel.dataRepresentation.write(to: PrivateMacSpec.hardwareModelURL)
        if !files.fileExists(atPath: PrivateMacSpec.machineIdentifierURL.path) {
            try VZMacMachineIdentifier().dataRepresentation.write(to: PrivateMacSpec.machineIdentifierURL)
        }
        try? files.removeItem(at: PrivateMacSpec.auxiliaryStorageURL)
        _ = try VZMacAuxiliaryStorage(creatingStorageAt: PrivateMacSpec.auxiliaryStorageURL,
                                      hardwareModel: hardwareModel, options: [])
    }

    private func createSparseDisk() throws {
        let url = PrivateMacSpec.diskImageURL
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw PrivateMacError.disk }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: PrivateMacSpec.diskBytes)
    }

    private func makeConfiguration(requirements: VZMacOSConfigurationRequirements?) throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()

        let platform = VZMacPlatformConfiguration()
        let hardwareData = try Data(contentsOf: PrivateMacSpec.hardwareModelURL)
        guard let hardwareModel = VZMacHardwareModel(dataRepresentation: hardwareData), hardwareModel.isSupported else {
            throw PrivateMacError.unsupportedImage
        }
        platform.hardwareModel = hardwareModel
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: PrivateMacSpec.auxiliaryStorageURL)
        let identifierData = try Data(contentsOf: PrivateMacSpec.machineIdentifierURL)
        guard let identifier = VZMacMachineIdentifier(dataRepresentation: identifierData) else {
            throw PrivateMacError.identity
        }
        platform.machineIdentifier = identifier
        configuration.platform = platform
        configuration.bootLoader = VZMacOSBootLoader()

        let minimumCPU = max(requirements?.minimumSupportedCPUCount ?? 0, VZVirtualMachineConfiguration.minimumAllowedCPUCount)
        let minimumMemory = max(requirements?.minimumSupportedMemorySize ?? 0, VZVirtualMachineConfiguration.minimumAllowedMemorySize)
        configuration.cpuCount = PrivateMacSpec.cpuCount(host: ProcessInfo.processInfo.processorCount,
                                                         minimum: minimumCPU,
                                                         maximum: VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        configuration.memorySize = PrivateMacSpec.memoryBytes(host: ProcessInfo.processInfo.physicalMemory,
                                                              minimum: minimumMemory,
                                                              maximum: VZVirtualMachineConfiguration.maximumAllowedMemorySize)

        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: PrivateMacSpec.displayWidthPixels,
                                                               heightInPixels: PrivateMacSpec.displayHeightPixels,
                                                               pixelsPerInch: PrivateMacSpec.displayPixelsPerInch)]
        configuration.graphicsDevices = [graphics]

        let disk = try VZDiskImageStorageDeviceAttachment(url: PrivateMacSpec.diskImageURL, readOnly: false)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]

        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]

        // Absolute coordinates, so a synthesized click lands exactly where the model aimed.
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        configuration.keyboards = [VZMacKeyboardConfiguration()]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        try configuration.validate()
        return configuration
    }

    // MARK: Start / stop

    /// Boots the VM if it isn't running. Returns true once it is. Several callers can wait on the same boot.
    @discardableResult
    func start(showWindow: Bool = false) async -> Bool {
        if phase == .running {
            if showWindow { show() }
            return true
        }
        if let startTask {
            let ok = await startTask.value
            if ok, showWindow { show() }
            return ok
        }
        guard isSetUp, [.stopped, .failed].contains(phase) else { return false }
        let task = Task<Bool, Never> { [weak self] in
            guard let self else { return false }
            return await self.boot()
        }
        startTask = task
        let ok = await task.value
        startTask = nil
        if ok, showWindow { show() }
        return ok
    }

    private func boot() async -> Bool {
        phase = .starting
        error = nil
        do {
            let vm: VZVirtualMachine
            if let existing = machine, existing.state == .stopped {
                vm = existing
            } else {
                vm = VZVirtualMachine(configuration: try makeConfiguration(requirements: nil))
                vm.delegate = self
                machine = vm
            }
            ensureWindow(for: vm)
            try await vm.start()
            bootedAt = Date()
            phase = .running
            return true
        } catch {
            phase = .failed
            self.error = Self.describe(error)
            return false
        }
    }

    /// Asks the guest to shut down; pulls the plug if it hasn't within `grace` seconds.
    func stop(grace: Double = 20) async {
        guard let vm = machine, [.running, .starting].contains(phase) else { return }
        phase = .stopping
        if vm.canRequestStop, (try? vm.requestStop()) != nil {
            let deadline = Date().addingTimeInterval(grace)
            while vm.state != .stopped, Date() < deadline {
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        if vm.state != .stopped, vm.canStop {
            try? await vm.stop()
        }
        machineStopped(error: nil)
    }

    private func machineStopped(error: Error?) {
        if let error { self.error = Self.describe(error) }
        bootedAt = nil
        windowController?.close()
        windowController = nil
        phase = isSetUp ? .stopped : .notSetUp
    }

    /// Seconds a fresh boot still needs before the desktop is usable. Zero once it has been up a while.
    var secondsUntilUsable: Double {
        guard phase == .running, let bootedAt else { return 0 }
        return max(0, 35 - Date().timeIntervalSince(bootedAt))
    }

    func markFirstBootDone() {
        defaults.set(true, forKey: firstBootKey)
        needsFirstBoot = false
    }

    /// Stops the VM and removes every file. Settings fall back to this Mac.
    func delete() async {
        setupTask?.cancel()
        downloadTask?.cancel()
        await stop(grace: 8)
        machine = nil
        try? FileManager.default.removeItem(at: PrivateMacSpec.directory)
        defaults.removeObject(forKey: firstBootKey)
        defaults.removeObject(forKey: versionKey)
        error = nil
        detail = ""
        progress = 0
        refreshPhaseFromDisk()
    }

    // MARK: Window

    var window: NSWindow? { windowController?.window }
    var view: VZVirtualMachineView? { windowController?.machineView }

    private func ensureWindow(for vm: VZVirtualMachine) {
        if let windowController, windowController.machineView.virtualMachine === vm { return }
        windowController?.close()
        windowController = PrivateMacWindowController(machine: vm)
    }

    /// Brings the VM window up for the user to look at or finish Setup Assistant in.
    func show() {
        guard let windowController else { return }
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Hides the window from the user without stopping the VM.
    func hide() {
        windowController?.window?.orderOut(nil)
    }

    /// Window capture needs the window on screen. Behind everything is fine.
    fileprivate func ensureOnScreen() {
        guard let window = windowController?.window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        if !window.isVisible { window.orderBack(nil) }
    }

    private static func describe(_ error: Error) -> String {
        if let known = error as? PrivateMacError { return known.errorDescription ?? "something went wrong" }
        let ns = error as NSError
        if ns.domain == VZErrorDomain {
            switch VZError.Code(rawValue: ns.code) {
            case .notSupported: return "this Mac can't run a virtual machine (it needs Apple silicon and the virtualization entitlement)"
            case .invalidVirtualMachineConfiguration: return "the VM configuration was rejected — try deleting the private Mac and setting it up again"
            case .restoreImageLoadFailed, .restoreImageCatalogLoadFailed: return "the macOS download is damaged — delete the private Mac and set it up again"
            case .networkError: return "the download lost its network connection"
            case .outOfDiskSpace: return "not enough free disk space"
            default: break
            }
        }
        return ns.localizedDescription.isEmpty ? "something went wrong" : ns.localizedDescription.lowercased()
    }
}

extension PrivateMacService: VZVirtualMachineDelegate {
    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        MainActor.assumeIsolated { machineStopped(error: nil) }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        MainActor.assumeIsolated { machineStopped(error: error) }
    }
}

enum PrivateMacError: LocalizedError {
    case unsupportedImage, download, disk, identity, notRunning, noWindow, noCapture

    var errorDescription: String? {
        switch self {
        case .unsupportedImage: return "this Mac can't run the latest macOS as a virtual machine"
        case .download: return "the macOS download didn't finish"
        case .disk: return "couldn't create the VM's disk"
        case .identity: return "the VM's identity files are missing — delete the private Mac and set it up again"
        case .notRunning: return "the private Mac isn't running"
        case .noWindow: return "the private Mac has no window to look at"
        case .noCapture: return "couldn't take a picture of the private Mac"
        }
    }
}

// MARK: - Window

@MainActor
final class PrivateMacWindowController: NSObject, NSWindowDelegate {
    private(set) var window: NSWindow?
    let machineView = VZVirtualMachineView()

    init(machine: VZVirtualMachine) {
        super.init()
        machineView.virtualMachine = machine
        machineView.capturesSystemKeys = false
        if #available(macOS 14, *) {
            // Keep the guest display at the fixed size the model learned; resizing the window scales it.
            machineView.automaticallyReconfiguresDisplay = false
        }
        let size = NSSize(width: PrivateMacSpec.displayPointWidth, height: PrivateMacSpec.displayPointHeight)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "okidoki's private Mac"
        window.contentAspectRatio = size
        window.contentView = machineView
        window.delegate = self
        window.collectionBehavior = [.fullScreenNone, .managed]
        window.center()
        window.makeFirstResponder(machineView)
        self.window = window
    }

    /// Closing the window hides it; the VM keeps running so runs can still use it.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func close() {
        window?.delegate = nil
        window?.orderOut(nil)
        machineView.virtualMachine = nil
        window = nil
    }
}

// MARK: - Computer target

/// Drives the private Mac through its view: screenshots come from a window capture, clicks
/// and keys are AppKit events delivered straight to the view, which forwards them to the guest.
/// Coordinates are points in the VM display with the origin at its top-left.
@MainActor
final class PrivateMacComputer: ComputerTarget {
    private let service: PrivateMacService
    private var eventNumber = 0

    init(service: PrivateMacService) { self.service = service }

    var displayName: String { "your private Mac" }
    var isRemote: Bool { true }
    var stopsOnUserEscape: Bool { false }
    var showsPointerOverlay: Bool { false }
    var canAct: Bool { service.isRunning && service.view != nil }

    func screen() -> NSScreen? { service.window?.screen ?? NSScreen.main }

    // MARK: Looking

    func capture() async -> ComputerUseService.Screenshot? {
        guard service.isRunning, let window = service.window, let view = service.view else { return nil }
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            return nil
        }
        service.ensureOnScreen()
        let windowID = CGWindowID(window.windowNumber)
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let target = content.windows.first(where: { $0.windowID == windowID }) else { return nil }
            let scale = max(window.backingScaleFactor, 1)
            let frame = target.frame
            guard frame.width > 0, frame.height > 0 else { return nil }
            let config = SCStreamConfiguration()
            config.width = Int((frame.width * scale).rounded())
            config.height = Int((frame.height * scale).rounded())
            config.showsCursor = false
            config.scalesToFit = false
            config.ignoreShadowsSingleWindow = true
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target),
                                                                   configuration: config)
            // The capture is the whole window, title bar included; keep only the guest display.
            let inWindow = view.convert(view.bounds, to: nil)
            let top = window.frame.height - inWindow.maxY
            let crop = CGRect(x: inWindow.minX * scale, y: top * scale,
                              width: inWindow.width * scale, height: inWindow.height * scale).integral
            guard let display = image.cropping(to: crop) else { return nil }
            let box = ScreenBox(x: 0, y: 0, width: inWindow.width, height: inWindow.height)
            let encoded = await Task.detached(priority: .userInitiated) {
                ComputerUseService.encodeForModel(display, pointWidth: inWindow.width)
            }.value
            guard let encoded else { return nil }
            return ComputerUseService.Screenshot(png: encoded.png, box: box, imageWidth: encoded.width,
                                                 imageHeight: encoded.height, full: display)
        } catch {
            return nil
        }
    }

    func context(box: ScreenBox, imageWidth: Double, imageHeight: Double) async -> ComputerContext {
        // No accessibility or scripting reaches into the guest; the model works from the picture.
        ComputerContext(appName: "", windowTitle: "", controls: [], scripting: "")
    }

    // MARK: Acting

    func perform(_ action: ComputerAction, screen box: ScreenBox, imageWidth: Double, imageHeight: Double) async throws -> String {
        guard canAct else { throw PrivateMacError.notRunning }
        switch action.type {
        case "open_app", "activate":
            let name = (action.app ?? action.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return "no app name" }
            await spotlight(name)
            return "opened \(name) through Spotlight on the private Mac — check the next screenshot"
        case "open_url":
            let url = (action.text ?? action.app ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty else { return "no url" }
            await spotlight("Safari")
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await press(combo: "cmd+l")
            try? await Task.sleep(nanoseconds: 200_000_000)
            _ = await type(url)
            await press(combo: "return")
            return "opened Safari on the private Mac and entered \(url)"
        case "script", "shell", "applescript", "jxa":
            return "scripts don't run on the private Mac — drive it with click, type and key instead (Spotlight is cmd+space)"
        case "click", "double_click", "triple_click", "right_click":
            guard let point = ComputerUseService.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                                           imageWidth: imageWidth, imageHeight: imageHeight) else {
                return action.x == nil || action.y == nil
                    ? "click needs x and y in screenshot pixels"
                    : "ignored click outside the screen"
            }
            guard let held = modifiers(action.modifiers) else { return "unknown modifiers \(action.modifiers ?? "")" }
            let count = action.type == "double_click" ? 2 : action.type == "triple_click" ? 3 : 1
            await click(at: point, right: action.type == "right_click", count: count, held: held)
            let verb = action.type == "double_click" ? "double-clicked" : action.type == "triple_click" ? "triple-clicked"
                : action.type == "right_click" ? "right-clicked" : "clicked"
            let withMods = held.isEmpty ? "" : " holding \(action.modifiers ?? "")"
            return String(format: "%@%@ at (%.0f, %.0f)", verb, withMods, point.x, point.y)
        case "middle_click":
            return "middle click isn't available on the private Mac — try cmd+click"
        case "move":
            guard let point = ComputerUseService.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                                           imageWidth: imageWidth, imageHeight: imageHeight) else {
                return "move needs x and y in screenshot pixels"
            }
            mouse(.mouseMoved, at: point)
            return String(format: "moved to (%.0f, %.0f)", point.x, point.y)
        case "drag":
            guard let from = ComputerUseService.mapImage(x: action.fromX ?? -1, y: action.fromY ?? -1, box: box,
                                                          imageWidth: imageWidth, imageHeight: imageHeight),
                  let to = ComputerUseService.mapImage(x: action.toX ?? -1, y: action.toY ?? -1, box: box,
                                                        imageWidth: imageWidth, imageHeight: imageHeight) else {
                return "ignored drag outside the screen"
            }
            await drag(from: from, to: to)
            return String(format: "dragged from (%.0f, %.0f) to (%.0f, %.0f)", from.x, from.y, to.x, to.y)
        case "type":
            let text = action.text ?? ""
            guard !text.isEmpty else { return "nothing to type" }
            let skipped = await type(text)
            return skipped > 0
                ? "typed \(text.count - skipped) characters — \(skipped) couldn't be typed on this keyboard layout"
                : "typed \(text.count) characters"
        case "key":
            guard let combo = action.key, !combo.isEmpty else { return "no key given" }
            let times = min(max(action.times ?? 1, 1), 50)
            for index in 0..<times {
                if index > 0 { try? await Task.sleep(nanoseconds: 50_000_000) }
                guard await press(combo: combo) else { return "unknown key \(combo)" }
            }
            return times > 1 ? "pressed \(combo) \(times) times" : "pressed \(combo)"
        case "scroll":
            let point = ComputerUseService.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                                     imageWidth: imageWidth, imageHeight: imageHeight)
                ?? CGPoint(x: box.width / 2, y: box.height / 2)
            await scroll(dx: action.dx ?? 0, dy: action.dy ?? 0, at: point)
            return String(format: "scrolled %.0f", action.dy ?? 0)
        case "wait":
            let seconds = min(max(action.seconds ?? 1, 0.2), 10)
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return action.reason.map { "waited — \($0)" } ?? "waited \(String(format: "%.1f", seconds))s"
        case "zoom":
            guard action.x != nil, action.y != nil else { return "zoom needs x and y" }
            return "zoomed"
        default:
            return "unknown action \(action.type)"
        }
    }

    // MARK: Event synthesis

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// The responder under a point, inside the VM view. The view may host a private subview
    /// that does the real work; hit-testing finds it either way.
    private func responder(at inWindow: CGPoint) -> NSView? {
        guard let window = service.window, let view = service.view else { return nil }
        if let hit = window.contentView?.hitTest(inWindow), hit === view || hit.isDescendant(of: view) { return hit }
        return view
    }

    private func keyResponder() -> NSResponder? {
        guard let window = service.window, let view = service.view else { return nil }
        if let first = window.firstResponder as? NSView, first === view || first.isDescendant(of: view) { return first }
        window.makeFirstResponder(view)
        return window.firstResponder ?? view
    }

    /// VM display points (origin top-left) → the window's base coordinates.
    private func windowPoint(_ point: CGPoint) -> CGPoint? {
        guard let view = service.view else { return nil }
        let inView = view.isFlipped ? point : CGPoint(x: point.x, y: view.bounds.height - point.y)
        return view.convert(inView, to: nil)
    }

    private func mouse(_ type: NSEvent.EventType, at point: CGPoint, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) {
        guard let window = service.window, let inWindow = windowPoint(point), let target = responder(at: inWindow) else { return }
        eventNumber += 1
        let pressed: Set<NSEvent.EventType> = [.leftMouseDown, .rightMouseDown, .leftMouseDragged, .rightMouseDragged]
        guard let event = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: flags, timestamp: now,
                                             windowNumber: window.windowNumber, context: nil, eventNumber: eventNumber,
                                             clickCount: clicks, pressure: pressed.contains(type) ? 1 : 0) else { return }
        switch type {
        case .mouseMoved: target.mouseMoved(with: event)
        case .leftMouseDown: target.mouseDown(with: event)
        case .leftMouseUp: target.mouseUp(with: event)
        case .leftMouseDragged: target.mouseDragged(with: event)
        case .rightMouseDown: target.rightMouseDown(with: event)
        case .rightMouseUp: target.rightMouseUp(with: event)
        case .rightMouseDragged: target.rightMouseDragged(with: event)
        default: break
        }
    }

    private func click(at point: CGPoint, right: Bool, count: Int, held: NSEvent.ModifierFlags) async {
        mouse(.mouseMoved, at: point, flags: held)
        try? await Task.sleep(nanoseconds: 60_000_000)
        setModifiers(held, down: true)
        for index in 1...count {
            mouse(right ? .rightMouseDown : .leftMouseDown, at: point, flags: held, clicks: index)
            try? await Task.sleep(nanoseconds: 45_000_000)
            mouse(right ? .rightMouseUp : .leftMouseUp, at: point, flags: held, clicks: index)
            if index < count { try? await Task.sleep(nanoseconds: 70_000_000) }
        }
        setModifiers(held, down: false)
    }

    private func drag(from origin: CGPoint, to target: CGPoint) async {
        mouse(.mouseMoved, at: origin)
        try? await Task.sleep(nanoseconds: 60_000_000)
        mouse(.leftMouseDown, at: origin)
        try? await Task.sleep(nanoseconds: 160_000_000)
        let steps = 24
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let eased = t * t * (3 - 2 * t)
            let point = CGPoint(x: origin.x + (target.x - origin.x) * eased, y: origin.y + (target.y - origin.y) * eased)
            mouse(.leftMouseDragged, at: point)
            try? await Task.sleep(nanoseconds: 18_000_000)
        }
        mouse(.leftMouseUp, at: target)
    }

    private func scroll(dx: Double, dy: Double, at point: CGPoint) async {
        guard let window = service.window, let inWindow = windowPoint(point), let target = responder(at: inWindow) else { return }
        mouse(.mouseMoved, at: point)
        try? await Task.sleep(nanoseconds: 40_000_000)
        // Quartz wants the pointer in global top-left coordinates; a wheel tick up is positive.
        let onScreen = window.convertPoint(toScreen: inWindow)
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let quartz = CGPoint(x: onScreen.x, y: primaryHeight - onScreen.y)
        var remainingY = -dy
        var remainingX = -dx
        let chunk = 120.0
        while abs(remainingY) > 0.5 || abs(remainingX) > 0.5 {
            let stepY = abs(remainingY) > chunk ? chunk * (remainingY < 0 ? -1 : 1) : remainingY
            let stepX = abs(remainingX) > chunk ? chunk * (remainingX < 0 ? -1 : 1) : remainingX
            remainingY -= stepY
            remainingX -= stepX
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                   wheel1: Int32(stepY.rounded()), wheel2: Int32(stepX.rounded()), wheel3: 0) else { break }
            cg.location = quartz
            if let event = NSEvent(cgEvent: cg) { target.scrollWheel(with: event) }
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
    }

    @discardableResult
    private func press(combo: String) async -> Bool {
        guard let stroke = EventActuator.keystroke(for: combo) else { return false }
        await send(stroke)
        return true
    }

    /// Returns how many characters had no key on the current layout.
    private func type(_ text: String) async -> Int {
        let typed = EventActuator.keystrokes(typing: text)
        for stroke in typed.strokes {
            await send(stroke)
            try? await Task.sleep(nanoseconds: 12_000_000)
        }
        return typed.skipped
    }

    private func send(_ stroke: EventActuator.Keystroke) async {
        guard let window = service.window, let responder = keyResponder() else { return }
        let flags = Self.modifierFlags(stroke.flags)
        setModifiers(flags, down: true)
        let characters = stroke.characters
        if let down = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: now,
                                       windowNumber: window.windowNumber, context: nil, characters: characters,
                                       charactersIgnoringModifiers: characters, isARepeat: false, keyCode: stroke.code) {
            // Command shortcuts travel as key equivalents so the view forwards them to the guest
            // instead of okidoki's own menu bar acting on them.
            if !(flags.contains(.command) && responder.performKeyEquivalent(with: down)) {
                responder.keyDown(with: down)
            }
        }
        try? await Task.sleep(nanoseconds: 30_000_000)
        if let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: flags, timestamp: now,
                                     windowNumber: window.windowNumber, context: nil, characters: characters,
                                     charactersIgnoringModifiers: characters, isARepeat: false, keyCode: stroke.code) {
            responder.keyUp(with: up)
        }
        setModifiers(flags, down: false)
    }

    /// Presses or releases modifier keys one at a time, as real hardware does.
    private func setModifiers(_ flags: NSEvent.ModifierFlags, down: Bool) {
        guard !flags.isEmpty, let window = service.window, let responder = keyResponder() else { return }
        let order: [(flag: NSEvent.ModifierFlags, code: UInt16)] = [(.control, 59), (.option, 58), (.shift, 56), (.command, 55)]
        var current: NSEvent.ModifierFlags = down ? [] : flags
        for entry in (down ? order : order.reversed()) where flags.contains(entry.flag) {
            if down { current.insert(entry.flag) } else { current.remove(entry.flag) }
            if let event = NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: current, timestamp: now,
                                            windowNumber: window.windowNumber, context: nil, characters: "",
                                            charactersIgnoringModifiers: "", isARepeat: false, keyCode: entry.code) {
                responder.flagsChanged(with: event)
            }
        }
    }

    private func spotlight(_ query: String) async {
        await press(combo: "cmd+space")
        try? await Task.sleep(nanoseconds: 600_000_000)
        _ = await type(query)
        try? await Task.sleep(nanoseconds: 700_000_000)
        await press(combo: "return")
    }

    private func modifiers(_ text: String?) -> NSEvent.ModifierFlags? {
        guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        var flags: NSEvent.ModifierFlags = []
        for piece in EventActuator.keyPieces(text) {
            switch piece {
            case "cmd", "command": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "opt", "alt", "option": flags.insert(.option)
            case "ctrl", "control": flags.insert(.control)
            default: return nil
            }
        }
        return flags
    }

    nonisolated private static func modifierFlags(_ flags: CGEventFlags) -> NSEvent.ModifierFlags {
        var result: NSEvent.ModifierFlags = []
        if flags.contains(.maskCommand) { result.insert(.command) }
        if flags.contains(.maskShift) { result.insert(.shift) }
        if flags.contains(.maskAlternate) { result.insert(.option) }
        if flags.contains(.maskControl) { result.insert(.control) }
        return result
    }
}
