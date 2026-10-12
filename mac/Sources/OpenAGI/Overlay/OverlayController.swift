import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private(set) var panel: NSPanel?
  private let defaults: UserDefaults
  private var screenObserver: NSObjectProtocol?
  /// True while an OverlayDragView is moving the panel. Content-driven
  /// resizes wait for the drop so they never fight the drag.
  private(set) var isDragging = false

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  private static let enabledKey = "openagi.overlay.enabled"
  // Where the collapsed pill sits: its bottom-left corner. Size-independent,
  // so a position saved while expanded restores without a jump.
  static let pillOriginXKey = "openagi.overlay.pillOriginX"
  static let pillOriginYKey = "openagi.overlay.pillOriginY"
  // Legacy: the raw frame origin of whatever size the panel had.
  private static let legacyOriginXKey = "openagi.overlay.originX"
  private static let legacyOriginYKey = "openagi.overlay.originY"

  // Panel geometry. The expanded width matches OverlayView's fixed frame.
  private static let expandedWidth: CGFloat = 320
  nonisolated static let pillSize: CGFloat = 44
  nonisolated static let screenMargin: CGFloat = 12

  static var isEnabled: Bool {
    UserDefaults.standard.object(forKey: enabledKey) == nil ? true : UserDefaults.standard.bool(forKey: enabledKey)
  }
  static func setEnabled(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: enabledKey)
    if on { shared.show() } else { shared.hide() }
  }

  func startIfEnabled() { if Self.isEnabled { show() } }

  func show() {
    if panel == nil {
      panel = makePanel()
      // Restore the saved spot only once. Re-applying it on every show()
      // (tray, notifications) would snap the panel back from where the owner
      // dragged it; later shows just keep it on-screen.
      positionPanel()
    } else {
      sizeToContent(animate: false)
    }
    panel?.orderFrontRegardless()
  }

  func hide() { panel?.orderOut(nil) }

  var panelWindowNumber: Int? { panel?.windowNumber }

  func toggle() {
    guard Self.isEnabled else { return }
    // ⌥Space means "ask about my screen": open on Tasks, whichever tab was
    // left showing. Notification and tray opens pick their own tab.
    if panel?.isVisible != true || !OverlayState.shared.expanded { OverlayState.shared.selectTab(.tasks) }
    if panel?.isVisible == true {
      withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
        OverlayState.shared.expanded.toggle()
      }
      sizeToContent()
      if OverlayState.shared.expanded { panel?.makeKey() }
    } else {
      OverlayState.shared.expanded = true
      show(); sizeToContent(animate: false)
      panel?.makeKey()
    }
  }

  /// Esc from anywhere in the panel collapses back to the pill.
  func collapse() {
    guard OverlayState.shared.expanded else { return }
    withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
      OverlayState.shared.expanded = false
    }
    sizeToContent()
  }

  private func makePanel() -> NSPanel {
    let p = KeyableOverlayPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.expandedWidth, height: 60),
      styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.hidesOnDeactivate = false
    // OverlayDragView owns dragging (pill and header). A movable background
    // would only compete with it, and could move the panel without saving.
    p.isMovableByWindowBackground = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(
      onCollapse: { [weak self] in self?.sizeToContent() },
      onExpand: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } },
      // Content grows after the fact (answer arrives, nudges land, errors
      // show). Without this hook the panel kept its stale frame and the
      // reply rendered clipped / spilling past the panel edge.
      onContentChange: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } },
      onDragBegan: { [weak self] in self?.beginDrag() },
      onDragEnded: { [weak self] cursor in self?.endDrag(cursor: cursor) }
    ))
    host.translatesAutoresizingMaskIntoConstraints = true
    p.contentView = host
    // A monitor unplugged or rearranged can leave the panel off-screen.
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.sizeToContent(animate: false) }
    }
    return p
  }

  // MARK: Dragging

  func beginDrag() {
    isDragging = true
    guard let p = panel else { return }
    // Stop a running resize animation where it is; otherwise it keeps
    // writing frames underneath the drag.
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0
      p.animator().setFrame(p.frame, display: false)
    }
  }

  /// Drop: fit the panel onto the display under the cursor (shrinking it for
  /// a shorter display), re-measure content that changed mid-drag, and save.
  func endDrag(cursor: NSPoint) {
    guard isDragging else { return }
    isDragging = false
    guard let p = panel else { return }
    let screen = NSScreen.screens.first { $0.frame.contains(cursor) } ?? p.screen ?? NSScreen.main
    if let vf = screen?.visibleFrame {
      let fitted = Self.clampedFrame(p.frame, in: vf)
      if fitted != p.frame { p.setFrame(fitted, display: true) }
    }
    sizeToContent(animate: false)
    persistPosition()
  }

  /// `frame` moved fully inside `visible`, inset by the screen margin, and
  /// shrunk first if it does not fit.
  static func clampedFrame(_ frame: NSRect, in visible: NSRect, margin: CGFloat = screenMargin) -> NSRect {
    let area = visible.insetBy(dx: margin, dy: margin)
    let w = min(frame.width, area.width)
    let h = min(frame.height, area.height)
    // Keep the top edge when shrinking: content grows downward.
    let y = frame.maxY - h
    return NSRect(
      x: min(max(area.minX, frame.minX), area.maxX - w),
      y: min(max(area.minY, y), area.maxY - h),
      width: w, height: h)
  }

  /// The frame the collapsed pill takes for a panel at `frame`, using the same
  /// anchoring as sizeToContent: top edge fixed, nearer horizontal edge kept.
  static func pillFrame(for frame: NSRect, visibleFrame vf: NSRect?) -> NSRect {
    let anchorRight = vf.map { frame.midX > $0.midX } ?? false
    let x = anchorRight ? frame.maxX - pillSize : frame.minX
    return NSRect(x: x, y: frame.maxY - pillSize, width: pillSize, height: pillSize)
  }

  /// Resize the panel to fit its SwiftUI content, animated, WITHOUT ever
  /// leaving the screen: the top edge stays put while height grows downward,
  /// the horizontal anchor is whichever edge is nearer a screen edge (so a
  /// pill parked on the right expands leftward instead of off-screen), and
  /// the final frame is clamped inside the screen's visible frame.
  private func sizeToContent(animate: Bool = true) {
    // endDrag runs this once at the drop.
    guard !isDragging else { return }
    guard let p = panel, let host = p.contentView else { return }
    let screen = p.screen ?? NSScreen.main
    guard let vf = screen?.visibleFrame else { return }
    let m = Self.screenMargin
    let expanded = OverlayState.shared.expanded

    let fitting = host.fittingSize
    let newW = expanded ? Self.expandedWidth : Self.pillSize
    let maxH = vf.height - m * 2
    let newH = min(max(Self.pillSize, fitting.height), maxH)

    let old = p.frame
    let anchorRight = old.midX > vf.midX
    var newX = anchorRight ? old.maxX - newW : old.minX
    var newY = old.maxY - newH // keep the top edge fixed; grow downward

    newX = min(max(vf.minX + m, newX), vf.maxX - m - newW)
    newY = min(max(vf.minY + m, newY), vf.maxY - m - newH)
    let target = NSRect(x: newX, y: newY, width: newW, height: newH)
    guard target != old else { return }

    if animate {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.22
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ctx.allowsImplicitAnimation = true
        p.animator().setFrame(target, display: true)
      }
    } else {
      p.setFrame(target, display: true)
    }
  }

  private func positionPanel() {
    guard let p = panel, let screen = NSScreen.main else { return }
    if let saved = savedPillFrame(),
       let home = NSScreen.screens.first(where: { $0.visibleFrame.insetBy(dx: -8, dy: -8).intersects(saved) }) {
      // A saved spot is only trustworthy while a display still shows it;
      // after unplugging a monitor it can be entirely off-screen.
      p.setFrame(Self.clampedFrame(saved, in: home.visibleFrame), display: false)
    } else {
      let vf = screen.visibleFrame
      // Default: upper-right, where downward growth has the most room.
      p.setFrameOrigin(NSPoint(
        x: vf.maxX - Self.expandedWidth - 40,
        y: vf.maxY - 200
      ))
    }
    sizeToContent(animate: false)
  }

  private func savedPillFrame() -> NSRect? {
    let size = NSSize(width: Self.pillSize, height: Self.pillSize)
    if defaults.object(forKey: Self.pillOriginXKey) != nil, defaults.object(forKey: Self.pillOriginYKey) != nil {
      let origin = NSPoint(x: defaults.double(forKey: Self.pillOriginXKey), y: defaults.double(forKey: Self.pillOriginYKey))
      return NSRect(origin: origin, size: size)
    }
    // Older builds saved a frame origin without its size. Nothing could drag
    // the pill then, so treat it as the pill's origin.
    if defaults.object(forKey: Self.legacyOriginXKey) != nil {
      let origin = NSPoint(x: defaults.double(forKey: Self.legacyOriginXKey), y: defaults.double(forKey: Self.legacyOriginYKey))
      return NSRect(origin: origin, size: size)
    }
    return nil
  }

  func persistPosition() {
    guard let p = panel else { return }
    let pill = Self.pillFrame(for: p.frame, visibleFrame: (p.screen ?? NSScreen.main)?.visibleFrame)
    defaults.set(Double(pill.minX), forKey: Self.pillOriginXKey)
    defaults.set(Double(pill.minY), forKey: Self.pillOriginYKey)
  }
}

// Borderless NSPanels return false for canBecomeKey by default; override so the
// Quick Ask field can receive keystrokes. .nonactivatingPanel keeps the owning
// app from activating, so summoning never steals focus from the user's app.
final class KeyableOverlayPanel: NSPanel {
  /// Set while a mouse-down on a drag handle is dispatched, so pressing or
  /// dragging the pill does not take keyboard focus from the owner's app.
  /// A click (no drag) makes the panel key itself before expanding.
  private var deferKeyForDragHandle = false

  override var canBecomeKey: Bool { !deferKeyForDragHandle }

  override func sendEvent(_ event: NSEvent) {
    guard event.type == .leftMouseDown, !isKeyWindow, let content = contentView else {
      super.sendEvent(event)
      return
    }
    let point = content.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
    guard content.hitTest(point) is OverlayDragView else {
      super.sendEvent(event)
      return
    }
    deferKeyForDragHandle = true
    defer { deferKeyForDragHandle = false }
    super.sendEvent(event)
  }

  // Esc anywhere in the panel collapses back to the pill instead of beeping.
  override func cancelOperation(_ sender: Any?) {
    Task { @MainActor in OverlayController.shared.collapse() }
  }
}
