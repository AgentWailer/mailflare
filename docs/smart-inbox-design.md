# Smart inbox and labels

Implemented 2026-10-11. Applies to new incoming mail. Existing messages and folder IDs remain intact.

## Use

- Primary Inbox, Promotions and Social appear in the sidebar on desktop and mobile. Spam remains its own area.
- Existing custom folders also act as labels. Create them with the existing sidebar plus button. Use **Labels and category** on a message or a same-mailbox bulk selection to assign several labels independently of its category. The same message appears in several views without duplicating bodies or attachments. Read/delete operations affect that one message.
- Assigned labels, including automatic filter labels, appear before the subject as compact chips with their label color on desktop and mobile. Two names are shown with a `+N` count for additional labels; the full list is available in the accessible group name and desktop hover text. Conversation rows combine labels from the messages represented in the current view, without duplicate labels or labels from excluded messages. Individual-message view shows only that message's labels.
- Selecting a category corrects the current message. **Always use this category for this sender** stores a mailbox-scoped override for future incoming mail. **Skip the inbox** archives a message while retaining its labels. Removing a label does not delete the message.
- Settings → Inbox → Smart inbox provides Active, Observe and Off modes, a daily AI request limit, a probability threshold, current usage and remembered senders. Remembered senders can be removed there. Default: Active, 1,000 requests per mailbox per UTC billing day, minimum category probability 0.90.
- Settings → Rules supports sender, recipient, subject and visible/body content conditions, AND/OR, negated conditions, multiple labels, a category, archive/spam/trash, forwarding, enable/disable and priority. Matching rules combine their labels and archive actions. The highest-priority explicit category and legacy folder win; explicit spam/trash actions take precedence. These rules affect future mail. Existing single-folder rules remain compatible.
- Open a received email → More → **Filter similar messages** to start with its sender. Choose the exact sender, its domain, or additional subject/body conditions, then choose actions. This also works from an individual message in a conversation. Saving requires full mailbox access and verifies that the source email belongs to that mailbox. Existing messages are not modified or forwarded.

## Forwarding filters

A filter can forward future matching mail to an address already verified in the same Cloudflare account's Email Routing destination list. The runtime `CF_TOKEN` must be able to read the mailbox domain's zone and the account's routing addresses. Missing access produces an actionable error; the rule is not enabled. A disabled forwarding rule can be saved during a Cloudflare API outage, but enabling it requires verification. Targets resolving back into the source mailbox are rejected.

Forwarding runs on the original MIME at live intake, before queue processing. Only the highest-priority matching forwarding filter sends a copy; a forwarding failure does not choose a different filter's target. Successful rule forwarding takes precedence over account-wide forwarding. The original remains stored locally, with attachments, labels and normal inbox sorting. Forwarding-only and label-only rules preserve AI category selection. A forwarding marker prevents repeating mailbox-rule forwarding on marked messages. Delivery failure keeps the local message; the app does not automatically retry external forwarding. Incoming providers must expose the live forwarding callback (the Cloudflare Worker and the SMTP/relay intake support it).

## Reading pane

Opening an email on desktop shows the message list above its reading pane by default. Drag the separator or focus it and press Up/Down to resize the list. The list and email scroll independently. Settings → Inbox → Reading pane offers Below, Right or Off; the choice and dimensions persist in this browser. A previously disabled reading pane stays disabled. On narrow screens the selected email occupies the full content area.

## Delivery and notifications

“All mail” (`/all`) appears directly below Starred and collects every stored incoming message in the selected mailbox, including Promotions, Social, labels, archived, snoozed, Spam and Trash. It shows each message once regardless of how many labels it has and supports search, pagination and conversation navigation. Sent mail, drafts and composer templates are excluded. Its unread count does not affect the Primary-only notification or app badge policy. This is a view over existing messages; it does not move or reclassify mail.

Local spam protection and explicit mailbox filters precede AI sorting. A filter with an explicit category or legacy folder supplies the final category without an AI call; label-only, archive-only and forwarding-only filters retain automatic category selection. Otherwise a remembered sender overrides AI. Narrow deterministic shortcuts handle unsubscribe-marked discount campaigns and LinkedIn digests, excluding security, transaction and direct-message subjects. Remaining mail uses Workers AI `@cf/cloudflare/clef-omni` with four System One typed questions. See [the measured model comparison](sorting-models-2026-10-28.md).

