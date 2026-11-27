-- Phase 26: operational indexes for normalized idempotent imports.
CREATE INDEX IF NOT EXISTS ticket_import_batches_imported_by_idx
  ON ticket_import_batches(imported_by, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_import_batches_workspace_created_idx
  ON ticket_import_batches(workspace_id, created_at DESC);
