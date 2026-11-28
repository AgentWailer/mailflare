import Foundation
import Observation
import MailflareKit

/// What the app needs from outside, so tests can supply their own.
struct AppDependencies {
	var credentials: any CredentialStore
	var storeDirectory: URL
	var transport: any HTTPTransport
	var defaults: UserDefaults
	var deviceName: String
}

/// One signed-in account in use: its server client, its mail on the device and its sync.
final class AccountSession {
	let account: AccountCredentials
	let api: APIClient
	let store: MailStore
	let engine: SyncEngine

	init(account: AccountCredentials, api: APIClient, store: MailStore, engine: SyncEngine) {
		self.account = account
		self.api = api
		self.store = store
		self.engine = engine
	}
}

enum SettingKey {
	static let offlineDays = "offline.days"
	static let autoAttachments = "attachments.auto"
	static let attachmentsWiFiOnly = "attachments.wifiOnly"
	static let lastScope = "list.lastScope"
	/// The account's own setting for pictures from the internet, as last fetched from the server.
	static let externalContent = "externalContent"
}

@Observable
final class AppModel {
	enum Phase: Equatable { case loading, needsServer, needsAccessKey, needsSignIn, ready }

	private(set) var phase: Phase = .loading
	private(set) var accounts: [AccountCredentials] = []
	private(set) var session: AccountSession?
	private(set) var access: ServerAccess?
	/// Why the last step failed, in the user's words.
	var errorMessage: String?
	/// Something the user should know that is not the answer to what they just did.
	var notice: String?
	private(set) var isWorking = false
	/// True while a sign-in waits for the code of the second factor.
	var needsSecondFactor: Bool { challengeToken != nil }
	/// True when the sign-in form was opened to add a further account.
	private(set) var isAddingAccount = false

	private let dependencies: AppDependencies
	private var pendingServer: URL?
	private var challengeToken: String?
	private var statusTask: Task<Void, Never>?
	private static let activeUserKey = "activeUserId"

	init(dependencies: AppDependencies) {
		self.dependencies = dependencies
	}

	var activeUserIdForTesting: String? { dependencies.defaults.string(forKey: Self.activeUserKey) }
	var serverAddress: URL? { access?.baseURL ?? pendingServer }

	// MARK: Start

	func start() async {
		do {
			access = try dependencies.credentials.loadAccess()
			accounts = try dependencies.credentials.accounts()
		} catch {
			errorMessage = String(localized: "The saved sign-in could not be read. Set the app up again.")
		}
		guard access != nil else { phase = .needsServer; return }
		let preferred = dependencies.defaults.string(forKey: Self.activeUserKey)
		guard let account = accounts.first(where: { $0.userId == preferred }) ?? accounts.first else { phase = .needsSignIn; return }
		activate(account)
	}

	// MARK: Setup

	@discardableResult
	func submitServer(_ text: String) -> Bool {
		guard let url = normalizeServerAddress(text) else {
			errorMessage = String(localized: "That is not a server address. Enter it like mail.example.com.")
			return false
		}
		errorMessage = nil
		pendingServer = url
		phase = .needsAccessKey
		return true
	}

	func backToServer() {
		errorMessage = nil
		phase = .needsServer
	}

	func submitAccessKey(_ key: AccessKey) async {
		guard let server = pendingServer ?? access?.baseURL else { phase = .needsServer; return }
		let candidate = ServerAccess(baseURL: server, accessClientId: key.clientId, accessClientSecret: key.clientSecret)
		await work {
			try await self.client(candidate, token: nil).checkAccess()
			try self.dependencies.credentials.saveAccess(candidate)
			self.access = candidate
			self.phase = .needsSignIn
		}
	}

	/// Swaps the device's key, for example after the old one was revoked. Accounts and mail stay.
	func replaceAccessKey(_ key: AccessKey) async {
		guard let current = access else { return }
		let candidate = ServerAccess(baseURL: current.baseURL, accessClientId: key.clientId, accessClientSecret: key.clientSecret)
		await work {
			try await self.client(candidate, token: nil).checkAccess()
			try self.dependencies.credentials.saveAccess(candidate)
			self.access = candidate
			if let account = self.session?.account { self.activate(account) }
		}
	}

	// MARK: Sign-in

	func signIn(email: String, password: String) async {
		guard let access else { phase = .needsServer; return }
		await work {
			let result = try await self.client(access, token: nil).signIn(
				email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password, deviceName: self.dependencies.deviceName)
			switch result {
			case .signedIn(let account): try self.finishSignIn(account)
			case .secondFactor(let challenge): self.challengeToken = challenge
			}
		}
	}

	func submitSecondFactor(code: String) async {
		guard let access, let challengeToken else { return }
		await work {
			let account = try await self.client(access, token: nil).verifySecondFactor(
				challengeToken: challengeToken, code: code.trimmingCharacters(in: .whitespacesAndNewlines), deviceName: self.dependencies.deviceName)
			try self.finishSignIn(account)
		}
	}

