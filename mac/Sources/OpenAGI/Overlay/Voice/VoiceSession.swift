import AVFoundation
import Foundation

struct VoiceFocus: Codable, Equatable {
  var view = "supervisor"
  var threadKey: String? = nil
  var questionId: String? = nil
  var prRef: String? = nil

  static func question(_ question: FleetQuestion) -> VoiceFocus {
    VoiceFocus(threadKey: question.threadKey ?? question.chats.first?.threadKey, questionId: question.id)
  }

  static func thread(_ thread: FleetThread) -> VoiceFocus {
    VoiceFocus(threadKey: thread.key, prRef: thread.prRef)
  }
}

struct VoiceControl: Encodable {
  let type: String
  var gesture: String? = nil
  var mode: String? = nil
  var focus: VoiceFocus? = nil
  var handsFree: Bool? = nil
  var itemId: String? = nil
  var playedMs: Double? = nil

  func message() throws -> URLSessionWebSocketTask.Message {
    .string(String(decoding: try JSONEncoder().encode(self), as: UTF8.self))
  }
}

struct VoiceConnection {
  let url: URL
  let token: String

  init(base: String, token: String) throws {
    guard var parts = URLComponents(string: base), let host = parts.host,
          parts.user == nil, parts.password == nil,
          token.range(of: "^[A-Za-z0-9._~+-]{16,512}$", options: .regularExpression) != nil else {
      throw VoiceFailure("Configure the paired hub URL and daemon token in the Mac app first.")
    }
    switch parts.scheme?.lowercased() {
    case "https", "wss": parts.scheme = "wss"
    case "http", "ws":
      guard ["localhost", "127.0.0.1", "::1"].contains(host) else {
        throw VoiceFailure("Voice needs a secure HTTPS connection to the paired hub.")
      }
      parts.scheme = "ws"
    default: throw VoiceFailure("Voice needs a secure HTTPS connection to the paired hub.")
    }
    parts.path = "/nodes/voice"
    parts.query = "rate=24000&mode=ptt"
    parts.fragment = nil
    guard let url = parts.url else { throw VoiceFailure("The paired hub URL is invalid.") }
    self.url = url
    self.token = token
  }

  static func failureMessage(status: Int?) -> String {
    switch status {
    case 404: return "Voice is off on the hub. Enable OPENAGI_VOICE=1 on Distiller, then try again."
    case 401, 403: return "Voice sign-in failed. Check the paired hub daemon token."
    case 429: return "The hub has too many voice connections. Try again shortly."
    default: return "Couldn't connect to hub voice. Check the connection and hub configuration."
    }
  }
}

struct VoiceFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct VoicePTT {
  enum Source: Hashable { case hotkey, mic }
  enum Phase: Equatable { case idle, connecting, ready, recording, waiting, replying }
  enum Effect: Equatable { case connect, capture, barge, commit }
  private(set) var phase: Phase = .idle
  private(set) var held: Set<Source> = []
  private var bytes = 0

  mutating func press(_ source: Source) -> [Effect] {
    guard held.insert(source).inserted, held.count == 1 else { return [] }
    if phase == .idle { phase = .connecting; return [.connect] }
    guard phase != .connecting else { return [] }
    let interrupt = phase == .replying || phase == .waiting
    phase = .recording
    bytes = 0
    return interrupt ? [.barge, .capture] : [.capture]
  }

  mutating func ready() -> [Effect] {
    guard phase == .connecting else { return [] }
    phase = held.isEmpty ? .ready : .recording
    bytes = 0
    return held.isEmpty ? [] : [.capture]
  }

  mutating func append(_ count: Int) {
    if phase == .recording { bytes += count }
  }

  mutating func release(_ source: Source) -> [Effect] {
    guard held.remove(source) != nil, held.isEmpty, phase == .recording else { return [] }
    phase = bytes >= 4800 ? .waiting : .ready
    return bytes > 0 ? [.commit] : []
  }

  mutating func reply() {
    if phase != .recording { phase = .replying }
  }

  mutating func replyDone() {
    if phase != .recording { phase = .ready }
  }

  mutating func reset() { self = VoicePTT() }
}

