import Foundation
import UserNotifications

// OpenAGINotify: rewrites a supervisor alert on the phone. The relay can only
// send generic text ("Supervisor needs you") plus the sealed envelope; this
// opens the envelope with the push key and puts the real question, its
// answer buttons and the exact option strings onto the notification. Any
// failure (no key yet, a key from another pairing, a tampered payload) leaves
// the generic text: the alert still arrives and a tap still opens Supervisor.
//
// The mapping itself is SupervisorPushContent.alert, pinned by the app's
// tests; this file only applies it.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    // Guarded by `lock`: the content handler must run exactly once, either
    // from the normal path or from the expiry callback.
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.withLock {
            self.contentHandler = contentHandler
            self.bestAttempt = request.content
        }
        guard let alert = SupervisorPushContent.alert(userInfo: request.content.userInfo, key: PushKeyStore.load()),
              let content = request.content.mutableCopy() as? UNMutableNotificationContent
        else {
            finish(with: request.content)
            return
        }
        content.title = alert.title
        content.body = alert.body
        content.categoryIdentifier = alert.categoryIdentifier
        var userInfo = content.userInfo
        for (key, value) in alert.userInfo { userInfo[key] = value }
        content.userInfo = userInfo
        let rewritten = content.copy() as? UNNotificationContent ?? content
        lock.withLock { bestAttempt = rewritten }

        // Neither type is Sendable; both are built here and never touched
        // again outside the task.
        nonisolated(unsafe) let category = SupervisorCategories.category(for: alert)
        nonisolated(unsafe) let delivered = rewritten
        Task {
            await SupervisorCategories.register(category)
            self.finish(with: delivered)
        }
    }

    // The system gives the extension about 30 seconds. Running out while
    // registering the category still delivers the decrypted text.
    override func serviceExtensionTimeWillExpire() {
        let content = lock.withLock { bestAttempt }
        if let content { finish(with: content) }
    }

    private func finish(with content: UNNotificationContent) {
        let handler = lock.withLock { () -> ((UNNotificationContent) -> Void)? in
            defer { contentHandler = nil }
            return contentHandler
        }
        handler?(content)
    }
}
