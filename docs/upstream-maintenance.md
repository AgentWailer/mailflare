# Reviewed upstream maintenance — 2026-10-28

Original: https://github.com/hieunc229/mailflare, reviewed through `f9839770f468b0137c781460372a10d949c4f971`.
Fork source import: `0e9c158`, application source equivalent to upstream `ca41c56` (only deployment configuration/workflow differed).

## Selective adoption

| Original commit | Adopted behavior and fork-specific adaptations |
|---|---|
| `ed045c6` | Domain routing requires domain-administration permission; mailbox-only managers cannot change domain rules. Preserve destinations across domains belonging to the same owner. Keep session cache improvements and gate UI with current user permissions. |
| `af266d9` | Parse MIME essence and allow safe inline formats only; sender inline disposition cannot override this. Reject comma-joined MIME metadata before filename inference. Retain private/no-store, authentication, PDF.js and native Wallet behavior. |
| `3bbd197` | Atomic queued→sending claim and transactional cancellation (message status and job removal roll back together on failure). Load attachments before the claim so storage failures remain retryable; cancellation during loading still wins. No additional MCP features added. |
| `c92db8a` | Contact enrichment failure no longer rolls back stored imported mail. Preserve staging and import checkpoints. Do not log contact values/SQL. |
| `07c4d56` | Persist Reply-To for inbound/imported messages and JMAP drafts, use it for manual replies. Old message details recover it from the existing bounded header read, alongside unsubscribe metadata. |
| `4479b5b` | Batch JMAP requests within D1's parameter cap; split mailbox scopes as well as requested IDs (including >100 mailbox grants), dedupe, preserve thread order, do not disclose SQL to clients or logs. |

These are adapted ports, not a wholesale merge. Original license/copyright remains in LICENSE. Performance indexes, other database backends, Vite+, new icons, read-receipt tracking, external spam intelligence and optional calendar/reminder features are deferred. Existing UI, classifier, Paperless, OAuth, backup and caching behavior remain part of this fork.

## Migration and compatibility

`0083_message_reply_to.sql` adds a nullable `messages.reply_to` column. No table is created/removed, so existing backup table coverage remains correct. Export/restore already includes table columns dynamically. Apply the additive migration **before** publishing code that selects the new column. Existing messages keep null; bounded MIME-header fallback handles them without bulk rewriting mail. Migration numbering belongs to this fork; do not reuse upstream 0061.

Old application code tolerates the extra nullable column. Rollback: revert this application change through the existing Git→Cloudflare pipeline, **leave the column and recorded migration in place**, and forward-fix. Old migration-status UI may flag a newer migration; do not delete mail or roll back the full database to clear it. Restore tests must cover both old records without reply_to and new records containing it.

The `sending` job status is a TypeScript enum addition to an existing text column. A successfully claimed job must not be automatically reset to queued if provider delivery may already have begun. Provider/crash ambiguity cannot be solved by blindly retrying; inspect such jobs separately. Ordinary pre-claim attachment failures remain queued and retryable.

## Checks

- `npm run test:upstream-fixes`: permission isolation, inline MIME rejection, simultaneous cancellation/delivery, duplicate consumers, contact failures, Reply-To and legacy headers, D1 batch bounds, Wallet/PDF behavior, backup round trips.
- Import/Gmail/MBOX and JMAP-import suites cover existing data workflows.
- Build plus browser attachment preview, desktop/mobile mailbox flow checks. Fixtures contain synthetic data; no live mail is sent.
- Existing project-wide TypeScript errors are tracked separately; these ports must introduce none.

## Weekly observation

`.github/workflows/upstream-watch.yml` runs Monday **07:23 UTC** (08:23 CET / 09:23 CEST) and supports manual dispatch. It has read-only repository permission and creates a 30-day GitHub Actions artifact plus a run summary. It never executes upstream code, merges, pushes, changes dependencies, migrates or deploys. GitHub schedules can be delayed and require Actions to remain enabled.

`scripts/upstream/baseline.json` records the last **reviewed**, not merged, upstream SHA. After reviewing new commits, record adoption/deferral here and advance that cursor deliberately. History rewrites stop the comparison for manual review. The priority flag is a filename/subject heuristic, not a security finding. Lockfile audit warnings are not automatically treated as reachable production vulnerabilities. Audit transport/JSON failures fail the watch job rather than pretending there are no warnings.

Local reproduction:

```sh
UPSTREAM_OUTPUT=/tmp/mailflare-upstream-review node scripts/upstream/report.mjs
npm audit --omit=dev --json
```

At the initial run the cursor matches upstream, so zero new commits is expected. Known dependency warnings (including DOMPurify, Next, MCP SDK) need separate runtime-specific assessment; these source fixes do not claim to resolve them. No forced dependency update is performed.
