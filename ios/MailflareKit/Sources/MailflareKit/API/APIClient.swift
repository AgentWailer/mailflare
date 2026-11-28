import Foundation

/// Talks to one Mailflare installation as one device. Every request carries the device's
/// Cloudflare Access key and, once signed in, its session token. No cookies are used.
public struct APIClient: Sendable {
	public let access: ServerAccess
	public let sessionToken: String?
	private let transport: any HTTPTransport

	public init(access: ServerAccess, sessionToken: String?, transport: any HTTPTransport = URLSessionTransport()) {
		self.access = access
		self.sessionToken = sessionToken
		self.transport = transport
	}

	// MARK: Access and sign-in

	/// Proves that the Access key is accepted: any JSON answer from Mailflare, even "Unauthorized", will do.
	public func checkAccess() async throws {
		do {
			_ = try await data(.get, "/api/auth/me")
		} catch APIError.signedOut {
			return
		}
	}

	/// The cookie Cloudflare Access hands out for this device's key, for the in-app web pages:
	/// a page loads images, scripts and more, and only a cookie reaches all of those requests.
	public func accessCookies() async throws -> [HTTPCookie] {
		let request = try request(.get, "/api/auth/me", query: [], body: nil)
		let response: HTTPURLResponse
		do {
			(_, response) = try await transport.send(request)
		} catch {
			throw APIError.offline
		}
		guard let url = request.url, let fields = response.allHeaderFields as? [String: String] else { return [] }
		return HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).filter { $0.name == "CF_Authorization" }
	}

	public func signIn(email: String, password: String, deviceName: String) async throws -> SignInResult {
		let answer: SignInAnswer = try await credentialRequest("/api/app/login", ["email": email, "password": password, "deviceName": deviceName])
		if answer.mfaRequired == true, let challenge = answer.challengeToken { return .secondFactor(challengeToken: challenge) }
		return .signedIn(try answer.credentials())
	}

	public func verifySecondFactor(challengeToken: String, code: String, deviceName: String) async throws -> AccountCredentials {
		let answer: SignInAnswer = try await credentialRequest("/api/app/login/mfa", ["challengeToken": challengeToken, "code": code, "deviceName": deviceName])
		return try answer.credentials()
	}

	public func signOut() async throws {
		_ = try await data(.post, "/api/auth/logout", body: Data("{}".utf8))
	}

	public func currentUser() async throws -> UserInfo {
		struct Answer: Decodable { let user: UserInfo }
		return try await decode(Answer.self, .get, "/api/auth/me").user
	}

	/// Whether the account lets mail load pictures from the internet without asking.
	public func externalContentAllowed() async throws -> Bool {
		struct Answer: Decodable { let enabled: Bool }
		return try await decode(Answer.self, .get, "/api/settings/external-content").enabled
	}

	/// The devices signed in to this account.
	public func devices() async throws -> [SignedInDevice] {
		struct Answer: Decodable { let devices: [SignedInDevice] }
		return try await decode(Answer.self, .get, "/api/app/devices").devices
	}

	/// Signs one of the account's devices out, this one included.
	public func endDevice(id: String) async throws {
		_ = try await data(.delete, "/api/app/devices/\(Self.segment(id))")
	}

	/// Hands the server the address Apple gave this app, so new mail is announced on this device.
	/// Returns whether the server is set up to reach Apple at all.
	@discardableResult
	public func registerPush(token: String, environment: String) async throws -> Bool {
		struct Answer: Decodable { let configured: Bool? }
		let body = try JSONSerialization.data(withJSONObject: ["token": token, "environment": environment])
		return try await decode(Answer.self, .post, "/api/app/push", body: body).configured ?? false
	}

	public func unregisterPush() async throws {
		_ = try await data(.delete, "/api/app/push")
	}

	// MARK: Composing

	private func fields(_ draft: DraftPayload) -> [String: Any] {
		var fields: [String: Any] = [
			"mailboxId": draft.mailboxId, "from": draft.from, "to": draft.to.joined(separator: ", "), "cc": draft.cc.joined(separator: ", "),
			"bcc": draft.bcc.joined(separator: ", "), "subject": draft.subject, "html": draft.html, "text": draft.text,
		]
		if let value = draft.inReplyTo { fields["inReplyTo"] = value }
		if let value = draft.references { fields["references"] = value }
		if let value = draft.threadId { fields["threadId"] = value }
		return fields
	}

	public func createDraft(_ draft: DraftPayload, requestId: String?) async throws -> String {
		struct Answer: Decodable { struct Draft: Decodable { let id: String }; let draft: Draft }
		var fields = fields(draft)
		// The server takes a request id or a forward source, not both.
		if let source = draft.forwardOfMessageId { fields["forwardOfMessageId"] = source } else if let requestId { fields["requestId"] = requestId.lowercased() }
		do {
			return try await decode(Answer.self, .post, "/api/drafts", body: try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])).draft.id
		} catch APIError.server(409, _) {
			// "Draft already completed": the message this draft was for has gone out.
			throw APIError.notFound
		}
	}

	public func updateDraft(id: String, _ draft: DraftPayload) async throws {
		_ = try await data(.patch, "/api/drafts/\(Self.segment(id))", body: try JSONSerialization.data(withJSONObject: fields(draft), options: [.sortedKeys]))
	}

	public func deleteDraft(id: String) async throws {
		_ = try await data(.delete, "/api/drafts/\(Self.segment(id))")
	}

	public func draft(id: String) async throws -> ServerDraft {
		struct Answer: Decodable { let draft: ServerDraft }
		return try await decode(Answer.self, .get, "/api/drafts/\(Self.segment(id))").draft
	}

	/// Sends a message from its draft. The draft goes with the send, so a second request for the
	/// same draft finds none and sends nothing: that is what makes a retry safe.
	public func send(_ draft: DraftPayload, draftId: String, attachments: [OutgoingAttachment]) async throws {
		var fields = fields(draft)
		fields["to"] = draft.to
		fields["cc"] = draft.cc.isEmpty ? nil : draft.cc
		fields["bcc"] = draft.bcc.isEmpty ? nil : draft.bcc
		fields["draftId"] = draftId
		if !attachments.isEmpty {
			fields["attachments"] = try attachments.map { ["filename": $0.filename, "type": $0.type, "contentBase64": try Data(contentsOf: $0.file).base64EncodedString()] }
		}
		_ = try await data(.post, "/api/send", body: try JSONSerialization.data(withJSONObject: fields.compactMapValues { $0 }, options: [.sortedKeys]))
	}

	/// The address book the composer suggests from: contacts and everyone mail was sent to, most written-to first.
	public func recipients() async throws -> [RecipientCandidate] {
		struct Answer: Decodable { let recipients: [RecipientCandidate] }
		return try await decode(Answer.self, .get, "/api/compose/recipients").recipients
	}

	// MARK: Actions

	/// One of the web's bulk actions: `archive`, `trash`, `spam`, `read`, `unread`, `inbox`, `folder` or `delete`.
	public func bulk(action: String, messageIds: [String], folderId: String?) async throws {
		var fields: [String: Any] = ["action": action, "messageIds": messageIds]
		if let folderId { fields["folderId"] = folderId }
		_ = try await data(.post, "/api/messages/bulk", body: try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]))
	}

	public func star(messageId: String, starred: Bool) async throws {
		_ = try await data(.post, "/api/messages/\(Self.segment(messageId))/star", body: try JSONSerialization.data(withJSONObject: ["starred": starred]))
	}

	/// Snoozes a message until the given time, or wakes it when `until` is nil.
	public func snooze(messageId: String, until: Date?) async throws {
		let path = "/api/messages/\(Self.segment(messageId))/snooze"
		guard let until else {
			_ = try await data(.delete, path)
			return
		}
		let text = until.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
		_ = try await data(.post, path, body: try JSONSerialization.data(withJSONObject: ["snoozedUntil": text]))
	}

	// MARK: Mail

	public func sync(cursor: String?, days: Int, limit: Int) async throws -> SyncPage {
		var query = [URLQueryItem(name: "days", value: String(days)), URLQueryItem(name: "limit", value: String(limit))]
		if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
		return try await decode(SyncPage.self, .get, "/api/app/sync", query: query)
	}

	public func message(id: String) async throws -> MessageDetail {
		try await decode(MessageDetail.self, .get, "/api/messages/\(Self.segment(id))")
	}

	public func mailboxes() async throws -> [MailboxInfo] {
		struct Answer: Decodable { let mailboxes: [MailboxInfo] }
		return try await decode(Answer.self, .get, "/api/mailboxes").mailboxes
	}

	public func folders(mailboxId: String) async throws -> [FolderInfo] {
		struct Answer: Decodable { let folders: [FolderInfo] }
		return try await decode(Answer.self, .get, "/api/folders", query: [URLQueryItem(name: "mailboxId", value: mailboxId)]).folders
	}

	public func counts(mailboxId: String?) async throws -> MailCounts {
		struct Answer: Decodable { let counts: MailCounts }
		let query = mailboxId.map { [URLQueryItem(name: "mailboxId", value: $0)] } ?? []
		return try await decode(Answer.self, .get, "/api/messages/counts", query: query).counts
	}

	/// A page of the server's own list, for mail older than what the device keeps.
	/// `filters` are the list route's parameters, such as `status` or `mailboxId`.
	public func messages(filters: [String: String], offset: Int, limit: Int) async throws -> [MessageRow] {
		struct Answer: Decodable { let messages: [MessageRow] }
		var query = filters.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
		query.append(URLQueryItem(name: "offset", value: String(offset)))
		query.append(URLQueryItem(name: "limit", value: String(limit)))
		return try await decode(Answer.self, .get, "/api/messages", query: query).messages
	}

	/// Downloads an attachment into its own temporary folder and returns the file, named as the attachment.
	public func attachment(messageId: String, attachmentId: String, filename: String) async throws -> URL {
		let bytes = try await data(.get, "/api/messages/\(Self.segment(messageId))/attachments/\(Self.segment(attachmentId))",
		                           query: [URLQueryItem(name: "download", value: "1")], expectJSON: false)
		let folder = FileManager.default.temporaryDirectory.appending(path: "attachments/\(UUID().uuidString)", directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let file = folder.appending(path: Self.safeFilename(filename), directoryHint: .notDirectory)
		try bytes.write(to: file, options: .atomic)
		return file
	}

	// MARK: Requests

	/// The header the session travels in. The server reads it in `src/lib/auth/session-header.ts`.
	public static let sessionHeader = "X-Mailflare-Session"

	enum Method: String { case get = "GET", post = "POST", delete = "DELETE", patch = "PATCH" }

	static func segment(_ value: String) -> String {
		var allowed = CharacterSet.urlPathAllowed
		allowed.remove(charactersIn: "/?#")
		return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
	}

	static func safeFilename(_ name: String) -> String {
		let cleaned = name.replacing(/[\/\\:\u{0}]/, with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
		return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "attachment" : String(cleaned.suffix(200))
	}

	static let decoder: JSONDecoder = {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let text = try decoder.singleValueContainer().decode(String.self)
			if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
			if let date = try? Date(text, strategy: .iso8601) { return date }
			throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO 8601 date"))
		}
		return decoder
	}()

	private func request(_ method: Method, _ path: String, query: [URLQueryItem], body: Data?) throws -> URLRequest {
		guard var components = URLComponents(url: access.baseURL, resolvingAgainstBaseURL: false) else { throw APIError.server(status: 0, message: nil) }
		components.percentEncodedPath = path
		components.queryItems = query.isEmpty ? nil : query
		// A plus sign in a cursor must not arrive as a space.
		components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
		guard let url = components.url else { throw APIError.server(status: 0, message: nil) }
		var request = URLRequest(url: url)
		request.httpMethod = method.rawValue
		request.setValue(access.accessClientId, forHTTPHeaderField: "CF-Access-Client-Id")
		request.setValue(access.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		// Not `Authorization: Bearer`: Cloudflare Access with Managed OAuth claims that header for its
		// own tokens and refuses anything else there before the request reaches Mailflare.
		if let sessionToken { request.setValue(sessionToken, forHTTPHeaderField: Self.sessionHeader) }
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		return request
	}

	/// Sends a request and returns the body of a successful answer, or throws what the answer means.
	private func data(_ method: Method, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, expectJSON: Bool = true, signingIn: Bool = false) async throws -> Data {
		let request = try request(method, path, query: query, body: body)
		let data: Data
		let response: HTTPURLResponse
		do {
			(data, response) = try await transport.send(request)
		} catch let error as APIError {
			throw error
		} catch is CancellationError {
			throw CancellationError()
		} catch let error as URLError where error.code == .cancelled {
			throw CancellationError()
		} catch {
			throw APIError.offline
		}

		let status = response.statusCode
		let isJSON = (response.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("json")
		// Cloudflare Access answers for the installation with a redirect or a page of its own.
		if (300..<400).contains(status) { throw APIError.accessDenied }
		if (200..<300).contains(status) {
			if expectJSON && !isJSON { throw APIError.accessDenied }
			return data
		}
		let answer = isJSON ? try? JSONDecoder().decode(ErrorAnswer.self, from: data) : nil
		let message = answer?.message
		// With Managed OAuth, Access refuses with a 401 of its own, in JSON like Mailflare's.
		// It is told apart by its challenge and by the pointer to its metadata.
		let challenge = response.value(forHTTPHeaderField: "WWW-Authenticate") ?? ""
		if status == 401, challenge.localizedCaseInsensitiveContains("OAuth") || answer?.isAccessRefusal == true { throw APIError.accessDenied }
		switch status {
		case 401 where signingIn && isJSON: throw APIError.server(status: 401, message: message)
		case 401: throw isJSON || !expectJSON ? APIError.signedOut : APIError.accessDenied
		case 403 where !isJSON && expectJSON: throw APIError.accessDenied
		case 404: throw APIError.notFound
		case 429: throw APIError.rateLimited(retryAfter: Int(response.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60)
		default: throw APIError.server(status: status, message: message)
		}
	}

	private func decode<T: Decodable>(_ type: T.Type, _ method: Method, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, signingIn: Bool = false) async throws -> T {
		let data = try await data(method, path, query: query, body: body, signingIn: signingIn)
		do {
			return try Self.decoder.decode(type, from: data)
		} catch {
			throw APIError.decoding
		}
	}

	/// Sign-in answers 401 for a wrong password or code. That is not a lost session.
	private func credentialRequest<T: Decodable>(_ path: String, _ fields: [String: String]) async throws -> T {
		let body = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
		return try await decode(T.self, .post, path, body: body, signingIn: true)
	}
}

private struct ErrorAnswer: Decodable {
	let message: String?
	/// True for the answer Cloudflare Access gives in Mailflare's place.
	let isAccessRefusal: Bool

	enum CodingKeys: String, CodingKey { case error, resourceMetadata = "resource_metadata" }

	init(from decoder: any Decoder) throws {
		let container = try? decoder.container(keyedBy: CodingKeys.self)
		// `error` is a sentence, or for a rejected form an object of field errors.
		message = try? container?.decode(String.self, forKey: .error)
		isAccessRefusal = container?.contains(.resourceMetadata) ?? false
	}
}

private struct SignInAnswer: Decodable {
	struct User: Decodable {
		let id: String
		let email: String
		let name: String
		let role: String
	}

	let token: String?
	let user: User?
	let mfaRequired: Bool?
	let challengeToken: String?

	func credentials() throws -> AccountCredentials {
		guard let token, let user else { throw APIError.decoding }
		return AccountCredentials(userId: user.id, email: user.email, name: user.name, role: user.role, sessionToken: token)
	}
}
