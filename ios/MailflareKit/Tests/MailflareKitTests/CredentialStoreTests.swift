import Foundation
import Testing
@testable import MailflareKit

@Suite struct CredentialStoreTests {
	@Test func `the in-memory store round-trips access and two accounts`() throws {
		let store = InMemoryCredentialStore()
		#expect(try store.loadAccess() == nil)
		#expect(try store.accounts().isEmpty)
		try store.saveAccess(testAccess)
		let anna = AccountCredentials(userId: "u1", email: "anna@example.test", name: "Anna", role: "user", sessionToken: "dev_1")
		let ben = AccountCredentials(userId: "u2", email: "ben@example.test", name: "Ben", role: "admin", sessionToken: "dev_2")
		try store.save(anna)
		try store.save(ben)
		#expect(try store.loadAccess() == testAccess)
		#expect(try store.accounts() == [anna, ben])

		var renewed = anna
		renewed.sessionToken = "dev_3"
		try store.save(renewed)
		#expect(try store.accounts() == [renewed, ben], "saving again replaces, keeping the order")

		try store.removeAccount(userId: "u1")
		#expect(try store.accounts() == [ben])
		try store.saveAccess(nil)
		#expect(try store.loadAccess() == nil)
	}

	@Test func `credentials survive encoding, as the keychain stores them`() throws {
		let bundle = StoredCredentials(access: testAccess, accounts: [AccountCredentials(userId: "u1", email: "a@example.test", name: "A", role: "user", sessionToken: "dev_1")])
		let decoded = try JSONDecoder().decode(StoredCredentials.self, from: JSONEncoder().encode(bundle))
		#expect(decoded == bundle)
	}
}
