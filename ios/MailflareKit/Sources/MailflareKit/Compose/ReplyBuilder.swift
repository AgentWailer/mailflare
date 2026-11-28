import Foundation

/// How a reply or a forward is put together. A port of the web's rules in
/// `src/components/message-actions/utils.ts`, so both write the same mail.
public enum ReplyBuilder {
	/// The few words a quote carries, in the user's language.
	public struct Phrases: Sendable {
		public var wrote: @Sendable (_ when: String, _ sender: String) -> String
		public var earlier: String
		public var forwarded: String
		public var from: String
		public var date: String
		public var subject: String
		public var to: String
		public var noSubject: String

		public static let english = Phrases(wrote: { "On \($0), \($1) wrote:" }, earlier: "an earlier date", forwarded: "Forwarded message",
		                                    from: "From", date: "Date", subject: "Subject", to: "To", noSubject: "(no subject)")
		public static let german = Phrases(wrote: { "Am \($0) schrieb \($1):" }, earlier: "einem früheren Datum", forwarded: "Weitergeleitete Nachricht",
		                                   from: "Von", date: "Datum", subject: "Betreff", to: "An", noSubject: "(kein Betreff)")
	}

	public static func replySubject(_ subject: String?) -> String {
		let trimmed = (subject ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return "Re:" }
		return trimmed.lowercased().hasPrefix("re:") ? trimmed : "Re: \(trimmed)"
	}

	public static func forwardSubject(_ subject: String?) -> String {
		let trimmed = (subject ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return "Fwd:" }
		let lowered = trimmed.lowercased()
		return lowered.hasPrefix("fwd:") || lowered.hasPrefix("fw:") ? trimmed : "Fwd: \(trimmed)"
	}

	/// Who a reply goes to. A plain reply answers the sender, or the Reply-To addresses when the
	/// message names any; reply-all keeps everyone else, minus the user's own addresses. A reply
	/// to a sent message goes to its original recipients.
	public static func recipients(for message: MessageRow, ownAddresses: [String], all: Bool) -> (to: [String], cc: [String]) {
		let own = Set(ownAddresses.map { $0.lowercased() })
		var seen: Set<String> = []
		func unique(_ header: String?) -> [String] {
			MailAddress.list(header ?? "").compactMap { entry in
				let key = entry.address.lowercased()
				guard !key.isEmpty, !own.contains(key), seen.insert(key).inserted else { return nil }
				return entry.name.map { "\($0) <\(entry.address)>" } ?? entry.address
			}
		}
		if message.direction == "outbound" {
			let to = unique(message.toAddr)
			return (to, all ? unique(message.ccAddr) : [])
		}
		let replyTo = unique(message.replyTo)
		let to = replyTo.isEmpty ? unique(message.fromAddr) : replyTo
		guard all else { return (to, []) }
		return (to, unique(message.toAddr) + unique(message.ccAddr))
	}

	/// Reply-all is only worth offering when it reaches someone a plain reply would not.
	public static func hasAdditionalRecipients(_ message: MessageRow, ownAddresses: [String]) -> Bool {
		let all = recipients(for: message, ownAddresses: ownAddresses, all: true)
		let single = recipients(for: message, ownAddresses: ownAddresses, all: false)
		return all.to.count + all.cc.count > single.to.count + single.cc.count
	}

	/// The headers that file a reply in the same conversation on both sides.
	public static func threading(for message: MessageRow) -> (inReplyTo: String?, references: String?, threadId: String?) {
		func bare(_ id: String) -> String { id.trimmingCharacters(in: CharacterSet(charactersIn: "<>")) }
		let parent = message.providerMessageId.map { bare($0.trimmingCharacters(in: .whitespacesAndNewlines)) }.flatMap { $0.isEmpty ? nil : $0 }
		var chain = (message.references ?? "").split(whereSeparator: \.isWhitespace).map { bare(String($0)) }.filter { !$0.isEmpty }
		if let parent, !chain.contains(parent) { chain.append(parent) }
		return (parent, chain.isEmpty ? nil : chain.joined(separator: " "), message.threadId ?? parent)
	}

	private static let quoteStyle = "margin:0 0 0 0;border-left:1px solid #ccc;padding-left:1ex;opacity:0.6"

	/// The original as it may be sent on: its HTML without anything active, or its text.
	private static func original(text: String?, html: String?) -> String? {
		if let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			var blocked = false
			return MailHTML.sanitize(html, allowRemote: true, inlineImages: [:], blocked: &blocked)
		}
		guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
		return MailHTML.escape(text).replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "<br>")
	}

	/// The folded quote under a reply: the line every mail program recognises, then the original.
	public static func replyQuoteHTML(sender: String, sentAt: String?, text: String?, html: String?, phrases: Phrases) -> String? {
		guard let original = original(text: text, html: html) else { return nil }
		let line = MailHTML.escape(phrases.wrote(sentAt ?? phrases.earlier, sender))
		return "\(QuoteSplitter.marker)<div style=\"margin-top:1.4em\">\(line)</div><blockquote style=\"\(quoteStyle)\">\(original)</blockquote></div>"
	}

	/// A forwarded message: the header block mail programs put above it, then the original, folded.
	public static func forwardHTML(for message: MessageRow, sentAt: String, text: String?, html: String?, phrases: Phrases) -> String {
		var lines = ["\(phrases.from): \(message.fromAddr)", "\(phrases.date): \(sentAt)", "\(phrases.subject): \(message.subject ?? phrases.noSubject)", "\(phrases.to): \(message.toAddr)"]
		if let cc = message.ccAddr, !cc.isEmpty { lines.append("Cc: \(cc)") }
		let header = "<div>---------- \(phrases.forwarded) ---------<br>\(lines.map(MailHTML.escape).joined(separator: "<br>"))</div><br>"
		return "\(QuoteSplitter.marker)\(header)\(original(text: text, html: html) ?? "")</div>"
	}

	/// The text/plain part that goes out beside the HTML.
	public static func plainText(fromHTML html: String) -> String {
		var text = html.replacing(/<(style|script)\b[^>]*>[\s\S]*?<\/(style|script)\s*>/.ignoresCase(), with: "")
		text = text.replacing(/<br\s*\/?>/.ignoresCase(), with: "\n")
		text = text.replacing(/<li\b[^>]*>/.ignoresCase(), with: "- ")
		text = text.replacing(/<\/(p|div|ul|ol|blockquote|h[1-6]|tr)\s*>/.ignoresCase(), with: "\n\n")
		text = text.replacing(/<\/li\s*>/.ignoresCase(), with: "\n")
		text = text.replacing(/<[^>]+>/, with: "")
		text = decodeEntities(text)
		text = text.replacing(/[ \t]+\n/, with: "\n").replacing(/\n{3,}/, with: "\n\n")
		return text.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	static func decodeEntities(_ text: String) -> String {
		var result = text.replacing(/&#x([0-9a-fA-F]{1,6});/) { match in
			UInt32(match.output.1, radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) } ?? ""
		}
		result = result.replacing(/&#([0-9]{1,7});/) { match in
			UInt32(match.output.1).flatMap(Unicode.Scalar.init).map { String(Character($0)) } ?? ""
		}
		for (entity, character) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
			result = result.replacingOccurrences(of: entity, with: character)
		}
		return result
	}
}
