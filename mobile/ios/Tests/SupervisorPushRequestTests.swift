import XCTest
@testable import OpenAGI

// The HTTP side of push: what a button tap sends to the daemon, how its
// result is judged, and the two registration calls (relay, then daemon).
// Uses DaemonClientTests' StubProtocol, so nothing leaves the process.
final class SupervisorPushRequestTests: XCTestCase {
    override func tearDown() {
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        StubProtocol.lastRequest = nil
        super.tearDown()
    }

    private var stubSession: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeClient() -> DaemonClient {
        DaemonClient(server: URL(string: "http://mac.tail1234.ts.net:43210")!, nodeID: "mobile:abc",
                     token: String(repeating: "a", count: 43), session: stubSession)
    }

    private func respond(_ status: Int, _ body: String) {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
    }

    private func body(of request: URLRequest) throws -> [String: Any] {
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Answer action → request

    private func send(_ action: SupervisorAnswerAction) async -> SupervisorAnswerOutcome {
        let client = makeClient()
        do {
            switch action {
            case let .answer(id, answer):
                return .of(error: nil, delivery: try await client.fleetAnswer(questionID: id, answer: answer).delivery)
            case let .dismiss(id):
                _ = try await client.fleetDismiss(questionID: id)
                return .done
            case .open:
                return .done
            }
        } catch {
            return .of(error: error, delivery: nil)
        }
    }

    func testAnswerButtonPostsTheExactOption() async throws {
        respond(200, #"{"delivery":{"status":"sent"}}"#)
        let action = try XCTUnwrap(SupervisorAnswerAction.from(
            actionIdentifier: "answer.1", defaultActionIdentifier: "default",
            userInfo: ["questionId": "fq123", "options": ["Approve", " Skip "]]))
        let outcome = await send(action)
        XCTAssertEqual(outcome, .done)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/fleet/api/questions/fq123")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:abc")
        XCTAssertEqual(try body(of: request) as? [String: String], ["answer": " Skip "])
    }

    func testDismissButtonPostsDismissTrue() async throws {
        respond(200, "{}")
        let outcome = await send(.dismiss(questionId: "fq123"))
        XCTAssertEqual(outcome, .done)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/fleet/api/questions/fq123")
        XCTAssertEqual(try body(of: request) as? [String: Bool], ["dismiss": true])
    }

    func testAlreadyClosedQuestionCountsAsDone() async {
        respond(404, #"{"error":"not-found"}"#)
        let notFound = await send(.answer(questionId: "gone", answer: "Approve"))
        XCTAssertEqual(notFound, .done)
        respond(409, #"{"error":"closed"}"#)
        let conflict = await send(.dismiss(questionId: "gone"))
        XCTAssertEqual(conflict, .done)
    }

    func testFailuresAndUndeliveredAnswersAreNotSent() async {
        respond(500, "{}")
        let serverError = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(serverError, .failed)
        respond(401, "{}")
        let unauthorized = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(unauthorized, .failed)
        StubProtocol.failure = URLError(.notConnectedToInternet)
        let offline = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(offline, .failed)
        StubProtocol.failure = nil

        respond(200, #"{"delivery":{"status":"blocked","detail":"Agent is busy"}}"#)
        let blocked = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(blocked, .undelivered("Agent is busy"))
        respond(200, #"{"delivery":{"status":"failed"}}"#)
        let failed = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(failed, .undelivered("The agent could not be reached"))
        respond(200, #"{"delivery":{"status":"dry-run"}}"#)
        let dryRun = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(dryRun, .done)
    }

    func testStaleAlertsAreOnlyThoseForClosedQuestions() {
        let stale = SupervisorAnswerSender.staleNotificationIDs(
            delivered: [(id: "n1", questionID: "open"), (id: "n2", questionID: "closed"), (id: "n3", questionID: nil)],
            open: ["open"])
        XCTAssertEqual(stale, ["n2"])
    }

    // MARK: - Registration

    func testRelayRegisterSendsTokensAndReturnsPass() async throws {
        respond(200, #"{"pass":"p1.abc.def"}"#)
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        let pass = try await relay.register(deviceToken: "aa01", startToken: "bb02", env: "sandbox")
        XCTAssertEqual(pass, "p1.abc.def")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://push.example.com/v1/register")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "the relay never sees the node token")
        XCTAssertEqual(try body(of: request) as? [String: String],
                       ["deviceToken": "aa01", "startToken": "bb02", "env": "sandbox"])
    }

    func testRelayErrorsAreTyped() async {
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        respond(429, #"{"error":"rate-limited"}"#)
        await assertRelayThrows(relay, .rejected("rate-limited"))
        respond(502, "oops")
        await assertRelayThrows(relay, .server(502))
        respond(200, #"{"pass":"not-a-pass"}"#)
        await assertRelayThrows(relay, .malformedResponse)
        StubProtocol.failure = URLError(.timedOut)
        await assertRelayThrows(relay, .transport)
    }

    private func assertRelayThrows(_ relay: PushRelayClient, _ expected: PushRelayError, line: UInt = #line) async {
        do {
            _ = try await relay.register(deviceToken: "a", startToken: "b", env: "sandbox")
            XCTFail("expected \(expected)", line: line)
        } catch {
            XCTAssertEqual(error as? PushRelayError, expected, line: line)
        }
    }

    func testDaemonRegisterAndUnregister() async throws {
        respond(200, #"{"ok":true}"#)
        let client = makeClient()
        try await client.registerPush(pass: "p1.x.y", key: "SMOleUn2o5oqGjAszy9JO7-tK3avgOZmkjI34rcEBsM", env: "production")
        var request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/mobile/push")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + String(repeating: "a", count: 43))
        XCTAssertEqual(try body(of: request) as? [String: String],
                       ["pass": "p1.x.y", "key": "SMOleUn2o5oqGjAszy9JO7-tK3avgOZmkjI34rcEBsM", "env": "production"])

        try await client.unregisterPush()
        request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/mobile/push")
    }

    func testRelayURLOverride() {
        XCTAssertEqual(PushRelayClient.configuredURL(info: nil), PushRelayClient.defaultURL)
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": ""]), PushRelayClient.defaultURL)
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "https://relay.example.com"]),
                       URL(string: "https://relay.example.com"))
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "http://relay.example.com"]),
                       PushRelayClient.defaultURL, "plain http only for loopback")
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "http://localhost:8787"]),
                       URL(string: "http://localhost:8787"))
        XCTAssertEqual(PushRelayClient.defaultURL.absoluteString, "https://push.openagi.sh")
    }

    func testRegistrationSignatureChangesWithEveryInput() {
        let server = URL(string: "http://mac.ts.net:43210")!
        let relay = PushRelayClient.defaultURL
        let base = PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", nodeID: "n", server: server, relay: relay)
        XCTAssertEqual(base, PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", nodeID: "n", server: server, relay: relay))
        XCTAssertFalse(base.contains("d\n"), "hashed, not the raw tokens")
        let variants = [
            PushRegistrar.signature(deviceToken: "d2", startToken: "s", env: "sandbox", nodeID: "n", server: server, relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s2", env: "sandbox", nodeID: "n", server: server, relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "production", nodeID: "n", server: server, relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", nodeID: "n2", server: server, relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", nodeID: "n",
                                    server: URL(string: "http://other.ts.net:43210")!, relay: relay)
        ]
        XCTAssertEqual(Set(variants + [base]).count, 6)
    }

    func testHexToken() {
        XCTAssertEqual(Data([0x00, 0xAB, 0x0F]).hexString, "00ab0f")
    }
}

// The push key runs through the real keychain in the xctest host, same as
// CredentialsTests, so this proves the ungrouped pattern works for it too.
final class PushKeyStoreTests: XCTestCase {
    override func tearDown() {
        PushKeyStore.clear()
        super.tearDown()
    }

    func testCreateIsStableUntilCleared() throws {
        PushKeyStore.clear()
        XCTAssertNil(PushKeyStore.load())
        let key = try PushKeyStore.loadOrCreate()
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(PushKeyStore.load(), key)
        XCTAssertEqual(try PushKeyStore.loadOrCreate(), key)
        XCTAssertEqual(key.base64URLEncodedString().count, 43)
        PushKeyStore.clear()
        XCTAssertNil(PushKeyStore.load())
        XCTAssertNotEqual(try PushKeyStore.loadOrCreate(), key)
    }
}
