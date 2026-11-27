-- Phase 41: MFA, security events, and session/device controls.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_user_created_idx ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_type_created_idx ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_ip_created_idx ON security_events(ip_address, created_at DESC);
