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
		// A "name" that is itself an address says nothing, or pretends to be someone else.
		name = written.isEmpty || written.contains("@") ? nil : written
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
