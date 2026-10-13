import Foundation
import XCTest
@testable import OpenAGI

final class FleetWatchingTests: XCTestCase {
  private let now = ISO8601DateFormatter().date(from: "2026-10-12T12:00:00Z")!

  private func decodeState(_ json: String) throws -> FleetState {
    try JSONDecoder().decode(FleetState.self, from: Data(json.utf8))
  }

  private func thread(_ key: String, _ group: String?, since: String? = nil, activity: String? = nil) -> FleetThread {
    FleetThread(key: key, title: key, lastActivityAt: activity,
                watch: group.map { FleetWatch(group: $0, since: since) })
  }

  // MARK: - Decoding

  func testDecodesWatchAndRowFields() throws {
    let state = try decodeState("""
      {"mode":"propose","enabled":true,"questions":[],
       "snapshot":{"counts":{"byWatch":{"waiting":1}},"threads":[
         {"key":"codex:a","title":"Fix login","workspace":"amman","state":"waiting-ci",
          "pr":{"ref":"Spshulem/openAGI#178","url":"https://github.com/Spshulem/openAGI/pull/178"},
          "lastActivityAt":"2026-10-12T11:50:00Z","lastAgentAt":"2026-10-12T11:49:00Z",
          "watch":{"group":"waiting","since":"2026-10-12T11:37:00.000Z","waitingOn":"BuildBot3 full run",
                   "waitSince":"2026-10-12T11:37:00.000Z","runningSince":null}}
       ]}}
      """)
    XCTAssertEqual(state.threads.count, 1)
    let t = state.threads[0]
    XCTAssertEqual(t.name, "Fix login")
    XCTAssertEqual(t.prShortRef, "openAGI#178")
    XCTAssertEqual(t.prLink?.absoluteString, "https://github.com/Spshulem/openAGI/pull/178")
    XCTAssertEqual(t.lastAgentAt, "2026-10-12T11:49:00Z")
    XCTAssertEqual(t.watch, FleetWatch(group: "waiting", since: "2026-10-12T11:37:00.000Z",
      waitingOn: "BuildBot3 full run", waitSince: "2026-10-12T11:37:00.000Z", runningSince: nil))
    XCTAssertEqual(FleetWatching.rowText(t.watch!, now: now), "on BuildBot3 full run for 23m")
  }

  func testMissingWatchFallsBackToState() throws {
    // A daemon from before Watching: no watch key on any row.
    let state = try decodeState("""
      {"questions":[],"snapshot":{"threads":[
        {"key":"a","state":"running","lastActivityAt":"2026-10-12T11:48:00Z"},
        {"key":"b","state":"needs-human"},
        {"key":"c","state":"pr-not-ready"},
        {"key":"d","state":"infra-blocked"},
        {"key":"e","state":"done"},
        {"key":"f","state":"excluded"},
        {"key":"g","state":"something-new"},
        {"key":"h"}
      ]}}
      """)
    let groups = Dictionary(uniqueKeysWithValues: state.threads.map { ($0.key, $0.watch?.group) })
    XCTAssertEqual(groups["a"], "working")
    XCTAssertEqual(groups["b"], "you")
    XCTAssertEqual(groups["c"], "push")
    XCTAssertEqual(groups["d"], "blocked")
    XCTAssertEqual(groups["e"], "quiet")
    XCTAssertEqual(groups["f"], .some(nil))
    XCTAssertEqual(groups["g"], "quiet")
    XCTAssertEqual(groups["h"], .some(nil))
    // Timed from the last activity; an old daemon can't say what it waits on.
    let a = state.threads[0].watch!
    XCTAssertEqual(a.since, "2026-10-12T11:48:00Z")
    XCTAssertNil(a.waitingOn)
    XCTAssertEqual(FleetWatching.rowText(a, now: now), "for 12m")
  }

