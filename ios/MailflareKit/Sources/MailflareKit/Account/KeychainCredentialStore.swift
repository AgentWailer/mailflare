import Foundation
import Security
import Synchronization

/// Credentials in the device keychain, readable after the first unlock so a background sync can
/// run while the phone is locked, and never copied to another device or a backup.
public final class KeychainCredentialStore: CredentialStore {
	public struct KeychainError: Error, Equatable {
		public let status: OSStatus
	}

	private let service: String
	private let account = "credentials"
	private let lock = Mutex(())

	public init(service: String = "de.steffenvonlindern.mailflare.credentials") {
		self.service = service
	}

	public func loadAccess() throws -> ServerAccess? { try read().access }
	public func accounts() throws -> [AccountCredentials] { try read().accounts }

	public func saveAccess(_ access: ServerAccess?) throws {
		try update { $0.access = access }
	}

	public func save(_ account: AccountCredentials) throws {
		try update { $0.upsert(account) }
	}

	public func removeAccount(userId: String) throws {
		try update { stored in stored.accounts.removeAll { $0.userId == userId } }
	}

	private var query: [String: Any] {
		[kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
	}

	private func update(_ change: (inout StoredCredentials) -> Void) throws {
		try lock.withLock { _ in
			var stored = try read()
			change(&stored)
			try write(stored)
		}
	}

	private func read() throws -> StoredCredentials {
		var request = query
		request[kSecReturnData as String] = true
		request[kSecMatchLimit as String] = kSecMatchLimitOne
		var result: CFTypeRef?
		let status = SecItemCopyMatching(request as CFDictionary, &result)
		if status == errSecItemNotFound { return StoredCredentials() }
		guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
		// An item this version cannot read is treated as absent: the user sets the app up again.
		return (try? JSONDecoder().decode(StoredCredentials.self, from: data)) ?? StoredCredentials()
	}

	private func write(_ stored: StoredCredentials) throws {
		let data = try JSONEncoder().encode(stored)
		let attributes: [String: Any] = [
			kSecValueData as String: data,
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]
		var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
		if status == errSecItemNotFound {
			status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
		}
		guard status == errSecSuccess else { throw KeychainError(status: status) }
	}
}
