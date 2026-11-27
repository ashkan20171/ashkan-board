-- Phase 25: collaboration runtime query indexes and integrity constraints.
CREATE INDEX IF NOT EXISTS ticket_comments_author_idx ON ticket_comments(workspace_id, author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_comments_mentions_gin_idx ON ticket_comments USING GIN(mentions);
CREATE INDEX IF NOT EXISTS workspace_notifications_unread_idx ON workspace_notifications(workspace_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_workspace_ticket_idx ON ticket_attachments(workspace_id, ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_audit_actor_idx ON workspace_audit_logs(workspace_id, actor_id, created_at DESC);
