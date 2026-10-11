CREATE TABLE gmail_import_connections (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email text NOT NULL,
 tokens text NOT NULL,
 created_at integer NOT NULL,
 UNIQUE(user_id,email)
);
CREATE TABLE gmail_import_jobs (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 connection_id text NOT NULL REFERENCES gmail_import_connections(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'paused',
 cursor text NOT NULL DEFAULT '{"pageToken":null,"pending":[],"loaded":false}',
 label_map text NOT NULL DEFAULT '{}',
 processed integer NOT NULL DEFAULT 0,
 imported integer NOT NULL DEFAULT 0,
 skipped integer NOT NULL DEFAULT 0,
 total integer NOT NULL DEFAULT 0,
 error text,
 lease_token text,
 lease_until integer NOT NULL DEFAULT 0,
 created_at integer NOT NULL,
 updated_at integer NOT NULL
);
CREATE INDEX gmail_import_jobs_user_idx ON gmail_import_jobs(user_id,created_at);
CREATE UNIQUE INDEX gmail_import_jobs_active_idx ON gmail_import_jobs(connection_id,mailbox_id) WHERE status <> 'completed';
-- One-use OAuth state/PKCE verifiers expire after 15 minutes and are excluded from backups.
CREATE TABLE gmail_oauth_states (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash text NOT NULL,
 verifier text NOT NULL,
 expires_at integer NOT NULL
);
