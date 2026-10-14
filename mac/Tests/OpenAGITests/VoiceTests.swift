import Foundation
import Network
import XCTest
@testable import OpenAGI

final class VoiceTests: XCTestCase {
  private func json(_ control: VoiceControl) throws -> [String: Any] {
    guard case .string(let text) = try control.message() else {
      XCTFail("Controls must be text frames")
      return [:]
    }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
  }

  func testStartFrameMatchesRelayProtocol() throws {
    let frame = try json(VoiceControl(type: "start", gesture: "hotkey", mode: "ptt", focus: VoiceFocus()))
    XCTAssertEqual(frame["type"] as? String, "start")
    XCTAssertEqual(frame["gesture"] as? String, "hotkey")
    XCTAssertEqual(frame["mode"] as? String, "ptt")
    XCTAssertEqual((frame["focus"] as? [String: Any])?["view"] as? String, "supervisor")
    XCTAssertNil(frame["token"])
    XCTAssertNil(frame["sessionId"])
  }

  func testCommitAndBargeAreTopLevelControls() throws {
    XCTAssertEqual(try json(VoiceControl(type: "commit"))["type"] as? String, "commit")
    let barge = try json(VoiceControl(type: "barge", playedMs: 1250))
    XCTAssertEqual(barge["playedMs"] as? Int, 1250)
    XCTAssertNil(barge["ctrl"])
    XCTAssertNil(barge["focus"])
  }

  func testContextFrameKeepsQuestionAndThreadTogether() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_42","threadKey":"codex:thread-7","title":"Which branch?"}
      """.utf8))
    let frame = try json(VoiceControl(type: "context", focus: .question(question)))
    let focus = try XCTUnwrap(frame["focus"] as? [String: Any])
    XCTAssertEqual(focus["view"] as? String, "supervisor")
    XCTAssertEqual(focus["threadKey"] as? String, "codex:thread-7")
    XCTAssertEqual(focus["questionId"] as? String, "fq_42")
    XCTAssertNil(focus["title"])
  }

  func testGroupedQuestionUsesChatThreadWhenNoPrimaryThread() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_group","chats":[{"threadKey":"codex:a","label":"Agent"}]}
      """.utf8))
    XCTAssertEqual(VoiceFocus.question(question).threadKey, "codex:a")
  }

  func testThreadContextAndClearedFocus() throws {
    let thread = try JSONDecoder().decode(FleetThread.self, from: Data("""
      {"key":"codex:a","title":"Voice","pr":{"ref":"Spshulem/openAGI#201"}}
      """.utf8))
    let focus = VoiceFocus.thread(thread)
    XCTAssertEqual(focus.threadKey, "codex:a")
    XCTAssertEqual(focus.prRef, "Spshulem/openAGI#201")
    XCTAssertNil(focus.questionId)
    let cleared = try json(VoiceControl(type: "context", focus: VoiceFocus()))
    XCTAssertEqual((cleared["focus"] as? [String: Any])?.count, 1)
  }

  func testPTTCommitsOnReleaseOnce() {
    var state = VoicePTT()
    XCTAssertEqual(state.press(.hotkey), [.connect])
    XCTAssertEqual(state.press(.hotkey), [])
    XCTAssertEqual(state.ready(), [.capture])
    state.append(9600)
    XCTAssertEqual(state.release(.hotkey), [.commit])
    XCTAssertEqual(state.phase, .waiting)
    XCTAssertEqual(state.release(.hotkey), [])
  }

  func testReleaseDuringConnectionNeverStartsMicrophone() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    XCTAssertEqual(state.release(.hotkey), [])
    XCTAssertEqual(state.ready(), [])
    XCTAssertEqual(state.phase, .ready)
    XCTAssertEqual(state.press(.hotkey), [.capture])
  }

  func testBargeBeforeNewCapture() {
    var state = VoicePTT()
    _ = state.press(.mic)
    _ = state.ready()
    state.append(9600)
    _ = state.release(.mic)
    state.reply()
    XCTAssertEqual(state.press(.hotkey), [.barge, .capture])
    state.replyDone()
    XCTAssertEqual(state.phase, .recording)
  }

  func testShortTurnCommitsToClearHubBuffer() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    _ = state.ready()
    state.append(960)
    XCTAssertEqual(state.release(.hotkey), [.commit])
    XCTAssertEqual(state.phase, .ready)
    _ = state.press(.hotkey)
    XCTAssertEqual(state.release(.hotkey), [])
  }

  func testOverlappingMicAndHotkeyHoldUntilBothRelease() {
    var state = VoicePTT()
    _ = state.press(.mic)
    _ = state.ready()
    XCTAssertEqual(state.press(.hotkey), [])
    state.append(9600)
    XCTAssertEqual(state.release(.mic), [])
    XCTAssertEqual(state.phase, .recording)
    XCTAssertEqual(state.release(.hotkey), [.commit])
  }

  func testResetAfterFailureNeedsNewGesture() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    state.reset()
    XCTAssertEqual(state.phase, .idle)
    XCTAssertTrue(state.held.isEmpty)
    XCTAssertEqual(state.release(.hotkey), [])
    XCTAssertEqual(state.press(.mic), [.connect])
  }

  func testConnectionUsesSubprotocolTokenNotURLToken() throws {
    let connection = try VoiceConnection(base: "https://hub.example/fleet?token=discarded#card", token: "test-daemon-token-1234")
    XCTAssertEqual(connection.url.absoluteString, "wss://hub.example/nodes/voice?rate=24000&mode=ptt")
    XCTAssertEqual(connection.token, "test-daemon-token-1234")
  }

  func testConnectionRejectsInsecureRemoteOrMissingPairing() throws {
    XCTAssertThrowsError(try VoiceConnection(base: "http://hub.example", token: "test-daemon-token-1234"))
    XCTAssertThrowsError(try VoiceConnection(base: "https://hub.example", token: ""))
    XCTAssertThrowsError(try VoiceConnection(base: "https://user:password@hub.example", token: "test-daemon-token-1234"))
    XCTAssertEqual(try VoiceConnection(base: "http://127.0.0.1:1234", token: "test-daemon-token-1234").url.scheme, "ws")
  }

  func testDisabledVoiceAndAuthenticationErrorsAreClear() {
    XCTAssertTrue(VoiceConnection.failureMessage(status: 404).contains("OPENAGI_VOICE=1"))
    XCTAssertTrue(VoiceConnection.failureMessage(status: 403).contains("daemon token"))
    XCTAssertTrue(VoiceConnection.failureMessage(status: nil).contains("hub configuration"))
  }

  func testDisabledVoiceHandshakeProvidesHTTPStatus() async throws {
    let listener = try NWListener(using: .tcp, on: .any)
    let ready = expectation(description: "Fixture listening")
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.fulfill() }
    }
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
        let response = Data("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    listener.start(queue: .global())
    defer { listener.cancel() }
    await fulfillment(of: [ready], timeout: 5)
    let port = try XCTUnwrap(listener.port)
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port.rawValue)/nodes/voice"))
    let socket = session.webSocketTask(with: url, protocols: ["openagi-voice", "test-daemon-token-1234"])
    socket.resume()
    do {
      _ = try await socket.receive()
      XCTFail("The disabled relay must reject the upgrade")
    } catch {
      XCTAssertEqual((socket.response as? HTTPURLResponse)?.statusCode, 404)
    }
  }
}
