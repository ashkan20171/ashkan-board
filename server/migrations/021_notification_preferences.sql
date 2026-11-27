-- Phase 52: workspace-scoped notification preferences.
CREATE TABLE IF NOT EXISTS workspace_notification_preferences (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  mention_enabled BOOLEAN NOT NULL DEFAULT true,
  ticket_updates_enabled BOOLEAN NOT NULL DEFAULT true,
  comments_enabled BOOLEAN NOT NULL DEFAULT true,
  system_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_notification_preferences_user_idx
  ON workspace_notification_preferences(user_id, workspace_id);
