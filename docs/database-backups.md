# Database backups

Backups run on the existing agent queue. Starting a manual backup returns HTTP 202; the page polls queued/running records. Closing the browser does not stop a backup. The scheduled job uses the same exporter.

The exporter plans existing tables in foreign-key order and records their upper rowids. It estimates row sizes before fetching content, reads bounded keyset pages, and writes fixed 5-MiB multipart parts to the private bucket. At most one part is handled per queue invocation. The checkpoint and lease live on the existing `backups` row (migration 0078); a JSON-frame tail is held as a private temporary object until the next part. Completed backups remove their temporary objects. Cron recovers interrupted/unsent work. Lost completion responses are checked against the final object's size.

The file remains `mailflare-database-backup` version 1 JSON. Table groups and legacy missing tables retain their existing behavior. Restoring a queued/running backup record marks that record failed and clears its checkpoint: restored upload state must never resume against old multipart uploads. Existing full-document restore remains memory-bound, so very large production restores need a suitable batch/Node workflow; no production restore is part of the export repair.

This is a **database** backup, including message bodies and object references. It does not duplicate every attachment, raw MIME, import file or Drive object in the bucket. Protect and separately back up that storage as needed. A series of live table queries is not a transactionally consistent snapshot across all tables; for point-in-time recovery also consider D1 Time Travel and coordinate major imports/deletions.

Verification: `node --test tests/backups-stream.test.mjs` exercises bounded reads, fixed part sizes, browser-independent completion, duplicate deliveries, interrupted uploads, a lost completion response, negative rowids, Unicode/escaped JSON crossing part boundaries, and restore compatibility.
