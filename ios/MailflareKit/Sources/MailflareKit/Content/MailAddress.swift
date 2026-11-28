import Foundation

/// One address of a From, To or Cc line: the address the mail goes to and the name written beside it.
public struct MailAddress: Equatable, Hashable, Sendable {
	public var name: String?
	public var address: String

	/// Parses `Name <address>`, `"Last, First" <address>` or a bare address.
	public init(_ text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let open = trimmed.lastIndex(of: "<"), let close = trimmed.lastIndex(of: ">"), open < close else {
			name = nil
			address = trimmed
			return
		}
		address = trimmed[trimmed.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
		var written = trimmed[..<open].trimmingCharacters(in: .whitespaces)
		for quote in ["\"", "'"] where written.count >= 2 && written.hasPrefix(quote) && written.hasSuffix(quote) {
			written = String(written.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
		}
		written = written.replacing(/\s+/, with: " ")
		name = written.isEmpty || Self.looksLikeAddress(written) ? nil : written
	}

	/// A "name" that is itself an address or a host name says nothing, or pretends to be someone
	/// else's address. Compatibility forms such as the full-width @ are folded first.
	static func looksLikeAddress(_ name: String) -> Bool {
		let folded = name.precomposedStringWithCompatibilityMapping.lowercased()
		if folded.contains("@") { return true }
		// A dot between two letter runs, the last at least two long: "bank.example", not "Dr. Anna".
		return folded.contains(/[\p{L}\p{N}-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])/)
	}

	/// What to show for this address: its name, or the address when it has none.
	public var label: String { name ?? address }

	/// Splits a header value at the commas that separate addresses, not those inside quotes.
	public static func list(_ text: String) -> [MailAddress] {
		var parts: [String] = []
		var current = ""
		var quoted = false
		var angled = false
		for character in text {
			switch character {
			case "\"": quoted.toggle(); current.append(character)
			case "<" where !quoted: angled = true; current.append(character)
			case ">" where !quoted: angled = false; current.append(character)
			case "," where !quoted && !angled: parts.append(current); current = ""
			default: current.append(character)
			}
		}
		parts.append(current)
		return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map(MailAddress.init)
	}
}
