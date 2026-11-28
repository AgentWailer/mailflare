import SwiftUI
import MailflareKit

/// The signed-in app: mailboxes at the root, a list of mail on top, a message on top of that.
struct MainView: View {
	let session: AccountSession
	@State private var path: [Route]
	@Environment(\.scenePhase) private var scenePhase
	@Environment(AppModel.self) private var model
	@State private var composer = ComposeCoordinator()

	init(session: AccountSession) {
		self.session = session
		// Open where the user left, on the inbox the first time.
		let saved = (try? session.store.setting(SettingKey.lastScope)).flatMap { $0 }.flatMap { try? JSONDecoder().decode(ListScope.self, from: Data($0.utf8)) }
		_path = State(initialValue: [.list(saved ?? ListScope(folder: .inbox))])
	}

	var body: some View {
		NavigationStack(path: $path) {
			MailboxListView(session: session)
				.navigationDestination(for: Route.self) { route in
					switch route {
					case .list(let scope): MessageListView(scope: scope, session: session)
					case .message(let id): MessageView(messageId: id, session: session)
					case .web(let area): WebAreaView(area: area, session: session)
					case .appSettings: AppSettingsView(session: session)
					case .outbox: OutboxView(session: session)
					}
				}
		}
		.environment(composer)
		.sheet(item: $composer.intent) { intent in
			ComposeView(intent: intent, session: session)
		}
		// An action the server refused is back as it was; say so, or it looks like it never happened.
		.task {
			for await failure in await session.engine.actionFailures() {
				model.notice = String(localized: "The server did not accept the last change (\(failure.reason)). The mail is back as it was.")
				Haptics.play(.error)
			}
		}
		// A tapped notification opens its message on top of wherever the user was.
		.onChange(of: model.messageToOpen, initial: true) { _, id in
			guard let id else { return }
			model.messageToOpen = nil
			composer.intent = nil
			if path.last != .message(id) { path.append(.message(id)) }
		}
		.task { await model.askForNotifications() }
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { Task { await session.engine.syncNow() } }
			if phase == .background { BackgroundRefresh.schedule() }
		}
		// While the app is on screen, the server says when something changed; nobody has to pull.
		.task(id: scenePhase == .active) {
			guard scenePhase == .active else { return }
			let engine = session.engine
			await RealtimeListener(access: session.api.access, sessionToken: session.account.sessionToken).run {
				await engine.syncNow()
			}
		}
	}
}
