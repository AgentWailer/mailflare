# CLAUDE.md

This file provides repository implementation guidance. For current deployment, migration order, recovery and OAuth procedures, start with [docs/operations.md](docs/operations.md). Follow AGENTS.md and the user's authorized scope; dated design notes do not override them.

## Commands

```bash
npm run dev                    # Vite + vinext in local workerd
npm run lint                   # eslint (next/core-web-vitals + next/typescript)
npm run build                  # vinext build, including the complete Worker
npm run check:quality          # migrations bundle + types + lint + full ordinary tests + build
npm run test:smoke             # sequential browser journeys using synthetic data

npm run db:generate            # drizzle-kit generate from src/db/schema/index.ts
npm run db:migrate:local       # wrangler d1 migrations apply DB --local
npm run db:migrate:remote      # --remote (needs a concrete database_id in wrangler.jsonc)
npm run db:seed                # POST /api/seed against localhost:3000

npm run deploy                 # quality-gated manual deployment; migration prerequisites first
npm run preview                # build and preview the vinext Worker locally
npm run cf-typegen             # regenerate cloudflare-env.d.ts from wrangler.jsonc
```

Run the ordinary suites with `node --test --test-concurrency=2 tests/*.test.mjs`
or use `npm run check:quality`. Tests can exercise D1-compatible local SQLite and
mock/local R2 bindings with the actual migrations. They must not require or
mutate production resources. Browser suites use the built application with
synthetic API fixtures; run them sequentially because previews share runtime
resources. Keep realistic permission, interruption, retry and data-volume cases.
Avoid tests that only match source-code constants instead of observable behavior.

A successful Vite/Next build is not a substitute for TypeScript validation.
`check:quality` includes `tsc --noEmit --incremental false` and lint. Preserve
that boundary rather than suppressing diagnostics to obtain a green build.

`npm run deploy` runs the quality gate before uploading with Wrangler. For this Git-connected installation, use the existing reviewed Git/Cloudflare release path and verify its configured checks. Apply required backward-compatible additive migrations before code that references their columns; do not rely on a deploy-first Admin migration when the reader would already fail. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to it, preserving the custom `worker.ts` entrypoint.

## Architecture

Next-compatible App Router APIs run on Cloudflare Workers via Vite/Vinext. Drizzle ORM uses D1; private R2 holds live raw MIME and attachments, while the separate `RESCUE_BUCKET` holds the encrypted rescue copy. Queues process asynchronous mail/jobs, a Durable Object provides realtime, and cron recovers jobs and checks the configured backup schedule. Node/Docker remains a separate runtime.

### worker.ts is the entrypoint

`worker.ts` wraps `vinext/server/fetch-handler` and adds handlers Next.js cannot express:

- **`fetch`** — intercepts `/api/realtime` for the WebSocket upgrade (authenticates the session cookie, then routes to `env.REALTIME.getByName(user.id)`), delegating everything else to vinext.
- **`email`** — the Cloudflare Email Routing handler. Resolves domain routing rules first (`resolveIncomingMail` in `src/lib/email/incoming.ts`) because `message.setReject()` and `message.forward()` only exist here, then applies optional account-level forwarding (loop-guarded by the `MAILFLARE_FORWARDED_HEADER`), writes raw MIME to R2, and enqueues to `INBOUND_QUEUE`. Full ingestion and persistence run in the queue; the live handler also enforces the inbound raw/attachment size policy before enqueueing.
- **`queue`** — a shared handler for the configured inbound, outbound and agent queues; payload guards and explicit `kind` checks dispatch mail, webhook retries, backups, imports, sorting, Paperless, bulk and AI work. Unknown kinds are rejected, never treated as outgoing mail. Failures use bounded queue retries and the configured dead-letter destination; do not blindly replay uncertain deliveries.

It also re-exports `RealtimeHub`, which must remain exported from the Worker entrypoint.

### Mail pipeline

Inbound: `email` handler → R2 → queue → `processInboundMessage` (`src/lib/email/inbound.ts`) → `resolveInboundAddress` routing decision (deliver / reject / forward) → `parseRawMime` (postal-mime) → insert message + attachments → upsert contacts → `dispatchWebhooks` → `notifyUsersOfNewMessage` over the Durable Object.

