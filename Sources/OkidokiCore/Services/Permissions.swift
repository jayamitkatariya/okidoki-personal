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
    public var title: String {
        switch self {
        case .screen: return "screen"
        case .microphone: return "microphone"
        case .accessibility: return "accessibility"
        case .automation: return "automation"
        }
    }
    public var blurb: String {
        switch self {
        case .screen: return "so I can see what you're looking at when you ask"
        case .microphone: return "so you can talk instead of type"
        case .accessibility: return "so I can click and type when you let me borrow the screen"
        case .automation: return "so reminders, calendar and notes happen without opening apps"
        }
    }
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
            let granted = CGRequestScreenCaptureAccess()
            return granted ? .granted : .notDetermined
        case .microphone:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            return granted ? .granted : .denied
        case .accessibility:
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(options)
            return granted ? .granted : .notDetermined
        case .automation:
            return .notDetermined
        }
    }

    public func openSettings(_ kind: PermissionKind) {
        if let url = URL(string: kind.settingsURL) {
            NSWorkspace.shared.open(url)
        }
    }

    public func markAutomationGranted(_ granted: Bool) {
        UserDefaults.standard.set(granted, forKey: "okidoki.automationGranted")
    }

    public var allGranted: Bool {
        PermissionKind.allCases.allSatisfy { state($0) == .granted }
    }
}
