import Foundation

/// Turns the body of a message into a page the reader can show safely.
///
/// The reader's web view runs no JavaScript and cancels every navigation, and the page carries a
/// policy that loads nothing but inline styles and permitted images. Removing active content
/// here as well means the page is harmless even where one of those layers is missing.
public enum MailHTML {
	public struct Document: Equatable, Sendable {
		public var html: String
		/// True when the mail refers to pictures on the internet that were not loaded.
		public var blockedRemoteContent: Bool
	}

	/// - Parameter inlineImages: embedded pictures by content id, as `data:` URLs.
	public static func document(html: String?, text: String?, snippet: String?, allowRemoteContent: Bool, inlineImages: [String: String] = [:]) -> Document {
		var blocked = false
		let body: String
		if let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			body = sanitize(html, allowRemote: allowRemoteContent, inlineImages: inlineImages, blocked: &blocked)
		} else if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			body = "<div class=\"plain\">\(linkify(escape(text)))</div>"
		} else {
			body = "<div class=\"plain\">\(escape(snippet ?? ""))</div>"
		}
		return Document(html: page(body, allowRemote: allowRemoteContent), blockedRemoteContent: blocked)
	}

	public static func escape(_ text: String) -> String {
		text.replacingOccurrences(of: "&", with: "&amp;")
			.replacingOccurrences(of: "<", with: "&lt;")
			.replacingOccurrences(of: ">", with: "&gt;")
			.replacingOccurrences(of: "\"", with: "&quot;")
	}

	/// Makes web addresses in already escaped text tappable. A full stop or bracket that ends the sentence stays outside.
	static func linkify(_ escaped: String) -> String {
		escaped.replacing(/https?:\/\/[^\s<>"]+/) { match in
			var url = String(match.output)
			var tail = ""
			while let last = url.last, ".,;:!?)]".contains(last) {
				tail = String(last) + tail
				url.removeLast()
			}
			return "<a href=\"\(url)\">\(url)</a>\(tail)"
		}
	}

	private static func page(_ body: String, allowRemote: Bool) -> String {
		let images = allowRemote ? "data: https: http:" : "data:"
		return """
			<!DOCTYPE html>
			<html><head><meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \(images); style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'">
			<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
			<style>
			:root { color-scheme: light dark; }
			html, body { margin: 0; padding: 0; }
			body { font: -apple-system-body; font-family: -apple-system, system-ui, sans-serif; line-height: 1.4; padding: 0 16px 16px; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
			img, video { max-width: 100%; height: auto; }
			table { max-width: 100%; }
			pre { white-space: pre-wrap; }
			blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent); }
			a { color: -apple-system-blue; }
			.plain { white-space: pre-wrap; }
			</style></head><body>\(body)</body></html>
			"""
	}

	/// Elements dropped together with what they contain.
	private static let removedWithContent: Set<String> = ["script", "iframe", "object", "noscript", "title", "applet", "frameset", "audio", "video", "textarea", "select", "button"]
	/// Elements whose tags are dropped while their content stays.
	private static let removedTags: Set<String> = ["form", "input", "meta", "link", "base", "html", "head", "body", "option", "source", "track", "embed", "frame", "param"]

	/// Walks the markup tag by tag, the way a browser splits it, and writes back only what is
	/// harmless. Text between tags is never touched, so a sentence that merely looks like an
	/// attribute stays as it was written.
	static func sanitize(_ source: String, allowRemote: Bool, inlineImages: [String: String], blocked: inout Bool) -> String {
		let characters = Array(source)
		var output = ""
		var index = 0
		var skipping: String?

		// Pictures: embedded ones are shown, pictures from the internet only when allowed.
		func resource(_ value: String) -> String? {
			let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
			let lowered = trimmed.lowercased()
			if lowered.hasPrefix("data:image/") && !lowered.hasPrefix("data:image/svg") { return trimmed }
			if lowered.hasPrefix("cid:") { return inlineImages[String(trimmed.dropFirst(4))] }
			if lowered.hasPrefix("https://") || lowered.hasPrefix("http://") || lowered.hasPrefix("//") {
				if allowRemote { return lowered.hasPrefix("//") ? "https:\(trimmed)" : trimmed }
				blocked = true
			}
			return nil
		}

		// Style sheets may not pull in others, and their pictures follow the same rule as any picture.
		func css(_ text: String) -> String {
			var css = text.replacing(/@import[^;]*;?/.ignoresCase(), with: "")
			css = css.replacing(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/.ignoresCase()) { match in
				let inner = unquote(String(match.output.dropFirst(4).dropLast()).trimmingCharacters(in: .whitespaces))
				guard let allowed = resource(inner) else { return "none" }
				return "url(\"\(allowed.replacingOccurrences(of: "\"", with: "%22"))\")"
			}
			return css.replacing(/expression\s*\(/.ignoresCase(), with: "(").replacingOccurrences(of: "</", with: "<\\/")
		}

		func filtered(_ name: String, _ value: String?) -> String? {
			guard name.wholeMatch(of: /[a-z_:][a-z0-9_:.\-]*/) != nil, !name.hasPrefix("on") else { return nil }
			guard let value else { return name }
			switch name {
			case "srcset", "ping", "data-src", "action", "formaction", "srcdoc", "http-equiv":
				if name == "srcset" || name == "data-src", value.lowercased().contains("http"), !allowRemote { blocked = true }
				return nil
			case "href", "xlink:href":
				// Links may lead to web pages, mail addresses, phone numbers and places in the mail itself.
				let scheme = String(value.lowercased().unicodeScalars.filter { $0.value > 32 && $0.properties.generalCategory != .format })
				let allowed = ["https://", "http://", "mailto:", "tel:", "#"].contains { scheme.hasPrefix($0) }
				return "\(name)=\"\(allowed ? attribute(value) : "#")\""
			case "src", "background", "poster":
				return resource(value).map { "\(name)=\"\(attribute($0))\"" }
			case "style":
				return "style=\"\(attribute(css(value)))\""
			default:
				return "\(name)=\"\(attribute(value))\""
			}
		}

		while index < characters.count {
			guard characters[index] == "<" else {
				let start = index
				while index < characters.count, characters[index] != "<" { index += 1 }
				if skipping == nil { output.append(contentsOf: characters[start..<index]) }
				continue
			}
			// A comment is dropped whole; one that never ends takes the rest with it.
			if characters[index...].starts(with: Array("<!--")) {
				index = end(of: Array("-->"), in: characters, from: index + 4) ?? characters.count
				continue
			}
			guard index + 1 < characters.count, characters[index + 1].isLetter || "/!?".contains(characters[index + 1]) else {
				if skipping == nil { output.append("&lt;") }
				index += 1
				continue
			}
			// Read the tag as a browser does: a name, then attributes whose values may be quoted.
			var cursor = index + 1
			let closing = characters[cursor] == "/"
			if closing { cursor += 1 }
			let nameStart = cursor
			while cursor < characters.count, !characters[cursor].isWhitespace, characters[cursor] != ">", characters[cursor] != "/" { cursor += 1 }
			let name = String(characters[nameStart..<cursor]).lowercased()
			var attributes: [String] = []
			var terminated = false
			while cursor < characters.count {
				let character = characters[cursor]
				if character == ">" { terminated = true; cursor += 1; break }
				if character.isWhitespace || character == "/" { cursor += 1; continue }
				let attributeStart = cursor
				while cursor < characters.count, !characters[cursor].isWhitespace, !"=>/".contains(characters[cursor]) { cursor += 1 }
				// A stray "=" would otherwise never be consumed.
				if cursor == attributeStart { cursor += 1; continue }
				let attributeName = String(characters[attributeStart..<cursor]).lowercased()
				var lookahead = cursor
				while lookahead < characters.count, characters[lookahead].isWhitespace { lookahead += 1 }
				var value: String?
				if lookahead < characters.count, characters[lookahead] == "=" {
					cursor = lookahead + 1
					while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
					if cursor < characters.count, characters[cursor] == "\"" || characters[cursor] == "'" {
						let quote = characters[cursor]
						let valueStart = cursor + 1
						cursor = valueStart
						while cursor < characters.count, characters[cursor] != quote { cursor += 1 }
						value = String(characters[valueStart..<min(cursor, characters.count)])
						cursor = min(cursor + 1, characters.count)
					} else {
						let valueStart = cursor
						while cursor < characters.count, !characters[cursor].isWhitespace, characters[cursor] != ">" { cursor += 1 }
						value = String(characters[valueStart..<cursor])
					}
				}
				if let kept = filtered(attributeName, value) { attributes.append(kept) }
			}
			index = cursor
			// A tag that never closes is not markup a mail client should guess at.
			guard terminated else { break }

			if let waiting = skipping {
				if closing, name == waiting { skipping = nil }
				continue
			}
			guard name.wholeMatch(of: /[a-z][a-z0-9:\-]*/) != nil else { continue }
			if removedWithContent.contains(name) {
				if !closing { skipping = name }
				continue
			}
			if removedTags.contains(name) { continue }
			if name == "style", !closing {
				// The sheet is text up to its closing tag, not markup.
				let close = start(of: Array("</style"), in: characters, from: index) ?? characters.count
				output.append("<style>\(css(String(characters[index..<close])))</style>")
				index = end(of: Array(">"), in: characters, from: close) ?? characters.count
				continue
			}
			output.append(closing ? "</\(name)>" : "<\(([name] + attributes).joined(separator: " "))>")
		}
		return output
	}

	/// Where `needle` begins at or after `from`, compared without regard to case.
	private static func start(of needle: [Character], in characters: [Character], from: Int) -> Int? {
		guard !needle.isEmpty, characters.count >= needle.count, from <= characters.count - needle.count else { return nil }
		var index = from
		while index <= characters.count - needle.count {
			if zip(needle, characters[index..<index + needle.count]).allSatisfy({ $0.lowercased() == $1.lowercased() }) { return index }
			index += 1
		}
		return nil
	}

	private static func end(of needle: [Character], in characters: [Character], from: Int) -> Int? {
		start(of: needle, in: characters, from: from).map { $0 + needle.count }
	}

	private static func unquote(_ value: String) -> String {
		guard value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first else { return value }
		return String(value.dropFirst().dropLast())
	}

	/// For putting a value back between double quotes. Entities the sender wrote stay as they are.
	private static func attribute(_ value: String) -> String {
		value.replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
	}
}
