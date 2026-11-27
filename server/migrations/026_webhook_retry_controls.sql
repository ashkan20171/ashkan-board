ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10);
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS retry_delay_seconds INTEGER NOT NULL DEFAULT 30 CHECK (retry_delay_seconds BETWEEN 0 AND 86400);
ALTER TABLE workspace_webhook_deliveries ADD COLUMN IF NOT EXISTS dead_lettered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workspace_webhook_deliveries ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS workspace_webhook_deliveries_retry_idx ON workspace_webhook_deliveries(webhook_id, dead_lettered, next_retry_at);
