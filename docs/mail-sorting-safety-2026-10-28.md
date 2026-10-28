# Keep consequential mail visible — 2026-10-28

## Verified cause

A read-only inspection of the sender identified by the user confirmed that recent collection correspondence had been classified by CLEF as possible spam, with a separate spam score of zero. One saved decision assigned promotions only 0.0347 and spam 0.7928, yet the application mapped it to promotions (`bulk_review`). The newest message already carries the user's manual correction to primary; previous sender-specific examples did not prevent the bad decision. No production message, label, filter or archive state was changed during diagnosis.

There was a second unsafe path: when AI was unavailable or its quota exhausted, a bulk/list header alone could move a message to promotions. Neither path established that the message was advertising.

## Policy 6

- Uncorrelated model spam remains primary with review required, instead of becoming advertising. Independent spam processing and corroborated spam decisions remain intact.
- Model-based promotions require their own confidence at least 0.9 (or the user's higher threshold). Social requires its configured category threshold; split/uncertain destinations remain primary with review required.
- AI failure/quota exhaustion keeps mail in primary. Narrow deterministic advertising rules still work.
- Case-specific collection, objections, payment demands and legal deadlines receive a primary shortcut before broad sender overrides or AI. It requires meaningful content, not a sender-domain allowlist; collection-service marketing is excluded. Receiver authentication failure or elevated spam score prevents this shortcut.
- Model criteria now explicitly describe automated acknowledgements of a personal legal case as actionable mail.
- The same content guard is available to a user-started historical audit. It preserves archive/read/label state and treats explicit user decisions as review suggestions, not automatic overwrites. No new audit was started.
- Existing manually corrected categories continue to provide mailbox-scoped learning examples. No new model, migration or service is added.

The intended tradeoff is more visible uncertain mail, rather than hiding consequential mail. This is a targeted policy regression fix, not proof of universal classification accuracy.

## Validation and deployment

Tests cover the recorded probability distribution using synthetic message content; collection replies, generic-subject claims, objections, deadlines, marketing counterexamples, sender overrides, AI outages, spoof/spam evidence and the actual incoming-message persistence/notification path. Historical review tests preserve manual decisions and archived state. Existing category/learning, import, filtering and permissions tests also pass.

Reproduce with:

```sh
node --test tests/smart-inbox.test.mjs tests/mail-content-audit.test.mjs tests/r2-mbox-import.test.mjs tests/message-filters.test.mjs
npm run build
```

120 distinct tests passed across these suites after correcting two new test fixtures. Targeted ESLint and production build passed. TypeScript retains 15 pre-existing unrelated errors; none in changed files. Tests use local databases and mocked AI; no live AI reclassification or real notification was sent.

Deploy through the existing main-branch Cloudflare build. Rollback by reverting the commit through the same pipeline. No schema/data migration is needed; decision policy versions remain recorded for later inspection. No historical reclassification is automatically initiated.
