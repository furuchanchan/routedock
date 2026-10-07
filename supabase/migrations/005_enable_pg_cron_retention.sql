-- supabase/migrations/005_enable_pg_cron_retention.sql
--
-- Replaces the scheduling step in 004_settlement_retention.sql.
--
-- 004's comments said the migration enabled pg_cron, but it only ran
-- cron.schedule when the extension was already installed — on a fresh
-- Supabase project the settlement-retention-cleanup job was silently never
-- registered, and because migrations do not re-run, enabling pg_cron by hand
-- afterwards still left the job unscheduled.
--
-- This migration enables pg_cron when it is available, schedules (or
-- refreshes) the daily cleanup job, and warns explicitly when pg_cron is
-- absent so the gap is visible instead of silent.

DO $$
BEGIN
  -- Enable pg_cron when it is offered but not yet installed. Supabase
  -- projects ship it; plain Postgres does not (it requires
  -- shared_preload_libraries, and CREATE EXTENSION errors without it) —
  -- catch that error so the migration still applies cleanly everywhere.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'pg_cron is available but could not be enabled: %', SQLERRM;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- cron.schedule(job_name, schedule, command) replaces the existing job
    -- of the same name for the same user, so this is safe on databases where
    -- 004 already registered it.
    PERFORM cron.schedule(
      'settlement-retention-cleanup',
      '0 3 * * *',           -- daily at 03:00 UTC
      'SELECT cleanup_stale_settlements(7)'
    );
  ELSE
    RAISE WARNING 'pg_cron is not installed, so settlement-retention-cleanup was not scheduled. Run SELECT cleanup_stale_settlements(7) daily from an external scheduler.';
  END IF;
END $$;
