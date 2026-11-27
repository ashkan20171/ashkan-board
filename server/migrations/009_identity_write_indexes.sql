-- Phase 23: indexes for normalized identity/workspace write and lookup paths.
CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_role_idx
  ON workspace_memberships(workspace_id, role, joined_at);
CREATE INDEX IF NOT EXISTS workspace_memberships_user_joined_idx
  ON workspace_memberships(user_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS workspaces_name_lower_idx
  ON workspaces(lower(name));
