import Foundation
import Testing
import UIKit
import MailflareKit
@testable import Mailflare

@MainActor @Suite struct RichTextHTMLTests {
	private func attributed(_ parts: [(String, UIFontDescriptor.SymbolicTraits, Bool, String?)]) -> NSAttributedString {
		let result = NSMutableAttributedString()
		for (text, traits, underline, link) in parts {
			let base = UIFont.preferredFont(forTextStyle: .body)
			var attributes: [NSAttributedString.Key: Any] = [.font: UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor, size: base.pointSize)]
			if underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
			if let link { attributes[.link] = URL(string: link)! }
			result.append(NSAttributedString(string: text, attributes: attributes))
		}
		return result
	}

	@Test func `plain lines become paragraphs and special characters are escaped`() {
		let html = RichTextHTML.html(from: NSAttributedString(string: "Hallo <Anna> & Ben\n\nZweite \"Zeile\""))
		#expect(html == "<p>Hallo &lt;Anna&gt; &amp; Ben</p><p><br></p><p>Zweite &quot;Zeile&quot;</p>")
	}

	@Test func `bold, italic, underline and links survive, also when they overlap or span lines`() {
		let html = RichTextHTML.html(from: attributed([("fett", .traitBold, false, nil), (" und ", [], false, nil), ("beides", [.traitBold, .traitItalic], true, nil),
		                                               ("\nzweite ", .traitItalic, false, nil), ("Seite", [], false, "https://example.org/a?b=1&c=2")]))
		#expect(html == "<p><b>fett</b> und <b><i><u>beides</u></i></b></p><p><i>zweite </i><a href=\"https://example.org/a?b=1&amp;c=2\">Seite</a></p>")
	}

	@Test func `a link that is not a web or mail address is written as text`() {
		let html = RichTextHTML.html(from: attributed([("klick", [], false, "javascript:alert(1)")]))
		#expect(html == "<p>klick</p>")
	}

	@Test func `empty text is no paragraph at all`() {
		#expect(RichTextHTML.html(from: NSAttributedString(string: "")) == "")
		#expect(RichTextHTML.html(from: NSAttributedString(string: "  \n ")) == "")
	}
}

