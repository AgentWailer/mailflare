# Advertising/spam ambiguity regression — 2026-10-28

The reported household pest-control offer reached Primary with policy 9 and reason
`spam_uncertain`. Sorting was active, threshold 0.8, and the AI returned successfully.
The independent marketing score was 0.8704; category scores were spam 0.8469,
promotions 0.1209, primary 0.0123, invoices 0.0046, orders 0.0081, social 0.0072.
The non-AI spam score was only 5. Policy 9 required marketing >=0.9 whenever
Promotions was not the leading category, leaving the message in Primary.
These scores are model outputs, not calibrated probabilities of correctness.

Policy 10 adds a narrow `marketing_spam_ambiguity` resolution to Promotions:

- Explicit marketing score >= max(0.8, mailbox threshold).
- Spam is at least as likely as Promotions and their combined category score is
  >= max(0.9, mailbox threshold).
- Inbox relevance, personal action and security scores are each <0.1.
- Primary and combined invoice/order scores are each <=0.1.
- All earlier legal/security/transaction protections still apply; independently
  corroborated spam takes precedence. Missing/invalid marketing scores cannot
  authorize this resolution. Observation mode still leaves the mail in Primary.

This does not change model, prompt, quota, inference calls or storage schema.
No sender blocklist or global weakening of confidence is introduced.

## Verification

- `node --test tests/smart-inbox.test.mjs tests/r2-mbox-import.test.mjs`: 104 passed.
- `npx eslint src/lib/mail-sorting/classifier.ts src/lib/mail-sorting/content-review.ts`: passed.
- `npm run build`: passed.
- Recorded incident scores reproduce Primary before and Promotions after.
- Inbound integration verifies persisted category and silent notification,
  with collection correspondence still protected and observation mode preserved.
- Deterministic replay of 98 stored model decisions from the prior 24 hours changed
  only the reported offer between current baseline and revised resolver. This is
  a regression comparison, not a labeled accuracy benchmark or new inference.
  Only 59 stored decisions exactly match baseline category/reason: 10 stored
  `bulk_review` decisions and 29 earlier `promotions` decisions reflect other
  review/policy contexts. They must not be counted as fresh model failures.

## Rollout and recovery

Publish via Git main and Cloudflare's configured build. Verify the active Worker
contains `marketing_spam_ambiguity` at 100% traffic. Watch stored decisions for
this reason and any reported false positives. Only the specifically reviewed
incident is eligible for immediate repair using an optimistic check of mailbox,
message ID, old decision, current Primary category and received status; preserve
read, starred, labels and body. Do not launch a whole-mailbox reclassification.

Rollback by reverting this change through the same build pipeline. No schema
rollback is needed. Revert an individual repaired category only if its decision
still matches the recorded correction, to preserve subsequent user actions.
