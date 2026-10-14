# Startup and folder navigation with large imports

The first startup-counter request on the production imported mailbox took about
17.8 seconds on 2026-10-14 (roughly 59,000 messages in a 4 GB D1 database). Its
query plan fetched message-table rows and built a temporary grouping tree.
Warm requests were faster, but still made several D1 round trips. The counter
join for labels also read message-table rows. Inline mail bodies made these table
reads expensive even though the response needed only metadata.

Migration `0073_mail_metadata_indexes.sql` adds two derived covering indexes:

- `messages_counts_cover_idx`: exact aggregates grouped by mailbox, legacy
  folder, category, direction, status, read flag, star flag and snooze time.
- `messages_page_cover_idx`: mailbox/status/folder/direction and newest-first
  page predicates, with category, snooze and thread metadata available in-index.

These indexes contain no mail content. The existing backup table list is unchanged;
normal migrations rebuild the indexes when restoring mail to a fresh database.
Counters remain exact; this change does not replace them with estimates or caps.
The production grouped-counter query uses the covering index without a temporary
grouping tree. Tests verify query plans using imported mail with large bodies.

The counter API batches folder, scheduled and label tallies into one D1 request,
using one consistent database snapshot. The message-list API reuses its already
loaded, current authorized-mailbox list instead of performing a second mailbox
access lookup. Valid read grants and disabled mailboxes still govern access.

Folder clicks no longer await list preloading or an artificial progress delay.
Navigation starts immediately; the destination keeps its own loading state and
shares the in-flight preload. The authenticated app shell is revealed independently
of pending mail data, so a slow list cannot hold the menu behind the startup splash.
The small startup transition is retained.

Counter refreshes for the same scope share an in-flight request, including forced
refreshes. If data changes while a request is pending, one fresh follow-up runs
after it rather than starting overlapping archive-wide aggregates. Old-generation
responses cannot refill the cache. Session switches clear pending state so the new
account does not wait for the previous account's request.

Regression checks cover exact counts, metadata-only query plans, immediate menu
navigation with an unresolved request, startup with pending data, refresh coalescing,
follow-up invalidation and account isolation. Timing measurements distinguish API
latency from full browser startup; network and cache conditions can change results.

## First category load and conversation view

Follow-up measurements of the first category pages found roughly 6.5 seconds for
Promotions in the default conversation view and 15.5 seconds for the first Social
single-message request. SQLite's DISTINCT optimization still selected an older,
ordered conversation-key index that required reading large message-table rows to
check category, status, direction and snooze predicates.

Migration `0074_category_conversation_indexes.sql` replaces the two incomplete
expression indexes with `messages_conversation_cover_idx` (mailbox, normalized
conversation key, dates and all required membership metadata). It adds
`messages_category_page_cover_idx` for category/status/direction and newest-first
selection. Exact DISTINCT counts, heads and matching conversation members are
checked for covering-index plans in all four categories, including the two-status
invoice/order views. Labels and conversation action membership remain intact.

Conversation count and head queries use one D1 batch. After selecting the visible
page, member IDs, thread totals, scheduled times, contact metadata and labels load
concurrently; they retain the same authorized mailbox/user scopes.

Sidebar preloads now follow the stored conversation preference, matching the
actual default page cache key. Previously a click requested a single-message page
and the destination requested a separate grouped page. Drafts stay ungrouped.
Tests verify that duplicate preload callers join the same request.

## Reducing request overhead and overlapping refreshes

Authenticated API calls now resolve the live session and user in one joined query.
Token hashing, expiry checks, account disabling and revocation remain enforced on
fresh database state. Mailbox discovery batches owned and delegated mailbox queries
while retaining the same disabled-mailbox and grant predicates; it does not cache
permissions. Ungrouped message pages also batch their exact count and page query.
These changes save three sequential D1 round trips on an ungrouped message request
and two on the default conversation request, without changing list data or scope.

Forced list refreshes share the pending query for the same scope and generation.
Changes while a query is pending schedule one fresh follow-up instead of overlapping
requests. Stale responses cannot refill the cache, and a failed old query still
allows the fresh follow-up. Account changes start requests immediately and prevent
old pending listeners from starting another query under the new session.

Regression tests exercise live session expiry/revocation and disabled users,
delegated permission removal, exact pagination and labels, refresh coalescing,
failed and successful stale responses, and account isolation.
