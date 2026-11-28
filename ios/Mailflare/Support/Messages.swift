import Foundation
import MailflareKit

extension APIError {
	/// What the user is told. Mailflare's own wording is passed on where it gave one.
	var userMessage: String {
		switch self {
		case .offline: String(localized: "No connection. Check the network and try again.")
		case .accessDenied: String(localized: "Access key rejected. Cloudflare Access did not let this device through.")
		case .signedOut: String(localized: "You have been signed out.")
		case .notFound: String(localized: "This no longer exists on the server.")
		case .rateLimited(let seconds): String(localized: "Too many attempts. Try again in \(seconds) seconds.")
		case .server(401, let message?) where message == "Invalid credentials": String(localized: "E-mail address or password is wrong.")
		case .server(_, let message?): message
		case .server(let status, nil): String(localized: "The server reported an error (\(status)).")
		case .decoding: String(localized: "The server answered in a way this version of the app does not understand.")
		}
	}
}
