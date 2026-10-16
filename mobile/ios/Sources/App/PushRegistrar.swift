import ActivityKit
import CryptoKit
import Foundation
import UIKit
import UserNotifications

// Registers this phone for supervisor pushes (the spec's "PushRegistrar"):
//
//   1. after pairing, ask for notification permission and an APNs device
//      token, and listen for the Live Activity push-to-start token;
//   2. once both tokens exist, trade them at the relay for a `pass`;
//   3. hand `pass` + this phone's push key to its own daemon.
//
// Steps 2-3 rerun only when something they depend on changed (a token, the
// pairing, the relay, the APNs environment), and any failure leaves the
// stored signature unset so the next foreground or background refresh tries
// again. Nothing here ever blocks the app: push is an extra, not a gate.
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
        static let registered = "push.registeredSignature"
    }

    private let defaults: UserDefaults
    private var startTokenTask: Task<Void, Never>?
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
        // needs no notification permission, and the relay needs both tokens.
        UIApplication.shared.registerForRemoteNotifications()
        observeStartTokens()
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
        guard let credentials = Credentials.load(),
              let deviceToken = defaults.string(forKey: Keys.deviceToken),
              let startToken = defaults.string(forKey: Keys.startToken)
        else { return }
        let relay = PushRelayClient()
        let signature = Self.signature(deviceToken: deviceToken, startToken: startToken, env: Self.env,
                                       nodeID: credentials.nodeID, server: credentials.server, relay: relay.base)
        guard defaults.string(forKey: Keys.registered) != signature else { return }
        do {
            let key = try PushKeyStore.loadOrCreate()
            let pass = try await relay.register(deviceToken: deviceToken, startToken: startToken, env: Self.env)
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            try await client.registerPush(pass: pass, key: key.base64URLEncodedString(), env: Self.env)
            // Unpaired while this ran: do not mark a registration that the
            // forget path is already tearing down.
            guard Credentials.load() == credentials else { return }
            defaults.set(signature, forKey: Keys.registered)
        } catch {
            defaults.removeObject(forKey: Keys.registered)
        }
    }

    // Forget pairing: tell the daemon to stop pushing (best effort; a revoke
    // removes the record daemon-side too), end any Live Activity, clear the
    // shade and drop the key so nothing sealed for this pairing opens again.
    // Tokens are kept: they belong to the phone, not the pairing.
    func forget(client: DaemonClient) async {
        try? await client.unregisterPush()
        defaults.removeObject(forKey: Keys.registered)
        PushKeyStore.clear()
        for activity in Activity<SupervisorActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    // Everything a relay registration depends on, hashed so the stored value
    // says nothing about the tokens.
    nonisolated static func signature(deviceToken: String, startToken: String, env: String,
                                      nodeID: String, server: URL, relay: URL) -> String {
        let joined = [deviceToken, startToken, env, nodeID, server.absoluteString, relay.absoluteString]
            .joined(separator: "\n")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
