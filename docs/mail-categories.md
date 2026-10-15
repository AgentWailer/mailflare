# Categories and learning

Mailflare separates incoming mail into Primary (`primary`), Invoices (`invoices`),
Promotions (`promotions`), Social (`social`) and Orders (`orders`). Spam and trash
remain separate message states. Invoices includes bills, receipts, payment
confirmations and credit notes. Orders includes purchase, shipment and delivery
confirmations. When an actual payment receipt accompanies an order, Invoices takes
precedence. Personal correspondence and account security alerts remain in Primary.
New unread invoices and orders retain their existing notification eligibility;
advertising and social updates remain silent. The app badge counts the unread mail
actually visible in the inbox, including social mail.

Category views show received, unarchived messages. Archiving an invoice or order
removes it from its category list, counters, navigation and folder-wide actions.
Its stored category and assigned labels remain intact; the message stays available
in Archive and All mail. This also applies to JMAP and assistant category searches.

Categories are additional views. New invoices, orders and social mail remain in the
inbox and appear in their own categories too; only advertising and spam skip the
inbox automatically. Explicit archive, move, snooze and filter `skipInbox` actions
still take precedence. Existing received categorized messages become visible
without reclassifying them or altering their read flags, labels or attachments.
Inbox counts, message navigation, JMAP mailbox membership and bulk selection use
the same policy. Durable jobs accepted under the older primary-only policy keep
their original scope rather than picking up additional categorized messages.

Narrow transaction and bulk-mail rules run before Clef Flash. Sender domains and
prices alone are not enough to identify a transaction. Coupons and invitations to
purchase are advertising, even when the same merchant also sends receipts. Weak
transaction evidence remains in Primary for review instead of becoming advertising.
The categories describe email content; Mailflare does not perform OCR on invoice
PDFs or validate their accounting details.

Correct a category using the label button or dragging the message to its category
in the sidebar. These explicit corrections are retained per mailbox and supplied
as examples to future Clef requests. Up to six examples are selected using sender
and subject similarity, with category diversity when relevant examples are scarce.
Older corrections from the same sender are retrieved even when many newer examples
exist. No model weights are trained and automatic import/AI decisions are not
treated as ground truth. Moving a message to an ordinary label or archiving it is
not a category correction. Settings → Mail sorting shows saved example counts and
allows clearing them. Explicit sender overrides remain separate; an advertising
override cannot capture a real receipt, order, security notice or conversation.

Use the imported archive to review a sample from each category, especially cases
where one merchant sends both marketing and transaction documents. Correct mistakes
as above. Those examples improve subsequent decisions without consuming AI calls
for already categorized promotions or social mail. A large unreviewed archive alone
does not establish classification accuracy.

The R2 background sorter checks unassigned imported Primary mail in the inbox and
archive, plus older automatic Primary decisions from policies before version 4.
Manual decisions, custom folder placement, snoozed mail, already categorized
advertising/social mail, spam/trash and outbound mail are preserved. Each applied
decision records its policy version, avoiding repeat charges on later deliveries.
Archive sorting uses no more than half of the shared daily AI allowance and waits
until the next UTC day when that allowance is spent. Rule matches require no AI
calls. Historical sorting does not replay forwarding, delivery or notifications.

The financial views also show archived financial mail without unarchiving it. Labels,
read flags and attachments remain intact. Migration 0069 renames the old
`Abrechnungen nach Kategorie` label to `Rechnung` while retaining its id, memberships
and rules. If a `Rechnung` label already exists, both identities are retained to
avoid destroying references. Confirmed financial label membership is a historical
hint for unassigned Primary mail. Incoming MBOX exports normalize the old label
name too. Migration staging table `mail_sorting_feedback_v4` is transient and
excluded from backups; the canonical feedback table and new sorting counters are
backed up, and pre-0069 documents remain restorable.
