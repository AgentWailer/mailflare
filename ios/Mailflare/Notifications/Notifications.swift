import UIKit
import UserNotifications
import MailflareKit

/// What a notification about a new message offers, and what the app does with the answers.
enum Notifications {
	/// The category the server sets on a notification about mail.
	static let mailCategory = "MAIL"

	enum Action: String, CaseIterable {
		case archive = "mail.archive"
		case markRead = "mail.read"
		case trash = "mail.trash"

		var mailAction: MailAction {
			switch self {
			case .archive: .archive
			case .markRead: .markRead(true)
			case .trash: .trash
			}
		}

		var title: String {
			switch self {
			case .archive: String(localized: "Archive")
			case .markRead: String(localized: "Mark as read")
			case .trash: String(localized: "Delete")
			}
		}
	}

	/// The message and account a notification is about, as the server wrote them into it.
	nonisolated struct Target: Equatable, Sendable {
		let userId: String
		let messageId: String

		init?(userInfo: [AnyHashable: Any]) {
			guard let userId = userInfo["userId"] as? String, let messageId = userInfo["messageId"] as? String, !userId.isEmpty, !messageId.isEmpty else { return nil }
			self.userId = userId
			self.messageId = messageId
		}
	}

	static func registerCategories() {
		let actions = Action.allCases.map { action in
			// None of them opens the app; deleting is marked as what it is. All of them need the
			// phone unlocked: whoever picks up a locked phone must not be able to move its mail.
			UNNotificationAction(identifier: action.rawValue, title: action.title, options: action == .trash ? [.destructive, .authenticationRequired] : [.authenticationRequired])
		}
		UNUserNotificationCenter.current().setNotificationCategories([
			UNNotificationCategory(identifier: mailCategory, actions: actions, intentIdentifiers: [], options: []),
		])
	}

	/// Asks once; iOS remembers the answer. With permission, asks Apple for this app's address.
	static func requestPermissionAndRegister() async {
		#if DEBUG
		// The walk-through must not meet the system's question in the middle of a step.
		if ProcessInfo.processInfo.environment["MAILFLARE_UI_NO_PASSWORD_SAVING"] == "1" || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
		#endif
		let center = UNUserNotificationCenter.current()
		let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
		if granted { UIApplication.shared.registerForRemoteNotifications() }
	}
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
	func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
		UNUserNotificationCenter.current().delegate = self
		Notifications.registerCategories()
		return true
	}

	func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		let token = deviceToken.map { String(format: "%02x", $0) }.joined()
		Task { await MailflareApp.model.pushTokenReceived(token) }
	}

	/// A notification woke the app: fetch the mail so it is there when the notification is tapped.
	func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
		await MailflareApp.model.backgroundSync()
		return .newData
	}

	// iOS calls these off the main thread on some paths, so they take what they need out of the
	// notification first and only then go to the main actor.

	nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
	                                        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
		// With the app open the list already shows the message; a banner still says whose it is.
		completionHandler([.banner, .list, .sound, .badge])
	}

	nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
	                                        withCompletionHandler completionHandler: @escaping () -> Void) {
		let target = Notifications.Target(userInfo: response.notification.request.content.userInfo)
		let identifier = response.actionIdentifier
		nonisolated(unsafe) let done = completionHandler
		Task { @MainActor in
			defer { done() }
			guard let target else { return }
			if identifier == UNNotificationDefaultActionIdentifier {
				await MailflareApp.model.openFromNotification(userId: target.userId, messageId: target.messageId)
			} else if let action = Notifications.Action(rawValue: identifier) {
				await MailflareApp.model.performFromNotification(action.mailAction, userId: target.userId, messageId: target.messageId)
			}
		}
	}
}