@MainActor
final class VoiceSession: ObservableObject {
  static let shared = VoiceSession()
  @Published private(set) var phase: VoicePTT.Phase = .idle
  @Published private(set) var transcript = ""
  @Published private(set) var reply = ""
  @Published private(set) var notice: String? = nil
  @Published private(set) var error: String? = nil
  @Published private(set) var micHeld = false

  private var ptt = VoicePTT()
  private let audio = VoiceAudio()
  private var socket: URLSessionWebSocketTask?
  private var transport: URLSession?
  private var connectionTask: Task<Void, Never>?
  private var receiver: Task<Void, Never>?
  private var sender: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var outbox: [URLSessionWebSocketTask.Message] = []
  private var queuedBytes = 0
  private var generation: UInt = 0
  private var focus = VoiceFocus()
  private var ignoreReply = false
  private var awaitingBarge = false
  private var replyStarted = false
  private var replyFinished = false

  init() {
    audio.onDrained = { [weak self] in
      Task { @MainActor in self?.finishReplyIfDrained() }
    }
    audio.onFailure = { [weak self] in
      Task { @MainActor in self?.fail("Voice audio couldn't keep up. Check the audio device and start again.") }
    }
  }

  var active: Bool { phase != .idle }
  var recording: Bool { phase == .recording }

  func press(_ source: VoicePTT.Source, focus: VoiceFocus) {
    updateFocus(focus)
    perform(ptt.press(source), gesture: source == .hotkey ? "hotkey" : "mic")
    phase = ptt.phase
    micHeld = ptt.held.contains(.mic)
  }

  func release(_ source: VoicePTT.Source) {
    perform(ptt.release(source))
    phase = ptt.phase
    micHeld = ptt.held.contains(.mic)
    audio.setCapturing(recording)
    if phase == .ready { notice = "Hold to talk a little longer." }
  }

  func updateFocus(_ next: VoiceFocus) {
    guard focus != next else { return }
    focus = next
    if socket != nil { enqueue(VoiceControl(type: "context", focus: next)) }
  }

  private func perform(_ effects: [VoicePTT.Effect], gesture: String = "mic") {
    for effect in effects {
      switch effect {
      case .connect:
        error = nil; notice = nil; transcript = ""; reply = ""
        generation &+= 1
        let mine = generation
        connectionTask = Task { await connect(gesture: gesture, generation: mine) }
        deadline = Task {
          try? await Task.sleep(for: .seconds(20))
          guard !Task.isCancelled, mine == generation, phase == .connecting else { return }
          fail("The hub didn't start voice in time. Check hub voice configuration and try again.")
        }
      case .capture:
        transcript = ""; reply = ""; notice = nil
        replyStarted = false; replyFinished = false
        audio.setCapturing(true)
      case .barge:
        ignoreReply = true
        awaitingBarge = true
        // Audio's serial queue stops playback before new mic frames reach us.
        let played = audio.interrupt()
        enqueue(VoiceControl(type: "barge", playedMs: Double(played)))
      case .commit:
        ignoreReply = awaitingBarge
        enqueue(VoiceControl(type: "commit"))
      }
    }
  }

