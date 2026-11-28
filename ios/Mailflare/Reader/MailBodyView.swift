import SwiftUI
import WebKit

/// Shows the prepared page of a message. No JavaScript runs, nothing is stored, and the view
/// never navigates: a tapped link is handed to the caller instead.
struct MailBodyView: UIViewRepresentable {
	let html: String
	@Binding var height: CGFloat
	let onLink: (URL) -> Void

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.defaultWebpagePreferences.allowsContentJavaScript = false
		configuration.suppressesIncrementalRendering = false
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.navigationDelegate = context.coordinator
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		// The surrounding screen scrolls; the page only moves sideways when a table is wider than the phone.
		view.scrollView.isScrollEnabled = true
		view.scrollView.alwaysBounceVertical = false
		view.scrollView.bounces = false
		view.scrollView.showsVerticalScrollIndicator = false
		view.allowsLinkPreview = false
		context.coordinator.observe(view)
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		context.coordinator.parent = self
		guard context.coordinator.loaded != html else { return }
		context.coordinator.loaded = html
		view.loadHTMLString(html, baseURL: nil)
	}

	static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
		coordinator.observation = nil
	}

	final class Coordinator: NSObject, WKNavigationDelegate {
		var parent: MailBodyView
		var loaded: String?
		var observation: NSKeyValueObservation?

		init(_ parent: MailBodyView) { self.parent = parent }

		/// The page's height becomes the view's height, also when pictures arrive later.
		func observe(_ view: WKWebView) {
			observation = view.scrollView.observe(\.contentSize, options: [.new]) { [weak self] scrollView, _ in
				let height = scrollView.contentSize.height
				Task { @MainActor in
					guard let self, abs(self.parent.height - height) > 0.5, height > 0 else { return }
					self.parent.height = height
				}
			}
		}

		func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
			// Only the page we put in is ever loaded.
			if navigationAction.navigationType == .other, navigationAction.request.url?.absoluteString == "about:blank" { return .allow }
			if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url { parent.onLink(url) }
			return .cancel
		}
	}
}
