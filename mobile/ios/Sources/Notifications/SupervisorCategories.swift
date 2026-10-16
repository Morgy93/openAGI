import Foundation
import UserNotifications

// Notification categories for supervisor alerts, shared by the app and the
// notification service extension (project.yml compiles this file into
// both). `setNotificationCategories` replaces the whole set, so every write
// merges into what is already registered instead of replacing it: the app
// registering its base category at launch must not strip the buttons off an
// alert the extension rewrote a minute ago.
enum SupervisorCategories {
    // What a relay alert arrives as. No buttons: without a decrypted option
    // list there is nothing to answer with. A tap still opens Supervisor.
    static func base() -> UNNotificationCategory {
        UNNotificationCategory(identifier: SupervisorPushContent.baseCategory, actions: [], intentIdentifiers: [])
    }

    // One button per option, then Dismiss. Both need an unlocked phone: a tap
    // relays text to a live coding agent (Android does the same).
    static func category(for alert: SupervisorPushContent.Alert) -> UNNotificationCategory {
        var actions = alert.actionTitles.enumerated().map { index, title in
            UNNotificationAction(identifier: SupervisorPushContent.answerActionPrefix + String(index),
                                 title: title, options: [.authenticationRequired])
        }
        actions.append(UNNotificationAction(identifier: SupervisorPushContent.dismissAction,
                                            title: SupervisorPushContent.dismissTitle, options: [.authenticationRequired]))
        return UNNotificationCategory(identifier: alert.categoryIdentifier, actions: actions, intentIdentifiers: [])
    }

    // Everything that is not a per-question `sq.*` category is kept as is.
    // An `sq.*` category survives only while an alert in the shade still
    // uses it, so the set cannot grow without bound.
    static func merged(existing: Set<UNNotificationCategory>, adding: UNNotificationCategory,
                       inUse: Set<String>) -> Set<UNNotificationCategory> {
        var result = existing.filter { category in
            guard category.identifier != adding.identifier else { return false }
            guard category.identifier.hasPrefix(SupervisorPushContent.categoryPrefix) else { return true }
            return inUse.contains(category.identifier)
        }
        result.insert(adding)
        return result
    }

    static func register(_ category: UNNotificationCategory, center: UNUserNotificationCenter = .current()) async {
        let existing = await center.notificationCategories()
        let inUse = Set(await center.deliveredNotifications().map(\.request.content.categoryIdentifier))
        center.setNotificationCategories(merged(existing: existing, adding: category, inUse: inUse))
        // Reading the set back waits for the write to land. Without it, an
        // extension that hands its content over straight away can have the
        // alert shown before its category exists, with no buttons.
        _ = await center.notificationCategories()
    }
}
