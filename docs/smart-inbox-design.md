# Smart inbox and labels

Implemented 2026-10-11. Applies to new incoming mail. Existing messages and folder IDs remain intact.

## Use

- Primary Inbox, Promotions and Social appear in the sidebar on desktop and mobile. Spam remains its own area.
- Existing custom folders also act as labels. Create them with the existing sidebar plus button. Use **Labels and category** on a message or a same-mailbox bulk selection to assign several labels independently of its category. The same message appears in several views without duplicating bodies or attachments. Read/delete operations affect that one message.
- Selecting a category corrects the current message. **Always use this category for this sender** stores a mailbox-scoped override for future incoming mail. **Skip the inbox** archives a message while retaining its labels. Removing a label does not delete the message.
- Settings → Inbox → Smart inbox provides Active, Observe and Off modes, a daily AI request limit, a probability threshold, current usage and remembered senders. Remembered senders can be removed there. Default: Active, 1,000 requests per mailbox per UTC billing day, minimum category probability 0.90.
- Settings → Rules supports sender, recipient, subject and visible/body content conditions, AND/OR, negated conditions, multiple labels, a category, archive/spam/trash, enable/disable and priority. Higher priority runs first; the first matching valid rule wins. These rules affect future mail. Existing single-folder rules remain compatible.

## Delivery and notifications

Local spam protection and explicit mailbox filters precede AI sorting. A matching filter provides the final category/labels without an AI call. Otherwise a remembered sender overrides AI. Narrow deterministic shortcuts handle unsubscribe-marked discount campaigns and LinkedIn digests, excluding security, transaction and direct-message subjects. Remaining mail uses Workers AI `@cf/cloudflare/clef-flash`.

CLEF is queried for category (choice), personal action and genuine security notice (noul). Personal action probability ≥0.50 or security probability ≥0.20 keeps mail in Primary. Promotions/Social require their category probability ≥ the configured threshold and Primary probability ≤0.10. AI-only spam classification requires probability ≥0.98 plus local spam score ≥40. Uncertain, malformed, unavailable, over-budget or timed-out results remain Primary. These thresholds are conservative routing policies, not measured accuracy guarantees. Default classification timeout: eight seconds. Observe mode records the proposal while retaining Primary delivery.

Sorting completes before message delivery notifications. Websocket events refresh all views even for silent mail. Only unread inbound Primary mail in the inbox triggers phone/browser alerts and contributes to the badge. Promotions, Social, spam, trash, archive and messages moved out of the inbox stay silent. Push delivery checks the stored message again, alongside current mailbox permission, session expiry and disabled-account checks. Existing notification opt-in/device permission requirements still apply.

This adds no automatic deletion, historical reclassification, late asynchronous classification jobs, model training or AI tool access. A sender/category correction changes stored facts; it does not fine-tune CLEF. Existing local spam/ham feedback remains available through Spam/Not spam actions. Notifications cannot currently be opted in per advertising/social category.

## Data, permissions and cost

The AI receives normalized sender, recipient (up to 300 characters), subject (up to 400), up to 6,000 characters of visible text, contact relationship source and a mailing-list-header flag. Attachments, raw MIME and arbitrary headers are not submitted. This is processing by Cloudflare; enabling AI sorting is distinct from running only local deterministic rules. Email content is explicitly treated as untrusted data, with no tools or actions exposed to the model.

The atomic per-mailbox daily reservation prevents concurrent requests exceeding the limit; failures still count because they may have incurred inference cost. Input token usage is recorded. Cloudflare documents CLEF Flash input pricing of USD 0.038 per million tokens; at 1,500 input tokens each, 1,000 messages are approximately USD 0.057, before allowances and other platform charges. Current pricing: https://developers.cloudflare.com/workers-ai/models/clef-flash/ . Each mail uses one inference with three questions. Actual tokens depend on content. There is no stronger-model escalation.

Labels, settings, overrides and usage enforce existing mailbox permissions. Read-only users can inspect labels but cannot change them or filters. Foreign-message and foreign-label selections are rejected before any writes. Message and sender corrections use one D1 batch; no notification is sent for manual organization of old mail. SQL reads are chunked to respect D1 parameter limits.

## Compatibility and persistence

Migration `0061_smart_inbox.sql` adds message category/decision fields, rule fields, the unique message-label relation, per-mailbox settings, sender overrides and usage. Existing folder membership is backfilled. Compatibility triggers add a label when legacy operations assign a folder. Clearing a legacy folder does not erase independent labels.

List, search, navigation, counts, bulk actions, assistant inbox queries and JMAP respect categories/labels. JMAP exposes Promotions/Social as stable virtual children and supports multiple label memberships within one account. Label views include archived mail; spam/trash are excluded. Conversation lists represent messages matching the current view. One message is counted once per label and once per mailbox, even when it has several labels.

All new tables are in backup export/types and exactly one group. Restores preserve optional compatibility for old documents and reconstruct old single-folder labels. A pre-migration database can still export and restore. Existing Drive metadata tables are now covered by backups as well. R2 object content is outside the database document. Push subscriptions are excluded as device credentials and are renewed after restore; incomplete multipart upload parts are transient and excluded. Restore inserts parents before children and deletes in reverse dependency order.

## Validation

Automated integration tests exercise migrations before/after upgrade, old/new backup restore, multiple labels/counts, authorization and CSRF, sender overrides, daily reservations, observation/failure behavior, conservative decisions, silent browser/push delivery, inbound classification and retry deduplication, and JMAP memberships. Browser fixtures render the real components with mocked APIs at 320/390/430px, landscape and desktop to check editing, filter conditions, category/label submission, settings and reachable dialogs. Physical iOS Home Screen push delivery still requires a device smoke test; desktop Chromium cannot establish Apple notification permissions.
