-- Phase 33: final PostgreSQL normalized cutover.
-- The application no longer uses the JSONB aggregate in normalized mode.
-- This migration permanently retires the compatibility aggregate.
DROP INDEX IF EXISTS ashkan_app_state_gin_idx;
DROP INDEX IF EXISTS ashkan_app_state_updated_idx;
DROP TABLE IF EXISTS ashkan_app_state;
