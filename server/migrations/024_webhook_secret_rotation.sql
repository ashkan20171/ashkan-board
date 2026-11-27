ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS secret_rotated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS workspace_webhooks_secret_version_idx ON workspace_webhooks(id, secret_version);
