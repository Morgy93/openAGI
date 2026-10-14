import AVFoundation

struct VoicePlayback {
  private struct Item {
    let id: String
    let audioMs: Double
    let endFrame: Int64
  }
  private(set) var scheduledFrames: Int64 = 0
  private(set) var completedFrames: Int64 = 0
  private var itemStartFrame: Int64 = 0
  private var items: [Item] = []

  mutating func beginReply() { itemStartFrame = scheduledFrames }
  mutating func schedule(_ frames: Int64) { scheduledFrames += frames }
  mutating func complete(_ frames: Int64) { completedFrames += frames }

  mutating func finishReply(itemId: String?, audioMs: Double?) {
    guard let itemId, !itemId.isEmpty, let audioMs, audioMs.isFinite, audioMs > 0,
          audioMs == Double(scheduledFrames - itemStartFrame) / 24 else { return }
    items.append(Item(id: itemId, audioMs: audioMs, endFrame: scheduledFrames))
  }

  mutating func acknowledgements() -> [VoiceControl] {
    var controls: [VoiceControl] = []
    while let item = items.first, item.endFrame <= completedFrames {
      items.removeFirst()
      controls.append(VoiceControl(type: "playback", itemId: item.id, playedMs: item.audioMs))
    }
    return controls
  }

  func playedMs(renderedFrames: Int64?) -> Int {
    let played = min(scheduledFrames, max(completedFrames, renderedFrames ?? completedFrames))
    return Int(max(0, played - itemStartFrame) / 24)
  }

  mutating func reset() { self = VoicePlayback() }
}

final class VoiceAudio {
  private let queue = DispatchQueue(label: "app.openagi.voice.audio")
  private var engine: AVAudioEngine?
  private let player = AVAudioPlayerNode()
  private var converter: AVAudioConverter?
  private var tapInstalled = false
  private var playerAttached = false
  private var capturing = false
  private var playback = VoicePlayback()
  private var renderedFrameOffset: Int64 = 0
  private var playbackGeneration: UInt = 0
  var onDrained: () -> Void = {}
  var onFailure: () -> Void = {}

  private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

  func start(onPCM: @escaping (Data) -> Void) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        do {
          let engine = AVAudioEngine()
          self.engine = engine
          let input = engine.inputNode
          try input.setVoiceProcessingEnabled(true)
          let format = input.outputFormat(forBus: 0)
          guard format.sampleRate > 0, format.channelCount > 0,
                let converter = AVAudioConverter(from: format, to: self.wireFormat) else {
            throw VoiceFailure("The microphone's audio format isn't available. Check the selected input device.")
          }
          self.converter = converter
          engine.attach(self.player)
          self.playerAttached = true
          engine.connect(self.player, to: engine.mainMixerNode, format: self.playFormat)
          input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
            copy.frameLength = buffer.frameLength
            let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
            for index in source.indices {
              if let from = source[index].mData, let to = target[index].mData {
                memcpy(to, from, Int(source[index].mDataByteSize))
              }
            }
            self.queue.async {
              guard self.capturing, self.engine === engine else { return }
              self.convert(copy, onPCM: onPCM)
            }
          }
          self.tapInstalled = true
          engine.prepare()
          try engine.start()
          self.player.play()
          continuation.resume()
        } catch {
          self.stopEngine()
          continuation.resume(throwing: VoiceFailure("Couldn't start echo-cancelled microphone audio. Check the microphone and output device."))
        }
      }
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer, onPCM: (Data) -> Void) {
    guard let converter else { return }
    let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 24_000 / buffer.format.sampleRate)) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, state in
      if supplied { state.pointee = .noDataNow; return nil }
      supplied = true
      state.pointee = .haveData
      return buffer
    }
    guard status != .error, error == nil else { onFailure(); return }
    guard converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
    onPCM(Data(bytes: samples, count: Int(converted.frameLength) * 2))
  }

  func setCapturing(_ on: Bool) {
    queue.async {
      self.capturing = on
      if on { self.converter?.reset() }
    }
  }

  func beginReply() {
    queue.sync { playback.beginReply() }
  }

  func play(_ pcm: Data) throws {
    guard !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 64_000 else {
      throw VoiceFailure("The hub sent invalid voice audio. Start again.")
    }
    let frames = AVAudioFrameCount(pcm.count / 2)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: frames),
          let samples = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = frames
    pcm.withUnsafeBytes { bytes in
      for index in 0..<Int(frames) {
        let value = Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
        samples[index] = Float(value) / 32768
      }
    }
    queue.async {
      guard self.engine != nil else { return }
      // Bound queued playback to ten seconds rather than retaining a whole reply.
      guard self.playback.scheduledFrames - self.playback.completedFrames + Int64(frames) <= 240_000 else {
        self.onFailure()
        return
      }
      // Idle time is not audio the owner heard.
      if self.playback.scheduledFrames == self.playback.completedFrames {
        self.player.stop()
        self.renderedFrameOffset = self.playback.scheduledFrames
        self.player.play()
      }
      self.playback.schedule(Int64(frames))
      let mine = self.playbackGeneration
      self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
        self.queue.async {
          guard mine == self.playbackGeneration else { return }
          self.playback.complete(Int64(frames))
          self.onDrained()
        }
      }
    }
  }

  func finishReply(itemId: String?, audioMs: Double?) {
    queue.sync { playback.finishReply(itemId: itemId, audioMs: audioMs) }
  }

  func playbackAcknowledgements() -> [VoiceControl] {
    queue.sync { playback.acknowledgements() }
  }

  func interrupt() -> Int {
    queue.sync {
      let time = player.lastRenderTime.flatMap { player.playerTime(forNodeTime: $0) }
      let frames = time.map { renderedFrameOffset + Int64(Double($0.sampleTime) * 24_000 / $0.sampleRate) }
      let played = playback.playedMs(renderedFrames: frames)
      player.stop()
      playbackGeneration &+= 1
      playback.reset()
      renderedFrameOffset = 0
      if engine != nil { player.play() }
      return max(0, played)
    }
  }

  var drained: Bool { queue.sync { playback.scheduledFrames == playback.completedFrames } }

  func stop() { queue.async { self.stopEngine() } }

  private func stopEngine() {
    capturing = false
    playbackGeneration &+= 1
    player.stop()
    if let engine {
      if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
      engine.stop()
      if playerAttached { engine.detach(player) }
    }
    tapInstalled = false; playerAttached = false
    engine = nil; converter = nil
    playback.reset()
    renderedFrameOffset = 0
  }
}
