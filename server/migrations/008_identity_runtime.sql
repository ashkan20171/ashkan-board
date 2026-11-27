-- Phase 22: identity/workspace runtime hardening.
ALTER TABLE workspace_memberships ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx ON workspace_memberships(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS workspaces_created_at_idx ON workspaces(created_at ASC);
