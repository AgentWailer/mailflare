import Foundation

/// A device's Cloudflare Access service token, as the owner creates it in Cloudflare.
struct AccessKey: Equatable, Sendable {
	var clientId: String
	var clientSecret: String
}

/// Reads a key from a scanned or pasted text: `mailflare-access:<id>:<secret>`, or a JSON object
/// with `clientId` and `clientSecret` (Cloudflare's own header names are accepted too).
func parseAccessKey(_ text: String) -> AccessKey? {
	let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
	func valid(_ id: String?, _ secret: String?) -> AccessKey? {
		guard let id, let secret, !id.isEmpty, !secret.isEmpty,
		      id.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
		      secret.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
		return AccessKey(clientId: id, clientSecret: secret)
	}
	let prefix = "mailflare-access:"
	if trimmed.hasPrefix(prefix) {
		let parts = trimmed.dropFirst(prefix.count).split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2 else { return nil }
		return valid(String(parts[0]), String(parts[1]))
	}
	guard trimmed.hasPrefix("{"), let object = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any] else { return nil }
	return valid(
		(object["clientId"] ?? object["CF-Access-Client-Id"]) as? String,
		(object["clientSecret"] ?? object["CF-Access-Client-Secret"]) as? String
	)
}

/// Turns what was typed into the installation's origin. A missing scheme means https, and https is required.
func normalizeServerAddress(_ text: String) -> URL? {
	let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
	guard !trimmed.isEmpty, trimmed.rangeOfCharacter(from: .whitespaces) == nil else { return nil }
	let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
	guard let components = URLComponents(string: withScheme), let scheme = components.scheme?.lowercased(),
	      scheme == "https" || scheme == "http", let host = components.host?.lowercased(), !host.isEmpty,
	      host.contains(".") || host == "localhost" else { return nil }
	// Plain http would send the access key and the session in the clear. It is accepted only
	// for a test server on this machine, and only in a development build.
	if scheme == "http" {
		#if DEBUG
		guard host == "localhost" || host == "127.0.0.1" else { return nil }
		#else
		return nil
		#endif
	}
	var origin = URLComponents()
	origin.scheme = scheme
	origin.host = host
	origin.port = components.port
	return origin.url
}
