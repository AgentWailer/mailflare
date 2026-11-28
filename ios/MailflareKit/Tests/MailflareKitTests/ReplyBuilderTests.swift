import Foundation
import Testing
@testable import MailflareKit

@Suite struct ReplyBuilderTests {
	private func message(direction: String = "inbound", from: String = "Anna Krüger <anna@example.org>", to: String = "me@example.test, Ben <ben@example.org>",
	                     cc: String? = "cleo@example.org, ME@example.test", replyTo: String? = nil, subject: String? = "Termin", messageId: String? = "<abc@example.org>",
	                     references: String? = "<first@example.org> <second@example.org>", thread: String? = "t1") -> MessageRow {
		var row = MessageRow(id: "m1", userId: "u", mailboxId: "box", direction: direction, providerMessageId: messageId, fromAddr: from, toAddr: to, ccAddr: cc,
		                     replyTo: replyTo, subject: subject, threadId: thread, createdAt: Date(timeIntervalSince1970: 1_795_000_000))
		row.references = references
		return row
	}

	private let own = ["me@example.test"]

	@Test func `subjects get their prefix once`() {
		#expect(ReplyBuilder.replySubject("Termin") == "Re: Termin")
		#expect(ReplyBuilder.replySubject("RE: Termin") == "RE: Termin")
		#expect(ReplyBuilder.replySubject("  ") == "Re:")
		#expect(ReplyBuilder.replySubject(nil) == "Re:")
		#expect(ReplyBuilder.forwardSubject("Termin") == "Fwd: Termin")
		#expect(ReplyBuilder.forwardSubject("Fw: Termin") == "Fw: Termin")
		#expect(ReplyBuilder.forwardSubject("fwd: Termin") == "fwd: Termin")
		#expect(ReplyBuilder.forwardSubject(nil) == "Fwd:")
	}

	@Test func `a reply answers the sender, reply-all keeps the others without the user's own addresses`() {
		let reply = ReplyBuilder.recipients(for: message(), ownAddresses: own, all: false)
		#expect(reply.to == ["Anna Krüger <anna@example.org>"])
		#expect(reply.cc.isEmpty)
		let all = ReplyBuilder.recipients(for: message(), ownAddresses: own, all: true)
		#expect(all.to == ["Anna Krüger <anna@example.org>"])
		#expect(all.cc == ["Ben <ben@example.org>", "cleo@example.org"])
	}

	@Test func `Reply-To wins over From, and a sent message is answered to its recipients`() {
		let list = ReplyBuilder.recipients(for: message(replyTo: "list@example.org"), ownAddresses: own, all: false)
		#expect(list.to == ["list@example.org"])
		let sent = ReplyBuilder.recipients(for: message(direction: "outbound", from: "me@example.test", to: "Ben <ben@example.org>", cc: "cleo@example.org"), ownAddresses: own, all: true)
		#expect(sent.to == ["Ben <ben@example.org>"])
		#expect(sent.cc == ["cleo@example.org"])
		#expect(ReplyBuilder.recipients(for: message(direction: "outbound", from: "me@example.test", to: "ben@example.org", cc: "cleo@example.org"), ownAddresses: own, all: false).cc.isEmpty)
	}

	@Test func `reply-all is only worth offering when it reaches someone else`() {
		#expect(ReplyBuilder.hasAdditionalRecipients(message(), ownAddresses: own))
		#expect(!ReplyBuilder.hasAdditionalRecipients(message(to: "me@example.test", cc: nil), ownAddresses: own))
	}

	@Test func `threading carries the parent and extends the chain`() {
		let threading = ReplyBuilder.threading(for: message())
		#expect(threading.inReplyTo == "abc@example.org")
		#expect(threading.references == "first@example.org second@example.org abc@example.org")
		#expect(threading.threadId == "t1")
		let bare = ReplyBuilder.threading(for: message(messageId: nil, references: nil, thread: nil))
		#expect(bare.inReplyTo == nil && bare.references == nil && bare.threadId == nil)
		#expect(ReplyBuilder.threading(for: message(references: "<abc@example.org>", thread: nil)).references == "abc@example.org", "the parent is not listed twice")
		#expect(ReplyBuilder.threading(for: message(thread: nil)).threadId == "abc@example.org")
	}

	@Test func `the quote under a reply is folded, names its author and is harmless`() throws {
		let quote = try #require(ReplyBuilder.replyQuoteHTML(sender: "Anna <anna@example.org>", sentAt: "Mi., 25. Nov. 2026, 10:00", text: nil,
		                                                     html: "<p onclick=\"x()\">Hallo</p><script>alert(1)</script>", phrases: .german))
		#expect(quote.hasPrefix(QuoteSplitter.marker))
		#expect(quote.contains("Am Mi., 25. Nov. 2026, 10:00 schrieb Anna &lt;anna@example.org&gt;:"))
		#expect(quote.contains("<blockquote"))
		#expect(quote.contains("<p>Hallo</p>"))
		#expect(!quote.contains("script") && !quote.contains("onclick"))
		#expect(QuoteSplitter.split(html: "<p>Antwort</p>" + quote).visible == "<p>Antwort</p>")
		let text = try #require(ReplyBuilder.replyQuoteHTML(sender: "anna@example.org", sentAt: nil, text: "Zeile 1\n<b>Zeile 2</b>", html: nil, phrases: .english))
		#expect(text.contains("On an earlier date, anna@example.org wrote:"))
		#expect(text.contains("Zeile 1<br>&lt;b&gt;Zeile 2&lt;/b&gt;"))
		#expect(ReplyBuilder.replyQuoteHTML(sender: "a@b.test", sentAt: nil, text: " ", html: nil, phrases: .english) == nil)
	}

	@Test func `a forward carries the header block of the original above it`() {
		let html = ReplyBuilder.forwardHTML(for: message(cc: "cleo@example.org"), sentAt: "25.11.2026", text: "Text", html: nil, phrases: .german)
		#expect(html.hasPrefix(QuoteSplitter.marker))
		#expect(html.contains("---------- Weitergeleitete Nachricht ---------"))
		#expect(html.contains("Von: Anna Krüger &lt;anna@example.org&gt;"))
		#expect(html.contains("Datum: 25.11.2026"))
		#expect(html.contains("Betreff: Termin"))
		#expect(html.contains("Cc: cleo@example.org"))
		#expect(html.contains("Text"))
	}

	@Test func `plain text is derived from the HTML that is sent`() {
		#expect(ReplyBuilder.plainText(fromHTML: "<p>Hallo <b>Anna</b>,</p><p>Zeile&nbsp;2 &amp; mehr<br>Zeile 3</p><ul><li>eins</li><li>zwei</li></ul>") == "Hallo Anna,\n\nZeile 2 & mehr\nZeile 3\n\n- eins\n- zwei")
		#expect(ReplyBuilder.plainText(fromHTML: "<style>p{}</style><p>x</p><script>y</script>") == "x")
		#expect(ReplyBuilder.plainText(fromHTML: "<a href=\"https://example.org\">Link</a> &lt;tag&gt; &#228;&#x20AC;") == "Link <tag> ä€")
	}
}
