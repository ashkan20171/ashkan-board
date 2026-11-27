CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspace_roles (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, role_key)
);

ALTER TABLE workspace_memberships DROP CONSTRAINT IF EXISTS workspace_memberships_role_check;
CREATE INDEX IF NOT EXISTS workspace_roles_workspace_idx ON workspace_roles(workspace_id, role_key);

INSERT INTO workspace_roles(id, workspace_id, role_key, display_name, permissions, is_system)
SELECT gen_random_uuid(), w.id, r.role_key, r.display_name, r.permissions::jsonb, true
FROM workspaces w
CROSS JOIN (VALUES
  ('owner','Owner','["read","create","update","delete","members","roles","audit"]'),
  ('admin','Administrator','["read","create","update","delete","members","audit"]'),
  ('member','Member','["read","create","update"]'),
  ('viewer','Viewer','["read"]')
) AS r(role_key,display_name,permissions)
ON CONFLICT (workspace_id, role_key) DO NOTHING;
