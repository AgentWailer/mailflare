-- Personal defaults apply across mailboxes and devices; existing accounts keep
-- the original tone and balanced polishing until they choose otherwise.
ALTER TABLE users ADD COLUMN writing_preferences TEXT NOT NULL DEFAULT '{}';
