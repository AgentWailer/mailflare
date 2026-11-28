import Foundation

/// What can go wrong between the app and the installation, in terms the app acts on.
public enum APIError: Error, Equatable, Sendable {
	/// No usable connection. Local mail stays readable.
	case offline
	/// Cloudflare Access refused the device's key, or asked for an interactive sign-in.
	case accessDenied
	/// Mailflare no longer accepts the session.
	case signedOut
	case notFound
	case rateLimited(retryAfter: Int)
	/// Mailflare answered with an error of its own; `message` is its wording, if it gave one.
	case server(status: Int, message: String?)
	/// The answer was not what this version of the app understands.
	case decoding
}
