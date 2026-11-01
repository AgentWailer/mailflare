# Opening uncached mail — 2 November 2026

## Production evidence

Cloudflare HTTP Analytics, approximately 1 November 00:08 to 2 November 00:08
Europe/Berlin (24 hours). Filtered to `mail.steffenvonlindern.de`,
`requestSource=eyeball`, and the exact message-detail route (excluding attachment,
thread and metadata subroutes). These are edge TTFB values, not click-to-render or
field Core Web Vitals. Adaptive sampling and the small sample limit inference.

| Route, successful requests | Recorded count | p50 | p75 | p95 |
| --- | ---: | ---: | ---: | ---: |
| Message detail | 74 | 291 ms | 517 ms | 7,143 ms |
| Message list | 187 | 461 ms | 813 ms | 7,600 ms |

The message-detail sample also includes six HTTP 500 responses and one client
abort. Numerous 504s in an initial unfiltered query came from internal Cloudflare
requests, not browser requests; none remained after filtering to eyeball traffic.
Do not report these internal requests as user failures. Six real 500s remain
unexplained; this patch does not claim to fix their root cause.

Worker CPU p50/p95 was approximately 26.8/202.6 ms over all Worker invocations,
with no reported uncaught Worker errors. These aggregates include unrelated work
and cannot identify the cause of a particular slow reader request.

Read-only management-API probes of five recent messages, twice each, found D1
body lookup SQL durations of 0.25–0.93 ms. R2 header management-API requests took
425–643 ms, but the execution environment and management gateway differ from
native Worker bindings: these are not estimates of the production reader's
R2 stage or proof that R2 explains the full seven-second tail.

## Change

Every uncached detail previously waited for a bounded R2 read to obtain Reply-To
and List-Unsubscribe, despite already having the body in D1. Persist versioned
header metadata during MIME parsing/ingestion/import instead, including explicit
nulls for headers that do not exist. Read this small value from the message row.
This removes the extra object-storage dependency for new/imported mail without
changing message bodies, access control or private cache policy.

`0084_message_header_metadata.sql` adds one nullable column. Legacy, malformed or
unknown-version values retain the bounded R2 fallback. No shared cache or global
cache of private data is introduced. Raw stored metadata is excluded from list,
thread and detail-message payloads. The existing explicit unsubscribe/Reply-To
fields remain available. The generic messages backup already covers the column;
no table or backup-group changes are required.

Detail responses now report separate `Server-Timing` stages for contacts,
attachments and headers, in addition to authentication, lookup, access and total
metadata. Timings contain no mail content or credentials.

## Verification

- 51 relevant tests pass (reader/storage, MIME/Reply-To, imports, sender names,
  authentication/isolation, backups and client retry/account-switch behavior).
- The final affected subset of 27 tests was rerun after timing instrumentation.
- Native inbound integration persists metadata and opens the newly received
  message even when a subsequent R2 get would fail.
- Invalid stored metadata falls back; known-empty metadata never reads R2.
- Build and targeted lint pass. TypeScript retains 15 pre-existing diagnostics
  outside this change; no new diagnostics remain.
- Controlled local benchmark, five paired rounds with an injected 1,000 ms R2
  delay: legacy reader p50 1,004 ms versus stored-header reader p50 1.3 ms.
  R2 reads 5 -> 0. This proves dependency removal, not production response times.
- Eight browser runs per version: 390/1440 px, cold/warm cache, two repetitions,
  4x CPU throttle, 100 ms latency, synthetic private APIs with 100 ms delay.
  Click-to-reader before 415–887 ms, after 448–1,109 ms; JS transfer unchanged,
  max CLS about 0.0015. Browser timings vary and show no frontend speed gain;
  the optimization is in the backend path that these synthetic APIs replace.

```sh
node --test tests/reply-recipients.test.mjs tests/worker-memory.test.mjs \
  tests/import-contact-failure.test.mjs tests/message-sender-names.test.mjs \
  tests/app-security-regressions.test.mjs tests/backups-stream.test.mjs \
  tests/account-switch.test.mjs
node scripts/benchmark-message-read.mjs
npm run build
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium PERF_RUNS=2 \
  PERF_OUTPUT=/tmp/mail-open-browser.json node scripts/benchmark-performance.mjs
```

## Rollout / remaining diagnosis

Apply additive migration 0084, then deploy through Git main and the existing
Cloudflare build. Verify both migration and the active Worker version. Enrich at
most 50 recent received messages from their immutable raw headers, guarded by
message ID, unchanged raw key and null header metadata. This bounded maintenance
changes no read flags, labels, folder, category or body. No whole-archive scan.

After rollout collect real uncached-reader requests and inspect `Server-Timing`.
A new production p95 cannot be established from the previous 24-hour window or
the local benchmark. No authenticated production browser session was available;
Cloudflare Access and session checks were not bypassed. The intermittent 500s
and any remaining latency tail need request-level evidence. Existing browser
retries remain bounded and unchanged.

Rollback: revert the application commit via Git build and keep the nullable
column/migration. The old version ignores the new values. No additional paid
service; one fewer R2 read per uncached new-message detail request, with a small
D1 metadata storage increase.
