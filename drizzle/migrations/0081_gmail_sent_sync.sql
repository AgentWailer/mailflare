CREATE TABLE gmail_sent_sync (
 connection_id text PRIMARY KEY NOT NULL REFERENCES gmail_import_connections(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 enabled integer NOT NULL DEFAULT 0,
 history_id text,
 cursor text NOT NULL DEFAULT '{"phase":"backfill","pending":[]}',
 imported integer NOT NULL DEFAULT 0,
 last_synced_at integer,
 error text,
 failures integer NOT NULL DEFAULT 0,
 retry_at integer NOT NULL DEFAULT 0,
 lease_token text,
 lease_until integer NOT NULL DEFAULT 0,
 updated_at integer NOT NULL
);
CREATE INDEX gmail_sent_sync_due_idx ON gmail_sent_sync(enabled,retry_at,lease_until);
CREATE TABLE gmail_sent_sync_issues (
 connection_id text NOT NULL REFERENCES gmail_sent_sync(connection_id) ON DELETE CASCADE,
 source_id text NOT NULL,
 error text NOT NULL,
 created_at integer NOT NULL,
 PRIMARY KEY(connection_id,source_id)
);
