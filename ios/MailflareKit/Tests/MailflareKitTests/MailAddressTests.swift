import Testing
@testable import MailflareKit

@Suite struct MailAddressTests {
	@Test(arguments: [
		("Anna Krüger <anna@example.org>", "Anna Krüger", "anna@example.org"),
		("\"Krüger, Anna\" <anna@example.org>", "Krüger, Anna", "anna@example.org"),
		("anna@example.org", nil, "anna@example.org"),
		("<anna@example.org>", nil, "anna@example.org"),
		("  Stadtwerke   <service@stadtwerke.example> ", "Stadtwerke", "service@stadtwerke.example"),
		("'Ben' <ben@example.org>", "Ben", "ben@example.org"),
		("\"anna@example.org\" <anna@example.org>", nil, "anna@example.org"),
	] as [(String, String?, String)])
	func `one address is split into name and address`(text: String, name: String?, address: String) {
		let parsed = MailAddress(text)
		#expect(parsed.name == name)
		#expect(parsed.address == address)
	}

	@Test func `a list is split at commas outside quotes`() {
		let list = MailAddress.list("\"Krüger, Anna\" <anna@example.org>, ben@example.org,  Cleo <cleo@example.org>")
		#expect(list.map(\.address) == ["anna@example.org", "ben@example.org", "cleo@example.org"])
		#expect(list.map(\.label) == ["Krüger, Anna", "ben@example.org", "Cleo"])
		#expect(MailAddress.list("").isEmpty)
		#expect(MailAddress.list(" , ").isEmpty)
	}

	@Test func `a name that only repeats or imitates an address is not shown as the name`() {
		#expect(MailAddress("\"ceo@bank.example\" <thief@evil.example>").label == "thief@evil.example")
		#expect(MailAddress("\"ceo\u{FF20}bank.example\" <thief@evil.example>").label == "thief@evil.example", "a full-width @ is still an @")
		#expect(MailAddress("\"ceo\u{FE6B}bank.example\" <thief@evil.example>").label == "thief@evil.example")
		#expect(MailAddress("\"www.bank.example\" <thief@evil.example>").label == "thief@evil.example", "a host name is not a person's name")
		#expect(MailAddress("\"bank.example Support\" <thief@evil.example>").label == "thief@evil.example")
		#expect(MailAddress("Dr. Anna Krüger <anna@example.org>").label == "Dr. Anna Krüger", "an ordinary abbreviation stays a name")
		#expect(MailAddress("J. R. R. Tolkien <jrr@example.org>").label == "J. R. R. Tolkien")
	}
}
