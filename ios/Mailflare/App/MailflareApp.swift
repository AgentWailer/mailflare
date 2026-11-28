import SwiftUI
import MailflareKit

@main
struct MailflareApp: App {
	@State private var model = AppModel(dependencies: AppDependencies(
		credentials: KeychainCredentialStore(),
		storeDirectory: URL.applicationSupportDirectory,
		transport: URLSessionTransport(),
		defaults: .standard,
		deviceName: UIDevice.current.name
	))

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
