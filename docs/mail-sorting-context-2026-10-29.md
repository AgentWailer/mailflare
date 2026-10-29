# Sorting context repair — 29 October 2026

## Observed failure

Sorting was active at confidence 0.8 and 1,000 AI requests/day. The reported
cloudHQ Halloween templates, Stepstone recommendation, and three Jordi Bruin
product-launch copies all had completed Clef Omni decisions, not quota errors.
They were retained by `inbox_uncertain` or `category_uncertain`.

The learning selector padded every request to six examples, even when none was
relevant. Comparing identical message content with and without these unrelated
examples reproduced a major context effect: a Forbes editorial newsletter was
assigned a high security score with unrelated historical examples, but correctly
recognized as a newsletter without them. This demonstrates sensitivity to the
supplied context, not a claim about the model's internal reasoning.

The policy also inadequately described free product launches, automated job-board
recommendations, and public community posts quoted in notification emails. The
previous policy-10 fix covered a separate advertising-versus-spam ambiguity and
was too narrow to address these failures.

## Changes (policy 11)

- Do not fill live requests with unrelated feedback. Include exact-sender examples
  or subject similarity with at least two shared words and Jaccard-like overlap
  of at least 0.35 against the larger subject token set. Keep the six-example cap,
  mailbox isolation, old same-sender lookup, and context-free inspection.
- Clarify free product/template campaigns and automated job-board recommendations
  as Promotions; community/public-post digests and social-platform newsletters
  as Social. Distinguish a quoted public question from a direct personal request.
- Clarify actual security events versus news discussing security/privacy.
- Recognize forum digests from a digest subject, content markers and list headers.
- Recognize an explicit editorial signature with a list header even if a long
  newsletter's unsubscribe footer lies outside the content window.
- Preserve all legal, transaction, conversation and security guards, the user's
  confidence setting, spam corroboration, model, timeout and daily budget.

No new service, model, schema, background reclassification or second inference
per message. Identical product newsletters delivered to multiple recipient
addresses are separate messages; this change does not silently deduplicate them.

## Validation

133 tests passed:

```sh
node --test tests/smart-inbox.test.mjs tests/mail-content-audit.test.mjs \
  tests/r2-mbox-import.test.mjs tests/message-filters.test.mjs
npx eslint src/lib/mail-sorting/{learning,decision-request,content-review,routine}.ts
npm run build
```

Paired live Cloudflare Clef Omni comparison against commit `8c2f658`, two rounds
with reversed before/after order:

| Selected cases | Policy 10 matches | Policy 11 matches |
| --- | ---: | ---: |
| 14 real cases, two rounds | 8/28 | 28/28 |
| 30 synthetic cases, two rounds | 40/60 | 56/60 |

No important primary-control message moved to Promotions/Spam/Social in either
version (4 distinct real and 11 synthetic primary controls, each repeated twice).
The four remaining candidate mismatches are two synthetic invoice/refund cases
retained in Primary, repeated twice.

Real inputs were reconstructed from stored content, original list/authentication
headers and current mailbox corrections; contact relationship was unknown.
Expected categories are expert-reviewed. These are selected problem cases, not
an unbiased accuracy estimate. Guard/routine outcomes were applied locally; the
final editorial/forum rules were replayed over the same inputs and model outputs.
The live model-only candidate initially matched 24/28 real cases; the two narrow
rules resolve the remaining four repeated outcomes. No extra inference was used
for that rule replay. The actual application inbound path is covered separately
by integration tests, not by sending test mail to production.

Real-case input tokens: 108,336 -> 70,654 (about 35% less). REST p50: 523 -> 591 ms;
p95: 1,003 -> 832 ms. No general latency improvement is claimed. Historical body
and learning snapshots remain private in the execution workspace.

A reusable synthetic benchmark uses non-personal example corrections (therefore
it is not the identical private-feedback dataset behind the table above):

```sh
# Opt-in paid inference; 120 calls, configured Cloudflare credentials required.
node scripts/benchmark-sorting-context.mjs --live
```

## Release and recovery

Release via the existing Git-main Cloudflare build. Check the deployed artifact
for `social_forum_digest` and the new context selector. Verify the active version
receives 100% traffic. Existing categories remain unchanged automatically.

Repair only reviewed messages with compare-and-swap against their original
decision, Primary category, mailbox and received status. Preserve labels, read,
starred, body and archive status; do not block entire sender domains or train from
unreviewed machine outputs. The reviewed repair set contains 12 messages:
eight Promotions (including three copies of the product launch), four Social.
Keep before/after snapshots outside Git.

Rollback by reverting this commit through the same build. No schema rollback.
Revert individual category repairs only if the recorded correction still matches;
never overwrite subsequent user changes. Monitor new policy-11 decisions and
user corrections; uncertain important messages should remain visible.
