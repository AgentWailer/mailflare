import Foundation

/// Finds the quoted original that Mailflare's composer puts below a reply, so the reader can
/// fold it. Mirrors `splitQuotedHtml` in `src/components/compose/rich-text-utils.ts`.
public enum QuoteSplitter {
	public static let marker = #"<div class="mailflare-quote" data-mailflare-quote="1">"#

	public static func split(html: String) -> (visible: String, quoted: String?) {
		guard let range = html.range(of: marker) else { return (html, nil) }
		let inner = String(html[range.upperBound...]).replacing(/<\/div>\s*$/, with: "")
		return (String(html[..<range.lowerBound]), inner)
	}
}
