import SwiftUI
import WebKit
import MailflareKit

/// A part of Mailflare that has no native screen yet, shown as its web page inside the app,
/// signed in as the account in use.
struct WebAreaView: View {
	let area: WebArea
	let session: AccountSession
	@State private var state: LoadState = .preparing
	@State private var store: WKWebsiteDataStore?
	@Environment(\.openURL) private var openURL

	enum LoadState: Equatable { case preparing, ready, failed(String) }

	private var title: LocalizedStringKey {
		switch area {
		case .calendar: "Calendar"
		case .drive: "Drive"
		case .settings: "Mailflare settings"
		case .admin: "Administration"
		}
	}

	var body: some View {
		Group {
			switch state {
			case .preparing:
				ProgressView()
			case .failed(let message):
				ContentUnavailableView {
					Label("Cannot open this page", systemImage: "wifi.slash")
				} description: {
					Text(message)
				} actions: {
					Button("Try again") { Task { await prepare() } }
				}
			case .ready:
				if let store {
					InstallationWebView(url: session.api.access.baseURL.appending(path: area.path), access: session.api.access, store: store) { openURL($0) }
						.ignoresSafeArea(edges: .bottom)
				}
			}
		}
		.navigationTitle(title)
		.navigationBarTitleDisplayMode(.inline)
		.task { await prepare() }
	}

	private func prepare() async {
		state = .preparing
		let store = WKWebsiteDataStore(forIdentifier: WebSession.storeIdentifier(userId: session.account.userId))
		do {
			try await WebSession.prepare(store, session: session)
			self.store = store
			state = .ready
		} catch let error as APIError {
			state = .failed(error.userMessage)
		} catch {
			state = .failed(String(localized: "That did not work. Try again."))
		}
	}
}

/// A web view that stays on the installation; any other address opens outside the app.
private struct InstallationWebView: UIViewRepresentable {
	let url: URL
	let access: ServerAccess
	let store: WKWebsiteDataStore
	let onExternalLink: (URL) -> Void

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = store
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.navigationDelegate = context.coordinator
		view.allowsBackForwardNavigationGestures = true
		view.load(URLRequest(url: url))
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		context.coordinator.parent = self
	}

	final class Coordinator: NSObject, WKNavigationDelegate {
		var parent: InstallationWebView

		init(_ parent: InstallationWebView) { self.parent = parent }

		func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
			guard let url = navigationAction.request.url else { return .cancel }
			if WebSession.isInstallation(url, access: parent.access) { return .allow }
			// Only a deliberate tap leaves the app; a page cannot send the user elsewhere by itself.
			if navigationAction.navigationType == .linkActivated, navigationAction.targetFrame?.isMainFrame != false { parent.onExternalLink(url) }
			return navigationAction.targetFrame?.isMainFrame == false ? .allow : .cancel
		}
	}
}
