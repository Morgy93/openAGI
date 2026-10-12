import AppKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// Quick Ask dragging, driven by real NSEvents through NSApp.sendEvent against
/// the production panel (OverlayController.makePanel) and OverlayView.
@MainActor
final class OverlayDragTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName = ""
  private var controllers: [OverlayController] = []
  private var wasExpanded = false

  override func setUp() async throws {
    _ = NSApplication.shared
    suiteName = "OverlayDragTests-\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
    wasExpanded = OverlayState.shared.expanded
    OverlayState.shared.expanded = false
  }

  override func tearDown() async throws {
    for c in controllers { c.panel?.close() }
    controllers = []
    defaults.removePersistentDomain(forName: suiteName)
    OverlayState.shared.expanded = wasExpanded
  }

  private var visible: NSRect { NSScreen.main!.visibleFrame }

  /// A production panel showing the pill with its bottom-left at `origin`.
  private func showPill(at origin: NSPoint? = nil) throws -> (OverlayController, NSPanel) {
    let o = origin ?? NSPoint(x: visible.minX + 300, y: visible.minY + 300)
    defaults.set(Double(o.x), forKey: OverlayController.pillOriginXKey)
    defaults.set(Double(o.y), forKey: OverlayController.pillOriginYKey)
    let c = OverlayController(defaults: defaults)
    c.animatesResizes = false
    controllers.append(c)
    c.show()
    let panel = try XCTUnwrap(c.panel)
    panel.contentView?.layoutSubtreeIfNeeded()
    XCTAssertEqual(panel.frame, NSRect(origin: o, size: NSSize(width: 44, height: 44)))
    return (c, panel)
  }

  private func savedPillOrigin() -> NSPoint {
    NSPoint(x: defaults.double(forKey: OverlayController.pillOriginXKey),
            y: defaults.double(forKey: OverlayController.pillOriginYKey))
  }

  private func hit(_ panel: NSPanel, _ point: NSPoint) -> NSView? {
    panel.contentView?.hitTest(point)
  }

  // MARK: Pill

  func testWholeVisiblePillRoutesToDragView() throws {
    let (_, panel) = try showPill()
    XCTAssertFalse(panel.isMovableByWindowBackground)
    // Center (badge), and points on the 36pt circle's material near each edge.
    for p in [NSPoint(x: 22, y: 22), NSPoint(x: 6, y: 22), NSPoint(x: 38, y: 22),
              NSPoint(x: 22, y: 6), NSPoint(x: 22, y: 38)] {
      let target = hit(panel, p)
      XCTAssertTrue(target is OverlayDragView, "\(p) hit \(String(describing: target.map { type(of: $0) }))")
    }
    // The handle also drives hover (SwiftUI onHover cannot see through it)
    // and carries the tooltip.
    let view = try XCTUnwrap(hit(panel, NSPoint(x: 22, y: 22)) as? OverlayDragView)
    XCTAssertNotNil(view.onHover)
    let area = try XCTUnwrap(view.hoverArea)
    XCTAssertTrue(view.trackingAreas.contains { $0 === area })
    XCTAssertTrue(area.options.contains(.mouseEnteredAndExited))
    XCTAssertEqual(view.toolTip?.hasPrefix("Quick Ask (⌥Space)"), true)
    // Re-laying out or re-setting the tooltip keeps the one hover area.
    view.toolTip = view.toolTip
    view.updateTrackingAreas()
    XCTAssertTrue(view.trackingAreas.contains { $0 === area })
    XCTAssertEqual(view.trackingAreas.filter { $0.owner === view && $0.options.contains(.mouseEnteredAndExited) }.count, 1)
  }

  func testPillDragMovesPersistsAndDoesNotExpandOrTakeFocus() throws {
    let (_, panel) = try showPill()
    let start = NSPoint(x: panel.frame.minX + 22, y: panel.frame.minY + 22)
    let origin = panel.frame.origin
    try send(.leftMouseDown, to: panel, screen: start)
    XCTAssertFalse(panel.isKeyWindow, "pressing the pill must not steal keyboard focus")
    try send(.leftMouseDragged, to: panel, screen: start.offset(60, 40))
    try send(.leftMouseDragged, to: panel, screen: start.offset(70, 45))
    try send(.leftMouseUp, to: panel, screen: start.offset(70, 45))

    let moved = origin.offset(70, 45)
    XCTAssertEqual(panel.frame.origin, moved)
    XCTAssertEqual(savedPillOrigin(), moved)
    XCTAssertFalse(OverlayState.shared.expanded)
    XCTAssertFalse(panel.isKeyWindow)
  }

  func testTinyMovementClicksExpandsAndMakesKey() throws {
    let (_, panel) = try showPill()
    let origin = panel.frame.origin
    let start = NSPoint(x: origin.x + 22, y: origin.y + 22)
    try send(.leftMouseDown, to: panel, screen: start)
    try send(.leftMouseDragged, to: panel, screen: start.offset(2, 2))
    try send(.leftMouseUp, to: panel, screen: start.offset(2, 2))

    XCTAssertTrue(OverlayState.shared.expanded)
    XCTAssertTrue(panel.isKeyWindow, "the Quick Ask field needs a key panel to type into")
    XCTAssertEqual(panel.frame.maxY, origin.y + 44, "expanding keeps the top edge")
    XCTAssertEqual(savedPillOrigin(), origin, "a click must not save a position")
  }

  func testDragReturningNearStartIsStillADrag() throws {
    let (_, panel) = try showPill()
    let origin = panel.frame.origin
    let start = NSPoint(x: origin.x + 22, y: origin.y + 22)
    try send(.leftMouseDown, to: panel, screen: start)
    try send(.leftMouseDragged, to: panel, screen: start.offset(40, 0))
    try send(.leftMouseDragged, to: panel, screen: start.offset(1, 0))
    try send(.leftMouseUp, to: panel, screen: start.offset(1, 0))
    XCTAssertFalse(OverlayState.shared.expanded)
    XCTAssertEqual(panel.frame.origin, origin.offset(1, 0))
  }

  func testReleaseOutsideWithoutDragDoesNothing() throws {
    let (_, panel) = try showPill()
    let origin = panel.frame.origin
    try send(.leftMouseDown, to: panel, screen: origin.offset(2, 22))
    try send(.leftMouseUp, to: panel, screen: origin.offset(-1, 22))
    XCTAssertFalse(OverlayState.shared.expanded)
    XCTAssertEqual(panel.frame.origin, origin)
  }

  func testPillIsAnAccessibilityButton() throws {
    let (_, panel) = try showPill()
    let view = try XCTUnwrap(hit(panel, NSPoint(x: 22, y: 22)) as? OverlayDragView)
    XCTAssertTrue(view.isAccessibilityElement())
    XCTAssertEqual(view.accessibilityRole(), .button)
    XCTAssertEqual(view.accessibilityLabel()?.hasPrefix("Quick Ask"), true)
    XCTAssertTrue(view.accessibilityPerformPress())
    XCTAssertTrue(OverlayState.shared.expanded)
    XCTAssertTrue(panel.isKeyWindow)
  }

  /// Real drags arrive with a global CGEvent location while the window is
  /// moving under them. Converting `locationInWindow` through the moved frame
  /// gives a stale point; the handle must track the global location exactly.
  func testDragTracksGlobalCursorNotStaleWindowLocation() throws {
    let (_, panel) = try showPill()
    let view = try XCTUnwrap(hit(panel, NSPoint(x: 22, y: 22)) as? OverlayDragView)
    let origin = panel.frame.origin
    let start = origin.offset(22, 22)
    let path = [start.offset(18, 8), start.offset(48, 28), start.offset(68, 38)]
    view.mouseDown(with: try globalEvent(.leftMouseDown, at: start))
    for p in path { view.mouseDragged(with: try globalEvent(.leftMouseDragged, at: p)) }
    view.mouseUp(with: try globalEvent(.leftMouseUp, at: path.last!))
    XCTAssertEqual(panel.frame.origin, origin.offset(68, 38))
  }

  // MARK: Clamping, restore, resize

  func testDropPastScreenEdgeClampsInsideVisibleFrame() throws {
    let (_, panel) = try showPill()
    let start = NSPoint(x: panel.frame.minX + 22, y: panel.frame.minY + 22)
    // Far past the left edge and above the menu bar.
    let end = NSPoint(x: visible.minX - 5000, y: visible.maxY + 5000)
    try send(.leftMouseDown, to: panel, screen: start)
    try send(.leftMouseDragged, to: panel, screen: end)
    try send(.leftMouseUp, to: panel, screen: end)

    let m = OverlayController.screenMargin
    let expected = NSPoint(x: visible.minX + m, y: visible.maxY - m - 44)
    XCTAssertEqual(panel.frame.origin, expected)
    XCTAssertEqual(savedPillOrigin(), expected)
    XCTAssertFalse(OverlayState.shared.expanded)
  }

  func testClampedFrameShrinksOntoShorterDisplayKeepingTop() {
    // A tall expanded panel dropped on a short secondary display at negative x.
    let visible = NSRect(x: -1280, y: 30, width: 1280, height: 690)
    let fitted = OverlayController.clampedFrame(NSRect(x: -100, y: -100, width: 320, height: 1100), in: visible)
    XCTAssertEqual(fitted, NSRect(x: -332, y: 42, width: 320, height: 666))
    let inside = NSRect(x: -900, y: 200, width: 44, height: 44)
    XCTAssertEqual(OverlayController.clampedFrame(inside, in: visible), inside)
  }

  /// Spots where the old frame-derived collapse moved the dot: the bottom
  /// edge (expanded panel clamped upward), just either side of the screen's
  /// center (expanded panel's midX lands on the other half), and corners.
  private var parkingSpots: [NSPoint] {
    let m = OverlayController.screenMargin
    let s: CGFloat = 44
    return [
      NSPoint(x: visible.maxX - m - s, y: visible.minY + m),          // bottom-right
      NSPoint(x: visible.minX + m, y: visible.minY + m),              // bottom-left
      NSPoint(x: visible.midX - 100 - s / 2, y: visible.midY),        // left of center
      NSPoint(x: visible.midX - 50 - s / 2, y: visible.midY),
      NSPoint(x: visible.midX + 50 - s / 2, y: visible.midY),         // right of center
      NSPoint(x: visible.midX + 100 - s / 2, y: visible.midY),
      NSPoint(x: visible.maxX - m - s, y: visible.maxY - m - s),      // top-right
      NSPoint(x: visible.minX + m, y: visible.maxY - m - s),          // top-left
    ]
  }

  func testOpenCloseReturnsDotToWhereItWasParked() throws {
    for spot in parkingSpots {
      OverlayState.shared.expanded = false
      let (c, panel) = try showPill(at: spot)
      let parked = panel.frame
      for round in 1...2 {
        c.toggle() // expand
        settle()
        let open = panel.frame
        XCTAssertEqual(open.width, 320, "\(spot) round \(round)")
        XCTAssertTrue(visible.contains(open), "\(spot) round \(round): \(open) off-screen")
        // Grows away from the nearer half: right of center keeps the right edge.
        if parked.midX > visible.midX, open.minX > visible.minX + OverlayController.screenMargin {
          XCTAssertEqual(open.maxX, parked.maxX, "\(spot)")
        } else if parked.midX <= visible.midX, open.maxX < visible.maxX - OverlayController.screenMargin {
          XCTAssertEqual(open.minX, parked.minX, "\(spot)")
        }
        c.collapse()
        settle()
        XCTAssertEqual(panel.frame, parked, "\(spot) round \(round): dot moved after open/close")
      }
      XCTAssertEqual(savedPillOrigin(), spot, "open/close must not change the saved spot")
      panel.close()
    }
  }

  func testDotDroppedNearCenterStaysPutAfterClickAndEsc() throws {
    for dx: CGFloat in [-50, 50] {
      OverlayState.shared.expanded = false
      let (c, panel) = try showPill(at: NSPoint(x: visible.minX + 300, y: visible.midY))
      let grab = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
      let drop = NSPoint(x: visible.midX + dx, y: grab.y)
      try send(.leftMouseDown, to: panel, screen: grab)
      try send(.leftMouseDragged, to: panel, screen: drop)
      try send(.leftMouseUp, to: panel, screen: drop)
      let dropped = panel.frame
      XCTAssertEqual(dropped.midX, drop.x)
      XCTAssertEqual(savedPillOrigin(), dropped.origin)

      // Click opens, Esc closes.
      try send(.leftMouseDown, to: panel, screen: drop)
      try send(.leftMouseUp, to: panel, screen: drop)
      settle()
      XCTAssertTrue(OverlayState.shared.expanded)
      XCTAssertEqual(panel.frame.width, 320)
      panel.cancelOperation(nil)
      settle()
      XCTAssertFalse(OverlayState.shared.expanded)
      XCTAssertEqual(panel.frame, dropped, "dx=\(dx)")
      XCTAssertEqual(savedPillOrigin(), dropped.origin)
      panel.close()
    }
  }

  /// A spot saved while expanded (quit with the panel open) restores the dot
  /// exactly where it was parked, not a spot derived from the expanded frame.
  func testSavedWhileExpandedRestoresWithoutJump() throws {
    for spot in parkingSpots {
      OverlayState.shared.expanded = false
      let (first, panel) = try showPill(at: spot)
      let parked = panel.frame
      first.toggle() // expand
      settle()
      XCTAssertEqual(panel.frame.width, 320)
      first.persistPosition()
      panel.close()

      OverlayState.shared.expanded = false
      let second = OverlayController(defaults: defaults)
      controllers.append(second)
      second.show()
      XCTAssertEqual(try XCTUnwrap(second.panel).frame, parked, "\(spot)")
    }
  }

  /// Dragging the open panel by its header carries the dot along by the same
  /// amount, even when the open panel had been pushed up off a bottom dot.
  func testHeaderDragMovesDotByTheSameAmount() throws {
    let m = OverlayController.screenMargin
    let spot = NSPoint(x: visible.maxX - m - 44, y: visible.minY + m)
    let (c, panel) = try showPill(at: spot)
    c.toggle()
    settle()
    let open = panel.frame
    XCTAssertGreaterThan(open.maxY, spot.y + 44, "expanded panel should be clamped upward")
    c.beginDrag()
    panel.setFrameOrigin(open.origin.offset(-40, 30))
    c.endDrag(cursor: NSPoint(x: panel.frame.midX, y: panel.frame.maxY - 10))
    XCTAssertEqual(panel.frame.origin, open.origin.offset(-40, 30))
    let home = spot.offset(-40, 30)
    XCTAssertEqual(c.pillHome?.origin, home)
    XCTAssertEqual(savedPillOrigin(), home)
    c.collapse()
    settle()
    XCTAssertEqual(panel.frame, NSRect(origin: home, size: NSSize(width: 44, height: 44)))
  }

  func testSavedSpotOffEveryScreenFallsBackToDefault() throws {
    defaults.set(-50_000.0, forKey: OverlayController.pillOriginXKey)
    defaults.set(-50_000.0, forKey: OverlayController.pillOriginYKey)
    let c = OverlayController(defaults: defaults)
    controllers.append(c)
    c.show()
    let frame = try XCTUnwrap(c.panel).frame
    XCTAssertTrue(visible.contains(frame), "\(frame) not inside \(visible)")
  }

  /// An upgrade keeps the dot where 0.0.46 showed it: that build put the saved
  /// origin on a 320x60 frame and shrank it to the pill on the nearer side.
  func testLegacyOriginRestoresWhereTheOldBuildShowedTheDot() throws {
    let vf = visible
    let cases: [(NSPoint, NSPoint)] = [
      // Left half: the pill keeps the left edge, 16pt up (60 - 44).
      (NSPoint(x: vf.minX + 200, y: vf.minY + 300), NSPoint(x: vf.minX + 200, y: vf.minY + 316)),
      // Right half: the pill sits at the right end of the old 320pt frame.
      (NSPoint(x: vf.maxX - 500, y: vf.minY + 300), NSPoint(x: vf.maxX - 500 + 276, y: vf.minY + 316)),
    ]
    for (legacy, expected) in cases {
      defaults.removeObject(forKey: OverlayController.pillOriginXKey)
      defaults.removeObject(forKey: OverlayController.pillOriginYKey)
      defaults.set(Double(legacy.x), forKey: "openagi.overlay.originX")
      defaults.set(Double(legacy.y), forKey: "openagi.overlay.originY")
      let c = OverlayController(defaults: defaults)
      c.animatesResizes = false
      controllers.append(c)
      c.show()
      XCTAssertEqual(try XCTUnwrap(c.panel).frame.origin, expected, "legacy \(legacy)")
      c.panel?.close()
    }
  }

  /// A dot parked in the menu-bar or Dock strip belongs to the display it is
  /// on, not whichever display is main.
  func testDotInMenuBarStripStaysOnItsDisplay() throws {
    let screen = try XCTUnwrap(NSScreen.main)
    let strip = NSRect(x: screen.frame.midX, y: screen.frame.maxY - 10, width: 44, height: 44)
      .intersection(screen.frame)
    XCTAssertFalse(screen.visibleFrame.contains(strip))
    XCTAssertTrue(OverlayController.screen(containing: strip) === screen)
    XCTAssertNil(OverlayController.screen(containing: NSRect(x: -50_000, y: -50_000, width: 44, height: 44)))
  }

  func testContentResizeWaitsForDrop() throws {
    let (c, panel) = try showPill()
    c.beginDrag()
    c.toggle() // expands while held: must not resize under the drag
    XCTAssertTrue(OverlayState.shared.expanded)
    XCTAssertEqual(panel.frame.width, 44)
    c.endDrag(cursor: NSPoint(x: panel.frame.midX, y: panel.frame.midY))
    XCTAssertFalse(c.isDragging)
    XCTAssertEqual(panel.frame.width, 320)
  }

  // MARK: Header

  func testExpandedHeaderDragsWhileCloseButtonAndFieldKeepClicks() throws {
    let (c, panel) = try showPill()
    c.toggle()
    settle()
    panel.contentView?.layoutSubtreeIfNeeded()
    let size = panel.frame.size
    XCTAssertEqual(size.width, 320)
    // Find the header row: the first band from the top where the title hits
    // the drag handle.
    let band = stride(from: size.height - 1, to: size.height - 50, by: -1)
      .filter { hit(panel, NSPoint(x: 20, y: $0)) is OverlayDragView }
    XCTAssertFalse(band.isEmpty, "title does not reach the drag handle")
    let headerY = try XCTUnwrap(band.isEmpty ? nil : band[band.count / 2])
    let row = stride(from: 13, to: 307, by: 1).map { hit(panel, NSPoint(x: CGFloat($0), y: headerY)) }
    // Close button (right edge) keeps its click.
    XCTAssertFalse(hit(panel, NSPoint(x: 320 - 12 - 6, y: headerY)) is OverlayDragView, "close button must keep its click")
    // The Supervisor picker, when the local daemon reports one, stays on top.
    if FleetConsumer.shared.available {
      XCTAssertTrue(row.contains { $0.map(isInSegmentedControl) ?? false }, "picker must sit above the drag handle")
    }
    // The Quick Ask field below the header is never a drag handle.
    let field = stride(from: headerY - 1, to: 0, by: -1).lazy
      .compactMap { self.hit(panel, NSPoint(x: 160, y: $0)) }
      .first { $0 is NSTextField || $0 is NSTextView }
    XCTAssertNotNil(field, "Quick Ask field not found below the header")

    let grabX = try XCTUnwrap(row.indices.last { row[$0] is OverlayDragView }).advanced(by: 13)
    let origin = panel.frame.origin
    let start = NSPoint(x: origin.x + CGFloat(grabX), y: origin.y + headerY)
    try send(.leftMouseDown, to: panel, screen: start)
    try send(.leftMouseDragged, to: panel, screen: start.offset(-40, 20))
    try send(.leftMouseUp, to: panel, screen: start.offset(-40, 20))
    XCTAssertEqual(panel.frame.origin, origin.offset(-40, 20))
    XCTAssertTrue(OverlayState.shared.expanded, "dragging the header must not collapse")
    // The dot moved with the panel.
    XCTAssertEqual(savedPillOrigin(), NSPoint(x: visible.minX + 300, y: visible.minY + 300).offset(-40, 20))
  }

  /// Same header layout with the Supervisor picker (FleetConsumer.available
  /// cannot be forced in tests): the segmented control stays clickable.
  func testHeaderPickerKeepsClicks() throws {
    let panel = KeyableOverlayPanel(
      contentRect: NSRect(x: visible.minX + 300, y: visible.minY + 300, width: 320, height: 40),
      styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    defer { panel.close() }
    var tab = 0
    panel.contentView = NSHostingView(rootView:
      HStack {
        Text("Ask OpenAGI").font(.caption)
        Picker("View", selection: Binding(get: { tab }, set: { tab = $0 })) {
          Text("Tasks").tag(0)
          Text("Supervisor").tag(1)
        }
        .pickerStyle(.segmented).labelsHidden().controlSize(.small).fixedSize()
        Spacer()
        Button(action: {}) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain)
      }
      .background { OverlayDragHandle() }
      .padding(12)
      .frame(width: 320))
    panel.orderFrontRegardless()
    panel.contentView?.layoutSubtreeIfNeeded()
    let y = panel.frame.height / 2
    let hits = stride(from: 13, to: 307, by: 2).map { hit(panel, NSPoint(x: CGFloat($0), y: y)) }
    XCTAssertTrue(hits.contains { $0 is OverlayDragView })
    XCTAssertTrue(hits.contains { $0.map(isInSegmentedControl) ?? false }, "picker must sit above the drag handle")
  }

  // MARK: Helpers

  private func isInSegmentedControl(_ view: NSView) -> Bool {
    var cur: NSView? = view
    while let v = cur { if v is NSSegmentedControl { return true }; cur = v.superview }
    return false
  }

  /// Let the animated resize (0.22s) and queued content-change resizes finish.
  /// RunLoop.run(until:) can return early when nothing is scheduled, so spin
  /// in short steps until the full second has passed.
  private func settle() {
    let end = Date().addingTimeInterval(1.0)
    while Date() < end { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
  }

  private func send(_ type: NSEvent.EventType, to panel: NSPanel, screen: NSPoint) throws {
    let event = try XCTUnwrap(NSEvent.mouseEvent(
      with: type, location: panel.convertPoint(fromScreen: screen), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber,
      context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    NSApplication.shared.sendEvent(event)
  }

  /// An event carrying only a global position, as the window server delivers.
  private func globalEvent(_ type: CGEventType, at cocoa: NSPoint) throws -> NSEvent {
    let primaryTop = NSScreen.screens.first!.frame.maxY
    let cg = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: type,
      mouseCursorPosition: CGPoint(x: cocoa.x, y: primaryTop - cocoa.y), mouseButton: .left))
    return try XCTUnwrap(NSEvent(cgEvent: cg))
  }
}

private extension NSPoint {
  func offset(_ dx: CGFloat, _ dy: CGFloat) -> NSPoint { NSPoint(x: x + dx, y: y + dy) }
}
