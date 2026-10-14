# Content review and label organization

Settings → Mail sorting → Content review starts a durable, mailbox-scoped job.
Only managers can start/control the job and inspect or confirm review suggestions.
The worker queue runs it without an open browser; the five-minute cron recovers
missed deliveries and expired leases. Node hosting uses the equivalent consumer
and scheduler. Pausing persists across deliveries. Permissions and disabled-user
state are checked for each invocation. New arrivals outside the frozen rowid
snapshot use normal intake instead of joining a historical job.

The first pass reads bounded visible content of every inbound received/archived
message, across all categories, in pages of 20. Plain text is limited to 6,000
characters and HTML to 64,000 characters before extracting visible text. It does
not download attachment contents or perform OCR, and it is not a byte-for-byte
review of entire MIME messages. Narrow rules correct security, invoice/payment and
order/delivery notices even when previously classified as advertising or social.
High spam scores, explicit user corrections, sender overrides and explicit mailbox
category/folder filters are preserved. Contradictions become review suggestions.
Replies are not classified from invoice wording in quoted history.

The second pass evaluates unresolved primary mail and financial/order assignments
that lacked deterministic content evidence. Already classified promotions/social
do not incur new AI calls. This historical job uses at most half the mailbox's
configured shared daily AI allowance, leaving the remainder for new mail. It waits
until the next UTC day automatically when the allowance is exhausted. Automatic
historical AI changes require consistent category confidence of at least 0.90,
with no uncertain/security/spam conflict. Other cases keep their category and go
into the review list. An unavailable or malformed AI answer records a per-message
review suggestion and advances; D1/checkpoint failures retry the same position.

Each message change, review suggestion and cursor/counter update is an atomic D1
batch guarded by the current lease, cursor and previous category/decision. Manual
changes racing a worker win. Historical processing never changes read flags,
status, custom-folder placement, labels or attachments, forwards mail, sends alerts,
or moves messages into Spam/Trash. Archiving remains independent of categorization.

Confirming a suggestion stores a manual category correction and a learning example
with up to 1,000 characters of cleaned visible content, without tracking URLs.
Suggestions, imported labels and automatic decisions never become examples.
Existing explicit category corrections also store excerpts. Reviewed archive
examples can use provenance `reviewed_archive`; they are distinct from user-created
examples and remain mailbox-scoped. CLEF receives at most six relevant reviewed
examples, prioritizing matching senders/subjects and category diversity. This is
context learning, not model fine-tuning or an accuracy guarantee. Owner-confirmed
categories win over subsequent automated runs. The existing clear-learning action
removes both forms of examples.

The label simplification action is optional per mailbox. It creates Antworten and
Warten, favors existing Aperturo/Projekte/Privat/Reisen/Paperless labels, hides broad
legacy/import labels and copies Shopping/travel-alias memberships to their canonical
labels. Source IDs and memberships remain available; filter label actions are
redirected to canonical IDs. `processed` becomes Paperless / Verarbeitet when safe.
It does not infer current tasks from old Dringend mail. Display order/visibility are
saved to the user's account and shared by their devices. Hidden labels remain in
settings and pickers. New MBOX imports normalize known Shopping/travel aliases.

Migration 0076 adds `mail_content_audit_jobs` and `mail_content_audit_issues`, both
backed up in the automation group, after messages in foreign-key insertion order.
It adds optional/defaulted excerpt/provenance fields to canonical feedback. Older
backups remain restorable. Restored active rowid snapshots are paused with
`restore_requires_restart`; starting a new review captures new rowids and prevents
silently continuing an invalid selection. Completed job history and suggestions
remain backed up. No new tables are excluded as internal/derived data.

Direct Amazon HTTPS links in the iOS Home Screen reader retain their destination
and use `_top` instead of a forced new window. Sanitization still permits only safe
link protocols. No custom application URL schemes or guessed tracking redirect
destinations are introduced. iOS and Amazon's universal-link configuration decide
whether an installed app opens; this cannot be forced or verified using desktop
Chromium. Other domains and normal desktop/browser tabs retain their behavior.
