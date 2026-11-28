import Foundation

/// How a device reaches the installation: its address and the device's own Cloudflare Access service token.
public struct ServerAccess: Codable, Equatable, Sendable {
	public var baseURL: URL
	public var accessClientId: String
	public var accessClientSecret: String

	public init(baseURL: URL, accessClientId: String, accessClientSecret: String) {
		self.baseURL = baseURL
		self.accessClientId = accessClientId
		self.accessClientSecret = accessClientSecret
	}
}

/// One signed-in Mailflare account on this device.
public struct AccountCredentials: Codable, Equatable, Sendable, Identifiable {
	public var userId: String
	public var email: String
	public var name: String
	public var role: String
	public var sessionToken: String

	public var id: String { userId }
	public var isAdmin: Bool { role == "admin" }

	public init(userId: String, email: String, name: String, role: String, sessionToken: String) {
		self.userId = userId
		self.email = email
		self.name = name
		self.role = role
		self.sessionToken = sessionToken
	}
}

/// Everything the keychain holds, as one item.
struct StoredCredentials: Codable, Equatable, Sendable {
	var access: ServerAccess?
	var accounts: [AccountCredentials] = []

	mutating func upsert(_ account: AccountCredentials) {
		if let index = accounts.firstIndex(where: { $0.userId == account.userId }) {
			accounts[index] = account
		} else {
			accounts.append(account)
		}
	}
}