CLEF Omni is queried for category (choice), primary-inbox relevance, personal action and genuine security notice (noul). Explicit filters and protected legal/security/transaction rules run first. Personal action probability ≥0.50 or security probability ≥0.20 keeps mail in Primary. Model-driven promotions require at least 0.90 (or the configured higher threshold); social requires the configured threshold. Financial uncertainty and uncertain inbox membership keep mail visible. Model spam requires correlated local spam evidence (score ≥40); uncorrelated suspicion never becomes advertising. Malformed, unavailable, over-budget or timed-out results remain Primary. These thresholds are conservative routing policies, not measured accuracy guarantees. Default classification timeout: eight seconds. Observe mode records the proposal while retaining Primary delivery. Policy 7 records the requested model alongside AI decisions.

Sorting completes before message delivery notifications. Websocket events refresh all views even for silent mail. Only unread inbound Primary mail in the inbox triggers phone/browser alerts and contributes to the badge. Promotions, Social, spam, trash, archive and messages moved out of the inbox stay silent. Push delivery checks the stored message again, alongside current mailbox permission, session expiry and disabled-account checks. Existing notification opt-in/device permission requirements still apply.

This adds no automatic deletion, historical reclassification, late asynchronous classification jobs, model training or AI tool access. A sender/category correction changes stored facts; it does not fine-tune CLEF. Existing local spam/ham feedback remains available through Spam/Not spam actions. Notifications cannot currently be opted in per advertising/social category.

## Data, permissions and cost

The AI receives normalized sender, recipient (up to 300 characters), subject (up to 400), up to 6,000 characters of visible text, contact relationship source and a mailing-list-header flag. Attachments, raw MIME and arbitrary headers are not submitted. This is processing by Cloudflare; enabling AI sorting is distinct from running only local deterministic rules. Email content is explicitly treated as untrusted data, with no tools or actions exposed to the model.

The atomic per-mailbox daily reservation prevents concurrent requests exceeding the limit; failures still count because they may have incurred inference cost. Input token usage is recorded. The live Cloudflare catalog on 28 October 2026 lists CLEF Omni at USD 0.15 per million input tokens, versus Flash at USD 0.038 and CLEF at USD 0.24. At 2,000 input tokens per classified message, 1,000 calls cost approximately USD 0.30 for Omni versus USD 0.076 for Flash, before allowances and other platform charges. Actual tokens depend on content, examples and questions. Each uncertain mail uses one inference with four questions; there is no automatic multi-model cascade. Deterministic matches do not call AI. Current pricing: https://developers.cloudflare.com/workers-ai/models/clef-omni/ .

Labels, settings, overrides and usage enforce existing mailbox permissions. Read-only users can inspect labels but cannot change them or filters. Foreign-message and foreign-label selections are rejected before any writes. Message and sender corrections use one D1 batch; no notification is sent for manual organization of old mail. SQL reads are chunked to respect D1 parameter limits.

## Compatibility and persistence

Migration `0061_smart_inbox.sql` adds message category/decision fields, rule fields, the unique message-label relation, per-mailbox settings, sender overrides and usage. Existing folder membership is backfilled. Compatibility triggers add a label when legacy operations assign a folder. Clearing a legacy folder does not erase independent labels.

List, search, navigation, counts, bulk actions, assistant inbox queries and JMAP respect categories/labels. JMAP exposes Promotions/Social as stable virtual children and supports multiple label memberships within one account. Label views include archived mail; spam/trash are excluded. Conversation lists represent messages matching the current view. One message is counted once per label and once per mailbox, even when it has several labels.

All new tables are in backup export/types and exactly one group. Restores preserve optional compatibility for old documents and reconstruct old single-folder labels. A pre-migration database can still export and restore. Existing Drive metadata tables are now covered by backups as well. R2 object content is outside the database document. Push subscriptions are excluded as device credentials and are renewed after restore; incomplete multipart upload parts are transient and excluded. Restore inserts parents before children and deletes in reverse dependency order.

## Validation

Automated integration tests exercise migrations before/after upgrade, old/new backup restore, multiple labels/counts, authorization and CSRF, sender overrides, daily reservations, observation/failure behavior, conservative decisions, silent browser/push delivery, inbound classification and retry deduplication, and JMAP memberships. Browser fixtures render the real components with mocked APIs at 320/390/430px, landscape and desktop to check editing, filter conditions, category/label submission, settings and reachable dialogs. Physical iOS Home Screen push delivery still requires a device smoke test; desktop Chromium cannot establish Apple notification permissions.
