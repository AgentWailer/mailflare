import SwiftUI
import UIKit

/// The text of a message. Bold, italic and underline come from the system's own text menu.
struct RichTextEditor: UIViewRepresentable {
	@Binding var text: NSAttributedString

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	func makeUIView(context: Context) -> UITextView {
		let view = UITextView()
		view.delegate = context.coordinator
		view.allowsEditingTextAttributes = true
		view.isScrollEnabled = false
		view.backgroundColor = .clear
		view.font = .preferredFont(forTextStyle: .body)
		view.adjustsFontForContentSizeCategory = true
		view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
		view.textContainer.lineFragmentPadding = 0
		view.typingAttributes = [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label]
		view.accessibilityIdentifier = "compose.body"
		view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		return view
	}

	func updateUIView(_ view: UITextView, context: Context) {
		context.coordinator.parent = self
		// Writing the same text back would move the cursor to the end.
		if !view.attributedText.isEqual(to: text) { view.attributedText = text }
	}

	func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
		guard let width = proposal.width else { return nil }
		return CGSize(width: width, height: max(160, uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
	}

	final class Coordinator: NSObject, UITextViewDelegate {
		var parent: RichTextEditor

		init(_ parent: RichTextEditor) { self.parent = parent }

		func textViewDidChange(_ textView: UITextView) {
			parent.text = textView.attributedText
		}
	}
}
