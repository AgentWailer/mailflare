# Mailflare for iOS, Stage 2 (Actions) Implementation Plan

**Goal:** Reading a message marks it read, and mail can be archived, deleted, starred, snoozed, moved and marked from the list and the reader, with swipes and haptics, also without a network.

**Spec:** `docs/superpowers/specs/2026-11-28-ios-app-design.md`, sections "Vormerken ohne Netz" and "Aufbau der App".

**Architecture:** No server change. The app uses the routes the web uses: `POST /api/messages/bulk` (`archive`, `trash`, `spam`, `read`, `unread`, `inbox`, `folder`, `delete`), `POST /api/messages/[id]/star` and `POST`/`DELETE /api/messages/[id]/snooze`. All of them set a state, so repeating one does no harm. An action is applied to the on-device store at once and written to an outbox in the same transaction; the sync engine sends the outbox in order before it pulls changes.

## Rules the tests pin

- An action changes the stored rows and adds one outbox entry atomically. The entry keeps the rows as they were.
- A sync page never overwrites a row that still has an outbox entry.
- The outbox is sent oldest first. Offline, a refused access key and a lost session stop the run and keep the entries. A message that no longer exists drops the entry. A request the server refuses for good (400, 403, 409, 422) puts the rows back as they were, drops the entry and is reported. A server error (5xx, 429) keeps the entry; after five tries it is treated as refused.
- An action taken while a sync is running is sent as soon as that run ends.
- A conversation row acts on every message of the conversation that the list shows.
- Managing actions are not offered in a mailbox the account may only read.

## Tasks

1. **Store:** `MailAction`, schema v2 (`outbox`), `perform`, `pendingOperations`, `completeOperation`, `revertOperation`, `conversationMemberIds`; `apply` skips rows with pending entries. Tests in `MailStoreActionTests`.
2. **API and engine:** `MailAPI.bulk/star/snooze`, `SyncEngine.perform`, flushing with the rules above, `actionFailures()` stream. Tests in `APIClientTests` and `SyncEngineActionTests`.
3. **App:** `MailActions` (what a row offers, by folder and permission), opening marks read, swipe actions, context menu, multiple selection, reader toolbar, snooze presets, folder picker, failure notice, haptics. Tests in `MailActionsTests` and `MessageModelTests`; the walk-through archives, stars and reads offline.
4. **Ship:** docs, build 3 to TestFlight.
