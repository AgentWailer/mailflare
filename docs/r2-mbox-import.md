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

## Resume an ongoing multipart upload

An ongoing upload can occupy gigabytes in R2 while the final object is still absent. Its uploaded parts become a readable object only after `CompleteMultipartUpload`. Running `aws s3 cp` again starts another upload; it does not resume the existing upload ID.

Keep the original local MBOX unchanged and stop any other process writing the same upload. Run the resume helper on the Mac that has the file and the configured `mailflare-r2` AWS profile:

```bash
python3 scripts/resume-mbox-to-r2.py "/path/to/archive.mbox" ACCOUNT_ID
```

Python 3.9 or later is required (`brew install python` if needed). The helper finds the existing upload for `mbox-imports/workspace-002.mbox`, infers its part size, and verifies the existing part ETags against the matching local byte ranges. It uploads only missing parts and completes the same upload ID. It then checks the final object size and multipart checksum. It neither starts a replacement upload nor aborts the existing upload, and it never reads or prints credentials.

If the helper is interrupted again, run the same command again. Successfully uploaded parts remain available. If every part was already uploaded, the helper only verifies them and performs the completion request. Existing parts are checked by reading the local file; they are not downloaded from R2.

Multiple ongoing uploads require explicit selection with `--upload-id UPLOAD_ID`; their IDs and initiation times are displayed. `--bucket`, `--key`, and `--profile` support alternate destinations. If the part size cannot be inferred, add `--part-size-mib 64` only when 64 MiB was the original upload setting. A local mismatch stops before completion; use the original source file rather than forcing a mixed archive. An upload that was already aborted cannot be resumed with its old upload ID.

The resume helper changes storage only through `upload-part` and `complete-multipart-upload`. Do not start Mailflare's background import until it prints **Upload complete and verified**.

## An archive originally uploaded through Mailflare Drive

A Drive upload uses `drive/OWNER_ID/FILE_ID` as its R2 key, with no filename extension. It will not appear under `mbox-imports/`. To resume that existing multipart upload, pass the exact Drive key:

```bash
python3 scripts/resume-mbox-to-r2.py "/path/to/archive.mbox" ACCOUNT_ID --key "drive/OWNER_ID/FILE_ID" --part-size-mib 64
```

Use 64 MiB only when it matches Drive's recorded upload part size. The helper verifies all existing part data before completing the upload. Then enter this same Drive key in the background import form. Mailflare verifies that the Drive entry belongs to the current administrator, is an untrashed MBOX file, and matches the complete object's size. It reconciles an upload completed externally and imports directly from the Drive object; there is no second upload or storage copy. Archives in another account's Drive are rejected even for administrators.

If using the browser instead, choosing the same local file again through Drive's Upload action resumes recorded parts when its name, size and last-modified fingerprint match. Keep only one uploader active for a given upload.

## Start and monitor the import

Log into Mailflare as an administrator, select the destination mailbox, and open **Settings → Import → Large MBOX archive from R2**. Enter `mbox-imports/workspace-002.mbox` and start the background import.

The background task reads R2 byte ranges of at most 2 MiB, processes up to 25 messages per queue invocation within a 15-second work window, and checkpoints the original archive offset after every successfully imported message. Queue batching waits at most one second. Contact names and profile images continue to be imported. Labels, message publication and each checkpoint are committed together. Closing the browser does not stop it. The job identity and object ETag prevent duplicate active jobs and detect source replacements. Do not overwrite the uploaded object during an import.

Pause stops after the current message. Resume retries from the checkpoint. Interrupted queue leases are recovered by the five-minute cron. A completed MIME message is deduplicated on replay; a partial staged message remains hidden and is rebuilt before completion.

Gmail's complete `X-Gmail-Labels` header is MIME-decoded before its comma-separated names are split, including folded headers and German system-label names. Categories without a dedicated Mailflare tab, such as purchases and updates, remain accessible as readable labels. The header preserves Inbox, Sent, Drafts, Spam, Trash, unread status, stars, categories and custom labels when available. Slash paths remain complete label names. Ordinary MBOX messages without that header are imported as read archived mail. Existing messages retain their current state. Imports do not invoke AI sorting, forwarding rules, auto replies or new-mail push alerts. Open **All emails** to inspect the imported inbound messages, including spam and trash; check Sent and Drafts separately.

A malformed or oversized individual message pauses the job with an error; it is never silently dropped. A message over 20 MiB requires separate processing or an explicit skip confirmation. The scan of a single batch is capped at 64 MiB; extremely large malformed messages should be split or repaired offline. Native D1 row limits also apply to decoded email bodies. Skip affects only the failed message, keeps the original archive, and is counted in the job summary. Headers with more than 100 custom labels pause rather than silently truncating labels.

## Storage and cleanup

The upload is private and accessible through the authenticated admin import and the Worker storage binding. No public download URL or S3 secret is exposed by the import API. Check the import count, any skipped messages, and sample attachments before manually deleting the original `mbox-imports/` object. Mailflare does not delete the source automatically.

The original archive consumes about 10 GB in addition to imported raw messages and attachments. This can exceed R2's 10 GB free storage allowance while both are retained. Delete the source after verification to reclaim that temporary storage.

Import jobs belong to the mail group in database backups; restoring active jobs pauses them and clears their leases. The source R2 object must still exist to resume. Older database backups without the job table remain restorable.
