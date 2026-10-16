import AppKit
import Carbon.HIToolbox

// System-wide hotkey via Carbon RegisterEventHotKey (needs no Accessibility
// permission). Default: ⌥Space. Fires onHotkey on the main actor.
@MainActor
final class HotkeyManager {
  static let shared = HotkeyManager()
  private var ref: EventHotKeyRef?
  private var voiceRef: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private var defaultsObserver: NSObjectProtocol?
  private var voiceShortcut: [UInt32] = []
  private var voiceHeld = false
  var onHotkey: () -> Void = {}
  var onVoicePressed: () -> Void = {}
  var onVoiceReleased: () -> Void = {}

  static let voiceKeyCodeKey = "openagi.voice.hotkey.keyCode"
  static let voiceModifiersKey = "openagi.voice.hotkey.modifiers"

  func register() {
    unregister()
    var eventTypes = [
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed)),
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyReleased))
    ]
    InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
      guard let event, let userData else { return OSStatus(eventNotHandledErr) }
      var id = EventHotKeyID()
      let result = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                     MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard result == noErr else { return result }
      let me = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
      let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
      let hotkeyID = id.id
      Task { @MainActor in
        if hotkeyID == 1, pressed { me.onHotkey() }
        if hotkeyID == 2 {
          guard me.voiceHeld != pressed else { return }
          me.voiceHeld = pressed
          if pressed { me.onVoicePressed() } else { me.onVoiceReleased() }
        }
      }
      return noErr
    }, 2, &eventTypes, Unmanaged.passUnretained(self).toOpaque(), &handler)

    let hotKeyID = EventHotKeyID(signature: OSType(0x4F41_4749), id: 1)
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &ref)
    if status != noErr { NSLog("OpenAGI: hotkey registration failed (\(status)) — tray-only") }
    registerVoiceShortcut()
    defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      // Swift 5.10 (the release runner) rejects the weak var inside the Task.
      guard let self else { return }
      Task { @MainActor in self.registerVoiceShortcut() }
    }
  }

  // Carbon key code and modifier mask, saved independently of the ask hotkey.
  func configureVoice(keyCode: UInt32, modifiers: UInt32) {
    UserDefaults.standard.set(Int(keyCode), forKey: Self.voiceKeyCodeKey)
    UserDefaults.standard.set(Int(modifiers), forKey: Self.voiceModifiersKey)
    registerVoiceShortcut()
  }

  private func registerVoiceShortcut() {
    let defaults = UserDefaults.standard
    let key = defaults.object(forKey: Self.voiceKeyCodeKey) == nil ? UInt32(kVK_Space) : UInt32(clamping: defaults.integer(forKey: Self.voiceKeyCodeKey))
    let modifiers = defaults.object(forKey: Self.voiceModifiersKey) == nil ? UInt32(optionKey | shiftKey) : UInt32(clamping: defaults.integer(forKey: Self.voiceModifiersKey))
    guard voiceShortcut != [key, modifiers] else { return }
    if voiceHeld { voiceHeld = false; onVoiceReleased() }
    if let voiceRef { UnregisterEventHotKey(voiceRef) }
    voiceRef = nil
    voiceShortcut = [key, modifiers]
    let id = EventHotKeyID(signature: OSType(0x4F41_4749), id: 2)
    let status = RegisterEventHotKey(key, modifiers, id, GetApplicationEventTarget(), 0, &voiceRef)
    if status != noErr { NSLog("OpenAGI: voice hotkey registration failed (\(status)) — use the mic button") }
  }

  func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    if voiceHeld { voiceHeld = false; onVoiceReleased() }
    if let voiceRef { UnregisterEventHotKey(voiceRef) }
    if let handler { RemoveEventHandler(handler) }
    if let defaultsObserver { NotificationCenter.default.removeObserver(defaultsObserver) }
    defaultsObserver = nil
    ref = nil; voiceRef = nil; handler = nil; voiceShortcut = []
  }
}
