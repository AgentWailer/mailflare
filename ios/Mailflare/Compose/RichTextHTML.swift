import UIKit
import MailflareKit

/// Turns what was written in the editor into the HTML that is sent: paragraphs, with bold,
/// italic, underline and links. Nothing else the editor may carry leaves the device.
enum RichTextHTML {
	static func html(from text: NSAttributedString) -> String {
		guard !text.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }
		let whole = text.string as NSString
		var paragraphs: [String] = []
		var location = 0
		// One paragraph per line; an empty line keeps its place.
		while location <= whole.length {
			let rest = NSRange(location: location, length: whole.length - location)
			let newline = whole.range(of: "\n", options: [], range: rest)
			let end = newline.location == NSNotFound ? whole.length : newline.location
			let range = NSRange(location: location, length: end - location)
			let content = range.length == 0 ? "<br>" : runs(of: text, in: range)
			paragraphs.append("<p>\(content)</p>")
			if newline.location == NSNotFound { break }
			location = end + 1
		}
		return paragraphs.joined()
	}

	private static func runs(of text: NSAttributedString, in range: NSRange) -> String {
		var html = ""
		text.enumerateAttributes(in: range) { attributes, runRange, _ in
			var piece = MailHTML.escape((text.string as NSString).substring(with: runRange))
			let traits = (attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits ?? []
			if let style = attributes[.underlineStyle] as? Int, style != 0 { piece = "<u>\(piece)</u>" }
			if traits.contains(.traitItalic) { piece = "<i>\(piece)</i>" }
			if traits.contains(.traitBold) { piece = "<b>\(piece)</b>" }
			if let url = (attributes[.link] as? URL) ?? (attributes[.link] as? String).flatMap(URL.init(string:)),
			   ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
				piece = "<a href=\"\(MailHTML.escape(url.absoluteString))\">\(piece)</a>"
			}
			html += piece
		}
		return html
	}
}
