-- Phase 13 schema groundwork for server notifications and import idempotency.
-- Runtime state remains in the transitional JSONB aggregate until normalized repositories land.
CREATE TABLE IF NOT EXISTS workspace_notifications (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  title VARCHAR(160) NOT NULL,
  message VARCHAR(500) NOT NULL DEFAULT '',
  entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workspace_notifications_inbox_idx ON workspace_notifications(workspace_id, user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ticket_import_batches (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_key VARCHAR(120) NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  imported_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, batch_key)
);