  private func connect(gesture: String, generation mine: UInt) async {
    do {
      let config = try AppState.shared.voiceConnection()
      let allowed: Bool
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: allowed = true
      case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .audio)
      default: allowed = false
      }
      guard mine == generation, !Task.isCancelled else { return }
      guard allowed else { throw VoiceFailure("Allow microphone access for OpenAGI in System Settings → Privacy & Security → Microphone.") }
      let session = URLSession(configuration: .ephemeral)
      let ws = session.webSocketTask(with: config.url, protocols: ["openagi-voice", config.token])
      transport = session; socket = ws
      ws.resume()
      try await ws.send(try VoiceControl(type: "start", gesture: gesture, mode: "ptt", focus: focus).message())
      guard mine == generation else { return }
      receiver = Task { await receive(ws, generation: mine) }
    } catch {
      guard mine == generation else { return }
      fail((error as? VoiceFailure)?.message ?? VoiceConnection.failureMessage(status: (socket?.response as? HTTPURLResponse)?.statusCode))
    }
  }

  private func receive(_ ws: URLSessionWebSocketTask, generation mine: UInt) async {
    do {
      while !Task.isCancelled {
        let message = try await ws.receive()
        guard mine == generation else { return }
        switch message {
        case .data(let pcm):
          guard !ignoreReply, !recording else { continue }
          if !replyStarted { audio.beginReply(); replyStarted = true; replyFinished = false }
          ptt.reply(); phase = ptt.phase
          try audio.play(pcm)
        case .string(let text):
          guard let data = text.data(using: .utf8), let event = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
          switch event["type"] as? String {
          case "ready":
            deadline?.cancel(); deadline = nil
            try await audio.start { [weak self] pcm in
              Task { @MainActor in
                guard let self, mine == self.generation, self.recording else { return }
                self.ptt.append(pcm.count)
                self.enqueue(.data(pcm))
              }
            }
            guard mine == generation else { return }
            perform(ptt.ready()); phase = ptt.phase
          case "transcript": transcript = String((event["text"] as? String ?? "").prefix(4000))
          case "reply.delta":
            if !ignoreReply { reply = String((reply + (event["text"] as? String ?? "")).prefix(4000)) }
          case "reply.done":
            if !ignoreReply {
              reply = String((event["text"] as? String ?? "").prefix(4000))
              audio.finishReply(itemId: event["itemId"] as? String, audioMs: event["audioMs"] as? Double)
              replyStarted = false
              replyFinished = true
              finishReplyIfDrained()
            }
          case "barged":
            awaitingBarge = false
            ignoreReply = recording
          case "notice": notice = event["message"] as? String
          case "error": notice = event["message"] as? String ?? "The hub reported a voice error."
          case "end":
            let reason = event["reason"] as? String ?? "Voice ended."
            stop(sendControl: false); notice = reason
            return
          default: break
          }
        @unknown default: break
        }
      }
    } catch {
      guard mine == generation else { return }
      fail((error as? VoiceFailure)?.message ?? VoiceConnection.failureMessage(status: (ws.response as? HTTPURLResponse)?.statusCode))
    }
  }

  private func enqueue(_ control: VoiceControl) {
    if let message = try? control.message() { enqueue(message) }
  }

  private func enqueue(_ message: URLSessionWebSocketTask.Message) {
    guard let ws = socket else { return }
    queuedBytes += Self.size(message)
    guard queuedBytes <= 192_000, outbox.count < 300 else {
      fail("Voice upload fell behind. Check the hub connection and start again.")
      return
    }
    outbox.append(message)
    guard sender == nil else { return }
    let mine = generation
    sender = Task {
      do {
        while !outbox.isEmpty, mine == generation {
          let next = outbox.removeFirst()
          queuedBytes -= Self.size(next)
          try await ws.send(next)
        }
        if mine == generation { sender = nil }
      } catch {
        if mine == generation { fail(VoiceConnection.failureMessage(status: (ws.response as? HTTPURLResponse)?.statusCode)) }
      }
    }
  }

  private static func size(_ message: URLSessionWebSocketTask.Message) -> Int {
    switch message {
    case .data(let data): return data.count
    case .string(let text): return text.utf8.count
    @unknown default: return 0
    }
  }

  private func finishReplyIfDrained() {
    guard !ignoreReply, !recording else { return }
    for control in audio.playbackAcknowledgements() { enqueue(control) }
    guard replyFinished, audio.drained else { return }
    ptt.replyDone(); phase = ptt.phase
    replyStarted = false; replyFinished = false
  }

  func stop(sendControl: Bool = true) {
    generation &+= 1
    connectionTask?.cancel(); receiver?.cancel(); sender?.cancel()
    deadline?.cancel(); deadline = nil
    connectionTask = nil; receiver = nil; sender = nil
    let ws = socket
    let session = transport
    Task {
      if sendControl, let ws, let message = try? VoiceControl(type: "stop").message() {
        try? await ws.send(message)
      }
      ws?.cancel(with: .normalClosure, reason: nil)
      session?.invalidateAndCancel()
    }
    socket = nil
    transport = nil
    outbox = []; queuedBytes = 0
    audio.stop()
    ptt.reset(); phase = .idle; ignoreReply = false; awaitingBarge = false; micHeld = false
    replyStarted = false; replyFinished = false
  }

  private func fail(_ message: String) {
    stop(sendControl: false)
    error = message
  }
}
