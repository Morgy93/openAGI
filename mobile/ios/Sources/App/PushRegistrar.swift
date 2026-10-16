import ActivityKit
import CryptoKit
import Foundation
import Security
import UIKit
import UserNotifications

// Registers this phone for supervisor pushes (the spec's "PushRegistrar"):
//
//   1. after pairing, ask for notification permission and an APNs device
//      token, and listen for the Live Activity push-to-start token;
//   2. trade the tokens at the relay for a `pass` (the device token alone is
//      enough: alerts never wait on Live Activities), and keep it;
//   3. hand `pass` + this phone's push key to its own daemon.
//
// Step 2 reruns only when a token, the relay or the APNs environment
// changed, and the pass is saved the moment the relay returns it, so a
// failed step 3 retries without minting another relay channel. Step 3 runs on
// every sync (foreground, background refresh, token arrival): re-posting the
// same pass is idempotent daemon-side and repairs a daemon that lost its
// record. Nothing here ever blocks the app: push is an extra, not a gate.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    // Development-signed builds get sandbox tokens; TestFlight and App Store
    // builds (Release) get production ones. The relay must call the matching
    // APNs host or every send fails with BadDeviceToken.
    static var env: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private enum Keys {
        static let deviceToken = "push.deviceToken"
        static let startToken = "push.startToken"
    }

    enum Step: Equatable {
        case idle
        // Get a new pass, then retire `replacing` (best effort) and post.
        case register(replacing: String?)
        case post(pass: String)
    }

    private let defaults: UserDefaults
    private var startTokenTask: Task<Void, Never>?
    private var activityTask: Task<Void, Never>?
    // Order this process first saw each activity in; the newest one is kept.
    private var activityFirstSeen: [String: Int] = [:]
    private var syncing = false
    private var syncAgain = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // Called once a pairing exists (RootTabView appears). Safe to call again.
    func start() async {
        guard Credentials.load() != nil else { return }
        let center = UNUserNotificationCenter.current()
        await SupervisorCategories.register(SupervisorCategories.base(), center: center)
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        // Asked for whatever the answer above: a Live Activity started by push
        // needs no notification permission.
        UIApplication.shared.registerForRemoteNotifications()
        observeStartTokens()
        observeActivities()
        await sync()
    }

    func didRegister(deviceToken: Data) {
        defaults.set(deviceToken.hexString, forKey: Keys.deviceToken)
        Task { await sync() }
    }

    private func didReceive(startToken: Data) {
        defaults.set(startToken.hexString, forKey: Keys.startToken)
        Task { await sync() }
    }

    private func observeStartTokens() {
        guard startTokenTask == nil else { return }
        startTokenTask = Task { [weak self] in
            for await token in Activity<SupervisorActivityAttributes>.pushToStartTokenUpdates {
                self?.didReceive(startToken: token)
            }
        }
    }

    // A token rotation or a daemon restart can leave two activities on the
    // lock screen. Only the newest one gets the channel's next update, so
    // every older one is ended.
    private func observeActivities() {
        guard activityTask == nil else { return }
        endOlderActivities()
        activityTask = Task { [weak self] in
            for await activity in Activity<SupervisorActivityAttributes>.activityUpdates {
                self?.noteActivity(id: activity.id)
            }
        }
    }

    private func noteActivity(id: String) {
        if activityFirstSeen[id] == nil { activityFirstSeen[id] = activityFirstSeen.count }
        endOlderActivities()
    }

    private func endOlderActivities() {
        let live = Activity<SupervisorActivityAttributes>.activities
            .filter { $0.activityState == .active || $0.activityState == .stale }
        let ending = Set(Self.activityIDsToEnd(current: live.map(\.id), firstSeen: activityFirstSeen))
        guard !ending.isEmpty else { return }
        Task {
            for activity in Activity<SupervisorActivityAttributes>.activities where ending.contains(activity.id) {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    // The retry entry point (foreground, background refresh, token arrival).
    // Overlapping calls fold into one follow-up run instead of racing two
    // relay registrations.
    func sync() async {
        if syncing { syncAgain = true; return }
        syncing = true
        defer { syncing = false }
        repeat {
            syncAgain = false
            await syncOnce()
        } while syncAgain
    }

    private func syncOnce() async {
        let credentials = Credentials.load()
        let deviceToken = defaults.string(forKey: Keys.deviceToken)
        // Live Activities switched off in Settings: register as alerts-only
        // rather than hand the relay a token that can start nothing.
        let startToken = ActivityAuthorizationInfo().areActivitiesEnabled ? defaults.string(forKey: Keys.startToken) : nil
        let relay = PushRelayClient()
        let signature = deviceToken.map {
            Self.signature(deviceToken: $0, startToken: startToken, env: Self.env, relay: relay.base)
        }
        let stored = PushPassStore.load()

        var pass: String
        switch Self.step(paired: credentials != nil, signature: signature, stored: stored) {
        case .idle:
            return
        case let .post(existing):
            pass = existing
        case let .register(replacing):
            guard let deviceToken, let signature,
                  let fresh = try? await relay.register(deviceToken: deviceToken, startToken: startToken, env: Self.env)
            else { return }
            pass = fresh
            PushPassStore.save(.init(pass: fresh, signature: signature))
            if let replacing { try? await relay.unregister(pass: replacing) }
        }

        guard let credentials, let key = try? PushKeyStore.loadOrCreate() else { return }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        // A failure here is retried on the next sync with the same pass.
        try? await client.registerPush(pass: pass, key: key.base64URLEncodedString(), env: Self.env,
                                       activities: startToken != nil)
    }

    // Forget pairing: tell the daemon to stop pushing (best effort; a revoke
    // removes the record daemon-side too), retire the pass at the relay, end
    // any Live Activity, clear the shade and drop the key so nothing sealed
    // for this pairing opens again. Tokens are kept: they belong to the
    // phone, not the pairing.
    func forget(client: DaemonClient) async {
        try? await client.unregisterPush()
        if let stored = PushPassStore.load() {
            PushPassStore.clear()
            try? await PushRelayClient().unregister(pass: stored.pass)
        }
        PushKeyStore.clear()
        for activity in Activity<SupervisorActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    // MARK: - Pure decisions (pinned by tests)

    // `signature` is nil until there is a device token.
    nonisolated static func step(paired: Bool, signature: String?, stored: PushPassStore.Stored?) -> Step {
        guard paired, let signature else { return .idle }
        if let stored, stored.signature == signature { return .post(pass: stored.pass) }
        return .register(replacing: stored?.pass)
    }

    // Keeps the newest: first seen latest in this process, and among ones
    // this process never saw start, the last the system lists.
    nonisolated static func activityIDsToEnd(current: [String], firstSeen: [String: Int]) -> [String] {
        guard current.count > 1 else { return [] }
        let ranked = current.enumerated().map { index, id in (id: id, rank: (firstSeen[id] ?? -1, index)) }
        guard let newest = ranked.max(by: { $0.rank < $1.rank }) else { return [] }
        return current.filter { $0 != newest.id }
    }

    // Everything a relay registration depends on, hashed so the stored value
    // says nothing about the tokens.
    nonisolated static func signature(deviceToken: String, startToken: String?, env: String, relay: URL) -> String {
        let joined = [deviceToken, startToken ?? "", env, relay.absoluteString].joined(separator: "\n")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// The current relay pass and the registration it came from, in the keychain
// (it lets anyone holding it push to this phone through the relay). App-only:
// the extensions never need it.
enum PushPassStore {
    struct Stored: Codable, Equatable, Sendable {
        var pass: String
        var signature: String
    }

    private static let service = "sh.openagi.mobile.pushpass"
    private static let account = "primary"

    static func load() -> Stored? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    static func save(_ stored: Stored) {
        guard let data = try? JSONEncoder().encode(stored) else { return }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}
