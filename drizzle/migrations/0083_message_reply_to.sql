-- Nullable for old mail; message detail resolves legacy Reply-To from its existing MIME.
ALTER TABLE messages ADD COLUMN reply_to text;