Outbound: `src/lib/email/send.ts` / `sender.ts`, composing with mimetext and sending through the `EMAIL` send_email binding, with `outbound_jobs` rows tracking queued sends. `to`, `cc` and `bcc` accept a header string or an array; `toAddr`/`ccAddr`/`bccAddr` on `messages` store the full comma-joined lists (use `splitEmailAddressList` from `src/lib/email/address.ts`, not `getEmailAddress`, when a value may be a list).

Composer: `src/components/compose/rich-text-editor.tsx` is a contentEditable HTML editor; the body is one HTML string and the text/plain part is derived with `htmlToPlainText` (`rich-text-utils.ts`). Quoted/forwarded content is wrapped by `wrapQuotedHtml` and folded by both the composer and the reader (`splitQuotedHtml`). Forward copies the source's attachments onto the draft (`copyMessageAttachments`); `/api/send` with `draftId` sends them.

Recipients: `recipient-fields.tsx` owns the To, Cc and Bcc lines. A chip moves between them by dragging (pointer events, with a 300 ms hold on touch so a swipe still scrolls) or from its menu; all moves go through the pure `moveRecipient` (`recipient-utils.ts`). Suggestions while typing come from one ranked address book per composer session, `GET /api/compose/recipients` (`src/lib/contacts/recipient-directory*.ts`): the user's contacts plus everyone they sent mail to, most written-to first, without blocked contacts and own addresses, filtered on the device by `recipient-match.ts`. The assistant's `find_contacts` tool reads the same book. Anything shown on a chip or taken from a `mailto:` link must be the address the mail goes to: a display name written as an address is never shown as the label (`getRecipientLabel`), and links yield bare addresses only (`mailto-utils.ts`).

Before a message goes, `getSendWarnings` (`send-warnings-utils.ts`) asks about a lookalike of a known correspondent, five or more outsiders at two or more domains who would see each other in To/Cc (offering to move them to Bcc), and a mentioned but missing attachment. "Known" means written to or kept as a contact, never merely received from, so a lookalike does not become known by writing first. The reader applies the same comparison to senders (`src/components/messages/sender-warnings-utils.ts`, `SenderWarningBanner`). The comparison helpers live in `src/lib/email/confusables.ts`; keep them linear in their input.

Undo send is a short scheduled delivery, not a client-side delay: the composer posts `undoSeconds`, `/api/send` passes it to `sendEmail`, which starts the window on the server clock once the attachments are stored (so a slow upload does not use it up) and returns `undoUntil`; the route adds `undoRemainingMs`, and the offer lasts exactly that long, never the browser's own count. Undo calls the existing `cancel-schedule`, which returns the message to Drafts unless delivery already claimed it. The offers (one per waiting message) are rendered by `ComposeProvider` so they survive the composer closing. While `/api/send` is under way only the message is locked (`inert`), the window can be closed; the provider then opens no other message until the send has answered (`setSending`), a message asked for meanwhile opens afterwards, and a failure of a send whose window is gone is said in a notice that stays until it is closed (`announceFailure`, shown by `StatusToastHost` above the undo offers). `/api/send` removes the draft a message was sent from itself (its row even when storage refuses to remove a file), so a second request for the same draft finds none; a notice belongs to the signed-in reader and goes when the session changes; the provider's lock lasts until that draft is gone. A composer that holds a message being written reports it (`reportOccupied`): an undone message then stays under Drafts and a mail link opens the page composer in a new tab instead of replacing it. It is off unless chosen in Account settings, because a held message reports delivery problems under Scheduled instead of in the composer.

`/compose?mailto=` (and `?to=&subject=&body=`) start a prefilled message; the manifest's `protocol_handlers` and the Account setting register that address for `mailto:` links, and the reader opens mail links in the composer.

