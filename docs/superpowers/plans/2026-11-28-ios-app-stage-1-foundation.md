# Mailflare for iOS, Stage 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native iPhone app that signs in through Cloudflare Access, keeps the last 30 days of mail on the device, and shows mailboxes, lists and messages with or without a network.

**Architecture:** The Worker gains a change log (`mail_changes`, filled by triggers), device sessions, and three routes under `/api/app/`. A Swift package `MailflareKit` owns access, sync and the on-device SQLite store and has no UI; the SwiftUI app target reads only from that store. Everything the app does not draw natively opens in an in-app web view.

**Tech Stack:** Existing Worker (TypeScript, Drizzle, D1, node:test). Swift 6, SwiftUI, iOS 26 minimum, GRDB (the only third-party dependency), XcodeGen for the project file, Xcode 27.2.

**Spec:** `docs/superpowers/specs/2026-11-28-ios-app-design.md` (German). This plan covers "Block 1, Stufe 1: Fundament" only. Actions, compose, notifications and search are later stages with their own plans.

## Global Constraints

- Migrations are additive, hand-written in the generated style, numbered from `0085`, and listed in `drizzle/migrations/meta/_journal.json`. Trigger bodies stay whole.
- Tests never read or change production resources. Server tests use the local SQLite harness with the real migrations (pattern: `tests/folder-read-all.test.mjs`).
- Server conventions from `CLAUDE.md` apply: tabs, `getEnv()`, `NextResponse.json({ error }, { status })`, helpers in sibling `*-utils.ts`, types in `*-types.d.ts`.
- Every app request carries `CF-Access-Client-Id`, `CF-Access-Client-Secret` and `Authorization: Bearer <device session token>`. No cookies in `MailflareKit`.
- Offline window: 30 days by default. Attachments up to 5 MB load automatically on Wi-Fi only; larger ones on tap.
- The UI reads only from the on-device database. No screen may show an empty or error page because the network is missing.
- App strings exist in German and English (String Catalog). Accent colour `#0b57d0` light, `#8ab4f8` dark. Dynamic Type and VoiceOver labels on every control.
- Swift builds run with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; do not change `xcode-select` (needs sudo).
- Haptics, real Access, and background refresh cannot be proven in the simulator. Report them as untested on device, never as working.

## Review Focus

1. **Access session expired or token revoked:** Access answers with a 302 or an HTML login page instead of JSON. The app must show "Zugangsschlüssel abgelehnt" and keep local mail readable, not crash on decoding or wipe data. (Task 5)
2. **Cursor older than the change log:** a phone that was off for two months must resync from scratch without duplicating or losing rows. (Tasks 3, 7)
3. **Mailbox access changed between syncs:** a revoked shared mailbox must disappear from the device, and a newly shared one must appear with its 30 days. (Tasks 3, 7)
4. **Sync interrupted mid-page:** the app is killed during the first sync; the next start continues from the stored cursor and the list shows what already arrived. (Task 7)
5. **Hostile or broken HTML mail:** scripts, forms, remote images and `javascript:` links in a message body must not run or load in the reader. (Task 10)

---

### Task 1: Change log on the server

**Files:**
- Create: `drizzle/migrations/0085_mail_changes.sql`
- Modify: `drizzle/migrations/meta/_journal.json`, `src/db/schema/index.ts`
- Test: `tests/app-mail-changes.test.mjs`

**Interfaces:**
- Produces: table `mail_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, mailbox_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('changed','removed')), changed_at INTEGER NOT NULL)` with index `mail_changes_mailbox_seq_idx(mailbox_id, seq)`; Drizzle export `mailChanges`.

- [ ] **Step 1: Write the failing tests** in `tests/app-mail-changes.test.mjs` using the `SqliteDatabase` + `applyMigrations` fixture:
  - `insert writes one changed row`: insert a message in `box`; `mail_changes` has exactly `[{mailbox_id:'box', message_id:'m1', kind:'changed'}]`.
  - `list-relevant updates write a row, others do not`: updating each of `read, starred, status, folder_id, category, snoozed_until, subject, snippet, thread_id, text_body, html_body` adds one row; updating `spam_score` or `header_metadata` adds none.
  - `moving a message removes it from the old mailbox`: `UPDATE messages SET mailbox_id='shared'` adds `('box','m1','removed')` then `('shared','m1','changed')`.
  - `delete writes removed`; `label assignment writes changed` (insert and delete on `message_labels`).
  - `messages without a mailbox write nothing`.
  - `seq never repeats after pruning`: delete all rows, insert a message, new `seq` is greater than the old maximum.
