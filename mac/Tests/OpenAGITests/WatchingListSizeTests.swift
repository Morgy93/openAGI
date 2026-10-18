import AppKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// The Watching list must not grow the Supervisor panel past a fixed height:
/// the panel is capped at the screen, so anything taller is cut off.
@MainActor
final class WatchingListSizeTests: XCTestCase {
  private func thread(_ key: String, _ group: String) -> FleetThread {
    FleetThread(key: key, title: "Thread \(key)", lastActivityAt: nil,
                watch: FleetWatch(group: group, since: "2026-10-12T11:00:00Z"))
  }

  private func height(_ threads: [FleetThread], limit: Int) -> CGFloat {
    _ = NSApplication.shared
    let layout = FleetWatching.layout(threads, openGroups: ["quiet"], limit: limit)
    let view = NSHostingView(rootView: WatchingList(layoutOverride: layout).frame(width: 360))
    view.layoutSubtreeIfNeeded()
    return view.fittingSize.height
  }

  private let groups = ["you", "working", "waiting", "push", "blocked", "quiet"]

  func testLongListScrollsInsideCap() {
    let threads = (0..<60).map { thread("t\($0)", groups[$0 % groups.count]) }
    // Title, the capped scroll area, and the "N more" link outside it.
    XCTAssertLessThanOrEqual(height(threads, limit: 60), WatchingList.maxListHeight + 60)
  }

  func testShortListDoesNotReserveTheCap() {
    let h = height([thread("a", "working")], limit: FleetWatching.rowLimit)
    XCTAssertGreaterThan(h, 0)
    XCTAssertLessThan(h, WatchingList.maxListHeight / 2)
  }
}
