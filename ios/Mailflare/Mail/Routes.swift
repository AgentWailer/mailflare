import Foundation
import MailflareKit

/// The parts of Mailflare the app shows as the web page until they are built natively.
enum WebArea: String, Hashable, CaseIterable {
	case calendar, drive, settings, admin

	var path: String {
		switch self {
		case .calendar: "/calendar"
		case .drive: "/drive"
		case .settings: "/settings"
		case .admin: "/admin"
		}
	}
}

enum Route: Hashable {
	case list(ListScope)
	case message(String)
	case web(WebArea)
	case appSettings
	case outbox
}
