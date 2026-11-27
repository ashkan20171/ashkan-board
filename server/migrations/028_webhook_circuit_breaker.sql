ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS circuit_breaker_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS failure_threshold INTEGER NOT NULL DEFAULT 5;
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS circuit_opened_at TIMESTAMPTZ;
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_failure_threshold_check CHECK (failure_threshold BETWEEN 1 AND 100);
