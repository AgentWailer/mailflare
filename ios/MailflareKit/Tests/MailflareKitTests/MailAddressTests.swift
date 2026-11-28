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
	}
}
