import Foundation
import Testing
@testable import MailflareKit

@Suite struct MailSearchTests {
	private func found(_ store: MailStore, _ text: String, mailbox: String? = nil) throws -> [String] {
		try store.search(text, mailboxId: mailbox, limit: 50).map(\.message.id)
	}

	private func store(_ rows: [MessageRow]) throws -> MailStore {
		let store = try MailStore.inMemory()
		try store.apply(page(rows, mailboxes: ["box", "other"]))
		return store
	}

	@Test func `words are found in the subject, the sender and the recipient, newest first`() throws {
		var fromAnna = mail("sender", age: 30, subject: "Hallo")
		fromAnna.fromAddr = "Anna Krüger <anna@example.test>"
		var toMarkus = mail("recipient", direction: "outbound", status: "sent", age: 20, subject: "Angebot")
		toMarkus.toAddr = "Markus Hahn <markus@handwerk.test>"
		let store = try store([mail("subject", age: 10, subject: "Rechnung für November"), fromAnna, toMarkus, mail("none", subject: "Anderes")])
		#expect(try found(store, "rechnung") == ["subject"])
		#expect(try found(store, "anna") == ["sender"])
		#expect(try found(store, "handwerk") == ["recipient"])
		#expect(try found(store, "example") == ["none", "subject", "recipient", "sender"])
	}

	@Test func `the beginning of a word is enough, case and accents do not matter, every word must occur`() throws {
		var row = mail("a", subject: "Elternabend im Kindergarten")
		row.fromAddr = "Anna Krüger <anna@example.test>"
		let store = try store([row, mail("b", subject: "Elternbrief")])
		#expect(try found(store, "ELTERN") == ["b", "a"])
		#expect(try found(store, "kruger") == ["a"])
		#expect(try found(store, "eltern kinder") == ["a"])
		#expect(try found(store, "eltern zebra") == [])
	}

	@Test func `the content is searched once it is on the device, also when the mail has only HTML`() throws {
		let store = try store([mail("text", age: 10), mail("html", age: 20)])
		#expect(try found(store, "wasserzähler") == [])
		try store.saveBody(MessageDetail(message: mail("text", age: 10), body: MessageBody(textBody: "Bitte den Wasserzähler ablesen.", htmlBody: nil)))
		try store.saveBody(MessageDetail(message: mail("html", age: 20), body: MessageBody(textBody: nil, htmlBody: "<style>p{color:red}</style><p>Der <b>Wasserz&auml;hler</b> wird am&nbsp;Montag getauscht.</p><script>geheim()</script>")))
		#expect(try found(store, "wasserzähler") == ["text", "html"])
		#expect(try found(store, "montag") == ["html"])
		#expect(try found(store, "color") == [])
		#expect(try found(store, "geheim") == [])
	}

	@Test func `a changed, removed or trimmed message is no longer found by what it said`() throws {
		let store = try store([mail("a", age: 100, subject: "Alt"), mail("b", subject: "Bleibt")])
		try store.saveBody(MessageDetail(message: mail("a", age: 100), body: MessageBody(textBody: "Geheimnis", htmlBody: nil)))
		try store.apply(page([mail("a", age: 100, subject: "Neu")], cursor: "c2", mailboxes: ["box", "other"]))
		#expect(try found(store, "alt") == [])
		#expect(try found(store, "neu") == ["a"])
		#expect(try found(store, "geheimnis") == ["a"])
		try store.trimBodies(olderThan: testNow.addingTimeInterval(-50))
		#expect(try found(store, "geheimnis") == [])
		#expect(try found(store, "neu") == ["a"])
		try store.apply(page(removed: ["a"], cursor: "c3", mailboxes: ["box", "other"]))
		#expect(try found(store, "neu") == [])
		try store.reset()
		#expect(try found(store, "bleibt") == [])
	}

	@Test func `spam and templates are left out and one mailbox can be searched alone`() throws {
		let store = try store([
			mail("inbox", age: 1, subject: "Treffen"), mail("spam", status: "spam", subject: "Treffen"),
			mail("template", direction: "outbound", status: "template", subject: "Treffen"),
			mail("trash", status: "trash", age: 2, subject: "Treffen"), mail("elsewhere", mailbox: "other", age: 3, subject: "Treffen"),
		])
		#expect(try found(store, "treffen") == ["inbox", "trash", "elsewhere"])
		#expect(try found(store, "treffen", mailbox: "other") == ["elsewhere"])
	}

	@Test func `the number at the icon counts unread mail of the inbox only`() throws {
		let store = try store([
			mail("a"), mail("b", category: "invoices"), mail("elsewhere", mailbox: "other"), mail("read", read: true),
			mail("promo", category: "promotions"), mail("spam", status: "spam"), mail("archived", status: "archived"),
			mail("snoozed", snoozedUntil: testNow.addingTimeInterval(3600)), mail("sent", direction: "outbound", status: "sent"), mail("filed", folder: "f1"),
		])
		#expect(try store.unreadInboxCount(now: testNow) == 3)
	}

	@Test func `signs that mean something to the index are taken as text`() throws {
		let store = try store([mail("a", subject: "Re: \"Angebot\" (Dach) - 50% AND mehr*")])
		for text in ["\"angebot\"", "(dach)", "50%", "AND", "mehr*", "angebot OR", "re:", "-", "\"", "  "] {
			_ = try found(store, text)
		}
		#expect(try found(store, "\"angebot\" (dach)") == ["a"])
		#expect(try found(store, "  ") == [])
		#expect(try found(store, "-") == [])
	}

	@Test func `mail stored before the search existed is found after the update`() throws {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: directory) }
		var old = try MailStore.open(userId: "u", directory: directory, migratingUpTo: "v3")
		try old.apply(page([mail("a", subject: "Steuerbescheid"), mail("b")]))
		try old.executeForTesting("INSERT INTO message_body(messageId, htmlBody) VALUES ('b', '<p>Grundsteuer</p>')")
		try old.close()
		old = try MailStore.open(userId: "u", directory: directory)
		#expect(try found(old, "steuerbescheid") == ["a"])
		#expect(try found(old, "grundsteuer") == ["b"])
	}
}
