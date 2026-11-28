import UIKit

/// Tactile feedback, in one place so it can be switched off. iOS's own setting always applies.
enum Haptics {
	enum Kind { case selection, success, warning, error, impact }

	static let settingKey = "haptics.enabled"

	static var isEnabled: Bool {
		UserDefaults.standard.object(forKey: settingKey) as? Bool ?? true
	}

	static func play(_ kind: Kind) {
		guard isEnabled else { return }
		switch kind {
		case .selection: UISelectionFeedbackGenerator().selectionChanged()
		case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
		case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
		case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
		case .impact: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
		}
	}
}
