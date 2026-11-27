ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS delivery_retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_delivery_retention_days_check CHECK (delivery_retention_days BETWEEN 1 AND 3650);
CREATE INDEX IF NOT EXISTS workspace_webhook_deliveries_retention_idx ON workspace_webhook_deliveries(webhook_id, created_at);
