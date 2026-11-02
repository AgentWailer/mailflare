# Mail startup and opening: database contention follow-up, 2 November 2026

## Verified production findings

The preceding header-cache change did not remove the slow tail. Cloudflare HTTP
Analytics for 2026-11-01 23:18 UTC through 2026-11-02 11:52 UTC, restricted to
browser (`eyeball`) traffic and exact message-detail paths, recorded 21 successful
detail responses: TTFB p50 93 ms, p75 422 ms, p95 8,369 ms. The list recorded 128
successful responses: p50 329 ms, p75 647 ms, p95 6,482 ms. No error responses
occurred in those samples. Small samples/adaptive analytics limit inference;
these are not click-to-render measurements or field Core Web Vitals.

D1 Insights over the preceding 12 hours exposed the larger bottleneck:

- Fetching the 25 already-selected conversation heads scanned ~69,379 rows,
  averaged 4,473 ms, and ran 36 times. SQLite chose the mailbox/read index instead
  of the message ID primary key, touching large message rows across the archive.
- Counting starred conversations averaged 1,425 ms over 27 calls. The ordered
  conversation index lacks `starred`, causing table-row reads across the mailbox.

[D1's documented execution model](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput)
processes queries one at a time per database instance. A slow list query can
therefore delay unrelated detail and authentication queries. This establishes a
real shared bottleneck; it does not trace every historical seven-second detail
request to a particular competing query. Worker cold starts were not established
as the cause.

## Paired read-only production checks

Three sequential rounds against the same mailbox, same 25 IDs, same predicates
and projection. Order alternated between rounds. Only SQL execution durations
reported by D1 are shown, excluding management API and browser/network overhead.
No bulk writes, mail actions, load test, or cache purge was performed. The first
round is not a controlled cold-cache experiment. Returned message IDs matched.

| Query | Before, three runs (ms) | After, three runs (ms) | Rows read before / after |
| --- | --- | --- | --- |
| 25 message heads | 9,910 / 210 / 205 | 16.5 / 1.6 / 1.9 | 69,424 / 50 |
| Starred conversation count | 351 / 370 / 420 | 33.1 / 19.9 / 20.3 | 69,424 / 69,424 |

The starred scan still examines metadata for the mailbox, but no longer loads
large message rows. This is an existing covering index; no migration is needed.
The page projection now requires the existing text-primary-key index. Every
mailbox/permission/filter predicate remains in SQL, even though IDs were already
selected by the authorized page query. Dates and booleans retain their decoders.

## Other focused changes

- Pause speculative folder warming while a detail request or its bounded retry
  is pending. Controlled seven-second unresolved-detail test: 14 extra folder/API
  requests before, zero after. Existing in-flight work completes. This covers
  intent/cold-navigation windows; the page already stopped warming once the
  selected-message route committed.
- Repair old snippets after returning the list, using the framework's `after()`
  integration with Workers `waitUntil`. Previously the response awaited body
  reads and up to 25 derived-preview writes. New mail already has clean snippets;
  legacy previews are immediately cleaned and fully rebuilt for the next fetch.
- No shared caching of mail, new service, infrastructure migration, or additional
  paid product. Fewer rows read should reduce D1 work; no cost saving is promised.

## Regression checks and reproduction

```sh
node --test tests/message-page-access-path.test.mjs \
  tests/conversation-page.test.mjs tests/message-preview-background.test.mjs \
  tests/mailbox-preload.test.mjs tests/mail-startup-performance.test.mjs \
  tests/account-switch.test.mjs tests/worker-memory.test.mjs
npm run build
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/cold-start.mjs
```

The access-path test creates 60,070 synthetic messages with full migrations and
no ANALYZE statistics. It asserts the actual production helpers' query plans,
foreign-mailbox/status exclusion, typed date/boolean decoding, bounded page
hydration, thread totals, tie-breaking, and pagination equivalence. It belongs in
CI to prevent this planner regression from returning. Background-preview tests
hold repair pending, verify the response still returns, and check later stored
results, failures and denied access. Existing reader tests cover unavailable R2,
retries and account isolation.

54 targeted tests and the production build passed. Targeted lint has no errors
(one pre-existing unused-variable warning).

Browser checks use real production assets/router with synthetic private APIs.
Desktop/mobile initial reader interactions, rapid selection, back navigation,
failed-first-load recovery, and compose interactions passed. A later desktop
star-button pointer test failed because the existing hover actions intercept its
click. This separate UI issue was not changed; the full browser suite is therefore
not green. These browser checks do not
measure the real D1 optimization or authenticated production user experience.

## Rollout, validation and rollback

Deploy via the existing Git main/Cloudflare build. No schema changes. Verify the
active version at 100% and source markers for the required index paths. Keep
personalized response cache policy unchanged. Then compare new browser detail
and list TTFB samples, and D1 Insights query durations/rows read; do not mix the
previous deployment window into an after measurement. End-user click-to-content
p75 target: under 500 ms warm and under 1 second uncached on normal European
connections; validate separately on slower mobile networks. Until enough new
traffic exists, these are targets rather than measured compliance.

Rollback is a Git revert and rebuild; the prior application remains compatible
with the unchanged database. The previous 15 unrelated TypeScript diagnostics
remain; targeted lint and build are checked independently. No authenticated
production browser session was available, so a complete live click-to-render
before/after result cannot be claimed.