	func cancelSecondFactor() {
		challengeToken = nil
		errorMessage = nil
	}

	private func finishSignIn(_ account: AccountCredentials) throws {
		try dependencies.credentials.save(account)
		accounts = try dependencies.credentials.accounts()
		challengeToken = nil
		isAddingAccount = false
		activate(account)
	}

	// MARK: Accounts

	func beginAddingAccount() {
		errorMessage = nil
		challengeToken = nil
		isAddingAccount = true
		phase = .needsSignIn
	}

	func cancelAddingAccount() {
		guard isAddingAccount, session != nil else { return }
		isAddingAccount = false
		errorMessage = nil
		challengeToken = nil
		phase = .ready
	}

	func switchAccount(userId: String) async {
		guard userId != session?.account.userId, let account = accounts.first(where: { $0.userId == userId }) else { return }
		activate(account)
	}

	/// Ends the session on the server when it can be reached, and removes the account and its mail from this device either way.
	func signOut(userId: String) async {
		guard let account = accounts.first(where: { $0.userId == userId }), let access else { return }
		try? await client(access, token: account.sessionToken).signOut()
		remove(account)
	}

	/// The server no longer accepts this account's session: its mail must not stay on the device.
	func handleSignedOut(userId: String) async {
		guard let account = accounts.first(where: { $0.userId == userId }) else { return }
		remove(account)
		notice = String(localized: "\(account.email) was signed out on the server. Its mail was removed from this device.")
	}

	private func remove(_ account: AccountCredentials) {
		let wasActive = session?.account.userId == account.userId
		if wasActive {
			statusTask?.cancel()
			try? session?.store.close()
			session = nil
		}
		try? dependencies.credentials.removeAccount(userId: account.userId)
		try? MailStore.destroy(userId: account.userId, directory: dependencies.storeDirectory)
		accounts = (try? dependencies.credentials.accounts()) ?? accounts.filter { $0.userId != account.userId }
		guard wasActive else { return }
		if let next = accounts.first {
			activate(next)
		} else {
			dependencies.defaults.removeObject(forKey: Self.activeUserKey)
			phase = .needsSignIn
		}
	}

	/// A sync started by iOS while the app is not on screen.
	func backgroundSync() async {
		if phase == .loading { await start() }
		await session?.engine.syncNow()
	}

	// MARK: Session

	private func client(_ access: ServerAccess, token: String?) -> APIClient {
		APIClient(access: access, sessionToken: token, transport: dependencies.transport)
	}

	func syncSettings(for store: MailStore) -> SyncSettings {
		var settings = SyncSettings()
		if let days = (try? store.setting(SettingKey.offlineDays)).flatMap({ $0 }).flatMap(Int.init), (7...90).contains(days) { settings.days = days }
		if (try? store.setting(SettingKey.autoAttachments)) == "0" { settings.autoAttachmentBytes = 0 }
		if (try? store.setting(SettingKey.attachmentsWiFiOnly)) == "0" { settings.attachmentsOnWiFiOnly = false }
		return settings
	}

	/// Rebuilds the sync after a setting it depends on has changed.
	func reloadSession() {
		if let account = session?.account { activate(account) }
	}

	private func activate(_ account: AccountCredentials) {
		guard let access else { phase = .needsServer; return }
		statusTask?.cancel()
		do {
			if session?.account.userId != account.userId { try? session?.store.close() }
			let store = try session?.account.userId == account.userId ? session!.store : MailStore.open(userId: account.userId, directory: dependencies.storeDirectory)
			let api = client(access, token: account.sessionToken)
			let cache = store.directory.map { AttachmentCache(directory: $0.appending(path: "attachments", directoryHint: .isDirectory)) }
			let engine = SyncEngine(api: api, store: store, settings: syncSettings(for: store), attachments: cache, isOnWiFi: { Connectivity.shared.isOnWiFi })
			let session = AccountSession(account: account, api: api, store: store, engine: engine)
			self.session = session
			dependencies.defaults.set(account.userId, forKey: Self.activeUserKey)
			errorMessage = nil
			phase = .ready
			statusTask = Task { [weak self] in
				for await status in await engine.statusUpdates() where status == .signedOut {
					await self?.handleSignedOut(userId: account.userId)
				}
			}
			Task {
				await engine.syncNow()
				if let allowed = try? await api.externalContentAllowed() { try? store.setSetting(SettingKey.externalContent, allowed ? "1" : "0") }
			}
		} catch {
			errorMessage = String(localized: "The mail on this device could not be opened.")
			phase = .needsSignIn
		}
	}

	private func work(_ operation: @escaping () async throws -> Void) async {
		isWorking = true
		errorMessage = nil
		defer { isWorking = false }
		do {
			try await operation()
		} catch let error as APIError {
			errorMessage = error.userMessage
			Haptics.play(.error)
		} catch {
			errorMessage = String(localized: "That did not work. Try again.")
			Haptics.play(.error)
		}
	}
}