- [ ] **Step 2:** Run `node --test tests/app-mail-changes.test.mjs`. Expected: FAIL, no such table `mail_changes`.
- [ ] **Step 3: Write the migration.** Triggers `mail_changes_messages_ai`, `_au` (`AFTER UPDATE OF mailbox_id, folder_id, category, status, read, starred, snoozed_until, subject, snippet, thread_id, from_addr, to_addr, text_body, html_body`), `_au_moved`, `_ad`, and `mail_changes_labels_ai` / `_ad` on `message_labels` (look the mailbox up from `messages`). `changed_at` is `unixepoch()`. Add the journal entry (`idx` 55) and the Drizzle table.
- [ ] **Step 4:** Run the test file, then `npm run db:bundle`. Expected: PASS.
- [ ] **Step 5: Measure the write cost.** In the same test file add `bulk read of 5000 messages stays within twice the baseline`: time `UPDATE messages SET read=1` over 5,000 rows with the new triggers dropped and with them present; assert the ratio is below 2.0 and log both timings. If it fails, stop and report; do not loosen the bound.
- [ ] **Step 6: Commit** `Record per-message changes for device sync`.

### Task 2: Device sessions and app sign-in

**Files:**
- Create: `drizzle/migrations/0086_device_sessions.sql`, `src/app/api/app/login/route.ts`, `src/app/api/app/login/mfa/route.ts`, `src/lib/auth/device-session.ts`, `src/lib/auth/device-session-types.d.ts`
- Modify: `src/db/schema/index.ts` (sessions), `src/lib/auth/session.ts`, `src/lib/validators.ts`, journal
- Test: `tests/app-login.test.mjs`

**Interfaces:**
- Produces: `sessions.kind TEXT NOT NULL DEFAULT 'web'` (`'web' | 'device'`), `sessions.device_name TEXT`, `sessions.last_used_at INTEGER`.
- Produces: `createDeviceSession(env, userId: string, deviceName: string): Promise<string>` (90 days).
- Produces: `POST /api/app/login` body `{ email, password, deviceName }` → `200 { ok: true, token, user: { id, email, name, role } }` or `200 { ok: true, mfaRequired: true, challengeToken }`; `POST /api/app/login/mfa` body `{ challengeToken, code, deviceName }` → `200 { ok: true, token, user }`. Errors keep the wording and statuses of the web routes (400, 401, 403, 429 with `Retry-After: 60`). Neither route sets a cookie.

- [ ] **Step 1: Write the failing tests:**
  - `password sign-in returns a device session`: token works as `Authorization: Bearer` on `GET /api/auth/me`; the row has `kind='device'`, `device_name='iPhone von Test'`, `expires_at` 90 days ahead; response has no `Set-Cookie`.
  - `second factor is required when enabled`: first call returns `mfaRequired` and no token; `/mfa` with a valid TOTP returns one.
  - `wrong password is 401`, `disabled account is 403`, `sixth attempt in a minute is 429` (same limiter as web).
  - `a device session renews itself`: set `expires_at` to 80 days ahead, call `getUserFromSession`, `expires_at` is 90 days ahead again and `last_used_at` is set; with 85 days left it is not written.
  - `a web session does not renew`.
  - `password change ends device sessions` (`deleteUserSessions`).
  - `Turnstile installations require Access`: with `TURNSTILE_SECRET_KEY` set and no valid `Cf-Access-Jwt-Assertion`, the route answers `403 { error: "App sign-in requires Cloudflare Access" }`.
