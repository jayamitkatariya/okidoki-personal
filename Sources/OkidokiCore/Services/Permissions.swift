import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ApplicationServices

public enum PermissionState: String, Sendable {
    case granted, denied, notDetermined, unknown
    public var label: String {
        switch self {
        case .granted: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not yet"
        case .unknown: return "check"
        }
    }
}

public enum PermissionKind: String, CaseIterable, Identifiable, Sendable {
    case screen, microphone, accessibility, automation
    public var id: String { rawValue }
    public var settingsURL: String {
        switch self {
        case .screen: return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .microphone: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case .accessibility: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .automation: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        }
    }
}

@MainActor
public final class PermissionsService {
    public static let shared = PermissionsService()
    private init() {}

    public func state(_ kind: PermissionKind) -> PermissionState {
        switch kind {
        case .screen:
            return CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        case .microphone:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return .granted
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown
            }
        case .accessibility:
            return AXIsProcessTrusted() ? .granted : .notDetermined
        case .automation:
            return UserDefaults.standard.bool(forKey: "okidoki.automationGranted") ? .granted : .notDetermined
        }
    }

    public func request(_ kind: PermissionKind) async -> PermissionState {
        switch kind {
        case .screen:
            if !CGPreflightScreenCaptureAccess() { await repairStaleGrant(kind) }
            let granted = CGRequestScreenCaptureAccess()
            return granted ? .granted : .notDetermined
        case .microphone:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            return granted ? .granted : .denied
        case .accessibility:
            if !AXIsProcessTrusted() { await repairStaleGrant(kind) }
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(options)
            return granted ? .granted : .notDetermined
        case .automation:
            // There is no way to ask macOS whether Apple events are allowed without sending one, and
            // resetting here would wipe every app the user has already allowed (Calendar, Mail, Notes…).
            // The caller sends a harmless event; a grant that proves stale is cleared where the denial
            // is seen (the script actuator), not on a plain request.
            return .notDetermined
        }
    }

    /// Services already cleared once in this process, so a user who declines isn't nagged on every step.
    private var repaired: Set<PermissionKind> = []

    /// The macOS privacy database ties a grant to the app's code signature. A grant recorded for an
    /// earlier build (an ad-hoc signature pins it to one binary) leaves the toggle switched on in
    /// System Settings while the system quietly denies this copy and never asks again — clicks, keys
    /// and Apple events all fail with no visible reason. Clearing only okidoki's own entry makes the
    /// next request prompt properly; it needs no password and touches no other app.
    @discardableResult
    public func repairStaleGrant(_ kind: PermissionKind) async -> Bool {
        guard !repaired.contains(kind), let bundleID = Bundle.main.bundleIdentifier else { return false }
        repaired.insert(kind)
        let service: String
        switch kind {
        case .accessibility: service = "Accessibility"
        case .screen: service = "ScreenCapture"
        case .automation: service = "AppleEvents"
        case .microphone: service = "Microphone"
        }
        // tccutil takes a moment; the UI thread shouldn't wait on it.
        return await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            process.arguments = ["reset", service, bundleID]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch {
                return false
            }
        }.value
    }

    public func openSettings(_ kind: PermissionKind) {
        if let url = URL(string: kind.settingsURL) {
            NSWorkspace.shared.open(url)
        }
    }

    public func markAutomationGranted(_ granted: Bool) {
        UserDefaults.standard.set(granted, forKey: "okidoki.automationGranted")
    }
}
