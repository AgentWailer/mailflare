import Foundation
import Synchronization

/// Where the access key and the session tokens are kept. The app uses the keychain.
public protocol CredentialStore: Sendable {
	func loadAccess() throws -> ServerAccess?
	func saveAccess(_ access: ServerAccess?) throws
	func accounts() throws -> [AccountCredentials]
	func save(_ account: AccountCredentials) throws
	func removeAccount(userId: String) throws
}

/// Keeps credentials for the life of the process. For previews and tests.
public final class InMemoryCredentialStore: CredentialStore {
	private let stored = Mutex(StoredCredentials())

	public init() {}

	public func loadAccess() throws -> ServerAccess? { stored.withLock { $0.access } }
	public func saveAccess(_ access: ServerAccess?) throws { stored.withLock { $0.access = access } }
	public func accounts() throws -> [AccountCredentials] { stored.withLock { $0.accounts } }
	public func save(_ account: AccountCredentials) throws { stored.withLock { $0.upsert(account) } }
	public func removeAccount(userId: String) throws { stored.withLock { $0.accounts.removeAll { $0.userId == userId } } }
}
