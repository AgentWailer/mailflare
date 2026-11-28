import SwiftUI
import UserNotifications
import MailflareKit

@main
struct MailflareApp: App {
	/// One model for the whole app: the app delegate reaches it when iOS reports a notification.
	static let model = AppModel(dependencies: MailflareApp.dependencies())
	@State private var model = MailflareApp.model
	@UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

	private static func dependencies() -> AppDependencies {
		var dependencies = AppDependencies(
			credentials: KeychainCredentialStore(),
			storeDirectory: URL.applicationSupportDirectory,
			transport: URLSessionTransport(),
			defaults: .standard,
			deviceName: UIDevice.current.name,
			removeWebData: { userId in await WebSession.removeData(userId: userId) },
			requestNotifications: { await Notifications.requestPermissionAndRegister() },
			setBadge: { count in Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) } }
		)
		#if !DEBUG
		// TestFlight and App Store builds are known to Apple's production service.
		dependencies.pushEnvironment = "production"
		#endif
		#if DEBUG
		// Hooks for the UI walk-through: start as a fresh install, or behave as without a network.
		let environment = ProcessInfo.processInfo.environment
		if environment["MAILFLARE_UI_RESET"] == "1" {
			try? dependencies.credentials.saveAccess(nil)
			for account in (try? dependencies.credentials.accounts()) ?? [] { try? dependencies.credentials.removeAccount(userId: account.userId) }
			try? FileManager.default.removeItem(at: dependencies.storeDirectory.appending(path: "accounts"))
			if let domain = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: domain) }
		}
		if environment["MAILFLARE_UI_OFFLINE"] == "1" { dependencies.transport = OfflineTransport() }
		#endif
		return dependencies
	}

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(model)
				.task { await model.start() }
		}
		.backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
			BackgroundRefresh.schedule()
			await model.backgroundSync()
		}
	}
}

#if DEBUG
/// Stands in for a phone without a connection.
private struct OfflineTransport: HTTPTransport {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		throw URLError(.notConnectedToInternet)
	}
}
#endif