- [ ] **Step 2:** Run `node --test tests/app-login.test.mjs`. Expected: FAIL, routes missing.
- [ ] **Step 3: Implement.** `DEVICE_SESSION_DAYS = 90`, renew when fewer than 83 days remain (one write a week at most), inside `getUserFromSession` and `getSessionFromToken`. `deviceName` is trimmed, 1 to 80 characters. The Access check for Turnstile installations uses `inspectAccessIdentity` from `src/lib/mcp/access-identity.ts` and accepts the statuses `verified` and `not_user_identity` (a service token is not a user). Record `auth.login` activity with the device name.
- [ ] **Step 4:** Run the test file and `tests/auth-browser-session.test.mjs`, `tests/account-switch.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `Add device sessions and app sign-in`.

### Task 3: Sync route

**Files:**
- Create: `src/app/api/app/sync/route.ts`, `src/lib/app-sync/sync.ts`, `src/lib/app-sync/cursor-utils.ts`, `src/lib/app-sync/sync-types.d.ts`, `src/lib/app-sync/prune.ts`
- Modify: `src/app/api/messages/route.ts` and `src/app/api/messages/utils.ts` (move the row enrichment that builds `enrichedRows` into an exported `enrichMessageRows(...)` so both routes use it), `worker.ts` (call `pruneMailChanges` on the `0 2 * * *` cron)
- Test: `tests/app-sync.test.mjs`

**Interfaces:**
- Consumes: `mail_changes` (Task 1), Bearer session auth (`getCurrentUser`), `listAccessibleMailboxIds`.
- Produces: `GET /api/app/sync?cursor=<string>&days=<7..90, default 30>&limit=<1..200, default 100>` →

```ts
type AppSyncResponse = {
	cursor: string;            // opaque; send back unchanged
	more: boolean;             // call again immediately
	reset: boolean;            // client must drop its data and call again without a cursor
	mailboxIds: string[];      // every mailbox the user may read now
	messages: AppSyncMessage[]; // same fields as a row of GET /api/messages, ungrouped
	removed: string[];         // message ids to delete locally
};
```

- Produces: `encodeCursor` / `decodeCursor` for `{ v: 1, seq: number, days: number, backfill: { createdAt: number, id: string } | null }`, base64url JSON. `pruneMailChanges(env, now): Promise<number>` deletes rows older than 45 days.

Behaviour the tests pin:
- No cursor: remember the current highest `seq`, return the newest page of messages from the last `days` days across all readable mailboxes (order `created_at desc, id desc`), `more: true` and a cursor with `backfill` set until the window is exhausted. Statuses included: all of them, drafts and trash too.
- Cursor without `backfill`: return changes with `seq` greater than the cursor's, restricted to readable mailboxes, de-duplicated per message. A message that still exists and is readable goes to `messages`, otherwise its id goes to `removed`. Changed messages older than the window are still returned.
- `reset: true` (and nothing else) when the cursor cannot be decoded, when `days` differs from the cursor's, or when `cursor.seq` is lower than the lowest stored `seq` minus one while rows have been pruned.

- [ ] **Step 1: Write the failing tests:** `first sync pages through 30 days newest first` (250 messages, limit 100, three calls, no duplicates, 31-day-old message absent); `changes made during the first sync arrive afterwards`; `read, move and delete arrive as changed and removed`; `another user's mailbox never appears` and its changes do not show in `removed`; `revoked shared mailbox drops from mailboxIds`; `stale cursor asks for a reset` (prune, then old cursor); `garbage cursor asks for a reset`; `unauthenticated is 401`; `more than 100 readable mailboxes still works` (D1's 100-parameter limit, see the fixture's bind guard); `prune keeps 45 days`.
- [ ] **Step 2:** Run `node --test tests/app-sync.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `sync.ts` and the route. Extract `enrichMessageRows` first and keep `tests/conversation-page.test.mjs` and `tests/message-filters.test.mjs` green.
- [ ] **Step 4:** Run the new file plus `node --test --test-concurrency=2 tests/*.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the device sync route`.

### Task 4: iOS project skeleton

**Files:**
- Create: `ios/project.yml`, `ios/Mailflare.xcodeproj` (generated, committed), `ios/Mailflare/MailflareApp.swift`, `ios/Mailflare/Localizable.xcstrings`, `ios/Mailflare/Assets.xcassets` (app icon from `public/icon-512.png`, accent colour), `ios/MailflareKit/Package.swift`, `ios/MailflareKit/Sources/MailflareKit/MailflareKit.swift`, `ios/MailflareKit/Tests/MailflareKitTests/SmokeTests.swift`, `ios/README.md`
- Modify: `.gitignore` (`ios/**/xcuserdata/`, `ios/**/.build/`, `ios/DerivedData/`), `eslint.config.mjs` and `tsconfig.json` only if they pick up `ios/`

**Interfaces:**
- Produces: app target `Mailflare`, bundle id `de.stepo.mailflare` (placeholder until the developer account's id is supplied; one line in `project.yml`), deployment target iOS 26.0, Swift 6 language mode, local package `MailflareKit` with GRDB 7 as its only dependency. Test command: `cd ios/MailflareKit && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`. Build command: `DEVELOPER_DIR=… xcodebuild -project ios/Mailflare.xcodeproj -scheme Mailflare -destination 'generic/platform=iOS Simulator' build`.

- [ ] **Step 1:** Write `SmokeTests.swift` asserting `MailflareKit.version == "0.1.0"`; run `swift test`. Expected: FAIL, no package.
- [ ] **Step 2:** Create the package, `project.yml` and a root view that shows the app name; run `xcodegen generate --spec ios/project.yml`.
- [ ] **Step 3:** Run both commands above. Expected: tests PASS, `BUILD SUCCEEDED`. Run `npm run lint` and `npx tsc --noEmit --incremental false` to confirm the web checks ignore `ios/`.
- [ ] **Step 4: Commit** `Add the iOS project skeleton`.

### Task 5: Access, sign-in and the API client

**Files:**
- Create in `ios/MailflareKit/Sources/MailflareKit/`: `API/APIClient.swift`, `API/APIError.swift`, `API/Endpoints.swift`, `API/Models.swift`, `Account/Credentials.swift`, `Account/CredentialStore.swift`, `Account/KeychainCredentialStore.swift`
- Test: `Tests/MailflareKitTests/APIClientTests.swift`, `CredentialStoreTests.swift`, `Support/StubURLProtocol.swift`

**Interfaces:**
- Produces:

```swift
public struct ServerAccess: Codable, Equatable, Sendable { public var baseURL: URL; public var accessClientId: String; public var accessClientSecret: String }
public struct AccountCredentials: Codable, Equatable, Sendable { public var userId: String; public var email: String; public var name: String; public var sessionToken: String }
public protocol CredentialStore: Sendable {
	func loadAccess() throws -> ServerAccess?; func saveAccess(_: ServerAccess?) throws
	func accounts() throws -> [AccountCredentials]; func save(_: AccountCredentials) throws; func removeAccount(userId: String) throws
}
public enum APIError: Error, Equatable { case offline, accessDenied, signedOut, notFound, rateLimited(retryAfter: Int), server(status: Int, message: String?), decoding }
public enum SignInResult: Equatable { case signedIn(AccountCredentials), secondFactor(challengeToken: String) }
public final class APIClient: Sendable {
	public init(access: ServerAccess, sessionToken: String?, session: URLSession = .shared)
	public func checkAccess() async throws                      // GET /api/push/config or another cheap route; proves the service token
	public func signIn(email: String, password: String, deviceName: String) async throws -> SignInResult
	public func verifySecondFactor(challengeToken: String, code: String, deviceName: String) async throws -> AccountCredentials
	public func sync(cursor: String?, days: Int, limit: Int) async throws -> SyncPage
	public func message(id: String) async throws -> MessageDetail
	public func mailboxes() async throws -> [MailboxInfo]
	public func folders(mailboxId: String) async throws -> [FolderInfo]
	public func counts(mailboxId: String?) async throws -> MailCounts
	public func messages(mailboxId: String?, status: String, before offset: Int, limit: Int) async throws -> [MessageRow]
	public func attachment(messageId: String, attachmentId: String) async throws -> URL   // downloaded temp file
	public func signOut() async throws
}
```

`MessageRow`, `MessageDetail`, `MailboxInfo`, `FolderInfo`, `MailCounts`, `SyncPage` mirror the JSON of the routes named in Task 3 and of `/api/messages/[id]`, `/api/mailboxes`, `/api/folders`, `/api/messages/counts`. Read each route to get the field list; unknown fields are ignored, missing optional fields decode as `nil`.

- [ ] **Step 1: Write the failing tests** with `StubURLProtocol`:
  - `every request carries the Access headers and the bearer token`.
  - `a redirect to cloudflareaccess.com is accessDenied`; `an HTML body with status 200 is accessDenied`; `403 from Access is accessDenied` (Review Focus 1). Redirects are not followed.
  - `401 from Mailflare is signedOut`; `429 carries Retry-After`; `no connection is offline`; `malformed JSON is decoding`.
  - `sign-in maps mfaRequired to secondFactor`; `sync decodes a recorded response` (fixture JSON taken from the Task 3 test output); `a row with unknown fields still decodes`.
  - `the in-memory credential store round-trips access and two accounts`.
- [ ] **Step 2:** Run `swift test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `KeychainCredentialStore` uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; it is compiled for iOS only and covered by the in-memory double in tests.
- [ ] **Step 4:** Run `swift test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the Mailflare API client for iOS`.

