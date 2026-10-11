-- Existing labels remain top-level. Removing a parent keeps its children and mail.
ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX folders_parent_idx ON folders(parent_id);

CREATE TRIGGER folders_parent_insert BEFORE INSERT ON folders WHEN NEW.parent_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'Invalid label parent') WHERE NEW.parent_id = NEW.id OR NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.parent_id AND mailbox_id = NEW.mailbox_id
 );
END;

CREATE TRIGGER folders_parent_update BEFORE UPDATE OF parent_id, mailbox_id ON folders WHEN NEW.parent_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'Invalid label parent') WHERE NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.parent_id AND mailbox_id = NEW.mailbox_id
 ) OR EXISTS (
  WITH RECURSIVE ancestors(id, parent_id) AS (
   SELECT id, parent_id FROM folders WHERE id = NEW.parent_id
   UNION SELECT folders.id, folders.parent_id FROM folders JOIN ancestors ON folders.id = ancestors.parent_id
  ) SELECT 1 FROM ancestors WHERE id = NEW.id
 );
END;
