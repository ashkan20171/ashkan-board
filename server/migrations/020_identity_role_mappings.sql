CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS workspace_role_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('oidc','scim')),
  claim TEXT NOT NULL,
  match_value TEXT NOT NULL,
  role_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 10000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source, claim, match_value)
);
CREATE INDEX IF NOT EXISTS workspace_role_mappings_lookup_idx ON workspace_role_mappings(workspace_id, source, enabled, priority);
