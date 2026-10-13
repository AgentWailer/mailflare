# Apply mailbox rules to existing mail

In Settings → Rules, each saved rule has an **Apply to existing messages** action.
The same option is available when creating or editing a filter, including filters
derived from a received email. Saving a rule without this option only changes
future intake.

The historical operation checks received and archived incoming messages in the
selected mailbox. Spam and Trash can be explicitly included from the saved-rule
dialog. Sent mail, drafts, other mailboxes and mail arriving after the operation
was accepted are excluded. Only messages matching the rule are changed, using the
same sender/recipient/subject/content matcher, combination and exclusions as intake.

Labels are added without removing existing labels. Explicit category, skip-inbox,
legacy folder, Spam and Trash actions are applied. A category alone does not
unarchive or restore messages from Spam or Trash. This action does not permanently
delete mail, change read flags, generate old-mail notifications or retrain the
classifier as though these were individual manual corrections.

Historical forwarding is intentionally not performed: Cloudflare Email Routing
forwards the original MIME during live intake. Existing forwarding filters can
apply their local labels, category and move actions; forwarding-only filters have
no historical action. The dialog explains this distinction.

The server captures the saved rule and an upper message-row boundary in the
existing `message_bulk_jobs` table. Its queue consumer scans bounded chunks and
persists progress before/after application. Saved chunks replay idempotently after
failure, even if an earlier action moved a message. Editing the rule later does
not change an accepted job. The browser observes progress and can be closed.
Permissions are checked on acceptance and every chunk; disabled accounts or
revoked grants stop the job. Jobs retain the existing recovery, retry and backup
behavior. Restored unfinished jobs are paused because restored row IDs can differ.

The dedicated `POST /api/routing-rules/:id/apply` endpoint accepts only a request
ID and `includeSpamTrash`. It loads and authorizes the saved mailbox rule itself.
Generic bulk endpoints reject rule snapshots, and domain routing/catch-all rules
cannot be applied retrospectively through this endpoint. Retrying acceptance with
the same request ID returns the same durable job.

Progress reports **messages checked**, including nonmatching messages, rather than
claiming every examined message was changed. Another bulk job must finish before
starting a rule application.
