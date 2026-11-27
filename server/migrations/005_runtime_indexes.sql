-- Runtime JSONB adapter remains transitional; this index supports future
-- containment-based diagnostics and controlled migration tooling.
CREATE INDEX IF NOT EXISTS ashkan_app_state_gin_idx
  ON ashkan_app_state USING GIN (state jsonb_path_ops);
