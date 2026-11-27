ALTER TABLE workspace_webhook_deliveries ADD COLUMN IF NOT EXISTS retry_locked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS workspace_webhook_deliveries_due_idx ON workspace_webhook_deliveries(dead_lettered, next_retry_at, retry_locked_at, created_at);