### Task 6: On-device store

**Files:**
- Create: `Store/MailStore.swift`, `Store/Schema.swift`, `Store/Records.swift`, `Store/MailQueries.swift`
- Test: `Tests/MailflareKitTests/MailStoreTests.swift`

**Interfaces:**
- Produces:

```swift
public final class MailStore: Sendable {
	public static func open(userId: String, directory: URL) throws -> MailStore   // one database file per account, file protection completeUntilFirstUserAuthentication
	public static func inMemory() throws -> MailStore
	public func apply(_ page: SyncPage) throws                 // upsert messages, delete removed, store cursor, in one transaction
	public func reset() throws                                  // drop mail data and cursor, keep settings
	public func cursor() throws -> String?
	public func replaceMailboxes(_: [MailboxInfo], folders: [FolderInfo], counts: MailCounts) throws
	public func saveBody(_ detail: MessageDetail) throws
	public func messagesNeedingBody(newerThan: Date, limit: Int) throws -> [String]
	public func observeList(_ scope: ListScope) -> AsyncStream<[MessageRow]>     // GRDB ValueObservation
	public func observeMessage(id: String) -> AsyncStream<StoredMessage?>
	public func observeMailboxes() -> AsyncStream<MailboxTree>
	public func thread(of messageId: String) throws -> [MessageRow]
	public func lastSync() throws -> Date?
	public func trimBodies(olderThan: Date) throws -> Int        // keep rows, drop bodies and cached attachments
	public static func destroy(userId: String, directory: URL) throws
}
public struct ListScope: Hashable, Sendable { public var mailboxId: String?; public var folder: SystemFolder; public var category: MailCategory?; public var folderId: String?; public var unreadOnly: Bool; public var conversations: Bool }
public enum SystemFolder: String, Sendable { case inbox, starred, snoozed, scheduled, sent, drafts, archived, spam, trash, all }
```

