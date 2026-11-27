-- Phase 24: session rotation and workspace invitations are runtime-owned relational data.
ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Keep the latest pending invitation for each workspace/email pair and revoke older duplicates.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id, lower(email) ORDER BY created_at DESC, id DESC) AS position
  FROM workspace_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL
)
UPDATE workspace_invitations AS invitation SET revoked_at = now()
FROM ranked WHERE invitation.id = ranked.id AND ranked.position > 1;
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family_idx
  ON auth_refresh_tokens(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_active_user_idx
  ON auth_refresh_tokens(user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_invitations_pending_lookup_idx
  ON workspace_invitations(workspace_id, lower(email), expires_at DESC)
  WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_invitations_expiry_idx
  ON workspace_invitations(expires_at)
  WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_one_active_per_email_idx
  ON workspace_invitations(workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
