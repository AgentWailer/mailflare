import SwiftUI

struct RootView: View {
	@Environment(AppModel.self) private var model

	/// The UI walk-through asks for the dark appearance this way; the simulator ignores XCUIDevice's own switch.
	private static var forcedColorScheme: ColorScheme? {
		#if DEBUG
		ProcessInfo.processInfo.environment["MAILFLARE_UI_DARK"] == "1" ? .dark : nil
		#else
		nil
		#endif
	}

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
		.preferredColorScheme(Self.forcedColorScheme)
		.alert("Notice", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model.notice ?? "")
		}
	}
}
