# Worker memory review — 20 October 2026

Mailflare continues to run on Cloudflare Workers. The 128 MB limit applies to an
**isolate**, including JS heap and ArrayBuffers, and is shared by concurrent
invocations within that isolate. Moving code to another file named `server.js`
does not change the limit. A larger Worker CPU allowance does not increase RAM.
The useful changes are bounded data loading, streams, short-lived buffers and
selective browser-side work.

## Production observations

Read-only Cloudflare GraphQL and D1 aggregation, taken at approximately 21:10 UTC.
No message contents, addresses, attachment bytes, credentials or tokens were
exported for this review. The D1 query returned only counts and sizes; computing
the body-size aggregate required one full database scan (18.5 seconds), so it is
not suitable for a startup query or frequent monitoring.

The production-size review confirmed a mailbox with tens of thousands of
messages and several gigabytes of stored bodies/attachments. Individual bodies
were below 1 MiB; this does not make a batch of 200 bodies safe to buffer.

The seven-day adaptive invocation query showed no `exceededMemory` or
`exceededCpu` group. Disconnects and one script exception were reported. These
are reported outcomes, **not a live RAM reading or a guarantee that historical
or brief spikes never happened**. The API does not provide a per-invocation heap
high-water mark. Historical detailed logs are not persisted; that privacy setting
remains unchanged. Exact production counts, sizes and invocation totals stay in
the local review artifact rather than the source repository.

Production uses the native private R2 binding. It has no configured B2/S3 storage
override. Personalized HTML and API results retain their private/no-store policy;
no mailbox data was put in a public/shared CDN cache to reduce memory.

## Changes implemented

| Path | Previous risk | Implemented behavior |
| --- | --- | --- |
| JSON and multipart helpers | Entire request buffered before its real size was checked; multipart then parsed that copy | Count bytes while reading; reject/cancel at the limit even with missing/incorrect Content-Length. Multipart parser consumes the guarded stream directly. |
| Draft attachment upload | All File objects copied to ArrayBuffers concurrently | Validate the File sizes and pass the original Blob/File objects sequentially to R2. Existing count/size rules remain. |
| Forward attachment copy | Whole attachment read into a JS ArrayBuffer | Stream the source R2 body into the independent destination object. |
| Avatar, branding and backup-restore uploads | Several parsers had no early limit without Content-Length | Guarded multipart parsing with limits appropriate to the existing accepted files. Avatar request limit is 3 MiB; branding allows the icon limit plus 64 KiB overhead; restore retains a 20 MiB request/10 MiB file limit. |
| Raw inbound webhook and JMAP | Size check after reading the entire raw body, or only a declared length check | Guarded raw/JSON reads, preserving existing receiving/JMAP size limits and authorization. |
| Single-message detail | HTML/text serialized under both `message` and `body` | Body fields appear once, under `body`. Raw object-storage pointers are omitted from the payload. |
| Conversation reader | Up to 200 full bodies fetched/serialized for collapsed messages | New app requests `?view=headers`; SQL excludes body columns. Only an expanded card fetches its individual authorized detail. Error/retry, read-state changes and reply quotation remain functional. |
| Previously loaded app versions | Existing code expects inline conversation bodies | Legacy thread responses remain available up to a 4 MiB aggregate body budget, checked **inside D1 before body retrieval**. Larger legacy requests receive 413 and a reload instruction. The new app uses individual detail requests. |
| Conversation attachment/contact metadata | Large sets could exceed D1's parameter allowance | Queries are split into groups of at most 80 IDs/addresses, with contact-name projections limited to the required fields. |
| Browser detail cache | Every visited mail could remain cached for the session | LRU policy: at most 32 entries and an estimated 16 MiB of retained string/attachment metadata. Oversized selected messages still display but are not cached. This is a cache budget, not a cap on total browser memory. |
| MBOX assembly | A suspended generator retained assembled byte blocks while the caller also parsed the finished Blob | Release the assembly buffers **before yielding** the Blob, including the final record. Scanning, resume offsets, limits and skipped-message behavior remain. |
| Schema initialization | Zod 4.4.3 instantiated many schemas throughout the app | Upgrade to Zod 4.6.7. Cloudflare explicitly recommends 4.5.0 or later to reduce schema memory. |

The thread response is intentionally small rather than shipping the entire
archive to the browser. Replies are enabled after the selected expanded message's
body has loaded, so a lazy fetch cannot silently produce a reply with no quote.
Existing cached browsers retain ordinary conversation behavior during rollout;
a reload is required only for legacy conversations above the guarded budget.

## Local measurements

Five fresh Node 24.19.0 processes per before/after case; table values are medians.
Both cases use synthetic data. These measure **retained allocations after GC**,
not peak RAM or Cloudflare's production isolate heap. JavaScript strings, native
storage, parser allocations and concurrent requests can raise the real peak.

