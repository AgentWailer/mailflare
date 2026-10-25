-- OAuth is handled by Cloudflare Access. This stores only explicit origin permissions.
CREATE TABLE mcp_oauth_grants (
 user_id text PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key_id text NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
 issuer text NOT NULL,
 audience text NOT NULL,
 subject text NOT NULL,
 email text NOT NULL,
 enabled integer NOT NULL DEFAULT 0,
 created_at integer NOT NULL,
 updated_at integer NOT NULL,
 UNIQUE(issuer,subject)
);
