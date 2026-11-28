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

	/// Elements dropped together with what they contain. Drawings and formulas are among them:
	/// a browser reads what is inside them by rules of their own.
	private static let removedWithContent: Set<String> = ["script", "iframe", "object", "noscript", "title", "applet", "frameset", "audio", "video", "textarea", "select", "button", "svg", "math", "template", "xmp", "plaintext", "noembed", "noframes"]
	/// Elements whose tags are dropped while their content stays.
	private static let removedTags: Set<String> = ["form", "input", "meta", "link", "base", "html", "head", "body", "option", "source", "track", "embed", "frame", "param"]
	/// The only elements whose `href` leads somewhere when tapped. Anywhere else it would load something.
	private static let linkElements: Set<String> = ["a", "area"]

	private typealias Scalar = Unicode.Scalar

	private static func isSpace(_ scalar: Scalar) -> Bool {
		scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" || scalar == "\u{0C}"
	}

	private static func isASCIILetter(_ scalar: Scalar) -> Bool {
		(scalar >= "a" && scalar <= "z") || (scalar >= "A" && scalar <= "Z")
	}

	private static func text(_ scalars: ArraySlice<Scalar>) -> String {
		String(String.UnicodeScalarView(scalars))
	}

	/// Walks the markup tag by tag and writes back only what is harmless. It reads code points,
	/// as a browser's tokenizer does, so an accent placed after a quote or a bracket cannot hide
	/// it. Text between tags is never touched.
	static func sanitize(_ source: String, allowRemote: Bool, inlineImages: [String: String], blocked: inout Bool) -> String {
		let scalars = Array(source.unicodeScalars)
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

		// Style sheets may not pull in others, their pictures follow the same rule as any picture,
		// and whatever they contain cannot be read as markup.
		func css(_ text: String) -> String {
			var css = text.replacing(/@import[^;]*;?/.ignoresCase(), with: "")
			css = css.replacing(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/.ignoresCase()) { match in
				let inner = unquote(String(match.output.dropFirst(4).dropLast()).trimmingCharacters(in: .whitespaces))
				guard let allowed = resource(inner) else { return "none" }
				return "url(\"\(allowed.replacingOccurrences(of: "\"", with: "%22"))\")"
			}
			return css.replacing(/expression\s*\(/.ignoresCase(), with: "(")
				.replacingOccurrences(of: "<", with: "\\3C ")
				.replacingOccurrences(of: ">", with: "\\3E ")
		}

		func filtered(_ element: String, _ name: String, _ value: String?) -> String? {
			guard name.wholeMatch(of: /[a-z_:][a-z0-9_:.\-]*/) != nil, !name.hasPrefix("on") else { return nil }
			guard let value else { return name }
			switch name {
			case "srcset", "ping", "data-src", "action", "formaction", "srcdoc", "http-equiv":
				if name == "srcset" || name == "data-src", value.lowercased().contains("http"), !allowRemote { blocked = true }
				return nil
			case "href", "xlink:href":
				// Links may lead to web pages, mail addresses, phone numbers and places in the mail itself.
				guard linkElements.contains(element) else { return nil }
				let scheme = String(String.UnicodeScalarView(value.lowercased().unicodeScalars.filter { $0.value > 32 && $0.properties.generalCategory != .format }))
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

		while index < scalars.count {
			guard scalars[index] == "<" else {
				let start = index
				while index < scalars.count, scalars[index] != "<" { index += 1 }
				if skipping == nil { output.append(text(scalars[start..<index])) }
				continue
			}
			// A comment is dropped whole; one that never ends takes the rest with it.
			if scalars[index...].starts(with: Array("<!--".unicodeScalars)) {
				index = end(of: "-->", in: scalars, from: index + 4) ?? scalars.count
				continue
			}
			guard index + 1 < scalars.count, isASCIILetter(scalars[index + 1]) || scalars[index + 1] == "/" || scalars[index + 1] == "!" || scalars[index + 1] == "?" else {
				if skipping == nil { output.append("&lt;") }
				index += 1
				continue
			}
			// Read the tag as a browser does: a name, then attributes whose values may be quoted.
			var cursor = index + 1
			let closing = scalars[cursor] == "/"
			if closing { cursor += 1 }
			let nameStart = cursor
			while cursor < scalars.count, !isSpace(scalars[cursor]), scalars[cursor] != ">", scalars[cursor] != "/" { cursor += 1 }
			let name = text(scalars[nameStart..<cursor]).lowercased()
			var attributes: [(name: String, value: String?)] = []
			var terminated = false
			while cursor < scalars.count {
				let scalar = scalars[cursor]
				if scalar == ">" { terminated = true; cursor += 1; break }
				if isSpace(scalar) || scalar == "/" { cursor += 1; continue }
				let attributeStart = cursor
				while cursor < scalars.count, !isSpace(scalars[cursor]), scalars[cursor] != "=", scalars[cursor] != ">", scalars[cursor] != "/" { cursor += 1 }
				// A stray "=" would otherwise never be consumed.
				if cursor == attributeStart { cursor += 1; continue }
				let attributeName = text(scalars[attributeStart..<cursor]).lowercased()
				var lookahead = cursor
				while lookahead < scalars.count, isSpace(scalars[lookahead]) { lookahead += 1 }
				var value: String?
				if lookahead < scalars.count, scalars[lookahead] == "=" {
					cursor = lookahead + 1
					while cursor < scalars.count, isSpace(scalars[cursor]) { cursor += 1 }
					if cursor < scalars.count, scalars[cursor] == "\"" || scalars[cursor] == "'" {
						let quote = scalars[cursor]
						let valueStart = cursor + 1
						cursor = valueStart
						while cursor < scalars.count, scalars[cursor] != quote { cursor += 1 }
						value = text(scalars[valueStart..<min(cursor, scalars.count)])
						cursor = min(cursor + 1, scalars.count)
					} else {
						let valueStart = cursor
						while cursor < scalars.count, !isSpace(scalars[cursor]), scalars[cursor] != ">" { cursor += 1 }
						value = text(scalars[valueStart..<cursor])
					}
				}
				attributes.append((attributeName, value))
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
				let close = start(of: "</style", in: scalars, from: index) ?? scalars.count
				output.append("<style>\(css(text(scalars[index..<close])))</style>")
				index = end(of: ">", in: scalars, from: close) ?? scalars.count
				continue
			}
			let kept = attributes.compactMap { filtered(name, $0.name, $0.value) }
			output.append(closing ? "</\(name)>" : "<\(([name] + kept).joined(separator: " "))>")
		}
		return output
	}

	/// Where `needle` (ASCII) begins at or after `from`, compared without regard to case.
	private static func start(of needle: String, in scalars: [Scalar], from: Int) -> Int? {
		let wanted = Array(needle.lowercased().unicodeScalars)
		guard !wanted.isEmpty, scalars.count >= wanted.count, from <= scalars.count - wanted.count else { return nil }
		var index = from
		while index <= scalars.count - wanted.count {
			var matches = true
			for offset in 0..<wanted.count {
				let scalar = scalars[index + offset]
				let lowered = (scalar >= "A" && scalar <= "Z") ? Scalar(scalar.value + 32)! : scalar
				if lowered != wanted[offset] { matches = false; break }
			}
			if matches { return index }
			index += 1
		}
		return nil
	}

	private static func end(of needle: String, in scalars: [Scalar], from: Int) -> Int? {
		start(of: needle, in: scalars, from: from).map { $0 + needle.unicodeScalars.count }
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
