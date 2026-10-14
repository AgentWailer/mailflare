# Paperless-ngx PDF delivery

In **Settings → Inbox → Paperless documents**, enter the HTTPS address of your
Paperless-ngx installation and its API token. Enable automatic delivery and save.
The connection test reads the documents and task APIs; it does not upload a test
file. The token must allow adding/viewing documents and viewing tasks. Obtain it
from the Paperless user profile. A separate restricted Paperless account is useful.
Never put tokens in chat, source control or URLs.

Select a trigger label (default **Paperless**) and a different confirmation label
(default **Paperless / Verarbeitet**). Labels are saved by ID and can be renamed.
If absent, the default labels are created when the connection is saved.

Apply Paperless to an email with PDF attachments. Each PDF receives a persistent
background job. Jobs continue through the server queue and scheduled recovery
without an open browser. Only after **all PDFs** are confirmed by the Paperless
task API is the confirmation label added. Existing read/unread, category, message
status and other labels are preserved. This integration archives PDFs in Paperless;
it does not delete or archive the source email in Mailflare.

Enabling a connection never scans or uploads existing labeled mail. For an old
unprocessed email, remove and reapply Paperless explicitly. Mail already bearing
the confirmation label is not exported. Manual label changes, bulk labeling, JMAP
label changes, legacy folder moves and rules on newly arriving mail are supported.
Historical rule replay deliberately stays local and does not deliver old documents
externally. Imported Gmail/MBOX labels and restored label memberships do not
trigger exports. No database trigger sends documents.

## Status and retries

The settings section displays the latest 30 PDF jobs and counts for all statuses.
The queue processes one PDF at a time per job; one failed PDF does not block others.
PDFs are streamed from object storage; Mailflare adds no extra 20/25 MB upload
limit here. Your Paperless proxy, Cloudflare Tunnel and Paperless may enforce
request/file size limits. Invalid PDFs and missing attachments remain visible as
errors. Non-PDF attachments are ignored.

After upload, Mailflare stores the Paperless task UUID and polls it until it returns
a document ID. Retryable connection/task-query errors back off automatically, up
to five consecutive failures. A known task is polled again rather than uploaded
again. No confirmation after seven days requires manual inspection. Duplicate
notices or failed Paperless OCR/import jobs require checking the Paperless task log;
they never falsely mark an email processed.

If an upload times out or a worker crashes after sending it but before recording
its task UUID, its receipt is **uncertain**. Automatic re-upload is disabled. Check
Paperless first; manual retry requires an explicit acknowledgement that a duplicate
may result. Stop ends an individual job permanently. It does not retract a PDF
already accepted by Paperless. Removing the trigger label or moving a message to
Spam/Trash prevents further work, but likewise cannot retract an accepted upload.

Disabling pauses delivery. Re-enabling resumes jobs paused for that reason.
Changing the destination requires finishing or stopping outstanding jobs first;
the API token must be re-entered for a new destination. Completed attachment
history prevents repeated delivery within the same mailbox.

## Server setup

Set **PAPERLESS_ENCRYPTION_KEY** to a stable base64-encoded 32-byte AES key in
Cloudflare Worker secrets (or the Node server environment). Do not rotate it without
re-entering connector credentials. API and optional Access credentials are stored
with AES-GCM, bound to the mailbox ID and normalized destination URL. GET responses
never expose them. Apply migration **0077_paperless.sql** and configure **AGENT_QUEUE**.
The worker cron and Node scheduler both recover durable pending jobs.

A public HTTPS hostname is required. A Cloudflare Tunnel can expose a private
Paperless installation. If Cloudflare Access protects it, create an Access service
token, allow it in a **Service Auth** policy for the Paperless API, and enter its
client ID and secret in the optional fields. Browser login cookies do not authorize
server-to-server uploads. HTTP redirects are never followed with tokens or PDFs.
Empty Access fields preserve saved credentials; replace both fields to rotate them.

Backups contain encrypted connections and job history in the automation group.
Keep the encryption key separately. Restore disables connections and pauses active
jobs for manual review, preventing automatic external uploads or duplicates after
restoration. Older backups without Paperless tables remain restorable. No remote
Paperless document database is included in a Mailflare backup.

## Validation

`node --test tests/paperless.test.mjs` checks real SQLite migrations/transactions,
permissions, encrypted credentials, multipart PDF streams, asynchronous task
acknowledgement, per-file isolation, queue recovery, ambiguous uploads and restores.
Browser coverage: `tests/browser/paperless-settings.mjs` (320/1440px).