Startup: two things keep the first screen from waiting. The page starts its own data requests: a script in the root layout's head (`earlyRequestsBootstrapScript`, `src/lib/auth/early-requests.ts`) asks for `/api/auth/me`, `/api/mailboxes` and the list this page showed first last time while the application scripts are still loading, and `authFetch(url, { early: true })` hands each answer to the first caller of exactly that address, once, for the same session and time zone, within ten seconds. Only the first unforced read of startup data may pass `early`; a refresh must reach the server. And a Workers build ships each interface language as an immutable script (`/_next/static/locales/<version>/<code>.js`) that the page names instead of carrying the catalogue; English is not in the browser bundle (`docs/localization.md`, *Delivery*). `scripts/benchmark-performance.mjs` holds the budgets for both.

Reader layout: a message is shown in a shadow root (`email-html-renderer.tsx`) and scaled down when it is wider than the reader (`fit-email-to-width.ts`). Its text wraps with `overflow-wrap: break-word`, never `anywhere`: `anywhere` lets a table squeeze a column to one character (a receipt's amount printed one digit per line). A message's own `word-break: break-word` and `overflow-wrap: anywhere`, which do the same and which payment receipts put on every cell, are rewritten for the reader and the printout only, through the CSS parser, to `word-break: normal; overflow-wrap: break-word` (`keepWordsWhole` in `src/lib/email/html.ts`). Strings of 30 and more characters without a space get `<wbr>` break points every few characters, after their own punctuation where there is some (`long-tokens.ts`), so a long link neither widens the message nor shrinks its column to a character. A word made of letters only is left whole up to 45 characters, because a break point also breaks a line the word would have fitted on. A message that would still be scaled below 0.6 (many narrow columns, a string spread over several styled pieces) gets extra break points in its longer words and identifiers (`addRelaxedBreaks`, switched on by `data-email-relaxed`) if that wins the size back; amounts, dates, short words and anything that is mostly digits (an amount with its currency code, a timestamp, an IBAN) stay whole in every case, and `overflow-wrap: anywhere` is not used at all. The verdict is kept per width and asked again when a folded quote is opened. A printout whose table cannot get as narrow as the paper is made smaller (`zoom`) until its last column is on the page (`print-message.ts`). `tests/browser/mail-table-layout.mjs` holds all of this, at every place a text stands, not only the first.

Threading: `resolveThreadId` in `src/lib/email/threading.ts` files an inbound or imported message under the thread of the stored message its `In-Reply-To`/`References` name (matched against `providerMessageId` in the same mailbox); otherwise its own Message-ID seeds a new thread. Outbound replies carry `inReplyTo`/`references`/`threadId` from the draft, and a fresh send is keyed by the Message-ID Cloudflare returns. `/api/messages/[id]/thread` returns the conversation. Lists pass `group=thread` (the "conversation view" toggle, `use-conversation-view.ts`) to get one row per thread plus `threadMessageIds`, which row actions and bulk actions expand to.

### Sending and receiving providers are per domain

`domains.sending_provider` (`none | cloudflare | resend | ses`) and `domains.receiving_provider` (`none | cloudflare | resend | ses`, default `cloudflare`) are chosen independently on the Domains page; DNS stays on Cloudflare either way. They record intent: switching a provider never touches DNS, each provider's own Setup does, and a **Clean up** button removes the config of an unselected provider.

- **Sending** goes through `sendThroughProvider` (`src/lib/email/outbound-provider.ts`), which `deliverEmail` and `sendSystemEmail` call after `getOutboundProviderConfig(env, from)` resolves the provider from the From domain (`none` throws). Cloudflare keeps its 5 MiB link fallback; Resend and SES take attachments directly. Resend and SES return different Message-IDs than we send, so `providerMessageId` stores the one replies will carry (`<id@email.amazonses.com>` or `<id@region.amazonses.com>` for SES).
- **Receiving** from a non-Cloudflare provider enters through `intakeProviderMail` (`src/lib/email/provider-intake.ts`) and then the same `intakeIncomingMail` as everything else, once per recipient on a known domain. Providers cannot be rejected to after accepting, so reject and size limits drop the message, and `forward` is unavailable. Inbound endpoints are public and authenticate themselves: `/api/inbound/resend` verifies the Svix signature (`svix.ts`) with the secret Resend returned when `ensureWebhook` created the hook (`app_settings.resend_webhook_secret`), then fetches the raw MIME from `raw.download_url`; `/api/inbound/ses` is an SNS HTTPS endpoint guarded by a secret token in its URL, the topic ARN and reading the object from our own bucket.
- **Only one MX owner per domain.** `publishMx` (`receiving-dns.ts`) refuses with `MxConflictError` (HTTP 409 `MX_CONFLICT`) when other MX records exist; the UI confirms and retries with `replaceMx`. Cloudflare Worker routes (`ensureMailboxDomainRouting`) are created only for domains whose receiving provider is `cloudflare`.
- **Resend** keeps one key (`app_settings.resend_api_key`, or `RESEND_API_KEY`) and one Resend domain per hostname carrying both capabilities, so sending cleanup disables only `sending` when the domain still receives through Resend and vice versa. Apex MX values matching `inbound-smtp.*.amazonaws.com` are receiving records; everything else is sending.
- **AWS** (`src/lib/aws/`) is a hand-rolled SigV4 client (`sigv4.ts`, verified against AWS's published vectors in `tests/provider-aws-resend.test.mjs`) so it runs on Workers and Node without the SDK. Credentials live in `app_settings.aws_config` (or `AWS_*` env vars) and are validated before saving by `validateAwsConfig`, which proves identity with STS then probes SES, SNS and S3, reporting each missing permission with the IAM policy that grants it. SES sending uses SESv2 (`ses.ts`); receipt rules exist only in SES v1 (Query protocol), so receiving uses `awsQuery`. `setupSesReceiving` creates the S3 bucket and policy, SNS topic, policy and HTTPS subscription, then a per-domain receipt rule in the account's active rule set (creating `mailflare-inbound` only when none is active), and the MX. State is in `app_settings.ses_receiving`. SES inbound exists only in some regions (`SES_RECEIVING_REGIONS`) and needs a public HTTPS `APP_URL`.

### Routing rules have two scopes

`routing_rules.scope` splits two genuinely different mechanisms, and mixing them up is the easy mistake:

- **`domain`** — evaluated by `resolveInboundAddress` (`src/lib/email/routing.ts`) *while resolving the address*, in three phases: `reject` rules first (so a sender can be blocked even when the recipient is a real mailbox), then exact mailbox and alias lookup, then `forward`/`store` catch-all fallbacks. Ordered by descending `priority`, then oldest first. This phase split is what stops a `*` catch-all from shadowing real mailboxes — preserve it.
- **`mailbox`** — evaluated by `resolveInboxRuleDestination` *after* delivery, to pick a folder or move to spam/trash.

Both queries filter on `scope`, so any new rule must set it explicitly. `forward` and `reject` are actioned in `worker.ts`, never in the queue consumer.

### Webhook retries ride the outbound queue

`src/lib/email/webhooks.ts` records every attempt (status, error snippet, duration, `nextRetryAt`) on `webhook_deliveries` and re-enqueues failures onto `OUTBOUND_QUEUE` with a `delaySeconds` backoff rather than adding a third queue binding. `env.d.ts` widens `OUTBOUND_QUEUE` to the union of both payload types accordingly. `runDelivery` is shared by the retry queue and the manual retry endpoint.

### Cloudflare is a live dependency, not just a host

Domain and mailbox management call the Cloudflare API at runtime (`src/lib/cloudflare-api.ts`, `src/lib/domains/`). Adding a domain enables Email Routing DNS and sending subdomains on the zone; creating a mailbox creates a Cloudflare Email Routing rule targeting `CF_EMAIL_WORKER_NAME`; removing a domain cleans those up (`src/lib/domains/cloudflare-cleanup.ts`).

Consequence: `CF_EMAIL_WORKER_NAME`, the deployed Worker `name`, and `services[].service` for `WORKER_SELF_REFERENCE` in `wrangler.jsonc` must all agree. Cloudflare service bindings need a literal name and cannot reference the top-level `name`.

Runtime authentication to the Cloudflare management API is `CF_TOKEN` (preferred) or the legacy `CF_EMAIL` + `CF_API_KEY` pair. These are server-side provider credentials, not user sessions or MCP credentials.

### Schema and the dual-migration gotcha

Schema lives in `src/db/schema/index.ts`; do not hardcode a historical table count in tooling. Migrations are generated into `drizzle/migrations/`. Note that `drizzle-kit generate` currently prompts interactively about a snapshot rename conflict, so recent migrations were hand-written to match the generated style.

`npm run db:bundle` packages the SQL files for the Worker. `/api/setup/prepare` and the admin migration endpoint use the shared runner in `src/lib/migrations/service.ts`; migration files remain the only schema history to maintain. Build, deploy, preview, and development scripts generate the bundle before loading application code.

The setup path only ever initializes an empty database — it refuses to touch one that already has tables.

### Object storage is `env.BUCKET`, from R2, Backblaze B2 or AWS S3

Live blobs (raw MIME, attachments, Drive, avatars, branding icon and JMAP uploads) go through `env.BUCKET` with the R2 API. Legacy record exports also use it. The current encrypted rescue copy uses the independent private R2 `RESCUE_BUCKET`; do not redirect it through the live B2/S3 substitution. `withStorage` (`src/lib/storage/index.ts`) swaps `BUCKET` for `B2Bucket` (`b2-bucket.ts`, S3 API signed with the shared SigV4 client; it serves AWS S3 too) when `getObjectStorageConfig` finds all of `B2_*` (Backblaze, wins) or `S3_BUCKET`/`S3_REGION`/credentials (AWS S3, credentials falling back to `AWS_*`); otherwise the R2 binding (or the Node file bucket) is untouched. It is applied in `getEnv()`, at the top of each `worker.ts` handler (which receive the raw env) and in the Node runtime env. `B2Bucket` implements only what the app calls (`get` with range, `head`, `put`, `delete`, multipart); if new code needs another R2 method, add it there. Do not read `cloudflare:workers` env directly for storage. `GET/POST /api/v1/storage` and the `manage_storage` MCP tool (admin scope `storage`) report and test it.

### Two runtimes, one code path

The Node build aliases `cloudflare:workers` to `server/runtime/cloudflare-workers.ts`, allowing the shared helper to use its existing `getNodeEnv()` fallback. That alias only applies when `MAILFLARE_RUNTIME=node`; vinext uses the native Workers module. Next outputs to `.next-node` so its generated types do not collide with vinext's `.next/types`.

The app reaches every platform service through `getEnv()` (`src/lib/cloudflare.ts`). On Workers that is the native `cloudflare:workers` env. In the self-hosted runtime, `server/index.ts` builds an object with the same shape (`server/runtime/env.ts`: a D1-compatible wrapper over better-sqlite3, an R2-compatible file bucket, `EMAIL` over nodemailer or the Cloudflare Sending REST API, in-process queues, a WebSocket hub standing in for the Durable Object, a fixed-window rate limiter) and publishes it as `globalThis.__mailflareNodeEnv` before Next starts; `getNodeEnv()` in `src/lib/runtime.ts` returns it. Application code must not care which one it got. The few places that must differ check `isNodeRuntime(env)`: setup requirement checks, the self-update button, and domain provisioning, which without Cloudflare credentials records the zone as `"manual"` (`src/lib/domains/provision.ts`) so every Cloudflare call is a no-op and the DNS page lists records to set by hand. Inbound mail off Workers goes through `intakeIncomingMail` (`src/lib/email/intake.ts`) from either the SMTP listener (`server/runtime/smtp.ts`) or the signed `/api/inbound` webhook the relay Worker in `deploy/cloudflare-email-relay` calls. `npm run build:node` builds Next in Node mode and bundles the server with esbuild to `dist/server.mjs`; the Dockerfile runs that. Migrations are applied from `drizzle/migrations` at start (`server/runtime/migrate.ts`), so the first-run empty-database setup wrapper in `src/lib/setup/migration.ts` is not the Node startup path.

### JMAP lives in `src/lib/jmap/`

`handleJmapRequest` (`src/lib/jmap/handler.ts`) owns `/jmap/*` and `/.well-known/jmap`; the Next routes under `src/app/jmap/[[...segments]]` and `src/app/.well-known/jmap` only delegate to it, and it is framework-free so it could be mounted from `worker.ts` too. Auth is an API key with the `jmap` scope via `authenticateApiRequest` (`src/lib/api/key-auth.ts`, the Next-free core that `src/lib/api/auth.ts` now wraps). JMAP Mailbox ids encode `mailboxId`, `mailboxId~role` or `mailboxId~f~folderId` (`ids.ts`); `email-query.ts` maps filters onto `messages` columns, `email-objects.ts` builds Email objects from stored rows (no MIME parsing), and states are digests of counts (`state.ts`), which is why every `/changes` method answers `cannotCalculateChanges`.

`Email/set` create and `Email/import` share one insert (`insertDraft` in `emails.ts`) and one target rule (`resolveDraftsMailbox` in `email-import-utils.ts`): a new message goes into exactly one Drafts mailbox, never Inbox or a folder, because delivered mail is the inbound pipeline's job. `Email/import` parses the uploaded blob with `parseRawMime`, stores the `Message-ID` in `providerMessageId` with its angle brackets (as inbound rows do) and keeps the uploaded bytes at `drafts/<messageId>.eml` in `rawR2Key`, so `readBlob` serves the client's own MIME back instead of the rebuilt minimal message; the `jmap-uploads/` object is deleted once claimed. `Email/copy` and `Email/parse` are still `emailUnsupported`.

`email-query.ts` answers the `header` filter from columns — `Message-ID` from `providerMessageId` (compared with and without angle brackets, since inbound rows store them and outbound rows do not), `In-Reply-To` from `inReplyTo`, `References` by a padded `LIKE` on the space-joined chain. Any other header name throws `unsupportedFilter` (RFC 8620 §5.5). Filter conditions must never be silently dropped: a client that de-duplicates with `header` would otherwise match every message in the mailbox.

### The iOS app lives in `ios/`

A native iPhone app (SwiftUI, Swift 6, iOS 26) with its own guide in `docs/ios-app.md` and its design in `docs/superpowers/specs/2026-11-28-ios-app-design.md`. Stage 1 exists: setup, sign-in, mail of the last 30 days on the device, lists and reader, also offline. Actions, composing, notifications and search are later stages.

- `ios/MailflareKit` is a Swift package without UI: `APIClient` (every request carries the device's Cloudflare Access service token and a bearer session token, never cookies), `MailStore` (one GRDB database per account; its folder rules are a port of `src/lib/messages/list-filter.ts`, so change both together), `SyncEngine`, `RealtimeListener`, and `MailHTML`, which rewrites a message body tag by tag for a web view that runs no JavaScript. `ios/Mailflare` is the app and reads only from the store. `Mailflare.xcodeproj` is generated from `ios/project.yml` by XcodeGen and committed.
- The server side is small: `mail_changes` (migration 0085) is an append-only log written by triggers on `messages` and `message_labels`, pruned after 45 days by the nightly cron; `GET /api/app/sync` (`src/lib/app-sync/`) pages through a window first and then replays the log, answering `reset` when a cursor no longer fits it. `device_sessions` (migration 0086) holds the device of a session created by `POST /api/app/login`; such a session has a `dev_` token, lasts 90 days and renews itself in `getUserFromSession`. Web sign-in must keep working on a database without these tables, so nothing on the web path may read them. Both tables are left out of record backups on purpose.
- The JSON the Swift tests decode is produced from the real routes by `ios/MailflareKit/Tests/MailflareKitTests/Fixtures/generate.mjs`; regenerate it when a route the app reads changes shape. German texts are one table, `ios/tools/strings.py`. `node ios/tools/local-server.mjs` plus the `MailflareUI` scheme walk the app through setup, reading and an offline start in the simulator.
- Swift commands need `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; `xcode-select` points at the command line tools on this machine.

### Password reset and MFA

`reset_email` on `users` is the destination for reset links (`src/lib/auth/password-reset.ts`); links are hashed, single-use, 30 minutes, and redeeming one revokes every session. Reset mail is sent by `sendSystemEmail` (`src/lib/email/system-mail.ts`), which writes straight to the send binding from the first admin mailbox on a sending-enabled domain, so nothing lands in Sent and no webhooks fire. If no domain can send, the request still returns 200 and a warning is logged. TOTP lives in `src/lib/auth/totp.ts` (RFC 6238 over Web Crypto, no dependency); the secret is stored on `users` at enrolment but only counts once `totp_enabled` is set by a verified code. A login with MFA returns `{ mfaRequired, challengeToken }` (`login_challenges`, 5 minutes) instead of a session, and `/api/auth/mfa/verify` finishes it with a TOTP or recovery code. Password changes and admin resets call `deleteUserSessions`.

### Search is an FTS5 index kept by triggers

`messages_fts` (migration 0030) is an external-content FTS5 table over `messages`; three triggers in the same migration keep it in sync on insert, update and delete, so no application code touches the index. `buildSearchConditions` in `src/lib/search/conditions.ts` turns the Gmail-style grammar (`src/lib/search/query-utils.ts`) into a `rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)` predicate plus plain column filters. Migration SQL splitting must keep trigger bodies whole. The backup coverage check skips `messages_fts%`, since the shadow tables are derived and repopulate on restore. Do not treat `wrangler d1 export` as the complete recovery path for a database with virtual tables: use the verified encrypted rescue workflow and empty-target restore described in `docs/rescue-backup.md`.

### Access control

Two independent auth surfaces:

- **Session cookie** (`ep_session`) — `getCurrentUser` / `requireUser` in `src/lib/auth/cookies.ts`, backed by `src/lib/auth/session.ts`. Used by dashboard/admin API routes. `requireUser` *throws*, which Next surfaces as a 500; prefer `requireSessionUser` from `src/lib/api/auth.ts`, which returns a proper 401 response. Most older routes still use `requireUser` and 500 on unauthenticated requests.
- **API key bearer token** — `authenticateApiKey` + `requireScope` in `src/lib/api/auth.ts`, used by the public `/api/v1/*` surface.

Mailbox authorization is separate from user role and goes through `src/lib/mailboxes/access.ts` (`getMailboxAccessLevel`, `listAccessibleMailboxes`, `listAccessibleMailboxIds`), which accounts for ownership, the `mailbox_access` sharing table, and admin role. Message queries scope by accessible mailbox IDs, not by `userId` — see `src/app/api/messages/route.ts` for the canonical pattern.

### Folders are mostly virtual

`messages.status` is a free-text column driving the folder views: `received` (inbox), `sent`, `draft`, `spam`, `trash`, `archived`. Orthogonal to that are `starred`, `snoozedUntil`, and `folderId` (user-created folders in the `folders` table). A "folder" route under `src/app/(dashboard)/` is usually a status filter, not a table.

### Licensing gates branding

Pro/Team keys are validated against Paymug (`src/lib/licenses/`); only a one-way key hash is stored. Without an active license the app falls back to the default name, icon, and favicon, and custom branding is unavailable. `getLicenseEntitlements` is the gate.

### Self-update

The admin overview dispatches `deploy-update.yml` (constant in `src/app/api/admin/update/utils.ts`) in the installation repo, which merges the upstream default branch and pushes it. It does not migrate, build, or deploy; the connected Cloudflare Git integration deploys the push. The admin update card separately reports and applies pending D1 migrations through the Worker binding.

## Conventions

- Tabs for indentation. `@/*` maps to `src/*`.
- Types and pure helpers are split out of components and modules into sibling `*-types.d.ts` and `*-utils.ts` files (41 and 27 of them respectively). Follow this when adding anything non-trivial.
- Server code reaches bindings through `getEnv()` / `getEnvAsync()` in `src/lib/cloudflare.ts`, then `getDb(env)` from `src/db`. Keep binding access centralized here.
- API routes return `NextResponse.json({ error: "..." }, { status })` for failures; there is no shared error envelope helper.
- UI is Tailwind v4 + shadcn/Radix primitives in `src/components/ui/`. `DialogContent` sets no max height, so a tall dialog overflows the viewport with an unreachable submit button — add `max-h-[calc(100vh-4rem)] overflow-y-auto` on any dialog with more than a few fields.
- `cloudflare-env.d.ts` is generated (500KB) — regenerate with `cf-typegen`, never hand-edit.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