@MainActor @Suite struct ComposeModelTests {
	private func session(_ transport: RouteTransport = .signedIn(), signature: String? = nil) throws -> AccountSession {
		let access = ServerAccess(baseURL: URL(string: "https://mail.example.test")!, accessClientId: "i", accessClientSecret: "s")
		let account = AccountCredentials(userId: "u1", email: "me@example.test", name: "Me", role: "user", sessionToken: "dev_u1")
		let api = APIClient(access: access, sessionToken: "dev_u1", transport: transport)
		let store = try MailStore.inMemory()
		try store.replaceMailboxes([
			MailboxInfo(id: "box", userId: "u1", localPart: "me", hostname: "example.test", displayName: "Me", permission: "full_access", isPrimary: true, signature: signature, senderAddresses: ["me@example.test", "alias@example.test"]),
			MailboxInfo(id: "team", userId: "u2", localPart: "team", hostname: "example.test", type: "shared", permission: "read_only", senderAddresses: ["team@example.test"]),
		], folders: [], counts: MailCounts())
		let original = MessageRow(id: "m1", userId: "u1", mailboxId: "box", providerMessageId: "<abc@example.org>", fromAddr: "Anna Krüger <anna@example.org>",
		                          toAddr: "alias@example.test, Ben <ben@example.org>", ccAddr: "cleo@example.org", subject: "Termin", threadId: "t1", createdAt: Date(timeIntervalSince1970: 1_795_000_000))
		try store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [original]))
		try store.saveBody(MessageDetail(message: original, body: MessageBody(textBody: "Passt dir 14 Uhr?", htmlBody: nil)))
		try store.setSetting(SettingKey.recipientBook, #"[{"email":"anna@example.org","name":"Anna Krüger"},{"email":"andreas@example.org","name":null},{"email":"ben@example.org","name":"Ben"}]"#)
		return AccountSession(account: account, api: api, store: store, engine: SyncEngine(api: api, store: store))
	}

	private let files = FileManager.default.temporaryDirectory.appending(path: "mailflare-compose-tests-\(UUID().uuidString)")

	@Test func `a new message is queued with its HTML, its text and the chosen sender`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .new(), session: session, filesDirectory: files)
		await model.load()
		#expect(model.senders.map(\.address) == ["me@example.test", "alias@example.test"], "a mailbox that may only be read cannot send")
		#expect(model.from == "me@example.test")
		#expect(model.canSend == false)
		model.to = ["anna@example.org"]
		model.subject = "Hallo"
		model.body = NSAttributedString(string: "Erste Zeile\nZweite Zeile")
		model.from = "alias@example.test"
		#expect(model.canSend)
		#expect(await model.send())
		let queued = try #require(try session.store.outgoingMessages().first)
		#expect(queued.state == .queued)
		#expect(queued.to == ["anna@example.org"])
		#expect(queued.from == "alias@example.test")
		#expect(queued.mailboxId == "box")
		#expect(queued.html == "<p>Erste Zeile</p><p>Zweite Zeile</p>")
		#expect(queued.text == "Erste Zeile\n\nZweite Zeile")
		#expect(UUID(uuidString: queued.id) != nil && queued.id == queued.id.lowercased())
	}

	@Test func `nothing is sent without a recipient, with a broken address or while nothing was written`() async throws {
		let model = ComposeModel(intent: .new(), session: try session(), filesDirectory: files)
		await model.load()
		model.subject = "Hallo"
		#expect(!model.canSend)
		model.to = ["not an address"]
		#expect(!model.canSend)
		#expect(model.invalidRecipients == ["not an address"])
		model.to = ["Anna <anna@example.org>"]
		#expect(model.canSend)
		model.cc = ["broken@"]
		#expect(!model.canSend)
	}

	@Test func `a message without a subject gets a placeholder, because the server requires one`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .new(), session: session, filesDirectory: files)
		await model.load()
		model.to = ["anna@example.org"]
		model.body = NSAttributedString(string: "Text")
		#expect(await model.send())
		#expect(try session.store.outgoingMessages().first?.subject.isEmpty == false)
	}

	@Test func `a reply answers the sender in the conversation, from the address the mail came to, above the quote`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .reply(messageId: "m1", all: false), session: session, filesDirectory: files)
		await model.load()
		#expect(model.to == ["Anna Krüger <anna@example.org>"])
		#expect(model.cc.isEmpty)
		#expect(model.subject == "Re: Termin")
		#expect(model.from == "alias@example.test", "the reply comes from the address that was written to")
		#expect(model.hasQuote)
		model.body = NSAttributedString(string: "Ja, passt.")
		#expect(await model.send())
		let queued = try #require(try session.store.outgoingMessages().first)
		#expect(queued.inReplyTo == "abc@example.org")
		#expect(queued.references == "abc@example.org")
		#expect(queued.threadId == "t1")
		#expect(queued.html.hasPrefix("<p>Ja, passt.</p>"))
		#expect(queued.html.contains("Passt dir 14 Uhr?"))
		#expect(QuoteSplitter.split(html: queued.html).visible == "<p>Ja, passt.</p>")
		#expect(queued.text.hasPrefix("Ja, passt."))
	}

	@Test func `a reply nobody wrote in is nothing to keep, and one that was touched is`() async throws {
		let model = ComposeModel(intent: .reply(messageId: "m1", all: false), session: try session(), filesDirectory: files)
		await model.load()
		#expect(!model.hasContent, "what the composer filled in by itself is not the user's work")
		model.cc = ["ben@example.org"]
		#expect(model.hasContent)
		model.cc = []
		#expect(!model.hasContent)
		model.body = NSAttributedString(string: "Ja.")
		#expect(model.hasContent)
	}

	@Test func `reply-all keeps the others and the quote can be left out`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .reply(messageId: "m1", all: true), session: session, filesDirectory: files)
		await model.load()
		#expect(model.to == ["Anna Krüger <anna@example.org>"])
		#expect(model.cc == ["Ben <ben@example.org>", "cleo@example.org"])
		model.includesQuote = false
		model.body = NSAttributedString(string: "Kurz.")
		#expect(await model.send())
		#expect(try session.store.outgoingMessages().first?.html == "<p>Kurz.</p>")
	}

	@Test func `a forward has no recipient yet, names its source and copies the attachments on the server`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .forward(messageId: "m1"), session: session, filesDirectory: files)
		await model.load()
		#expect(model.to.isEmpty)
		#expect(model.subject == "Fwd: Termin")
		model.to = ["ben@example.org"]
		#expect(await model.send())
		let queued = try #require(try session.store.outgoingMessages().first)
		#expect(queued.forwardOfMessageId == "m1")
		#expect(queued.html.contains("Termin") && queued.html.contains("Passt dir 14 Uhr?"))
	}

	@Test func `the signature of the sending mailbox is put under a new message`() async throws {
		let model = ComposeModel(intent: .new(), session: try session(signature: "<p>Viele Grüße<br>Me</p>"), filesDirectory: files)
		await model.load()
		#expect(model.body.string == "\n\nViele Grüße\nMe")
	}

	@Test func `typing suggests people from the address book, names before addresses, without those already chosen`() async throws {
		let model = ComposeModel(intent: .new(), session: try session(), filesDirectory: files)
		await model.load()
		#expect(model.suggestions(for: "an").map(\.email) == ["anna@example.org", "andreas@example.org"])
		#expect(model.suggestions(for: "kr").map(\.email) == ["anna@example.org"], "a later word of the name matches too")
		#expect(model.suggestions(for: "").isEmpty)
		model.to = ["Anna Krüger <anna@example.org>"]
		#expect(model.suggestions(for: "an").map(\.email) == ["andreas@example.org"])
		#expect(model.entry(for: RecipientCandidate(email: "anna@example.org", name: "Anna Krüger")) == "Anna Krüger <anna@example.org>")
		#expect(model.entry(for: RecipientCandidate(email: "x@example.org", name: "x@evil.example")) == "x@example.org", "a name that poses as an address is not written")
	}

	@Test func `a message put aside is kept as a draft on the device with its attachment, and discarding removes both`() async throws {
		let session = try session()
		let model = ComposeModel(intent: .new(), session: session, filesDirectory: files)
		await model.load()
		#expect(!model.hasContent)
		model.subject = "Später"
		let source = FileManager.default.temporaryDirectory.appending(path: "mailflare-pick-\(UUID().uuidString).txt")
		try Data("hello".utf8).write(to: source)
		try model.attach(fileAt: source, type: "text/plain")
		#expect(model.hasContent)
		model.saveDraft()
		let draft = try #require(try session.store.outgoingMessages().first)
		#expect(draft.state == .draft)
		#expect(draft.attachments.map(\.filename) == [source.lastPathComponent])
		#expect(FileManager.default.fileExists(atPath: draft.attachments[0].file.path))
		#expect(draft.attachments[0].file != source, "the picked file is copied; the original may go away")

		let reopened = ComposeModel(intent: .outgoing(id: draft.id), session: session, filesDirectory: files)
		await reopened.load()
		#expect(reopened.subject == "Später")
		#expect(reopened.attachments.count == 1)
		reopened.discard()
		#expect(try session.store.outgoingMessages().isEmpty)
		#expect(!FileManager.default.fileExists(atPath: draft.attachments[0].file.path))
	}

	@Test func `more than ten files or more than the size the server takes are refused`() async throws {
		let model = ComposeModel(intent: .new(), session: try session(), filesDirectory: files)
		await model.load()
		let big = FileManager.default.temporaryDirectory.appending(path: "mailflare-big-\(UUID().uuidString).bin")
		try Data(count: ComposeModel.maxAttachmentBytes + 1).write(to: big)
		defer { try? FileManager.default.removeItem(at: big) }
		#expect(throws: ComposeModel.AttachmentError.tooLarge) { try model.attach(fileAt: big, type: "application/octet-stream") }
		for index in 0..<10 {
			let small = FileManager.default.temporaryDirectory.appending(path: "mailflare-small-\(UUID().uuidString)-\(index).txt")
			try Data("x".utf8).write(to: small)
			try model.attach(fileAt: small, type: "text/plain")
		}
		let eleventh = FileManager.default.temporaryDirectory.appending(path: "mailflare-eleventh-\(UUID().uuidString).txt")
		try Data("x".utf8).write(to: eleventh)
		#expect(throws: ComposeModel.AttachmentError.tooMany) { try model.attach(fileAt: eleventh, type: "text/plain") }
	}
}
