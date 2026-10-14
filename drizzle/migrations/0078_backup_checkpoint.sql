-- A backup exports bounded D1 pages and uploads fixed-size R2 parts on the agent queue.
ALTER TABLE backups ADD COLUMN checkpoint TEXT;
ALTER TABLE backups ADD COLUMN lease_token TEXT;
ALTER TABLE backups ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
