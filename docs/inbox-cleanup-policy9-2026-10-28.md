# Reviewed inbox cleanup and policy 9 — 28 October 2026

## Scope and verified cleanup

The earlier count of 56 was the total inbox snapshot: 41 primary, 9 orders, 6 social. Nine was the model's proposal count, not a human-labeled total of advertising. A closer content review identified 25 advertising/general-newsletter messages in that snapshot (24 primary, one social), plus one advertisement that arrived during the work.

The user explicitly authorized sorting the current inbox. All 26 reviewed messages were assigned to `promotions`, with compare-and-swap guards on message ID, mailbox, owner, prior category and prior sorting decision, and eligibility guards on inbound/received/non-snoozed/unfiled state. No concurrent-edit conflicts occurred. Follow-up reads confirmed every category change and preservation of read/star state, labels, folder and archive state. Nothing was deleted. Existing orders, account/security mail, contractual confirmations, appointments, personal support and the disputed collection case remained intact.

Each change has a `reviewed` sorting decision with previous category/decision and a cleanup run ID. Mailbox-scoped content examples were recorded as `reviewed_archive`; no sender-wide override was created. A pre-change snapshot, including existing feedback rows, was retained in a private local rollback file. Feedback insertion was a separate idempotent guarded step and verified after the category update; this was not presented as a cross-request database transaction.

No private message bodies, account identifiers, claim numbers, verification codes or credential values are included in this report or regression fixtures.

## Fixes for future mail

- Decode numeric HTML entities and named layout-padding entities before trimming the 6,000-character model input. Link origins remain; tracking paths/queries are removed. Bounded source size is unchanged.
- Allow a clear advertising category score at the configured threshold to overcome weak general inbox relevance (<0.50), only with primary ≤0.10 and action/security each <0.10. Transaction uncertainty and stronger personal/security signals still veto advertising.
- Recognize editorial newsletter formats using list-delivery headers, editorial subject/introduction evidence and opt-out wording together. An unsubscribe footer alone is insufficient.
- Protect operational vulnerability bulletins even if delivered as newsletters.
- Require evidence of an actual authentication request/code instead of protecting any body that mentions “Bestätigungscode.” Preserve subject-based account-security protections.
- Protect cancellation confirmations and actual invoices for newsletter subscriptions; promotional mentions of invoicing remain excluded.
- Policy version 9 retains the existing model, daily cap, timeout and single-inference budget. There is no model cascade or new paid infrastructure.

## Validation

129 automated tests passed across smart inbox, content audit, mailbox import and message filters. Added checks exercise encoded padding, invalid entities, conflicting inbox/category signals, editorial newsletters versus real security bulletins and paid receipts, instructional versus actual codes, and cancellation confirmation safety. Targeted lint and production build passed. TypeScript still reports the same 15 pre-existing errors as the prior baseline; none are in these changed sorting files.

A further read-only replay evaluates the original snapshot using original R2 list headers, bounded stored content, current mailbox settings/contact relationships and the updated learning examples. This replay deliberately reevaluates the freshly reviewed advertising instead of treating its new `reviewed` category as a prediction. Other pre-existing explicit corrections remain protected. Because it uses examples learned from the same inbox, it measures behavior on the reviewed set, not independent generalization or a real-world accuracy guarantee. No replay result changes production mail. In this replay, 19 of the 25 reviewed advertising messages were automatically recognized; six still fell back to Primary. All 25 already retain the reviewed advertising assignment in production. There were 30 model calls, 116,080 input tokens and zero evaluation errors. None of the other messages was proposed as advertising or spam; four pre-existing explicit corrections were preserved without reevaluation. One existing order remained uncertain, which does not authorize changing its stored category.

## Rollout and rollback

Ship source changes through the existing Git-connected Cloudflare build and verify `editorial_newsletter` in the active Worker artifact. Confirm new mail records policy 9. No schema migration is needed. Reverting the source commit restores the old future-mail policy and does not undo the user-authorized cleanup. Undoing cleanup requires the saved per-message pre-change state, guarded by the cleanup run ID/current reviewed decision; preserve intervening user edits and restore/remove feedback from the corresponding snapshot.
