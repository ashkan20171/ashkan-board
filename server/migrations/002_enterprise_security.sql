-- Transitional PostgreSQL persistence aggregate. Domain tables from 001 remain the normalized target schema.
CREATE TABLE IF NOT EXISTS ashkan_app_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL DEFAULT '{"users":[],"workspaces":[],"memberships":[],"tickets":[],"refreshTokens":[],"passwordResets":[],"invitations":[],"auditLogs":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ashkan_app_state_updated_idx ON ashkan_app_state(updated_at);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
