ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS circuit_recovery_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE workspace_webhooks ADD COLUMN IF NOT EXISTS circuit_recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_circuit_recovery_seconds_check CHECK (circuit_recovery_seconds BETWEEN 30 AND 86400);