The folder rules must match the server's (`src/lib/messages/folder-params.ts`): inbox is `status = received`, not snoozed into the future, category filter only in the inbox, and so on. Read that file and port its predicate table.

- [ ] **Step 1: Write the failing tests:** `apply upserts and removes in one transaction`; `applying the same page twice changes nothing` (Review Focus 4); `inbox scope excludes snoozed, spam, trash and other categories`; `conversation scope returns one row per thread with the newest message and the unread count`; `starred scope spans folders`; `a second account's store is a separate file`; `reset keeps settings`; `trimBodies keeps the list row`; `observeList emits after apply`.
- [ ] **Step 2:** Run `swift test`. Expected: FAIL.
- [ ] **Step 3: Implement** with GRDB migrations (`v1`). Tables: `mailbox`, `folder`, `message`, `message_body`, `attachment`, `message_label`, `setting`, `sync_state`. Indexes on `(mailbox_id, status, created_at desc)` and `(thread_id)`.
- [ ] **Step 4:** Run `swift test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the on-device mail store`.

### Task 7: Sync engine

**Files:**
- Create: `Sync/SyncEngine.swift`, `Sync/SyncStatus.swift`, `Sync/Reachability.swift`
- Test: `Tests/MailflareKitTests/SyncEngineTests.swift`, `Support/FakeServer.swift`

**Interfaces:**
- Consumes: `APIClient` through a protocol `MailAPI` (extract it in this task so `FakeServer` can stand in), `MailStore`.
- Produces:

```swift
public enum SyncStatus: Equatable, Sendable { case idle(last: Date?), syncing(firstRun: Bool), offline(last: Date?), accessDenied, signedOut, failed(message: String) }
public actor SyncEngine {
	public init(api: MailAPI, store: MailStore, settings: SyncSettings)
	public func syncNow() async            // coalesces concurrent calls into one run
	public func fetchBody(messageId: String) async throws -> StoredMessage
	public nonisolated var status: AsyncStream<SyncStatus> { get }
}
public struct SyncSettings: Sendable { public var days: Int = 30; public var autoAttachmentBytes: Int = 5_000_000; public var attachmentsOnWiFiOnly: Bool = true }
```

