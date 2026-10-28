# Advertising recall regression — 28 October 2026

## Verified production diagnosis

Read-only examination of the latest 100 inbound records. Of these, 32 used policy 7 after rollout: 7 promotions, 3 social, 2 orders and 20 primary. Thirteen of the primary decisions were `category_uncertain`, three `spam_uncertain`, two `personal_or_security`, one `inbox_uncertain` and one a protected-conversation rule. No policy-7 AI errors or daily-limit failures were present in this sample. Mode was active, configured threshold 0.80; usage at inspection was 576/1,000 requests for the UTC day. This is a bounded sample, not a systemwide failure-rate measurement.

The policy-7 safeguard had silently imposed a 0.90 advertising-category threshold over the user's 0.80 setting. Five messages rated between 0.80 and 0.90 as advertising stayed in primary. Other newsletters split probability between promotions and spam: rejecting them was our routing policy, not a missing AI binding or inactive filter. The previous fix prevented important mail being hidden, but excessively reduced advertising recall.

Input inspection also found long tracking URLs and invisible preheader padding taking up the 6,000-character AI budget. That can crowd out useful text. Source data and private message contents are not committed here.

## Focused changes

- Honor configured confidence for the category choice. Do not change the user's stored threshold.
- Ask a fifth typed `marketing` question in the same Clef Omni call: is the main purpose advertising, a general newsletter or a promotional update? Do not infer advertising merely from low inbox relevance, mailing-list headers or a spam guess.
- When promotions leads with probability ≥0.50, require marketing ≥the configured threshold. Otherwise require marketing ≥max(0.90, configured threshold). Both routes preserve all earlier personal, legal, security, transaction and primary-inbox guards. Correlated spam still takes precedence.
- Record `marketingProbability` for diagnosis. Old responses without the field remain replayable; invalid fields fail closed to primary.
- Normalize a bounded input before rules and AI: remove invisible preheader padding, collapse whitespace, and shorten links to their origins before taking 6,000 characters. Keep host evidence for phishing; the separate spam analyzer retains original content/URLs. Never follow email links.
- Policy version 8; no schema changes, no new queue, no second inference or model cascade, and no automatic historical reclassification.

## Validation and limitations

Paired live Workers AI REST comparison against frozen policy 7 (`12dcb24`), same 24 synthetic DE/EN cases, two repetitions with reversed before/after order. These are 24 distinct examples, not 48 independent messages. Results are model plus policy, **before deterministic rules**:

| Metric | Policy 7 | Policy 8 |
|---|---:|---:|
| Expected category matches | 34/48 | 42/48 |
| Advertising matches | 4/12 | 12/12 |
| Important mail incorrectly sent to advertising/spam | 0/20 | 0/20 |
| REST median | 344 ms | 358 ms |
| REST p95 | 409 ms | 475 ms |
| Input tokens over 48 calls | 56,618 | 65,738 |

Remaining six candidate mismatches were three invoice/receipt cases repeated twice, left in primary. Some are handled by the production transaction shortcuts; the comparison does not establish end-to-end invoice recall. Synthetic labels are expert judgments, not representative-user ground truth. Probabilities are routing signals, not calibrated accuracy guarantees. Results: `mail-sorting-policy-comparison-2026-10-28.json`.

A separate read-only replay of 13 selected recent messages used stored bodies, authentication signals and mailbox-scoped learning examples. Ten were manually assessed as missed advertising/newsletters and three as account/support controls. Policy 8 recognized **7/10** of the missed messages; all three controls remained primary. This reconstruction lacked original list headers and exact contact state, so it is not an exact production replay or unbiased accuracy estimate. Three ambiguous newsletters remained primary; no claim of perfect filtering. Removing learning examples in a diagnostic comparison changed which messages matched (8/10), but did not demonstrate a reliable general improvement; the learning policy remains unchanged.

Tests cover configured threshold boundaries, missing/malformed marketing answers, ambiguous advertising, correlated versus uncorrelated spam, personal/security/transaction vetoes, legal notices despite incorrect model answers, a full inbound advertising persistence/notification path, tracking/padding limits, explicit filters, import and historical-audit behavior. Build and targeted lint pass.

At the checked catalog price ($0.15/million input tokens), the extra question cost about **$0.0285 per 1,000 synthetic classifications** (190 additional tokens per request), before allowances and other charges. Actual usage varies; content normalization can reduce tokens in long newsletters. The daily request cap and one-call budget reservation remain unchanged.

## Reproduce and release

```sh
node --test tests/smart-inbox.test.mjs tests/mail-content-audit.test.mjs tests/r2-mbox-import.test.mjs tests/message-filters.test.mjs
# Requires configured Cloudflare environment credentials; makes 96 paid synthetic inference calls.
node scripts/benchmark-sorting-policy.mjs --live
npm run build
```

Roll out through the existing Git-connected Cloudflare build; do not use direct deployment. Verify the active artifact includes `marketing_confirmed` and the marketing question, then inspect new decision metadata for policy 8, requested model, marketing probability, fallback reasons and daily usage. Real incoming mail is needed to measure production recall; do not manufacture messages or send push notifications for this check.

Existing messages retain their category. Roll back by reverting the policy-8 commit through the same Git build. No data/schema rollback is needed; recorded decisions remain readable. A future historical review must preserve user corrections, archive status and labels.
