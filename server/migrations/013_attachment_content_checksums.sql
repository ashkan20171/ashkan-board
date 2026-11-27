-- Phase 30: persist a content fingerprint for private attachment blobs.
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_attachments_content_sha256_format_check'
      AND conrelid = 'ticket_attachments'::regclass
  ) THEN
    ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_content_sha256_format_check
      CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ticket_attachments_checksum_missing_idx
  ON ticket_attachments(id) WHERE content_sha256 IS NULL;