- [ ] **Step 1: Write the failing tests** against `FakeServer` (an in-memory model of mailboxes, messages and a change log that serves the Task 3 contract):
  - `first run stores 30 days and is usable after the first page` (the list observation emits before the last page).
  - `a second run fetches only changes`; `a removed message disappears`; `a read flag set on the server arrives`.
  - `reset from the server clears the store and resyncs without duplicates` (Review Focus 2).
  - `a changed mailbox set clears the store and resyncs` (Review Focus 3), for both a revoked and a newly shared mailbox.
  - `a run killed after page two resumes at page three` (throw from the fake after two pages, start a new engine on the same store; Review Focus 4).
  - `bodies are fetched for the window, newest first, and failures do not stop the run`.
  - `offline leaves the store untouched and reports offline with the last sync time`; `accessDenied and signedOut surface as statuses, and signedOut does not delete data by itself` (the app decides).
  - `two simultaneous syncNow calls make one server pass`.
- [ ] **Step 2:** Run `swift test`. Expected: FAIL.
- [ ] **Step 3: Implement.** After each run: refresh mailboxes, folders and counts, then fetch missing bodies in batches of 20 with at most 4 concurrent requests, then `trimBodies(olderThan: window)`. Attachments are not downloaded by the engine in this stage beyond their metadata; the reader fetches on demand and honours `SyncSettings`.
- [ ] **Step 4:** Run `swift test`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the sync engine`.

### Task 8: Setup and sign-in screens

**Files:**
- Create in `ios/Mailflare/`: `App/AppModel.swift`, `App/RootView.swift`, `Setup/ServerSetupView.swift`, `Setup/AccessKeyView.swift`, `Setup/AccessKeyScanner.swift`, `Setup/SignInView.swift`, `Setup/SecondFactorView.swift`, `Support/Haptics.swift`
- Test: `ios/MailflareTests/AppModelTests.swift`, `ios/MailflareTests/AccessKeyParsingTests.swift` (add the test target to `project.yml`)

**Interfaces:**
- Consumes: `APIClient`, `CredentialStore`, `MailStore`, `SyncEngine`.
- Produces: `@Observable final class AppModel` with `phase: .needsServer | .needsAccessKey | .needsSignIn | .ready(AccountSession)`, `accounts`, `switchAccount(userId:)`, `signOut(userId:)` (deletes that account's store and credentials), `handleSignedOut(userId:)` (spec: a 401 wipes the local data of that account and shows sign-in). `parseAccessKey(_ scanned: String) -> (id: String, secret: String)?` accepts `mailflare-access:<id>:<secret>` and a JSON object `{"clientId","clientSecret"}`. `Haptics.play(_ kind: .selection | .success | .warning | .error | .impact)` honours the app setting `haptics.enabled`.

- [ ] **Step 1: Write the failing tests:** `phase follows stored credentials`; `a rejected access key stays on the key screen with the reason`; `second factor step appears only when asked`; `signing out one of two accounts keeps the other and deletes only its store`; `handleSignedOut wipes and returns to sign-in`; `parseAccessKey accepts both formats and rejects others`.
- [ ] **Step 2:** Run `xcodebuild test -scheme Mailflare -destination 'platform=iOS Simulator,name=iPhone 17'`. Expected: FAIL.
- [ ] **Step 3: Build the screens.** Server address field normalises to `https://`. The key screen offers paste, typing and QR scan (`DataScannerViewController`; add `NSCameraUsageDescription`). Device name defaults to `UIDevice.current.name`. Errors are shown in the user's language from `APIError`.
- [ ] **Step 4:** Run the tests, then walk through setup in the simulator against `npm run dev` with seeded data (`npm run db:seed`); local dev has no Access, so any key passes. Take screenshots of all four screens in light and dark.
- [ ] **Step 5: Commit** `Add setup and sign-in to the iOS app`.

### Task 9: Mailboxes and message list

**Files:**
- Create: `Mail/MailboxListView.swift`, `Mail/MailboxListModel.swift`, `Mail/MessageListView.swift`, `Mail/MessageListModel.swift`, `Mail/MessageRowView.swift`, `Mail/CategoryBar.swift`, `Mail/SyncStatusLabel.swift`, `Mail/AccountSwitcher.swift`, `Mail/DateFormatting.swift`
- Test: `ios/MailflareTests/MessageListModelTests.swift`, `DateFormattingTests.swift`, `SyncStatusLabelTests.swift`

**Interfaces:**
- Consumes: `MailStore.observeMailboxes/observeList`, `SyncEngine.status/syncNow`, `APIClient.messages(...)` for mail older than the window.
- Produces: `MessageListModel(scope: ListScope, store:, engine:, api:)` with `rows`, `status`, `refresh() async`, `loadOlder() async`, `olderState: .idle | .loading | .end | .needsNetwork`.