  func testNullWatchIsOutOfScopeAndBadWatchFallsBack() throws {
    let state = try decodeState("""
      {"questions":[],"snapshot":{"threads":[
        {"key":"a","state":"running","watch":null},
        {"key":"b","state":"waiting-ci","watch":{"since":"2026-10-12T11:00:00Z"}},
        {"key":"c","state":"running","watch":"working"},
        {"title":"no key, dropped","watch":{"group":"you"}},
        {"key":"d","title":7,"pr":"nope","watch":{"group":"push","since":42}}
      ]}}
      """)
    XCTAssertEqual(state.threads.map(\.key), ["a", "b", "c", "d"])
    XCTAssertNil(state.threads[0].watch)
    XCTAssertEqual(state.threads[1].watch?.group, "waiting")
    XCTAssertEqual(state.threads[2].watch?.group, "working")
    let d = state.threads[3]
    XCTAssertEqual(d.watch?.group, "push")
    XCTAssertNil(d.watch?.since)
    XCTAssertEqual(d.name, "d")
    XCTAssertNil(d.prShortRef)
  }

  func testNoSnapshotOrBadSnapshotMeansNoThreads() throws {
    XCTAssertEqual(try decodeState(#"{"questions":[],"snapshot":null}"#).threads, [])
    XCTAssertEqual(try decodeState(#"{"questions":[]}"#).threads, [])
    XCTAssertEqual(try decodeState(#"{"questions":[],"snapshot":{"threads":{"a":1}}}"#).threads, [])
    XCTAssertEqual(try decodeState(#"{"questions":[],"snapshot":"x"}"#).threads, [])
  }

  // MARK: - Grouping and sorting

  func testGroupsInPageOrderWithLabels() {
    let threads = [
      thread("q", "quiet"), thread("b", "blocked"), thread("x", nil), thread("w", "working"),
      thread("p", "push"), thread("y", "you"), thread("c", "waiting"), thread("n", "new-group")
    ]
    let groups = FleetWatching.groups(threads)
    XCTAssertEqual(groups.map(\.group), ["you", "working", "waiting", "push", "blocked", "quiet", "new-group"])
    XCTAssertEqual(groups.map(\.label), ["Waiting on you", "Working", "Waiting on CI or BuildBot3",
      "Needs a push", "Blocked by infra", "Quiet", "new-group"])
    XCTAssertFalse(groups.flatMap(\.threads).contains { $0.key == "x" })
  }

  func testLongestWaitFirstAndQuietNewestFirst() {
    let threads = [
      thread("w-new", "waiting", since: "2026-10-12T11:50:00Z"),
      thread("w-none", "waiting", since: nil),
      thread("w-old", "waiting", since: "2026-10-12T09:00:00.000Z"),
      thread("w-mid", "waiting", since: "2026-10-12T11:00:00Z"),
      thread("q-old", "quiet", since: "2026-10-12T11:59:00Z", activity: "2026-10-10T00:00:00Z"),
      thread("q-new", "quiet", since: "2026-10-01T00:00:00Z", activity: "2026-10-12T11:00:00Z"),
      thread("q-none", "quiet")
    ]
    let groups = FleetWatching.groups(threads)
    XCTAssertEqual(groups[0].threads.map(\.key), ["w-old", "w-mid", "w-new", "w-none"])
    XCTAssertEqual(groups[1].threads.map(\.key), ["q-new", "q-old", "q-none"])
  }

  func testLayoutCapsRowsAndKeepsQuietCollapsed() {
    var threads = (0..<10).map { thread("you\($0)", "you", since: "2026-10-12T10:0\($0):00Z") }
    threads += (0..<5).map { thread("work\($0)", "working", since: "2026-10-12T11:0\($0):00Z") }
    threads += (0..<4).map { thread("quiet\($0)", "quiet") }

    // A few rows per group: ten waiting on the owner cannot hide the rest.
    let closed = FleetWatching.layout(threads, openGroups: [])
    XCTAssertEqual(closed.sections.map(\.group), ["you", "working", "quiet"])
    XCTAssertEqual(closed.sections.map(\.rows.count), [4, 4, 0])
    XCTAssertEqual(closed.sections.map(\.total), [10, 5, 4])
    XCTAssertEqual(closed.sections.map(\.collapsed), [false, false, true])
    XCTAssertEqual(closed.hidden, 7)

    let open = FleetWatching.layout(threads, openGroups: ["quiet"])
    XCTAssertEqual(open.sections.map(\.rows.count), [4, 4, 4])
    XCTAssertFalse(open.sections[2].collapsed)
    XCTAssertEqual(open.hidden, 7)

    // The overall cap still holds across groups.
    let capped = FleetWatching.layout(threads, openGroups: ["quiet"], limit: 6)
    XCTAssertEqual(capped.sections.map(\.rows.count), [4, 2, 0])
    XCTAssertEqual(capped.hidden, 13)

    let few = FleetWatching.layout(Array(threads.suffix(4)), openGroups: ["quiet"])
    XCTAssertEqual(few.sections.map(\.rows.count), [4])
    XCTAssertEqual(few.hidden, 0)
    XCTAssertEqual(FleetWatching.layout([thread("x", nil)], openGroups: []).sections, [])
  }

  // MARK: - Row text and durations

  func testRowText() {
    let ci = FleetWatch(group: "waiting", since: "2026-10-12T11:48:00Z", waitingOn: "CI")
    XCTAssertEqual(FleetWatching.rowText(ci, now: now), "on CI for 12m")
    // Only a waiting row says what it waits on.
    let you = FleetWatch(group: "you", since: "2026-10-12T10:00:00Z", waitingOn: "your answer")
    XCTAssertEqual(FleetWatching.rowText(you, now: now), "for 2h")
    XCTAssertEqual(FleetWatching.rowText(FleetWatch(group: "waiting", since: nil, waitingOn: "bb-quick"), now: now), "on bb-quick")
    XCTAssertNil(FleetWatching.rowText(FleetWatch(group: "push", since: "soon"), now: now))
    // A clock ahead of ours never shows a negative time.
    XCTAssertEqual(FleetWatching.rowText(FleetWatch(group: "working", since: "2026-10-12T12:05:00Z"), now: now), "for 0s")
  }

  func testDurationMatchesThePage() {
    XCTAssertEqual(FleetWatching.duration(-5), "0s")
    XCTAssertEqual(FleetWatching.duration(42), "42s")
    XCTAssertEqual(FleetWatching.duration(59.4), "59s")
    XCTAssertEqual(FleetWatching.duration(90), "2m")
    XCTAssertEqual(FleetWatching.duration(23 * 60), "23m")
    XCTAssertEqual(FleetWatching.duration(59 * 60 + 20), "59m")
    XCTAssertEqual(FleetWatching.duration(59 * 60 + 40), "1h")
    XCTAssertEqual(FleetWatching.duration(5 * 3600 + 29 * 60), "5h")
    XCTAssertEqual(FleetWatching.duration(47 * 3600), "47h")
    XCTAssertEqual(FleetWatching.duration(48 * 3600), "2d")
    XCTAssertEqual(FleetWatching.duration(10 * 86_400), "10d")
  }

  func testNameAndPullRequestLinks() {
    XCTAssertEqual(FleetThread(key: "k", title: "  ", workspace: "amman", watch: nil).name, "amman")
    XCTAssertEqual(FleetThread(key: "k", watch: nil).name, "k")
    let refOnly = FleetThread(key: "k", prRef: "Spshulem/openAGI#12", watch: nil)
    XCTAssertEqual(refOnly.prShortRef, "openAGI#12")
    XCTAssertEqual(refOnly.prLink?.absoluteString, "https://github.com/Spshulem/openAGI/pull/12")
    let odd = FleetThread(key: "k", prRef: "#12", prURL: "https://evil.example/pull/1", watch: nil)
    XCTAssertEqual(odd.prShortRef, "#12")
    XCTAssertNil(odd.prLink)
  }
}
