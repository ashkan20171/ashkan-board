-- Phase 20: support bounded workspace ticket queries and stable ordering.
CREATE INDEX IF NOT EXISTS tickets_workspace_created_id_idx
  ON tickets(workspace_id, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS tickets_workspace_updated_id_idx
  ON tickets(workspace_id, updated_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS tickets_workspace_priority_created_idx
  ON tickets(workspace_id, priority, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS tickets_workspace_title_idx
  ON tickets(workspace_id, title);