Layout (spec, variant "wie Apple Mail"): root list of mailboxes and system folders with unread counts, then own folders, then Kalender, Drive, Einstellungen and, for admins, Verwaltung. List screen: large title, search field (disabled with the hint "Suche kommt in einer späteren Version" until stage 5), category chips in the inbox only, rows with sender, subject, snippet, time, unread dot, star and paperclip, bottom bar with filter (Alle / Ungelesen), status text and a compose button that is disabled until stage 3.

- [ ] **Step 1: Write the failing tests:** `status text`: `Gerade aktualisiert` within a minute, `Aktualisiert vor 5 Min.`, `Offline · Stand 09:14`, `Erster Abgleich läuft …`, `Zugangsschlüssel abgelehnt`; `row time`: today as `09:12`, yesterday as `Gestern`, this week as weekday, older as date, in `de` and `en`; `loadOlder asks the server past the window and reports needsNetwork when offline`; `unread filter narrows the scope`; `conversation setting switches the scope`.
- [ ] **Step 2:** Run `xcodebuild test …`. Expected: FAIL.
- [ ] **Step 3: Build the views.** `NavigationSplitView` is not used; a `NavigationStack` rooted at the mailbox list opens straight into the last used list. Pull to refresh calls `refresh()` and plays `Haptics.play(.impact)` when it triggers. Rows carry one combined VoiceOver label.
- [ ] **Step 4:** Run the tests; in the simulator check the inbox with seeded data, then switch the Mac's network off and relaunch the app: the list must appear with the offline status. Screenshot both.
- [ ] **Step 5: Commit** `Add mailboxes and the message list`.

### Task 10: Reader

**Files:**
- Create: `Reader/MessageView.swift`, `Reader/MessageModel.swift`, `Reader/MailBodyView.swift` (WKWebView wrapper), `Reader/MailHTML.swift`, `Reader/QuotedText.swift`, `Reader/AttachmentRow.swift`, `Reader/AttachmentPreview.swift` (Quick Look), `Reader/SenderWarningBanner.swift`
- Create in MailflareKit: `Content/MailHTMLSanitizer.swift`, `Content/QuoteSplitter.swift`
- Test: `MailflareKit/Tests/MailflareKitTests/MailHTMLSanitizerTests.swift`, `QuoteSplitterTests.swift`, `ios/MailflareTests/MessageModelTests.swift`

**Interfaces:**
- Consumes: `MailStore.observeMessage/thread`, `SyncEngine.fetchBody`, `APIClient.attachment`.
- Produces: `MailHTMLSanitizer.document(html: String?, text: String?, allowRemoteContent: Bool, colorScheme:) -> String` (a full HTML page with a strict CSP); `QuoteSplitter.split(html:) -> (visible: String, quoted: String?)` matching `splitQuotedHtml` in the web reader (read `src/components/messages/` for the markers `wrapQuotedHtml` writes).

- [ ] **Step 1: Write the failing tests** (Review Focus 5):
  - `scripts, event handlers, forms, iframes, object and meta refresh are removed`.
  - `javascript: and data:text/html links are neutralised`; `mailto: and https: links survive`.
  - `remote images are replaced by placeholders unless allowed; cid: and data:image stay`.
  - `the page carries a CSP with default-src 'none' and img-src limited to data: (plus https: when allowed)`.
  - `plain text is escaped and line breaks kept`; `an empty body shows the snippet`.
  - `quote splitter folds wrapQuotedHtml output and leaves other mail whole`.
  - `opening a message without a stored body fetches it; offline shows "Wird geladen, sobald du wieder online bist"`.
- [ ] **Step 2:** Run both test commands. Expected: FAIL.
- [ ] **Step 3: Build.** The web view has JavaScript disabled (`allowsContentJavaScript = false`), a non-persistent data store, and a navigation delegate that cancels every navigation except the initial load: `https:` links open in `SFSafariViewController`, `mailto:` is ignored until stage 3. Height follows content. The remote-content default comes from `GET /api/settings` (external content setting), with a per-message "Bilder laden" button. The sender warning uses the fields the server already sends on the detail response; if the detail has none, omit the banner and note it in the task report. Attachments at or under 5 MB download automatically on Wi-Fi, otherwise on tap, then open in Quick Look. Earlier messages of the thread are collapsed rows above the open one.
- [ ] **Step 4:** Run the tests; in the simulator open a plain-text mail, an HTML newsletter, a mail with a PDF, and a three-message thread from seeded data. Screenshot each, light and dark.
- [ ] **Step 5: Commit** `Add the message reader`.

