ALTER TABLE backups ADD COLUMN kind TEXT NOT NULL DEFAULT 'database';
ALTER TABLE backups ADD COLUMN verified_at INTEGER;
ALTER TABLE backups ADD COLUMN object_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backups ADD COLUMN object_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_settings ADD COLUMN rescue_public_key TEXT;

-- Operational index for bounded copying and shared-object garbage collection.
-- Recreated from the rescue manifest, never included in a database export.
CREATE TABLE backup_snapshot_objects (
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_etag TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  blob_key TEXT NOT NULL DEFAULT '',
  destination_etag TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  checksums TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending',
  checkpoint TEXT,
  PRIMARY KEY (backup_id, source_key)
);
CREATE INDEX backup_snapshot_objects_blob_idx ON backup_snapshot_objects(blob_key);
CREATE INDEX backup_snapshot_objects_state_idx ON backup_snapshot_objects(backup_id,state,source_key);
CREATE TABLE backup_snapshot_links (
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (backup_id,kind,token)
);

-- Time Travel provides the short-term database history; keep one weekly rescue point.
UPDATE backup_settings SET enabled=0,schedule_type='weekly',schedule_value=0,
  retention_enabled=0,excluded_table_groups='[]';
