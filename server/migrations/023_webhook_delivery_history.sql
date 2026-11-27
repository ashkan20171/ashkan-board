CREATE TABLE IF NOT EXISTS workspace_webhook_deliveries (
  id UUID PRIMARY KEY,
  webhook_id UUID NOT NULL REFERENCES workspace_webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status INTEGER,
  delivered BOOLEAN NOT NULL DEFAULT false,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_webhook_deliveries_webhook_idx ON workspace_webhook_deliveries(webhook_id, created_at DESC);
