-- Phase 38: accelerate workspace ticket filtering, sorting, and substring search.
-- pg_trgm indexes support the existing parameterized ILIKE '%term%' predicates.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS tickets_workspace_status_created_id_idx
  ON tickets(workspace_id, status, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS tickets_workspace_priority_created_id_idx
  ON tickets(workspace_id, priority, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS tickets_title_trgm_idx
  ON tickets USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tickets_description_trgm_idx
  ON tickets USING GIN (description gin_trgm_ops);

-- Cover the common unread inbox path while retaining the existing full inbox index.
CREATE INDEX IF NOT EXISTS workspace_notifications_unread_user_created_idx
  ON workspace_notifications(workspace_id, user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