### Task 11: Web view for the rest, app settings, staying current

**Files:**
- Create: `Web/WebAreaView.swift`, `Web/WebSession.swift`, `Settings/AppSettingsView.swift`, `Settings/AccessSettingsView.swift`, `Sync/RealtimeListener.swift` (MailflareKit), `App/BackgroundRefresh.swift`
- Modify: `ios/project.yml` (background mode `fetch`, `BGTaskSchedulerPermittedIdentifiers`)
- Test: `MailflareKit/Tests/MailflareKitTests/RealtimeListenerTests.swift`, `ios/MailflareTests/WebSessionTests.swift`

**Interfaces:**
- Consumes: `ServerAccess`, `AccountCredentials`, `SyncEngine`.
- Produces: `WebSession.prepare(for: WKWebsiteDataStore) async throws` puts an `ep_session` cookie and the Access cookie in the store; `RealtimeListener(access:sessionToken:onChange:)` connects to `/api/realtime` with the Access and bearer headers, calls `onChange` on `new_message` and on `revision` with `changed == true`, and reconnects with backoff 1, 2, 4 … 60 s.

- [ ] **Step 1: Spike first, on the live installation with a real service token** (needs the owner to create the Service Auth policy and one token; ask and wait). Establish and write down in `docs/ios-app.md`: (a) whether a request with the service-token headers returns a `CF_Authorization` cookie that a `WKWebView` can then use for a whole page load, and (b) whether `/api/realtime` accepts the bearer token (today `worker.ts` reads the session with `getSessionTokenFromRequest` and checks the origin with `hasValidSessionMutationOrigin`; extend both for bearer requests if needed, with a test in `tests/`). If (a) fails, stop and report: the fallback in the spec (a small in-app relay) is a new decision for the owner.
- [ ] **Step 2: Write the failing tests:** `prepare sets both cookies for the server's host only, secure and httpOnly`; `the listener calls onChange for new_message and changed revisions, not for ping`; `it reconnects after a drop with growing delays`.
- [ ] **Step 3: Build.** Kalender, Drive, Einstellungen (web part) and Verwaltung open `WebAreaView` at `/calendar`, `/drive`, `/settings`, `/admin` without an address bar and with a close button. App settings: Offline-Zeitraum (7, 14, 30, 60, 90 days), Anhänge automatisch laden (on/off, Wi-Fi only), Haptik, Zugang (server, key, replace key), accounts with sign-out. Sync triggers: launch, return to foreground, pull, realtime, and `BGAppRefreshTask` (`de.stepo.mailflare.refresh`).
- [ ] **Step 4:** Run all tests; in the simulator receive a seeded message while the list is open and confirm it appears without pulling.
- [ ] **Step 5: Commit** `Add the web areas, app settings and live updates`.

### Task 12: Documentation and stage check

**Files:**
- Create: `docs/ios-app.md`
- Modify: `CLAUDE.md` (a short "iOS app" section under Architecture: where the code lives, the `/api/app/` routes, the change log and its triggers, the test commands), `docs/operations.md` (migration order: `0085`, `0086` before the code)

- [ ] **Step 1:** Write `docs/ios-app.md`: creating the Service Auth policy and one service token per device, first start, what is stored where on the phone, how to end a device session, build and test commands, and the list of things only a real iPhone can prove.
- [ ] **Step 2:** Run `npm run check:quality`, `swift test`, and `xcodebuild test`. Expected: all green. Paste the summaries into the task report.
- [ ] **Step 3: Offline walk-through in the simulator:** fresh install, setup, wait for "Gerade aktualisiert", quit, cut the network, relaunch, open five messages from different folders. Every one must show its content. Record a screenshot of each.
- [ ] **Step 4:** Report explicitly what was not tested: a physical iPhone, real Access with a service token beyond the Task 11 spike, haptics, background refresh timing.
- [ ] **Step 5: Commit** `Document the iOS app and its setup`.

---

## Not in this stage

Mail actions and the offline queue (stage 2), compose and the outbox (stage 3), `app_devices` and APNs (stage 4), search and TestFlight (stage 5), native settings (block 2). The disabled search field and compose button are placeholders for those stages and must say so.
