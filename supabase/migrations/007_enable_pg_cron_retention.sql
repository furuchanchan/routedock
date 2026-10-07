-- ─── pg_cron enablement for settlement retention (#382) ──────
--
-- Migration 004 schedules `settlement-retention-cleanup` only when the
-- pg_cron extension is *installed*. Supabase projects and self-hosted
-- Postgres commonly ship pg_cron *available but not installed* — the
-- check in 004 then quietly skips scheduling, so
-- `cleanup_stale_settlements` is never invoked by anything.
--
-- This migration enables pg_cron when the instance offers it, then
-- schedules the same daily job (idempotent: cron.schedule replaces an
-- existing job of the same name, so instances where 004 already
-- scheduled it simply re-register the same schedule). Instances without
-- pg_cron get a named WARNING pointing at an external scheduler.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      -- Supabase exposes pg_cron through pg_catalog; plain Postgres
      -- accepts the same WITH SCHEMA clause.
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'settlement-retention-cleanup not scheduled: pg_cron is available but could not be enabled (%) — run SELECT cleanup_stale_settlements(7) daily from an external scheduler', SQLERRM;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'settlement-retention-cleanup',
      '0 3 * * *',
      'SELECT cleanup_stale_settlements(7)'
    );
  ELSE
    RAISE WARNING 'pg_cron is not installed, so settlement-retention-cleanup was not scheduled. Run SELECT cleanup_stale_settlements(7) daily from an external scheduler.';
  END IF;
END $$;
