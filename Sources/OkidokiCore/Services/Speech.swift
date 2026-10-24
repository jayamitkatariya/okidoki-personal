import Foundation
import Speech
import AVFoundation
import AppKit

@MainActor
public final class SpeechRecognizer: ObservableObject {
    @Published public private(set) var transcript = ""
    @Published public private(set) var isListening = false
    @Published public private(set) var error: String?
    @Published public private(set) var level: Double = 0

    public var onUpdate: ((String) -> Void)?
    public var onFinal: ((String) -> Void)?
    public var levelObserver: ((Double) -> Void)?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()
    private var silenceWork: DispatchWorkItem?
    private var didFinish = false
    private var hardStop: DispatchWorkItem?

    public init() {}

    public func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    public func start() {
        guard !isListening else { return }
        transcript = ""
        error = nil
        didFinish = false

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                guard status == .authorized else {
                    self.error = "speech recognition is off. turn it on in settings → privacy."
                    return
                }
                do {
                    try self.begin()
                } catch {
                    self.error = "couldn't start the microphone: \(error.localizedDescription)"
                    self.stop()
                }
            }
        }
    }

    private func begin() throws {
        guard let recognizer, recognizer.isAvailable else {
            error = "speech recognition isn't available right now."
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        if #available(macOS 13.0, *) { request.addsPunctuation = true }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            error = "no microphone found."
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            var sum: Float = 0
            let count = Int(buffer.frameLength)
            for i in 0..<count { sum += channel[i] * channel[i] }
            let rms = sqrt(sum / Float(count))
            let normalized = min(1, max(0, Double(rms) * 18))
            Task { @MainActor in
                self?.level = normalized
                self?.levelObserver?(normalized)
            }
        }

        engine.prepare()
        try engine.start()
        isListening = true

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if text != self.transcript {
                        self.transcript = text
                        self.onUpdate?(text)
                        self.scheduleSilence()
                    }
                    if result.isFinal { self.finish() }
                }
                if let error {
                    let message = error.localizedDescription
                    if self.isListening && !message.isEmpty && !message.contains("canceled") {
                        self.error = message
                    }
                }
            }
        }

        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isListening else { return }
            if self.transcript.isEmpty {
                self.error = "i didn't hear anything. try again, or type."
                self.stop()
            } else {
                self.finish()
            }
        }
        hardStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }

    private func scheduleSilence() {
        silenceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isListening, !self.transcript.isEmpty else { return }
            self.finish()
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    public func finish() {
        guard !didFinish else { return }
        didFinish = true
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        stop(keepTranscript: true)
        if !text.isEmpty { onFinal?(text) }
    }

    public func stop(keepTranscript: Bool = false) {
        isListening = false
        silenceWork?.cancel()
        hardStop?.cancel()
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        level = 0
        if !keepTranscript { transcript = "" }
    }
}

@MainActor
public final class VoiceSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published public private(set) var isSpeaking = false
    @Published public private(set) var lastError: String?

    private let synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var generation = 0

    public override init() {
        super.init()
        synthesizer.delegate = self
    }

    public func speak(_ text: String, voiceID: String, speed: Double, enabled: Bool = true) {
        guard enabled else { return }
        let cleaned = text
            .replacingOccurrences(of: #"[*_`#>]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        generation += 1
        let current = generation
        stop()
        lastError = nil

        let cartesiaKey = Keychain.get("cartesia") ?? ""
        let voice = Voices.voice(voiceID)
        if !cartesiaKey.isEmpty && !voice.cartesiaID.isEmpty {
            Task {
                do {
                    let audio = try await requestCartesia(text: String(cleaned.prefix(900)), key: cartesiaKey,
                                                          voiceID: voice.cartesiaID, speed: speed)
                    guard current == self.generation else { return }
                    try self.play(audio)
                } catch {
                    guard current == self.generation else { return }
                    self.lastError = error.localizedDescription
                    self.speakSystem(cleaned, speed: speed)
                }
            }
        } else {
            speakSystem(cleaned, speed: speed)
        }
    }

    private func requestCartesia(text: String, key: String, voiceID: String, speed: Double) async throws -> Data {
        var request = URLRequest(url: URL(string: "https://api.cartesia.ai/tts/bytes")!)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "X-API-Key")
        request.setValue("2025-03-24", forHTTPHeaderField: "Cartesia-Version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = [
            "model_id": "sonic-2",
            "transcript": text,
            "voice": ["mode": "id", "id": voiceID],
            "output_format": ["container": "wav", "sample_rate": 44100, "encoding": "pcm_s16le"],
            "language": "en",
            "generation_config": ["speed": max(0.6, min(1.5, speed))],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count > 100 else {
            throw NSError(domain: "okidoki.tts", code: 1, userInfo: [NSLocalizedDescriptionKey: "voice service unavailable"])
        }
        return data
    }

    private func play(_ data: Data) throws {
        let player = try AVAudioPlayer(data: data)
        self.player = player
        player.prepareToPlay()
        isSpeaking = true
        player.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + player.duration) { [weak self] in
            self?.isSpeaking = false
        }
    }

    private func speakSystem(_ text: String, speed: Double) {
        let utterance = AVSpeechUtterance(string: String(text.prefix(700)))
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = min(max(Float(0.48 * speed), 0.32), 0.68)
        utterance.pitchMultiplier = 1.02
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    public func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        isSpeaking = false
    }

    nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }

    nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