| Probe | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Import module containing the 36 central validation schemas: retained heap delta | 5,685,936 B | 4,066,280 B | −28.5%, about 1.54 MiB |
| Pause MBOX iterator after yielding a 19 MiB message: retained ArrayBuffer delta | 40,960,674 B | 21,037,730 B | About 19 MiB released |

The schema import-time medians were approximately 35.5 ms in both versions, so
this experiment supports a memory improvement, not a claim of faster startup.
Eliminating a request/attachment buffer also avoids a copy proportional to its
size: a roughly 25 MB uploaded attachment no longer needs that extra File-to-JS
buffer on the draft-upload path. Native multipart storage still has a cost.

Run the current synthetic probes with:

```sh
node scripts/profile-worker-memory.mjs
node --test tests/request-memory.test.mjs tests/worker-memory.test.mjs \
  tests/conversation-memory.test.mjs tests/worker-memory-runtime.test.mjs \
  tests/r2-mbox-import.test.mjs
```

The profiling script builds temporary test modules and starts fresh child
processes, always using generated content. It reads no production data or secrets.
The native runtime test uses local workerd/R2 with no remote bindings and verifies
a 24 MiB multipart File, a streamed copy and byte-for-byte checksum equality.

## Server/client boundary and remaining limits

- PDFs already render in a browser PDF worker; offscreen canvases are released.
  Avatar cropping/resizing and email layout fitting also already run in the
  browser. Language catalogs other than English load on demand.
- Authentication, mailbox access, API validation, credentials, sending, import
  checkpoints and durable bulk jobs must stay on the server. Moving them to the
  client would weaken access control or stop processing when the app closes.
  AI model weights run at the provider, not inside this Worker.
- Backups already use bounded database chunks (roughly 4 MiB for rescue data),
  bounded D1 pages and encrypted object-copy parts (8 MiB). MBOX reads use 2 MiB
  ranges, process one bounded message at a time and checkpoint between batches.
  Bulk mail actions work on indexed bounded batches instead of loading 60,000
  complete messages into JS. No backup format, encryption or persisted tables
  were changed in this work.
- MIME parsing still needs one complete bounded message and decoded attachments.
  The Gmail raw-JSON import can still hold a base64 response and decoded data
  around its existing 40 MiB raw/56 MiB encoded limits. Resend/SES sending still
  builds bounded base64/MIME payloads; optional B2/S3 storage adapters still
  buffer writes for signing. These remain the highest-risk paths for future
  expansion. Raising their file limits safely requires a dedicated streaming
  MIME/base64 path or a separate processing service, rather than increasing a
  frontend upload limit. The production invocation data did not show a memory
  failure for these paths in the observation window.
- Streaming makes memory independent of a copied file's total size on native R2;
  it does not make parsing/crypto memory-free or eliminate the isolate-wide
  concurrency limit. Do not describe 128 MB headroom as verified without actual
  isolate heap/peak measurements under representative concurrent load.

For ongoing monitoring: **Workers & Pages → mailflare → Metrics → Errors →
Invocation Statuses → Exceeded Memory**. Use local DevTools memory profiling with
synthetic data for deeper heap investigation. Do not enable body/header logging
or collect real mailbox heap snapshots as a routine diagnostic.

## Validation

- New focused request/server/client/native-runtime checks plus existing MBOX
  regressions: **72 passing**, including 200 large messages without body-column
  reads, legacy budget checks, ownership/disabled-mailbox checks, failed-fetch
  recovery and unchanged attachment bytes.
- Browser tests at 320/390px touch and 1440px light/dark: collapsed headers trigger
  no body downloads; opening a card loads one body; replies quote its original
  contents; retries and reopening work without horizontal overflow. These use
  actual conversation/reader/reply components, production CSS and synthetic APIs,
  not an authenticated production session or a physical iPhone.
- Broad unit run: **612 of 621 pass, nine fail**. All nine failures were reproduced
  in a separate unchanged `c5ae9d6` snapshot with the old Zod 4.4.3: one agent-draft
  revision test, one legacy backup fixture, five locale expectations and two
  outdated bootstrap-schema expectations. They are not new regressions. The two
  additional new lazy/legacy checks are included in the focused passing run.
- Existing cold-start browser checks also pass, including immediate first-click
  acknowledgement, failed-load recovery, rapid navigation, early back navigation,
  composer/assistant opening and clickable whole rows on mobile/desktop. The four
  quote-toggle browser cases and default reader folding also remain passing.
- Production build and lint for changed TypeScript files pass. Global TypeScript
  checking retains its same 15 unrelated diagnostics in admin/calendar/settings.
  No schema migration or backup-table-list update is needed.

Sources checked on 20 October 2026:
[Cloudflare Workers memory limits and mitigation](https://developers.cloudflare.com/workers/platform/limits/#memory),
[Cloudflare Workers invocation analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).
