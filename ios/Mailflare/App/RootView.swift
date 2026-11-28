import SwiftUI

struct RootView: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		Group {
			switch model.phase {
			case .loading: ProgressView()
			case .needsServer: ServerSetupView()
			case .needsAccessKey: AccessKeyView()
			case .needsSignIn: SignInView()
			case .ready:
				if let session = model.session {
					MainView(session: session).id(session.account.userId)
				}
			}
		}
		.animation(.default, value: model.phase)
		.alert("Notice", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model.notice ?? "")
		}
	}
}

/// Placeholder until the mailbox list exists.
struct MainView: View {
	let session: AccountSession

	var body: some View {
		Text(session.account.email)
	}
}
