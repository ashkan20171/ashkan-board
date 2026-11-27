ALTER TABLE workspace_webhook_deliveries ADD COLUMN IF NOT EXISTS payload JSONB;
CREATE INDEX IF NOT EXISTS workspace_webhook_deliveries_replay_idx ON workspace_webhook_deliveries(webhook_id, delivered, created_at DESC);
