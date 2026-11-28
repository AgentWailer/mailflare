import Foundation

/// What the search index holds of a message's content, and how typed words become a query.
enum SearchText {
	/// Content beyond this is not indexed: a long newsletter is found by its beginning.
	static let limit = 50_000

	/// The words of a message: its text part, or the text left of its HTML.
	static func body(text: String?, html: String?) -> String {
		if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(text.prefix(limit)) }
		guard let html, !html.isEmpty else { return "" }
		return String(plain(html).prefix(limit))
	}

	/// Only for the index: what a reader would see as words. Not a sanitizer.
	static func plain(_ html: String) -> String {
		var text = html
		for pattern in ["<(style|script|head|title)\\b[^>]*>.*?</\\1\\s*>", "<!--.*?-->", "<[^>]*>"] {
			text = text.replacingOccurrences(of: pattern, with: " ", options: [.regularExpression, .caseInsensitive])
		}
		for (entity, character) in entities { text = text.replacingOccurrences(of: entity, with: character) }
		return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}

	private static let entities = [
		("&nbsp;", " "), ("&auml;", "ä"), ("&ouml;", "ö"), ("&uuml;", "ü"), ("&Auml;", "Ä"), ("&Ouml;", "Ö"), ("&Uuml;", "Ü"),
		("&szlig;", "ß"), ("&euro;", "€"), ("&quot;", "\""), ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"),
	]

	/// Every typed word must occur, as a word or as the beginning of one. Signs the index reads
	/// as operators are dropped, so nothing the user types is a syntax error.
	static func match(_ text: String) -> String? {
		let words = text.split { !($0.isLetter || $0.isNumber) }.prefix(12)
		guard !words.isEmpty else { return nil }
		return words.map { "\"\($0)\"*" }.joined(separator: " ")
	}
}
