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

	private static let removedWithContent = ["script", "iframe", "object", "embed", "noscript", "title", "applet", "frameset", "frame", "audio", "video", "textarea", "select", "button"]
	private static let removedTags = ["form", "input", "meta", "link", "base", "html", "head", "body", "!doctype", "option", "source", "track"]

	static func sanitize(_ source: String, allowRemote: Bool, inlineImages: [String: String], blocked: inout Bool) -> String {
		var html = source
		// Removing one tag can join the halves of another ("<scr<script>ipt>"), so repeat until nothing changes.
		for _ in 0..<8 {
			let before = html
			html = html.replacing(/<!--[\s\S]*?-->/, with: "")
			for tag in removedWithContent {
				html = html.replacing(try! Regex("<\(tag)\\b[^>]*>[\\s\\S]*?</\(tag)\\s*>").ignoresCase(), with: "")
			}
			for tag in removedWithContent + removedTags {
				html = html.replacing(try! Regex("</?\(tag)\\b[^>]*>?").ignoresCase(), with: "")
			}
			// Event handlers: on…="…", on…='…' or on…=value.
			html = html.replacing(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/.ignoresCase(), with: "")
			if html == before { break }
		}

		// Links may lead to web pages, mail addresses, phone numbers and places in the mail itself.
		html = html.replacing(/(\s(?:href|action|formaction|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/.ignoresCase()) { match in
			let value = unquote(String(match.output.2))
			let scheme = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().filter { !$0.isWhitespace && $0.asciiValue.map { $0 > 31 } ?? true }
			let allowed = ["https://", "http://", "mailto:", "tel:", "#"].contains { scheme.hasPrefix($0) }
			return "\(match.output.1)\"\(allowed ? attribute(value) : "#")\""
		}

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
		html = html.replacing(/(\s)(src|background|poster)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/.ignoresCase()) { match in
			guard let allowed = resource(unquote(String(match.output.4))) else { return "\(match.output.1)data-blocked-\(match.output.2)=\"\"" }
			return "\(match.output.1)\(match.output.2)=\"\(attribute(allowed))\""
		}
		html = html.replacing(/\s(?:srcset|ping|data-src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/.ignoresCase()) { match in
			if match.output.lowercased().contains("http") && !allowRemote { blocked = true }
			return ""
		}
		// Style sheets may not pull in others, and their pictures follow the same rule.
		html = html.replacing(/@import[^;]*;?/.ignoresCase(), with: "")
		html = html.replacing(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/.ignoresCase()) { match in
			let inner = unquote(String(match.output.dropFirst(4).dropLast()).trimmingCharacters(in: .whitespaces))
			guard let allowed = resource(inner) else { return "none" }
			return "url(\"\(allowed.replacingOccurrences(of: "\"", with: "%22"))\")"
		}
		html = html.replacing(/expression\s*\(/.ignoresCase(), with: "(")
		return html
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
