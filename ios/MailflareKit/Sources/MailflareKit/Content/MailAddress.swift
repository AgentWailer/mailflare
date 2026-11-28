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
		// Invisible characters are dropped and look-alike dots become dots before looking.
		let visible = String(String.UnicodeScalarView(name.unicodeScalars.filter { $0.properties.generalCategory != .format && !$0.properties.isDefaultIgnorableCodePoint }))
		let dotted = String(visible.map { "\u{3002}\u{FF0E}\u{FF61}\u{06D4}\u{2024}\u{2027}\u{30FB}\u{00B7}".contains($0) ? "." : $0 })
		let folded = dotted.precomposedStringWithCompatibilityMapping.lowercased()
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
