# Import a large MBOX archive from private R2 storage

Mailflare's ordinary browser upload accepts at most 25 MiB and 100 messages. A 10 GB Gmail Takeout archive must be uploaded directly to object storage, then imported by the background queue. Do not enable public bucket access.

## Upload from a Mac or PC

Use the bucket bound as `BUCKET` on the Mailflare Worker. This installation uses `mailflare-raw`. If external S3/B2 storage is configured, upload to that configured bucket instead.

1. In Cloudflare, open **R2 → Manage R2 API tokens** and create S3 credentials with **Object Read & Write** access restricted to the destination bucket. Store them locally; do not paste secret access keys into chat or source code.
2. Install AWS CLI on your Mac if needed: `brew install awscli`.
3. Run `aws configure --profile mailflare-r2`. Enter the R2 Access Key ID and Secret Access Key, region `auto`, and output format `json`. The existing Wrangler token is not an S3 credential.
4. Copy the account ID from the R2 S3 API endpoint shown by Cloudflare, then upload with the repository helper:

```bash
bash scripts/upload-mbox-to-r2.sh "/path/to/archive.mbox" ACCOUNT_ID
```

The helper uses a multipart upload with 64 MiB parts to `s3://mailflare-raw/mbox-imports/workspace-002.mbox`. It leaves the local source intact and prints the key to enter in Mailflare. Optional arguments select another bucket, object key, and AWS profile. The upload must finish before the background import starts. For a 10 GB file, use this S3 multipart method rather than the dashboard's ordinary upload.

## Start and monitor the import

Log into Mailflare as an administrator, select the destination mailbox, and open **Settings → Import → Large MBOX archive from R2**. Enter `mbox-imports/workspace-002.mbox` and start the background import.

The background task reads R2 byte ranges of at most 2 MiB, processes up to five messages per queue invocation, and checkpoints the original archive offset after every successfully imported message. Closing the browser does not stop it. The job identity and object ETag prevent duplicate active jobs and detect source replacements. Do not overwrite the uploaded object during an import.

Pause stops after the current message. Resume retries from the checkpoint. Interrupted queue leases are recovered by the five-minute cron. A completed MIME message is deduplicated on replay; a partial staged message remains hidden and is rebuilt before completion.

Gmail's `X-Gmail-Labels` header preserves Inbox, Sent, Drafts, Spam, Trash, unread status, stars, categories and custom labels when available. Slash paths remain complete label names. Ordinary MBOX messages without that header are imported as read archived mail. Existing messages retain their current state. Imports do not invoke AI sorting, forwarding rules, auto replies or new-mail push alerts. Open **All emails** to inspect the imported inbound messages, including spam and trash; check Sent and Drafts separately.

A malformed or oversized individual message pauses the job with an error; it is never silently dropped. A message over 20 MiB requires separate processing or an explicit skip confirmation. The scan of a single batch is capped at 64 MiB; extremely large malformed messages should be split or repaired offline. Native D1 row limits also apply to decoded email bodies. Skip affects only the failed message, keeps the original archive, and is counted in the job summary. Headers with more than 100 custom labels pause rather than silently truncating labels.

## Storage and cleanup

The upload is private and accessible through the authenticated admin import and the Worker storage binding. No public download URL or S3 secret is exposed by the import API. Check the import count, any skipped messages, and sample attachments before manually deleting the original `mbox-imports/` object. Mailflare does not delete the source automatically.

The original archive consumes about 10 GB in addition to imported raw messages and attachments. This can exceed R2's 10 GB free storage allowance while both are retained. Delete the source after verification to reclaim that temporary storage.

Import jobs belong to the mail group in database backups; restoring active jobs pauses them and clears their leases. The source R2 object must still exist to resume. Older database backups without the job table remain restorable.
